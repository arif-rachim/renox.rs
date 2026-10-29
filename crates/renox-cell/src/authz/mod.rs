//! The cell's side of authorization (`docs/contracts/ops.md` 1.5.0 section
//! 17; #279): the deployment's policy engine, built at cell creation from
//! the artifact (`policies/`, the app's and each module's `authz` block)
//! with attribute types read from the tenant's tables, the principal cache,
//! and its invalidation from the outbox.
//!
//! The principal itself is resolved in the request by the bootstrap
//! (`auth.principal`), and the `guard` is evaluated by `op_authz_guard`
//! before any handler (`renox-runtime`, `ops/authz.rs`); both read what this
//! module puts in the deployment's [`AuthzSlot`].

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::AtomicU64;
use std::time::Duration;

use renox_authz::{AttrType, AuthzBlock, Engine, MergedSchema, Owner, PolicySet};
use renox_runtime::ops::authz::{AuthzSlot, AuthzState, PRINCIPAL_TTL, PrincipalCache};
use renox_runtime::ops::db::DbHandle;

/// The worker's `[authz]` (`config.rs`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AuthzConfig {
    /// Dev mode: `ctx.authz.explain` works and `RENOX_FORBIDDEN` names the
    /// deciding policy (`renox dev`). Never in production.
    pub dev: bool,
    /// Principal cache TTL (`ops.md` Open 12: 60 s *proposed*).
    pub principal_ttl: Duration,
}

impl Default for AuthzConfig {
    fn default() -> Self {
        AuthzConfig {
            dev: false,
            principal_ttl: PRINCIPAL_TTL,
        }
    }
}

/// The events that drop a user's cached principal (`ops.md` section 17,
/// "Cache"): delivered through the cell's own outbox. `auth.principal_changed`
/// (#292) is auth's, for what its principal hook's fillers changed: the
/// active organisation (org), a second-factor verification (2fa).
pub const INVALIDATING_EVENTS: [&str; 4] = [
    "authz.roles_changed",
    "auth.login",
    "auth.logout",
    "auth.principal_changed",
];

/// Drops the cached principal of the event's `user_id`; `true` when the
/// event is one of [`INVALIDATING_EVENTS`].
pub fn on_event(slot: &AuthzSlot, name: &str, payload: &str) -> bool {
    if !INVALIDATING_EVENTS.contains(&name) {
        return false;
    }
    let Some(st) = slot.read().ok().and_then(|s| s.clone()) else {
        return true;
    };
    match serde_json::from_str::<serde_json::Value>(payload)
        .ok()
        .and_then(|v| {
            v.get("user_id")
                .and_then(|u| u.as_str())
                .map(str::to_string)
        }) {
        Some(user) => {
            st.cache.invalidate_user(&user);
        }
        // No user id: be safe, forget everyone.
        None => st.cache.clear(),
    }
    true
}

/// Operator counters of the live cells (#279): principal cache hits and
/// misses, cached principals, and decisions made (guards and ops).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct AuthzStats {
    pub cache_hits: u64,
    pub cache_misses: u64,
    pub cached: usize,
    pub decisions: u64,
}

impl AuthzStats {
    /// Adds one deployment's counters; an empty slot adds nothing.
    pub fn add(&mut self, slot: &AuthzSlot) {
        let Some(st) = slot.read().ok().and_then(|s| s.clone()) else {
            return;
        };
        let (hits, misses, cached) = st.cache.stats();
        self.cache_hits += hits;
        self.cache_misses += misses;
        self.cached += cached;
        self.decisions += st.decisions.load(std::sync::atomic::Ordering::Relaxed);
    }

    /// Hits over lookups, 0 when nothing was looked up.
    pub fn hit_rate(&self) -> f64 {
        let total = self.cache_hits + self.cache_misses;
        if total == 0 {
            0.0
        } else {
            self.cache_hits as f64 / total as f64
        }
    }
}

/// Every `policies/**/*.cedar` file of the artifact, and the app's schema.
/// `(path, text)` of the `.cedar` files, and the schema text if any.
type PolicyFiles = (Vec<(String, String)>, Option<String>);

fn policy_files(artifact_dir: &Path) -> std::io::Result<PolicyFiles> {
    let root = artifact_dir.join("policies");
    let mut files = Vec::new();
    let mut schema = None;
    if !root.is_dir() {
        return Ok((files, schema));
    }
    let mut stack = vec![root.clone()];
    while let Some(dir) = stack.pop() {
        for e in std::fs::read_dir(&dir)? {
            let p = e?.path();
            if p.is_dir() {
                stack.push(p);
                continue;
            }
            let rel = p
                .strip_prefix(artifact_dir)
                .map(|r| r.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default();
            if rel == "policies/schema.cedarschema" {
                schema = Some(std::fs::read_to_string(&p)?);
            } else if rel.ends_with(".cedar") {
                files.push((rel, std::fs::read_to_string(&p)?));
            }
        }
    }
    files.sort();
    Ok((files, schema))
}

/// The owners of the deployment: the app's `authz` block (when present)
/// and each module entry's, from `manifest.json`.
fn owners(manifest: &serde_json::Value) -> Result<Vec<Owner>, String> {
    let mut out = Vec::new();
    let block = |v: &serde_json::Value| -> Result<AuthzBlock, String> {
        serde_json::from_value(v.clone()).map_err(|e| format!("authz: {e}"))
    };
    if let Some(a) = manifest.get("authz") {
        out.push(Owner::new("app", block(a)?));
    }
    for m in manifest
        .get("modules")
        .and_then(|m| m.as_array())
        .into_iter()
        .flatten()
    {
        let (Some(name), Some(a)) = (m.get("name").and_then(|n| n.as_str()), m.get("authz")) else {
            continue;
        };
        out.push(Owner::new(name, block(a)?));
    }
    Ok(out)
}

/// The engine of an artifact without its database, for `renox check` and
/// `renox test` (`renox-worker check-policies`, #283): the same owners,
/// schema and policies as [`build`]. `columns` (table → column → declared
/// type, from the migrations applied in memory by the CLI, #292) types the
/// declared attributes as the cell does from the tenant's tables; an
/// attribute without a known column is `String`. `policies` are
/// `(artifact path, text)`; `policies/schema.cedarschema` is the app's
/// schema.
pub fn engine_for_check(
    manifest: &serde_json::Value,
    policies: &[(String, String)],
    columns: &BTreeMap<String, BTreeMap<String, String>>,
) -> Result<Engine, Vec<renox_authz::PolicyError>> {
    let one = |message: String| {
        vec![renox_authz::PolicyError {
            file: "manifest.json".into(),
            line: 0,
            column: 0,
            message,
        }]
    };
    let mut owners = owners(manifest).map_err(one)?;
    // #292: the declared columns of each entity's table (the CLI applies the
    // migrations in memory and sends them), typed as the cell types them.
    for o in owners.iter_mut() {
        let typed: Vec<(String, String, AttrType)> = o
            .authz
            .entities
            .iter()
            .filter_map(|(ty, d)| {
                d.table
                    .as_ref()
                    .and_then(|t| columns.get(t))
                    .map(|cols| (ty, d, cols))
            })
            .flat_map(|(ty, d, cols)| {
                d.attrs.iter().filter_map(move |a| {
                    cols.get(a)
                        .map(|decl| (ty.clone(), a.clone(), AttrType::from_sqlite(decl)))
                })
            })
            .collect();
        for (ty, a, t) in typed {
            *o = std::mem::take(o).with_type(&ty, &a, t);
        }
    }
    let schema_text = policies
        .iter()
        .find(|(p, _)| p == "policies/schema.cedarschema")
        .map(|(_, t)| t.as_str());
    let files: Vec<(String, String)> = policies
        .iter()
        .filter(|(p, _)| p.ends_with(".cedar"))
        .cloned()
        .collect();
    let schema = MergedSchema::build(&owners, schema_text)?;
    let set = PolicySet::load(&files, &schema)?;
    Ok(Engine::new(schema, set))
}

/// Builds the deployment's engine (V24 at load: a policy that does not
/// parse or validate refuses the deployment, nothing is loaded). Entity
/// attribute types come from the declared table's columns.
pub async fn build(
    artifact_dir: &Path,
    db: &DbHandle,
    config: AuthzConfig,
) -> Result<Arc<AuthzState>, String> {
    let raw = std::fs::read(artifact_dir.join("manifest.json"))
        .map_err(|e| format!("manifest.json: {}", e.kind()))?;
    let manifest: serde_json::Value =
        serde_json::from_slice(&raw).map_err(|e| format!("manifest.json: {e}"))?;
    let mut owners = owners(&manifest)?;
    // (owner, entity type, table) to type from the tenant's tables.
    let tables: Vec<(usize, String, String)> = owners
        .iter()
        .enumerate()
        .flat_map(|(i, o)| {
            o.authz
                .entities
                .iter()
                .filter_map(move |(t, d)| d.table.clone().map(|tb| (i, t.clone(), tb)))
        })
        .collect();
    let lookups = tables.clone();
    let columns: Vec<BTreeMap<String, String>> = db
        .call(move |db| {
            db.with_policy(None, || {
                lookups
                    .iter()
                    .map(|(_, _, table)| {
                        db.query(
                            "select name, type from pragma_table_info(?)",
                            &[table.as_str().into()],
                        )
                        .map(|rows| {
                            rows.iter()
                                .filter_map(|r| match (r.get("name"), r.get("type")) {
                                    (
                                        Some(renox_data::Value::Text(n)),
                                        Some(renox_data::Value::Text(t)),
                                    ) => Some((n.clone(), t.clone())),
                                    _ => None,
                                })
                                .collect()
                        })
                        .unwrap_or_default()
                    })
                    .collect()
            })
            .unwrap_or_default()
        })
        .await
        .map_err(|e| format!("attribute types: {e}"))?;
    for ((i, ty, _), cols) in tables.iter().zip(columns) {
        let attrs = owners[*i]
            .authz
            .entities
            .get(ty)
            .map(|d| d.attrs.clone())
            .unwrap_or_default();
        for a in attrs {
            if let Some(decl) = cols.get(&a) {
                let o = std::mem::take(&mut owners[*i]);
                owners[*i] = o.with_type(ty, &a, AttrType::from_sqlite(decl));
            }
        }
    }
    let module_roles: BTreeMap<String, BTreeSet<String>> = owners
        .iter()
        .filter(|o| o.name != "app")
        .map(|o| {
            (
                o.name.clone(),
                o.authz.default_roles.keys().cloned().collect(),
            )
        })
        .collect();
    let (files, schema_text) =
        policy_files(artifact_dir).map_err(|e| format!("policies: {}", e.kind()))?;
    let render = |errs: Vec<renox_authz::PolicyError>| {
        errs.iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join("; ")
    };
    let schema = MergedSchema::build(&owners, schema_text.as_deref()).map_err(render)?;
    let set = PolicySet::load(&files, &schema).map_err(render)?;
    Ok(Arc::new(AuthzState {
        engine: Arc::new(Engine::new(schema, set)),
        dev: config.dev,
        cache: Arc::new(PrincipalCache::new(config.principal_ttl)),
        module_roles,
        decisions: AtomicU64::new(0),
    }))
}
