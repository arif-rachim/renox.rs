//! `prepare` (#96, `docs/contracts/deploy-api.md` section 6 step 4): the
//! owning node readies a deployment before any route points at it, and
//! answers `POST /v1/nodes/{node_id}/prepare-results`.
//!
//! | Stage | Here |
//! | --- | --- |
//! | `fetch` | the artifact through [`S3ArtifactStore`] (verified, cached) |
//! | `migrate` | every not-yet-applied `migrations/app/*.sql`, each file in its own transaction (`renox_data::migrate_with_checksums`); the failing file and the SQLite message are reported, the files before it stay applied (forward-only) |
//! | `load`, `probe` | [`crate::health_probe`]: the cell is created and probed directly, without a route |
//!
//! The prepared cell stays warm and receives traffic when the route delta
//! arrives. Without one within `deadline_ms`, the node drains it (step 7).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use renox_data::{DbOptions, MigrationError, MigrationFile, TenantDb, migrate_with_checksums};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::artifact::ArtifactStore;
use crate::artifact_s3::S3ArtifactStore;
use crate::cell::{CellKey, valid_tenant_id};
use crate::control::http::ControlClient;
use crate::control::routes::RouteState;
use crate::health_probe;
use crate::manager::{CellManager, DeploymentMeta};
use crate::tiers::{TierName, Tiers};

/// `$defs/prepare`.
#[derive(Debug, Clone, Deserialize)]
pub struct Prepare {
    pub activation_id: String,
    pub tenant_id: String,
    pub app: String,
    pub deployment_hash: String,
    pub tier: TierName,
    pub secrets_version: u64,
    pub probe: Option<ProbeSpec>,
    pub deadline_ms: u64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ProbeSpec {
    pub path: String,
    pub timeout_ms: u64,
}

/// `$defs/activation_error`. Never a node path, an internal address, or a
/// secret value.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct ActivationError {
    pub stage: &'static str,
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub module: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sqlite_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub http_status: Option<u16>,
}

fn failure(stage: &'static str, reason: impl Into<String>) -> ActivationError {
    ActivationError {
        stage,
        reason: clip(reason.into()),
        ..Default::default()
    }
}

/// `maxLength: 1024` of `reason` and `sqlite_error`.
fn clip(s: String) -> String {
    s.chars().take(1024).collect()
}

/// What the node did: the migration files applied by this prepare
/// (`<module>/<file>`), or why it failed.
pub type Outcome = (Vec<String>, Result<(), ActivationError>);

/// Runs `prepare` messages from the control stream.
pub struct Preparer {
    pub client: ControlClient,
    pub manager: CellManager,
    pub store: Arc<S3ArtifactStore>,
    pub routes: Arc<RouteState>,
    pub data_dir: PathBuf,
    pub tiers: Tiers,
}

impl Preparer {
    /// The control stream's handler for messages other than routes.
    pub fn handle(self: &Arc<Self>, message: Value) {
        if message.get("type").and_then(Value::as_str) != Some("prepare") {
            tracing::debug!("control message ignored");
            return;
        }
        let p: Prepare = match serde_json::from_value(message) {
            Ok(p) => p,
            Err(e) => {
                tracing::warn!(error = %e, "prepare refused");
                return;
            }
        };
        let me = self.clone();
        tokio::spawn(async move { me.run(p).await });
    }

    async fn run(&self, p: Prepare) {
        tracing::info!(activation_id = %p.activation_id, tenant_id = %p.tenant_id, deployment_hash = %p.deployment_hash, "prepare");
        let (applied, result) = self.prepare(&p).await;
        let mut body = serde_json::json!({
            "type": "prepare_result",
            "schema_version": 0,
            "activation_id": p.activation_id,
            "node_id": self.client.node_id(),
            "ok": result.is_ok(),
            "migrations_applied": applied,
        });
        if let Err(e) = &result {
            tracing::warn!(activation_id = %p.activation_id, stage = e.stage, reason = %e.reason, "prepare failed");
            body["error"] = serde_json::to_value(e).unwrap_or_default();
        }
        match self
            .client
            .post_json(&self.client.node_path("/prepare-results"), &body)
            .await
        {
            Ok(a) if a.status.is_success() => {}
            Ok(a) => {
                tracing::warn!(status = a.status.as_u16(), activation_id = %p.activation_id, "prepare_result refused")
            }
            Err(e) => {
                tracing::warn!(error = %e, activation_id = %p.activation_id, "prepare_result not delivered")
            }
        }
        // Step 7: no route delta for the prepared cell within the deadline
        // → it drains like any cell without an active entry.
        let routes = self.routes.clone();
        let deadline = Duration::from_millis(p.deadline_ms);
        tokio::spawn(async move {
            tokio::time::sleep(deadline).await;
            routes.sync_manager();
        });
    }

    /// The stages of step 4, in order.
    pub async fn prepare(&self, p: &Prepare) -> Outcome {
        if !valid_tenant_id(&p.tenant_id) {
            return (Vec::new(), Err(failure("load", "invalid tenant id")));
        }
        // The cell created below takes its tier, app and secret version from here.
        self.routes.expect(
            &p.tenant_id,
            &p.deployment_hash,
            DeploymentMeta {
                tier: p.tier,
                app: Some(p.app.clone()),
                secrets_version: p.secrets_version,
                database: None,
            },
        );
        let store = self.store.clone();
        let hash = p.deployment_hash.clone();
        let artifact = match tokio::task::spawn_blocking(move || store.get(&hash)).await {
            Ok(Ok(a)) => a,
            Ok(Err(e)) => return (Vec::new(), Err(failure("fetch", e.to_string()))),
            Err(e) => return (Vec::new(), Err(failure("fetch", e.to_string()))),
        };
        let quota = self.tiers.get(p.tier).db_quota_bytes;
        let db_path = self.data_dir.join(&p.tenant_id).join("app.db");
        let dir = artifact.path.clone();
        // #255: a missing or corrupt tenant file is restored from its replica
        // before the migrations open it.
        let hooks = self.manager.db_lifecycle();
        let tenant = p.tenant_id.clone();
        let migrated = tokio::task::spawn_blocking(move || {
            if let Some(h) = &hooks
                && let Err(e) = h.before_open(&tenant, &db_path)
            {
                return (Vec::new(), Err(failure("migrate", e)));
            }
            migrate(&db_path, &dir, quota)
        })
        .await;
        let applied = match migrated {
            Ok((applied, Ok(()))) => applied,
            Ok((applied, Err(e))) => return (applied, Err(e)),
            Err(e) => return (Vec::new(), Err(failure("migrate", e.to_string()))),
        };
        let key = CellKey {
            tenant_id: p.tenant_id.clone(),
            deployment_hash: p.deployment_hash.clone(),
        };
        let (path, timeout) = match &p.probe {
            Some(s) => (Some(s.path.as_str()), Duration::from_millis(s.timeout_ms)),
            None => (None, Duration::from_secs(10)),
        };
        let probed =
            health_probe::probe(&self.manager, &key, path, timeout, &p.activation_id).await;
        (
            applied,
            probed.map_err(|f| ActivationError {
                stage: f.stage,
                reason: clip(f.reason),
                http_status: f.http_status,
                ..Default::default()
            }),
        )
    }
}

/// Applies the artifact's app migrations on a connection of its own (the
/// live cell keeps its handle; SQLite serialises the writers). Returns the
/// files applied (`app/<file>`) and the first failure.
pub fn migrate(
    db_path: &Path,
    artifact_dir: &Path,
    quota: u64,
) -> (Vec<String>, Result<(), ActivationError>) {
    let app_dir = artifact_dir.join("migrations").join("app");
    if !app_dir.is_dir() {
        return (Vec::new(), Ok(()));
    }
    let read = || -> Result<(Vec<MigrationFile>, BTreeMap<String, String>), String> {
        #[derive(Deserialize)]
        struct Sums {
            files: BTreeMap<String, String>,
        }
        let sums: Sums = serde_json::from_slice(
            &std::fs::read(artifact_dir.join("migrations").join("checksums.json"))
                .map_err(|_| "migrations/checksums.json missing".to_string())?,
        )
        .map_err(|_| "migrations/checksums.json invalid".to_string())?;
        let mut files = Vec::new();
        for entry in std::fs::read_dir(&app_dir).map_err(|e| e.kind().to_string())? {
            let entry = entry.map_err(|e| e.kind().to_string())?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.ends_with(".sql") {
                let sql = std::fs::read_to_string(entry.path())
                    .map_err(|_| format!("migration {name} is not UTF-8"))?;
                files.push(MigrationFile { name, sql });
            }
        }
        Ok((files, sums.files))
    };
    let (files, sums) = match read() {
        Ok(r) => r,
        Err(e) => return (Vec::new(), Err(failure("migrate", e))),
    };
    if let Some(parent) = db_path.parent()
        && let Err(e) = std::fs::create_dir_all(parent)
    {
        return (Vec::new(), Err(failure("migrate", e.kind().to_string())));
    }
    let options = DbOptions {
        module_prefix: Some("app".into()),
        ..DbOptions::with_quota_bytes(quota)
    };
    let db = match TenantDb::open(db_path, options) {
        Ok(db) => db,
        Err(e) => {
            return (
                Vec::new(),
                Err(failure("migrate", format!("database: {e}"))),
            );
        }
    };
    // One file at a time, so the files before a failing one are known.
    let mut applied = Vec::new();
    let mut sorted: Vec<&MigrationFile> = files.iter().collect();
    sorted.sort_by(|a, b| a.name.cmp(&b.name));
    let mut result = Ok(());
    for i in 0..sorted.len() {
        let prefix: Vec<MigrationFile> = sorted[..=i].iter().map(|f| (*f).clone()).collect();
        match migrate_with_checksums(&db, "app", &prefix, &sums) {
            Ok(report) => applied.extend(report.applied.into_iter().map(|n| format!("app/{n}"))),
            Err(e) => {
                result = Err(migration_error(e));
                break;
            }
        }
    }
    let _ = db.close();
    (applied, result)
}

fn migration_error(e: MigrationError) -> ActivationError {
    let file = match &e {
        MigrationError::Failed { name, .. }
        | MigrationError::ChecksumMismatch { name }
        | MigrationError::OutsidePrefix { name, .. }
        | MigrationError::InvalidName { name }
        | MigrationError::DuplicateName { name } => Some(format!("app/{name}")),
        MigrationError::Db(_) => None,
    };
    let sqlite_error = match &e {
        MigrationError::Failed { source, .. } => Some(clip(source.to_string())),
        _ => None,
    };
    ActivationError {
        stage: "migrate",
        reason: clip(e.to_string()),
        module: Some("app".into()),
        file,
        sqlite_error,
        http_status: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn artifact(dir: &Path, files: &[(&str, &str)]) {
        let app = dir.join("migrations/app");
        std::fs::create_dir_all(&app).unwrap();
        let mut sums = serde_json::Map::new();
        for (name, sql) in files {
            std::fs::write(app.join(name), sql).unwrap();
            sums.insert(format!("app/{name}"), renox_data::checksum(sql).into());
        }
        std::fs::write(
            dir.join("migrations/checksums.json"),
            serde_json::json!({ "version": 0, "files": sums }).to_string(),
        )
        .unwrap();
    }

    /// `docs/23-failure-modes.md` section 3, "Migration fails half-way": the
    /// first file stays applied, the second is reported with its SQLite
    /// error, and a fixed artifact applies only the remaining file.
    #[test]
    fn a_failing_second_file_is_reported_and_the_first_stays_applied() {
        let root = std::env::temp_dir().join(format!("renox-prepare-unit-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let db = root.join("t_x/app.db");
        let broken = root.join("broken");
        artifact(
            &broken,
            &[
                (
                    "001_items.sql",
                    "create table app__items (id integer primary key);",
                ),
                (
                    "002_price.sql",
                    "alter table app__missing add column price integer;",
                ),
            ],
        );
        let (applied, result) = migrate(&db, &broken, 10 * 1024 * 1024);
        assert_eq!(applied, ["app/001_items.sql"]);
        let e = result.unwrap_err();
        assert_eq!(e.stage, "migrate");
        assert_eq!(e.module.as_deref(), Some("app"));
        assert_eq!(e.file.as_deref(), Some("app/002_price.sql"));
        assert!(e.sqlite_error.is_some(), "{e:?}");
        let fixed = root.join("fixed");
        artifact(
            &fixed,
            &[
                (
                    "001_items.sql",
                    "create table app__items (id integer primary key);",
                ),
                (
                    "002_price.sql",
                    "alter table app__items add column price integer;",
                ),
            ],
        );
        let (applied, result) = migrate(&db, &fixed, 10 * 1024 * 1024);
        assert!(result.is_ok(), "{result:?}");
        assert_eq!(applied, ["app/002_price.sql"]);
        let _ = std::fs::remove_dir_all(&root);
    }
}
