//! Degraded mode (#98, `docs/23-failure-modes.md` section 3, "Control plane
//! unreachable from the worker" and "Object storage unreachable"): the
//! worker keeps serving what it has without the control plane.
//!
//! | Piece | Here |
//! | --- | --- |
//! | Last route table | [`SnapshotFile`]: `<data_dir>/routes.snapshot.json`, written after every applied snapshot or delta, read at start before the control plane answers |
//! | Artifacts | the disk cache of [`S3ArtifactStore`] is authoritative for the request path |
//! | Meters and logs | spooled and replayed ([`crate::spool`]) |
//! | Uncached cold start while storage or the control plane is down | [`GuardedDispatcher`]: 503 `RENOX_UNAVAILABLE`, `Retry-After: 5` (`errors.md`) |
//! | Health | `/healthz` reports `degraded` with the reasons; every change is a tracing event (the alert) |

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use axum::body::Body;
use bytes::Bytes;
use http::{Request, Response};
use renox_gateway::{CellDispatcher, RequestCtx};

use crate::artifact::{ArtifactError, ArtifactStore};
use crate::artifact_s3::S3ArtifactStore;
use crate::cell::CellKey;
use crate::control::health::Health;
use crate::control::routes::{ControlEntry, Snapshot};
use crate::manager::CellManager;
use crate::render::{default_page, prefers_html};

/// `errors.md`, `RENOX_UNAVAILABLE`.
pub const UNAVAILABLE_MESSAGE: &str = "The service is temporarily unavailable.";
pub const RETRY_AFTER_SECS: u32 = 5;

/// The last applied route table on disk. Holds routes only (hostnames,
/// tenants, hashes, tiers): no secret, no token.
#[derive(Debug, Clone)]
pub struct SnapshotFile {
    pub path: PathBuf,
}

impl SnapshotFile {
    pub fn in_data_dir(data_dir: &Path) -> SnapshotFile {
        SnapshotFile {
            path: data_dir.join("routes.snapshot.json"),
        }
    }

    /// Writes the table atomically (temporary file, then rename).
    pub fn save(&self, version: u64, entries: &[ControlEntry]) {
        let body = serde_json::json!({
            "type": "route_snapshot",
            "schema_version": 0,
            "version": version,
            "entries": entries,
        });
        let tmp = self.path.with_extension("json.tmp");
        let result =
            std::fs::write(&tmp, body.to_string()).and_then(|_| std::fs::rename(&tmp, &self.path));
        if let Err(e) = result {
            tracing::error!(error = %e, "route snapshot not written");
        }
    }

    /// The saved table, if there is a readable one.
    pub fn load(&self) -> Option<Snapshot> {
        let bytes = std::fs::read(&self.path).ok()?;
        match serde_json::from_slice(&bytes) {
            Ok(s) => Some(s),
            Err(e) => {
                tracing::error!(error = %e, "route snapshot unreadable; starting without it");
                None
            }
        }
    }
}

/// The gateway's dispatcher in both modes. In controlled mode it checks,
/// before a cold start, that the cell can be created without the services
/// that are down.
pub struct GuardedDispatcher {
    pub manager: CellManager,
    pub guard: Option<Guard>,
}

/// What the controlled-mode check needs.
pub struct Guard {
    pub store: Arc<S3ArtifactStore>,
    pub health: Arc<Health>,
    pub artifacts_dir: PathBuf,
    /// Whether a deployment declares secrets (`permissions.secrets`), by hash.
    declares: Mutex<HashMap<String, bool>>,
}

impl Guard {
    pub fn new(store: Arc<S3ArtifactStore>, health: Arc<Health>, artifacts_dir: PathBuf) -> Guard {
        Guard {
            store,
            health,
            artifacts_dir,
            declares: Mutex::new(HashMap::new()),
        }
    }

    fn declares_secrets(&self, hash: &str) -> bool {
        if let Some(d) = self.declares.lock().expect("guard lock").get(hash) {
            return *d;
        }
        let d = declares_secrets(&self.artifacts_dir, hash);
        self.declares
            .lock()
            .expect("guard lock")
            .insert(hash.to_string(), d);
        d
    }

    /// `None` when the request may go on to the manager; the reason for a
    /// 503 otherwise.
    async fn refuse(&self, manager: &CellManager, key: &CellKey) -> Option<&'static str> {
        // A live cell needs nothing that may be down.
        if !self.store.is_cached(&key.deployment_hash) && !manager.cells().contains(key) {
            let store = self.store.clone();
            let hash = key.deployment_hash.clone();
            let fetched = tokio::task::spawn_blocking(move || store.get(&hash))
                .await
                .map_err(|e| ArtifactError::Invalid {
                    rule: "fetch",
                    reason: e.to_string(),
                })
                .and_then(|r| r);
            match fetched {
                Ok(_) => self.health.recover("object_storage"),
                // Not found or invalid: the manager reports it like before.
                Err(ArtifactError::NotFound(_) | ArtifactError::HashMismatch { .. }) => {}
                Err(ArtifactError::Invalid {
                    rule: "fetch",
                    reason,
                }) => {
                    self.health.degrade("object_storage", reason);
                    return Some("artifact_unavailable");
                }
                Err(_) => {}
            }
        }
        // A cold start needs the secret bundle when the deployment declares
        // secrets; the control plane is the only place it comes from.
        if self.health.has("control_plane")
            && self.declares_secrets(&key.deployment_hash)
            && !manager.cells().contains(key)
        {
            return Some("artifact_unavailable");
        }
        None
    }
}

/// Whether `<artifacts_dir>/<hash>/manifest.json` lists any secret.
pub fn declares_secrets(artifacts_dir: &Path, hash: &str) -> bool {
    let Ok(bytes) = std::fs::read(artifacts_dir.join(hash).join("manifest.json")) else {
        return true;
    };
    let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap_or_default();
    v.pointer("/permissions/secrets")
        .and_then(|s| s.as_array())
        .is_none_or(|a| !a.is_empty())
}

/// 503 `RENOX_UNAVAILABLE` with `Retry-After: 5`: the JSON body of
/// `errors.md` section 1, or the default page when the client prefers HTML.
pub fn unavailable(request_id: &str, html: bool) -> Response<Bytes> {
    let mut r = if html {
        default_page(503, UNAVAILABLE_MESSAGE, request_id)
    } else {
        let body = serde_json::json!({
            "error": { "code": "RENOX_UNAVAILABLE", "request_id": request_id, "message": UNAVAILABLE_MESSAGE }
        });
        Response::builder()
            .status(503)
            .header(
                http::header::CONTENT_TYPE,
                "application/json; charset=utf-8",
            )
            .header(http::header::CACHE_CONTROL, "no-store")
            .header("x-renox-request-id", request_id)
            .body(Bytes::from(body.to_string()))
            .expect("valid response")
    };
    r.headers_mut().insert(
        http::header::RETRY_AFTER,
        http::HeaderValue::from(RETRY_AFTER_SECS),
    );
    r
}

impl CellDispatcher for GuardedDispatcher {
    async fn dispatch(&self, ctx: RequestCtx, req: Request<Body>) -> Response<Body> {
        if let Some(guard) = &self.guard {
            let key = CellKey {
                tenant_id: ctx.tenant_id.clone(),
                deployment_hash: ctx.deployment_hash.clone(),
            };
            if let Some(reason) = guard.refuse(&self.manager, &key).await {
                tracing::warn!(
                    tenant_id = %key.tenant_id,
                    deployment_hash = %key.deployment_hash,
                    request_id = %ctx.request_id,
                    reason,
                    "cold start refused: RENOX_UNAVAILABLE"
                );
                let html = prefers_html(req.headers());
                return unavailable(&ctx.request_id, html).map(Body::from);
            }
        }
        self.manager.dispatch(ctx, req).await
    }
}
