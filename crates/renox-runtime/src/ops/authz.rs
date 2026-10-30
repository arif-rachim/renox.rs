//! Principal, `guard`, and `op_authz_*` (`docs/contracts/ops.md` 1.5.0
//! section 17; #279). The engine is `renox-authz`; the cell builds it at
//! cell creation and puts it in the deployment's [`AuthzSlot`].
//!
//! **Principal.** Resolved once per request, before the route's `guard` and
//! the handler: the bootstrap asks [`PrincipalCache`] through
//! `op_authz_principal_cached`; on a miss it calls the `auth` module's
//! service `auth.principal(sessionId)` in the request (the service runs the
//! `auth.principal` hook itself) and hands the answer to
//! `op_authz_principal_set`, which adds the role assignments from
//! `renox__role_assignments` and caches the result. Without `auth`, without
//! cookies, or when `auth` answers `null`: the anonymous principal. Event
//! handlers and jobs get `Renox::System::"<module>"`. Ops never take a
//! principal argument: they use the request's own.
//!
//! **Guard.** `op_authz_guard` evaluates the route's `guard` in Rust before
//! the handler runs (and before a lazy module is evaluated). A guard
//! resource is loaded through its entity declaration, outside any tenant
//! transaction; a row that does not exist is a deny.
//!
//! **Audit.** A `guard` decision and a `require` (`enforce`) on a
//! `sensitive` action write one `renox__authz_audit` row in the request's
//! current transaction (autocommit when none is open).
//!
//! The pure part compiles without V8; the ops are behind the `v8` feature.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use renox_authz::{Engine, Principal};
use serde::Deserialize;

/// Evaluations one request may make (`ops.md` Open 13, *proposed*).
pub const MAX_EVALS: u64 = 10_000;
/// Resources one `check_batch` may take.
pub const MAX_BATCH: usize = 1_000;
/// Principal cache TTL (`ops.md` Open 12, *proposed*).
pub const PRINCIPAL_TTL: Duration = Duration::from_secs(60);

/// A route's `guard` (`artifact.md` 1.3).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Guard {
    pub action: String,
    #[serde(default)]
    pub resource: Option<GuardResource>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GuardResource {
    #[serde(rename = "type")]
    pub ty: String,
    /// A literal or `:<param>`.
    pub id: String,
}

/// The principal cache of one cell, shared by its isolates: key → the
/// extended principal (roles included), for the TTL. Dropped per user on
/// `authz.roles_changed`, `auth.login`, and `auth.logout`.
pub struct PrincipalCache {
    ttl: Duration,
    map: Mutex<HashMap<String, (Arc<Principal>, Instant)>>,
    hits: std::sync::atomic::AtomicU64,
    misses: std::sync::atomic::AtomicU64,
}

impl PrincipalCache {
    pub fn new(ttl: Duration) -> PrincipalCache {
        PrincipalCache {
            ttl,
            map: Mutex::new(HashMap::new()),
            hits: Default::default(),
            misses: Default::default(),
        }
    }

    pub fn get(&self, key: &str) -> Option<Arc<Principal>> {
        use std::sync::atomic::Ordering::Relaxed;
        let now = Instant::now();
        let mut map = self
            .map
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        match map.get(key) {
            Some((p, until)) if *until > now => {
                self.hits.fetch_add(1, Relaxed);
                Some(p.clone())
            }
            Some(_) => {
                map.remove(key);
                self.misses.fetch_add(1, Relaxed);
                None
            }
            None => {
                self.misses.fetch_add(1, Relaxed);
                None
            }
        }
    }

    pub fn put(&self, key: String, p: Arc<Principal>) {
        let mut map = self
            .map
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if map.len() >= 100_000 {
            map.clear();
        }
        map.insert(key, (p, Instant::now() + self.ttl));
    }

    /// Drops every cached principal of `user_id` (and anonymous entries
    /// are never cached for a user, so a login always resolves afresh).
    pub fn invalidate_user(&self, user_id: &str) -> usize {
        let mut map = self
            .map
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let before = map.len();
        map.retain(|_, (p, _)| p.id != user_id);
        before - map.len()
    }

    pub fn clear(&self) {
        self.map
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clear();
    }

    /// (hits, misses, entries) for the metrics endpoint.
    pub fn stats(&self) -> (u64, u64, usize) {
        use std::sync::atomic::Ordering::Relaxed;
        (
            self.hits.load(Relaxed),
            self.misses.load(Relaxed),
            self.map
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .len(),
        )
    }
}

/// What the cell gives a deployment's isolates (`ops.md` section 17).
pub struct AuthzState {
    pub engine: Arc<Engine>,
    /// Dev mode: `explain` works and `RENOX_FORBIDDEN` names the policy.
    pub dev: bool,
    pub cache: Arc<PrincipalCache>,
    /// Module → the roles it may assign (`[authz.default_roles]` keys).
    pub module_roles: BTreeMap<String, BTreeSet<String>>,
    /// Decisions made (guards and ops), for the metrics endpoint.
    pub decisions: std::sync::atomic::AtomicU64,
}

/// The deployment's slot: empty until the cell has built the engine (an
/// op before then denies, `evaluation_error`).
pub type AuthzSlot = Arc<RwLock<Option<Arc<AuthzState>>>>;

pub fn new_slot() -> AuthzSlot {
    Arc::new(RwLock::new(None))
}

/// Per-request authorization state (in `RequestState`).
#[derive(Debug, Default)]
pub struct RequestAuthz {
    /// The route index, `None` for an event delivery.
    pub route: Option<usize>,
    pub method: String,
    pub path: String,
    /// Route parameters, for a guard resource id `:<param>`.
    pub params: BTreeMap<String, String>,
    /// The cache key: the page session id and the request's cookies.
    pub cache_key: Option<String>,
    /// The platform page session id (`auth.principal`'s argument).
    pub session: Option<String>,
    pub principal: Option<Arc<Principal>>,
    pub evals: u64,
    /// Per request: `(action, resource id)` of `r-can`/`can` already counted.
    pub seen: BTreeSet<(String, String)>,
}

/// The cache key of a request: the page session id and the `Cookie`
/// header (minus the platform's), so another browser's cookies never get a
/// cached principal. `None` without any cookie: the anonymous principal,
/// no `auth.principal` call.
pub fn cache_key(session: Option<&str>, cookie: Option<&str>) -> Option<String> {
    use sha2::{Digest, Sha256};
    let cookie = cookie.unwrap_or("").trim();
    if cookie.is_empty() {
        return None;
    }
    let mut h = Sha256::new();
    h.update(session.unwrap_or("").as_bytes());
    h.update(b"|");
    h.update(cookie.as_bytes());
    Some(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// The JSON `auth.principal` answers: `{ id, attrs? }` (`kind` defaults to
/// `user`; roles are the platform's, not the service's).
#[derive(Debug, Deserialize)]
pub struct ServicePrincipal {
    pub id: String,
    #[serde(default)]
    pub attrs: serde_json::Map<String, serde_json::Value>,
}

#[cfg(feature = "v8")]
pub(crate) use v8_ops::*;

#[cfg(feature = "v8")]
mod v8_ops {
    use std::cell::RefCell;
    use std::rc::Rc;
    use std::time::{SystemTime, UNIX_EPOCH};

    use deno_core::{OpState, op2};
    use deno_error::JsErrorBox;
    use renox_authz::{Decision, PlatformContext, Reason, RoleAssignment};
    use renox_data::roles;
    use serde::Serialize;

    use super::*;
    use crate::ops::db::{DbEnv, DbHandle};
    use crate::ops::request::{RequestState, live_request, op_error};

    /// The authz environment of one isolate (op state).
    pub(crate) struct AuthzEnv {
        pub slot: AuthzSlot,
        /// `guard` per route index (`manifest.routes`).
        pub guards: Vec<Option<Guard>>,
        /// Owner of each route: `app` or the module name.
        pub owners: Vec<String>,
    }

    fn env(state: &Rc<RefCell<OpState>>) -> (Rc<AuthzEnv>, Rc<DbEnv>) {
        let s = state.borrow();
        (
            s.borrow::<Rc<AuthzEnv>>().clone(),
            s.borrow::<Rc<DbEnv>>().clone(),
        )
    }

    fn authz_state(env: &AuthzEnv) -> Option<Arc<AuthzState>> {
        env.slot.read().ok().and_then(|s| s.clone())
    }

    fn now_ms() -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
    }

    fn platform(r: &RequestState) -> PlatformContext {
        PlatformContext {
            now_ms: now_ms(),
            request: (!r.authz.method.is_empty())
                .then(|| (r.authz.method.clone(), r.authz.path.clone())),
        }
    }

    fn principal_of(r: &RequestState) -> Principal {
        r.authz
            .principal
            .as_deref()
            .cloned()
            .unwrap_or_else(Principal::anonymous)
    }

    /// `RENOX_FORBIDDEN` with the contract's details; the policy only in dev.
    fn forbidden(
        action: &str,
        resource: Option<(&str, &str)>,
        reason: &str,
        policy: Option<&str>,
    ) -> JsErrorBox {
        op_error(
            "RENOX_FORBIDDEN",
            serde_json::json!({
                "action": action,
                "resource": resource.map(|(t, i)| serde_json::json!({ "type": t, "id": i })),
                "reason": reason,
                "policy": policy,
            }),
            "You are not allowed to do this.",
        )
    }

    /// One evaluation counted; past the limit, a deny (`eval_limit`).
    fn count(request: &Rc<RefCell<RequestState>>) -> bool {
        let mut r = request.borrow_mut();
        r.authz.evals += 1;
        r.authz.evals <= MAX_EVALS
    }

    fn resource_ref(v: Option<&serde_json::Value>) -> Option<(String, String)> {
        let o = v?.as_object()?;
        let t = o.get("type")?.as_str()?.to_string();
        let id = match o.get("id")? {
            serde_json::Value::String(s) => s.clone(),
            other => other.to_string(),
        };
        Some((t, id))
    }

    /// Writes the audit row of a decision on a sensitive action, in the
    /// request's current transaction (autocommit when none is open).
    async fn audit(
        db: &DbHandle,
        tx: Option<u32>,
        principal: &str,
        action: &str,
        resource: Option<(String, String)>,
        d: &Decision,
    ) -> Result<(), renox_data::DbError> {
        let (principal, action) = (principal.to_string(), action.to_string());
        let allow = d.allow;
        let policy = d.policies.first().cloned();
        db.call_tx(tx, move |db, t| {
            let row = roles::AuditRow {
                principal: &principal,
                action: &action,
                resource: resource.as_ref().map(|(a, b)| (a.as_str(), b.as_str())),
                allow,
                policy: policy.as_deref(),
                at: now_ms(),
            };
            match t {
                Some(t) => db.with_policy(None, || roles::record(t, &row))?,
                None => db.with_policy(None, || roles::record(db, &row))?,
            }
            .map(|_| ())
        })
        .await
    }

    #[derive(Serialize)]
    pub(crate) struct Cached {
        /// `hit`, `miss`, or `anonymous` (no cookie, or no `auth.principal`).
        state: &'static str,
        principal: Option<serde_json::Value>,
        session: Option<String>,
    }

    fn principal_json(p: &Principal) -> Option<serde_json::Value> {
        if p.kind == renox_authz::PrincipalKind::Anonymous {
            return None;
        }
        Some(serde_json::json!({
            "id": p.id,
            "kind": p.kind,
            "roles": p.roles.iter().map(|r| serde_json::json!({ "role": r.role, "scope_type": r.scope_type, "scope_id": r.scope_id })).collect::<Vec<_>>(),
            "attrs": p.attrs,
        }))
    }

    /// The request's principal if it is known (set, or in the cache).
    #[op2]
    #[serde]
    pub(crate) fn op_authz_principal_cached(
        state: &mut OpState,
        token: u32,
    ) -> Result<Cached, JsErrorBox> {
        let request = state
            .borrow::<crate::ops::request::RequestTable>()
            .get(token)
            .ok_or_else(crate::ops::request::no_request)?;
        let env = state.borrow::<Rc<AuthzEnv>>().clone();
        let mut r = request.borrow_mut();
        if let Some(p) = &r.authz.principal {
            return Ok(Cached {
                state: "hit",
                principal: principal_json(p),
                session: r.authz.session.clone(),
            });
        }
        let Some(key) = r.authz.cache_key.clone() else {
            r.authz.principal = Some(Arc::new(Principal::anonymous()));
            return Ok(Cached {
                state: "anonymous",
                principal: None,
                session: None,
            });
        };
        if let Some(st) = authz_state(&env)
            && let Some(p) = st.cache.get(&key)
        {
            let json = principal_json(&p);
            r.authz.principal = Some(p);
            return Ok(Cached {
                state: "hit",
                principal: json,
                session: r.authz.session.clone(),
            });
        }
        Ok(Cached {
            state: "miss",
            principal: None,
            session: r.authz.session.clone(),
        })
    }

    /// What `auth.principal` answered (`null`: anonymous). Adds the role
    /// assignments and caches the result; returns `ctx.principal`.
    #[op2]
    #[serde]
    pub(crate) async fn op_authz_principal_set(
        state: Rc<RefCell<OpState>>,
        token: u32,
        #[serde] answer: Option<serde_json::Value>,
    ) -> Result<Option<serde_json::Value>, JsErrorBox> {
        let request = live_request(&state.borrow(), token)?;
        let (env, db_env) = env(&state);
        let sp = answer
            .and_then(|v| serde_json::from_value::<ServicePrincipal>(v).ok())
            .filter(|p| !p.id.is_empty());
        let principal = match (sp, db_env.db.clone()) {
            (Some(sp), Some(db)) => {
                let id = sp.id.clone();
                // At the start of the request: no transaction is open.
                let rows = db
                    .call(move |db| {
                        db.with_policy(None, || roles::list(db, &id))
                            .and_then(|r| r)
                    })
                    .await
                    .ok()
                    .and_then(Result::ok)
                    .unwrap_or_default();
                Principal {
                    id: sp.id,
                    kind: renox_authz::PrincipalKind::User,
                    roles: rows
                        .into_iter()
                        .map(|r| RoleAssignment {
                            role: r.role,
                            scope_type: r.scope_type,
                            scope_id: r.scope_id,
                        })
                        .collect(),
                    attrs: sp.attrs,
                }
            }
            (Some(sp), None) => Principal {
                id: sp.id,
                kind: renox_authz::PrincipalKind::User,
                roles: Vec::new(),
                attrs: sp.attrs,
            },
            (None, _) => Principal::anonymous(),
        };
        let p = Arc::new(principal);
        let key = {
            let mut r = request.borrow_mut();
            r.authz.principal = Some(p.clone());
            r.authz.cache_key.clone()
        };
        if let (Some(key), Some(st)) = (key, authz_state(&env))
            && p.kind == renox_authz::PrincipalKind::User
        {
            st.cache.put(key, p.clone());
        }
        Ok(principal_json(&p))
    }

    #[derive(Serialize)]
    pub(crate) struct GuardOut {
        allow: bool,
        reason: Option<String>,
        policy: Option<String>,
        action: Option<String>,
        resource: Option<serde_json::Value>,
    }

    /// Evaluates the route's `guard` (`ops.md` section 17, "`guard`").
    #[op2]
    #[serde]
    pub(crate) async fn op_authz_guard(
        state: Rc<RefCell<OpState>>,
        token: u32,
    ) -> Result<GuardOut, JsErrorBox> {
        let request = live_request(&state.borrow(), token)?;
        let (env, db_env) = env(&state);
        let route = request.borrow().authz.route;
        let Some(guard) = route.and_then(|r| env.guards.get(r).cloned().flatten()) else {
            return Ok(GuardOut {
                allow: true,
                reason: None,
                policy: None,
                action: None,
                resource: None,
            });
        };
        let owner = route
            .and_then(|r| env.owners.get(r).cloned())
            .unwrap_or_else(|| "app".into());
        let deny =
            |reason: &str, policy: Option<String>, resource: Option<serde_json::Value>| GuardOut {
                allow: false,
                reason: Some(reason.to_string()),
                policy,
                action: Some(guard.action.clone()),
                resource,
            };
        let Some(st) = authz_state(&env) else {
            return Ok(deny("evaluation_error", None, None));
        };
        st.decisions
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        if !count(&request) {
            return Ok(deny("eval_limit", None, None));
        }
        let module = (owner != "app").then_some(owner.as_str());
        // The resource, through its declaration, outside any transaction.
        let resource: Option<serde_json::Value> = match &guard.resource {
            None => None,
            Some(gr) => {
                let id = match gr.id.strip_prefix(':') {
                    Some(param) => request.borrow().authz.params.get(param).cloned(),
                    None => Some(gr.id.clone()),
                };
                let decl = st.engine.schema().resolve_type(module, &gr.ty).cloned();
                let reference = serde_json::json!({ "type": gr.ty, "id": id });
                let (Some(id), Some(decl), Some(db)) = (id, decl, db_env.db.clone()) else {
                    return Ok(deny("missing_attribute", None, Some(reference)));
                };
                let Some(table) = decl.decl.table.clone() else {
                    return Ok(deny("missing_attribute", None, Some(reference)));
                };
                let id_col = decl.decl.id.clone().unwrap_or_else(|| "id".into());
                let cols: Vec<String> = decl
                    .decl
                    .attrs
                    .iter()
                    .map(|a| format!("\"{}\"", a.replace('"', "\"\"")))
                    .collect();
                let sql = format!(
                    "select {} from \"{}\" where \"{}\" = ? limit 1",
                    if cols.is_empty() {
                        "1".to_string()
                    } else {
                        cols.join(", ")
                    },
                    table.replace('"', "\"\""),
                    id_col.replace('"', "\"\"")
                );
                let policy = db_env
                    .modules
                    .policy(module)
                    .ok()
                    .flatten()
                    .map(|p| Arc::new((*p).clone().with_scoped(true)));
                let deadline = request.borrow().deadline;
                let measured = db
                    .statement(
                        crate::ops::db::StmtKind::QueryOne,
                        sql,
                        vec![id.clone().into()],
                        None,
                        policy,
                        deadline,
                    )
                    .await;
                match measured.value {
                    Ok(crate::ops::db::StmtOut::Row(Some(row))) => {
                        let mut obj = serde_json::Map::new();
                        obj.insert("type".into(), gr.ty.clone().into());
                        obj.insert("id".into(), id.into());
                        for a in &decl.decl.attrs {
                            if let Some(v) = row.get(a) {
                                obj.insert(a.clone(), value_json(v));
                            }
                        }
                        Some(serde_json::Value::Object(obj))
                    }
                    _ => return Ok(deny("missing_attribute", None, Some(reference))),
                }
            }
        };
        let (principal, platform, tx) = {
            let r = request.borrow();
            (principal_of(&r), platform(&r), r.resources.db_tx)
        };
        let d = st.engine.check(
            &principal,
            &guard.action,
            resource.as_ref(),
            module,
            None,
            &platform,
        );
        if st.engine.is_sensitive(&guard.action)
            && let Some(db) = db_env.db.clone()
        {
            let _ = audit(
                &db,
                tx,
                &principal.id,
                &guard.action,
                resource_ref(resource.as_ref()),
                &d,
            )
            .await;
        }
        if d.allow {
            return Ok(GuardOut {
                allow: true,
                reason: None,
                policy: None,
                action: None,
                resource: None,
            });
        }
        let reference =
            resource_ref(resource.as_ref()).map(|(t, i)| serde_json::json!({ "type": t, "id": i }));
        Ok(deny(
            d.reason.as_str(),
            st.dev.then(|| d.policies.first().cloned()).flatten(),
            reference,
        ))
    }

    fn value_json(v: &renox_data::Value) -> serde_json::Value {
        match v {
            renox_data::Value::Null => serde_json::Value::Null,
            renox_data::Value::Integer(i) => (*i).into(),
            renox_data::Value::Real(f) => serde_json::Number::from_f64(*f)
                .map(Into::into)
                .unwrap_or(serde_json::Value::Null),
            renox_data::Value::Text(s) => s.clone().into(),
            renox_data::Value::Blob(_) => serde_json::Value::Null,
        }
    }

    #[derive(Serialize)]
    pub(crate) struct CheckOut {
        allow: bool,
        policy: Option<String>,
        reason: &'static str,
    }

    async fn check_one(
        state: &Rc<RefCell<OpState>>,
        token: u32,
        action: &str,
        resource: Option<&serde_json::Value>,
        context: Option<&serde_json::Map<String, serde_json::Value>>,
        module: Option<&str>,
        enforce: bool,
    ) -> Result<(Decision, bool), JsErrorBox> {
        let request = live_request(&state.borrow(), token)?;
        let (env, db_env) = env(state);
        let Some(st) = authz_state(&env) else {
            return Ok((
                Decision {
                    allow: false,
                    policies: Vec::new(),
                    reason: Reason::EvaluationError(vec!["no policies loaded".into()]),
                },
                false,
            ));
        };
        st.decisions
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        // r-can / can with a resource: one evaluation per (action, id) per request.
        let first = match resource_ref(resource) {
            Some((t, i)) if !enforce => request
                .borrow_mut()
                .authz
                .seen
                .insert((action.to_string(), format!("{t}:{i}"))),
            _ => true,
        };
        if first && !count(&request) {
            return Ok((
                Decision {
                    allow: false,
                    policies: Vec::new(),
                    reason: Reason::Deny,
                },
                true,
            ));
        }
        let (principal, platform, tx) = {
            let r = request.borrow();
            (principal_of(&r), platform(&r), r.resources.db_tx)
        };
        let d = st
            .engine
            .check(&principal, action, resource, module, context, &platform);
        if enforce
            && st.engine.is_sensitive(action)
            && let Some(db) = db_env.db.clone()
        {
            audit(&db, tx, &principal.id, action, resource_ref(resource), &d)
                .await
                .map_err(|e| {
                    op_error(
                        e.code(),
                        serde_json::Value::Null,
                        "the audit row could not be written",
                    )
                })?;
        }
        Ok((d, false))
    }

    /// `ctx.authz.require` (`enforce`), `can`.
    #[op2]
    #[serde]
    pub(crate) async fn op_authz_check(
        state: Rc<RefCell<OpState>>,
        token: u32,
        #[string] action: String,
        #[serde] resource: Option<serde_json::Value>,
        #[serde] context: Option<serde_json::Map<String, serde_json::Value>>,
        #[string] module: Option<String>,
        enforce: bool,
    ) -> Result<CheckOut, JsErrorBox> {
        let module = module.filter(|m| m != "app");
        let (d, limited) = check_one(
            &state,
            token,
            &action,
            resource.as_ref(),
            context.as_ref(),
            module.as_deref(),
            enforce,
        )
        .await?;
        let (env, _) = env(&state);
        let dev = authz_state(&env).is_some_and(|s| s.dev);
        let reason = if limited {
            "eval_limit"
        } else {
            d.reason.as_str()
        };
        let policy = dev.then(|| d.policies.first().cloned()).flatten();
        if enforce && !d.allow {
            let r = resource_ref(resource.as_ref());
            return Err(forbidden(
                &action,
                r.as_ref().map(|(a, b)| (a.as_str(), b.as_str())),
                reason,
                policy.as_deref(),
            ));
        }
        Ok(CheckOut {
            allow: d.allow,
            policy,
            reason,
        })
    }

    /// `ctx.authz.canBatch`: one boolean per resource, at most 1,000.
    #[op2]
    #[serde]
    pub(crate) async fn op_authz_check_batch(
        state: Rc<RefCell<OpState>>,
        token: u32,
        #[string] action: String,
        #[serde] resources: Vec<serde_json::Value>,
        #[serde] context: Option<serde_json::Map<String, serde_json::Value>>,
        #[string] module: Option<String>,
    ) -> Result<Vec<bool>, JsErrorBox> {
        if resources.len() > MAX_BATCH {
            return Err(JsErrorBox::range_error(format!(
                "canBatch: at most {MAX_BATCH} resources"
            )));
        }
        let module = module.filter(|m| m != "app");
        let mut out = Vec::with_capacity(resources.len());
        for r in &resources {
            let (d, _) = check_one(
                &state,
                token,
                &action,
                Some(r),
                context.as_ref(),
                module.as_deref(),
                false,
            )
            .await?;
            out.push(d.allow);
        }
        Ok(out)
    }

    #[derive(Serialize)]
    pub(crate) struct ExplainOut {
        decision: &'static str,
        reasons: Vec<String>,
        errors: Vec<String>,
        text: String,
    }

    /// `ctx.authz.explain`: dev mode only.
    #[op2]
    #[serde]
    pub(crate) async fn op_authz_explain(
        state: Rc<RefCell<OpState>>,
        token: u32,
        #[string] action: String,
        #[serde] resource: Option<serde_json::Value>,
        #[serde] context: Option<serde_json::Map<String, serde_json::Value>>,
        #[string] module: Option<String>,
    ) -> Result<ExplainOut, JsErrorBox> {
        let request = live_request(&state.borrow(), token)?;
        let (env, _) = env(&state);
        let st = authz_state(&env)
            .filter(|s| s.dev)
            .ok_or_else(|| forbidden(&action, None, "dev_only", None))?;
        let module = module.filter(|m| m != "app");
        let (principal, platform) = {
            let r = request.borrow();
            (principal_of(&r), platform(&r))
        };
        let x = st.engine.explain(
            &principal,
            &action,
            resource.as_ref(),
            module.as_deref(),
            context.as_ref(),
            &platform,
        );
        Ok(ExplainOut {
            decision: x.decision,
            reasons: x.reasons.clone(),
            errors: x.errors.clone(),
            text: x.text(),
        })
    }

    fn request_tx(request: &Rc<RefCell<RequestState>>, tx: u32) -> Result<Option<u32>, JsErrorBox> {
        if tx == 0 {
            return Ok(None);
        }
        if request.borrow().resources.db_tx == Some(tx) {
            Ok(Some(tx))
        } else {
            Err(op_error(
                "RENOX_DB_TX_STATE",
                serde_json::Value::Null,
                "the transaction is not open",
            ))
        }
    }

    #[derive(Deserialize)]
    pub(crate) struct RoleArgs {
        user_id: String,
        role: String,
        #[serde(default)]
        scope_type: Option<String>,
        #[serde(default)]
        scope_id: Option<String>,
    }

    /// Assign (`assign: true`) or revoke one role; emits the durable
    /// platform event `authz.roles_changed` in the same transaction.
    async fn change_role(
        state: Rc<RefCell<OpState>>,
        token: u32,
        args: RoleArgs,
        module: Option<String>,
        tx: u32,
        assign: bool,
    ) -> Result<bool, JsErrorBox> {
        let request = live_request(&state.borrow(), token)?;
        let (env, db_env) = env(&state);
        let module = module.filter(|m| m != "app");
        let allowed: Option<BTreeSet<String>> = module.as_ref().map(|m| {
            authz_state(&env)
                .and_then(|s| s.module_roles.get(m).cloned())
                .unwrap_or_default()
        });
        if let Some(a) = &allowed
            && !a.contains(&args.role)
        {
            return Err(op_error(
                "RENOX_MODULE_UNDECLARED",
                serde_json::json!({ "module": module, "target": format!("role:{}", args.role) }),
                &format!(
                    "module {} may not assign the role {}",
                    module.as_deref().unwrap_or("app"),
                    args.role
                ),
            ));
        }
        let tx = request_tx(&request, tx)?;
        let Some(db) = db_env.db.clone() else {
            return Err(op_error(
                "RENOX_DB_SQL",
                serde_json::Value::Null,
                "no database",
            ));
        };
        let scope_type = args.scope_type.unwrap_or_else(|| "global".into());
        let scope_id = if scope_type == "global" {
            None
        } else {
            args.scope_id
        };
        let granted_by = {
            let r = request.borrow();
            let p = principal_of(&r);
            if p.kind == renox_authz::PrincipalKind::System {
                format!("system:{}", p.id)
            } else {
                p.id.clone()
            }
        };
        let ev = renox_data::outbox::OutboxEvent {
            id: crate::ops::events::ulid(),
            name: "authz.roles_changed".into(),
            payload: serde_json::json!({
                "user_id": args.user_id, "role": args.role, "scope_type": scope_type, "scope_id": scope_id,
                "op": if assign { "assign" } else { "revoke" },
            })
            .to_string(),
            module: renox_data::PLATFORM_MODULE.into(),
            created_at: now_ms(),
        };
        let a = roles::RoleAssignment::new(
            &args.user_id,
            &args.role,
            &scope_type,
            scope_id.as_deref(),
            &granted_by,
            now_ms(),
        );
        let changed = db
            .call_tx(tx, move |db, t| {
                let run = |t: &renox_data::Tx<'_>| -> Result<bool, renox_data::DbError> {
                    let changed = if assign {
                        db.with_policy(None, || roles::assign(t, &a, None))??
                    } else {
                        db.with_policy(None, || {
                            roles::revoke(
                                t,
                                &a.user_id,
                                &a.role,
                                &a.scope_type,
                                a.scope_id.as_deref(),
                                None,
                            )
                        })??
                    };
                    if changed {
                        renox_data::outbox::emit(db, t, &ev)?;
                    }
                    Ok(changed)
                };
                match t {
                    Some(t) => run(t),
                    None => db.transaction(|t| run(t)),
                }
            })
            .await
            .map_err(|e| op_error(e.code(), serde_json::Value::Null, &e.to_string()))?;
        Ok(changed)
    }

    #[op2]
    pub(crate) async fn op_authz_roles_assign(
        state: Rc<RefCell<OpState>>,
        token: u32,
        #[serde] args: RoleArgs,
        #[string] module: Option<String>,
        tx: u32,
    ) -> Result<(), JsErrorBox> {
        change_role(state, token, args, module, tx, true)
            .await
            .map(|_| ())
    }

    #[op2]
    pub(crate) async fn op_authz_roles_revoke(
        state: Rc<RefCell<OpState>>,
        token: u32,
        #[serde] args: RoleArgs,
        #[string] module: Option<String>,
        tx: u32,
    ) -> Result<bool, JsErrorBox> {
        change_role(state, token, args, module, tx, false).await
    }

    #[derive(Serialize)]
    pub(crate) struct RoleOut {
        user_id: String,
        role: String,
        scope_type: String,
        scope_id: Option<String>,
        granted_by: String,
        at: i64,
    }

    #[op2]
    #[serde]
    pub(crate) async fn op_authz_roles_list(
        state: Rc<RefCell<OpState>>,
        token: u32,
        #[string] user_id: String,
        #[string] _module: Option<String>,
    ) -> Result<Vec<RoleOut>, JsErrorBox> {
        let request = live_request(&state.borrow(), token)?;
        let (_, db_env) = env(&state);
        let Some(db) = db_env.db.clone() else {
            return Ok(Vec::new());
        };
        // In the request's transaction when one is open (the writer is held).
        let tx = request.borrow().resources.db_tx;
        let rows = db
            .call_tx(tx, move |db, t| match t {
                Some(t) => db.with_policy(None, || roles::list(t, &user_id))?,
                None => db.with_policy(None, || roles::list(db, &user_id))?,
            })
            .await
            .map_err(|e| op_error(e.code(), serde_json::Value::Null, &e.to_string()))?;
        Ok(rows
            .into_iter()
            .map(|r| RoleOut {
                user_id: r.user_id,
                role: r.role,
                scope_type: r.scope_type,
                scope_id: r.scope_id,
                granted_by: r.granted_by,
                at: r.at,
            })
            .collect())
    }
}
