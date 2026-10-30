//! The installed modules of a deployment (`docs/contracts/ops.md` 1.3.0,
//! section 15; `artifact.md` section 3, "Modules"): parsed from the
//! artifact's `modules` field, they give every op that acts for a module
//! its enforcement data. One enforcement point per resource, in Rust:
//!
//! | Resource | Where |
//! | --- | --- |
//! | Tables | [`ModuleRegistry::policy`]: the module's authorizer (`module(m).with_read_deps(deps)`) for each statement (`ops/db.rs`) |
//! | Secrets | [`ModuleRegistry::secret_names`]: `op_secrets_get_all(module)` returns only those (`ops/secrets.rs`) |
//! | Network | [`ModuleRegistry::allowlist`]: `op_renox_fetch` checks the module's own list (`ops/fetch.rs`) |
//!
//! A module name that is neither `app` nor installed is refused by each of
//! them. The broker itself (service calls, hooks) is JavaScript in the
//! bootstrap; it never widens what these give.
//!
//! Pure Rust (no V8): the module list is checked by tests without an isolate.

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use renox_data::AuthorizerPolicy;
use serde::{Deserialize, Serialize};

use crate::ops::net_policy::Allowlist;

/// The app's own module name (`app__*` tables, `ops.md` section 0).
pub const APP: &str = "app";

/// What a module may use: the lock's approved permissions as the artifact
/// carries them (`artifact.md` V22: never more than approved).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModulePermissions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tables: Option<String>,
    #[serde(default)]
    pub network: Vec<String>,
    #[serde(default)]
    pub secrets: Vec<String>,
    #[serde(default)]
    pub slots: Vec<String>,
    #[serde(default)]
    pub hooks: Vec<String>,
}

/// A module's public API (`artifact.md` section 3, "Modules", `exports`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ModuleExports {
    #[serde(default)]
    pub services: Vec<String>,
    /// Event name → payload schema.
    #[serde(default)]
    pub events: BTreeMap<String, serde_json::Value>,
    #[serde(default)]
    pub hooks: Vec<String>,
    #[serde(default)]
    pub views: Vec<String>,
}

/// One installed module as the bootstrap receives it (`ops.schema.json`
/// `$defs/moduleInfo`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ModuleInfo {
    pub name: String,
    #[serde(default = "shared")]
    pub isolation: String,
    #[serde(default)]
    pub dependencies: Vec<String>,
    #[serde(default)]
    pub config: serde_json::Map<String, serde_json::Value>,
    pub permissions: ModulePermissions,
    #[serde(default)]
    pub exports: ModuleExports,
    /// Artifact 1.3: the module's `authz` block (`ownership` is read here;
    /// the rest by `renox-authz`, built by the cell).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authz: Option<serde_json::Value>,
}

/// `authz.ownership` of an `authz` block (`ops.md` 1.5.0 section 17).
pub fn ownership_of(authz: Option<&serde_json::Value>) -> renox_data::Ownership {
    let mut own = renox_data::Ownership::new();
    if let Some(map) = authz
        .and_then(|a| a.get("ownership"))
        .and_then(|o| o.as_object())
    {
        for (table, v) in map {
            if let Some(owner) = v.get("owner").and_then(|o| o.as_str()) {
                own.insert(table, owner, v.get("org").and_then(|o| o.as_str()));
            }
        }
    }
    own
}

fn shared() -> String {
    "shared".into()
}

/// The modules of one deployment, in the artifact's (topological) order.
#[derive(Debug, Default)]
pub struct ModuleRegistry {
    modules: Vec<ModuleInfo>,
    /// The app's policy when modules are installed: `app__*` plus the
    /// public views of every installed module (`ops.md` 1.3.0 section 1).
    app_policy: Option<Arc<AuthorizerPolicy>>,
    policies: HashMap<String, Arc<AuthorizerPolicy>>,
    allowlists: HashMap<String, Arc<Allowlist>>,
    /// Owned tables (`[authz.ownership]`) of the app (`app`) and each module.
    ownership: HashMap<String, Arc<renox_data::Ownership>>,
}

impl ModuleRegistry {
    /// From the manifest's `modules` field. Absent or `{}` (artifact
    /// versions 0 and 1) means no module; an array (1.1) is the module list.
    /// Each entry's enforcement data is checked here, and a bad entry fails
    /// the deployment (fail closed): a valid name, its own table prefix,
    /// prefixed secrets, a parsable network list, dependencies listed
    /// before it, and an isolation of `shared` or `isolate` (ops.md 1.7.0
    /// section 15.6, #320).
    pub fn from_manifest(modules: Option<&serde_json::Value>) -> Result<ModuleRegistry, String> {
        let list: Vec<serde_json::Value> = match modules {
            None => Vec::new(),
            Some(serde_json::Value::Object(m)) if m.is_empty() => Vec::new(),
            Some(serde_json::Value::Array(a)) => a.clone(),
            Some(_) => return Err("modules must be an array".into()),
        };
        let mut reg = ModuleRegistry::default();
        for raw in list {
            // `permissions` is what runs (V22: the artifact never carries more than `approved`).
            let info: ModuleInfo =
                serde_json::from_value(raw).map_err(|e| format!("modules: {e}"))?;
            let name = info.name.clone();
            let owned = ownership_of(info.authz.as_ref());
            // ops.md 1.5.0 section 17: module code reaching an owned table
            // without db.scoped() is refused (RENOX_DB_SCOPE, unscoped).
            let policy = AuthorizerPolicy::module(name.as_str())
                .with_read_deps(info.dependencies.iter().cloned())
                .with_owned(owned.tables().map(str::to_string).collect::<Vec<_>>());
            reg.ownership.insert(name.clone(), Arc::new(owned));
            policy
                .validate()
                .map_err(|e| format!("module {name}: {e}"))?;
            if name == APP || name == renox_data::PLATFORM_MODULE {
                return Err(format!("module name {name} is reserved"));
            }
            if reg.policies.contains_key(&name) {
                return Err(format!("module {name} is listed twice"));
            }
            if let Some(dep) = info
                .dependencies
                .iter()
                .find(|d| !reg.policies.contains_key(d.as_str()))
            {
                return Err(format!(
                    "module {name} is listed before its dependency {dep}"
                ));
            }
            if let Some(t) = &info.permissions.tables
                && *t != format!("{name}__*")
            {
                return Err(format!("module {name}: tables {t} is not {name}__*"));
            }
            if let Some(s) = info
                .permissions
                .secrets
                .iter()
                .find(|s| !s.starts_with(&format!("{}_", name.to_uppercase())))
            {
                return Err(format!(
                    "module {name}: secret {s} is not prefixed {}_",
                    name.to_uppercase()
                ));
            }
            if info.isolation != "shared" && info.isolation != "isolate" {
                return Err(format!(
                    "module {name}: isolation {:?} is neither \"shared\" nor \"isolate\"",
                    info.isolation
                ));
            }
            let allowlist = Allowlist::parse(&info.permissions.network)
                .map_err(|e| format!("module {name}: {e}"))?;
            reg.policies.insert(name.clone(), Arc::new(policy));
            reg.allowlists.insert(name.clone(), Arc::new(allowlist));
            reg.modules.push(info);
        }
        if !reg.modules.is_empty() {
            reg.app_policy = Some(Arc::new(
                AuthorizerPolicy::module(APP)
                    .with_read_deps(reg.modules.iter().map(|m| m.name.clone())),
            ));
        }
        Ok(reg)
    }

    /// Artifact 1.3: the app's own `authz` block (its owned tables are
    /// fenced by `db.scoped()`; the app is never refused unscoped, D16).
    pub fn with_app_authz(mut self, authz: Option<&serde_json::Value>) -> ModuleRegistry {
        self.ownership
            .insert(APP.into(), Arc::new(ownership_of(authz)));
        self
    }

    /// The owned tables `db.scoped()` fences for `module` (`None`: the app).
    pub fn ownership(&self, module: Option<&str>) -> Arc<renox_data::Ownership> {
        self.ownership
            .get(module.unwrap_or(APP))
            .cloned()
            .unwrap_or_default()
    }

    pub fn modules(&self) -> &[ModuleInfo] {
        &self.modules
    }

    pub fn is_empty(&self) -> bool {
        self.modules.is_empty()
    }

    /// Whether module `module` is installed and exports the service `name`.
    pub fn exports_service(&self, module: &str, name: &str) -> bool {
        self.get(module)
            .is_some_and(|m| m.exports.services.iter().any(|s| s == name))
    }

    pub fn get(&self, name: &str) -> Option<&ModuleInfo> {
        self.modules.iter().find(|m| m.name == name)
    }

    /// Whether `name` is an installed module with `isolation = "isolate"`
    /// (ops.md 1.7.0 section 15.6): its code runs in an isolate of its own.
    pub fn is_isolated(&self, name: &str) -> bool {
        self.get(name).is_some_and(|m| m.isolation == "isolate")
    }

    /// `None` or `"app"`: the app (`Ok(None)` without modules: the handle's
    /// own policy; with modules, `app__*` plus every installed module's
    /// public views). An installed module: its policy. Anything else: an
    /// error (the op answers `RENOX_DB_PARAM`, `details.reason: "module"`).
    pub fn policy(&self, module: Option<&str>) -> Result<Option<Arc<AuthorizerPolicy>>, String> {
        match module {
            None | Some(APP) => Ok(self.app_policy.clone()),
            Some(m) => self
                .policies
                .get(m)
                .cloned()
                .map(Some)
                .ok_or_else(|| format!("unknown module {m:?}")),
        }
    }

    /// The module's own allowlist; `None` for the app (the caller uses the app's).
    pub fn allowlist(&self, module: &str) -> Result<Option<Arc<Allowlist>>, String> {
        match module {
            APP => Ok(None),
            m => self
                .allowlists
                .get(m)
                .cloned()
                .map(Some)
                .ok_or_else(|| format!("unknown module {m:?}")),
        }
    }

    /// The secret names a module may read; `None` for an unknown module.
    pub fn secret_names(&self, module: &str) -> Option<&[String]> {
        self.get(module).map(|m| m.permissions.secrets.as_slice())
    }

    /// The JSON list handed to the bootstrap's `harden` (`ops.md` section 11, step 3).
    pub fn to_json(&self) -> String {
        serde_json::to_string(&self.modules).unwrap_or_else(|_| "[]".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(name: &str, deps: &[&str]) -> serde_json::Value {
        serde_json::json!({
            "name": name, "version": "1.0.0", "hash": "0".repeat(64), "source": format!("path:modules/{name}"),
            "mount": format!("/{name}"), "isolation": "shared", "dependencies": deps, "config": {},
            "permissions": { "tables": format!("{name}__*"), "network": [], "secrets": [], "slots": [], "hooks": [] },
            "approved": { "tables": format!("{name}__*"), "network": [], "secrets": [], "slots": [], "hooks": [] },
            "exports": { "services": ["x"] }
        })
    }

    #[test]
    fn legacy_and_array_forms() {
        assert!(ModuleRegistry::from_manifest(None).unwrap().is_empty());
        assert!(
            ModuleRegistry::from_manifest(Some(&serde_json::json!({})))
                .unwrap()
                .is_empty()
        );
        let r = ModuleRegistry::from_manifest(Some(&serde_json::json!([
            entry("auth", &[]),
            entry("org", &["auth"])
        ])))
        .unwrap();
        assert_eq!(r.modules().len(), 2);
        assert_eq!(
            r.policy(Some("org")).unwrap().unwrap().read_deps,
            vec!["auth".to_string()]
        );
        assert_eq!(
            r.policy(None).unwrap().unwrap().read_deps,
            vec!["auth".to_string(), "org".to_string()]
        );
        assert_eq!(r.policy(Some("app")).unwrap().unwrap().module, "app");
        assert!(ModuleRegistry::default().policy(None).unwrap().is_none());
        assert!(r.policy(Some("billing")).is_err());
    }

    #[test]
    fn bad_lists_fail_closed() {
        for (list, why) in [
            (
                serde_json::json!([entry("org", &["auth"]), entry("auth", &[])]),
                "before its dependency",
            ),
            (
                serde_json::json!([entry("auth", &[]), entry("auth", &[])]),
                "twice",
            ),
            (serde_json::json!([entry("app", &[])]), "reserved"),
        ] {
            let e = ModuleRegistry::from_manifest(Some(&list)).unwrap_err();
            assert!(e.contains(why), "{e}");
        }
        let mut other = entry("auth", &[]);
        other["permissions"]["tables"] = "org__*".into();
        assert!(ModuleRegistry::from_manifest(Some(&serde_json::json!([other]))).is_err());
        let mut secret = entry("auth", &[]);
        secret["permissions"]["secrets"] = serde_json::json!(["STRIPE_KEY"]);
        assert!(ModuleRegistry::from_manifest(Some(&serde_json::json!([secret]))).is_err());
    }
}

#[cfg(feature = "v8")]
pub(crate) use span_ops::*;

#[cfg(feature = "v8")]
pub(crate) use cross_ops::*;

/// The most bytes of JSON that cross between isolates in one call, each way
/// (ops.md 1.7.0 section 15.6; *proposed*, Open 20).
pub const MAX_CROSS_BYTES: usize = 1024 * 1024;

/// `isolate` mode (ops.md 1.7.0 section 15.6, #320): a service call or a
/// hook filler run whose callee lives in another isolate of the deployment.
/// The bootstrap of the caller's isolate calls `op_modules_call`; the
/// deployment's pool (`isolate.rs`) runs it on the callee's isolate, with
/// the caller's request id, deadline, principal and open transaction, and
/// answers the structured clone (JSON) of the result.
#[cfg(feature = "v8")]
mod cross_ops {
    use std::cell::RefCell;
    use std::future::Future;
    use std::pin::Pin;
    use std::rc::Rc;
    use std::sync::Arc;
    use std::sync::atomic::Ordering;
    use std::time::Instant;

    use deno_core::{OpState, op2};
    use deno_error::JsErrorBox;

    use super::MAX_CROSS_BYTES;
    use crate::ops::request::{live_request, op_error};

    /// What crosses: a service (`<target>.<name>(...args)`) or the filler
    /// of hook `name` that module `target` provides.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum CrossKind {
        Service,
        Hook,
    }

    impl CrossKind {
        pub fn as_str(self) -> &'static str {
            match self {
                CrossKind::Service => "service",
                CrossKind::Hook => "hook",
            }
        }
    }

    /// One call into another isolate.
    #[derive(Debug, Clone)]
    pub struct CrossCall {
        pub kind: CrossKind,
        pub caller: String,
        pub target: String,
        pub name: String,
        /// A JSON array (a service) or value (a hook), at most [`MAX_CROSS_BYTES`].
        pub args_json: String,
        pub request_id: String,
        pub deadline: Instant,
        /// The caller's open transaction: the callee's statements join it.
        pub tx: Option<u32>,
        pub principal: Option<Arc<renox_authz::Principal>>,
    }

    /// How the call ended.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub enum CrossResult {
        /// The result as JSON.
        Ok(String),
        /// The callee threw; its code when it was a `RenoxError`.
        Threw { code: Option<String> },
        /// The result is over [`MAX_CROSS_BYTES`].
        TooLarge,
        /// No such service or filler in the callee's isolate.
        NoHandler,
        /// A platform error around the callee (its isolate could not be
        /// created, a limit, the deadline): the error code.
        Failed(String),
    }

    /// What the callee used: charged to the caller's request.
    #[derive(Debug, Clone, Copy, Default, PartialEq)]
    pub struct CrossUse {
        pub cpu_ms: f64,
        pub db_ms: f64,
        pub db_rows: u64,
        pub fetch_sent_bytes: u64,
        pub fetch_received_bytes: u64,
        pub fetch_blocked: u64,
        pub logs_dropped: u64,
        pub authz_evals: u64,
    }

    /// Runs a [`CrossCall`] on the callee's isolate (the deployment's pool).
    pub trait CrossCaller {
        fn call(&self, call: CrossCall) -> Pin<Box<dyn Future<Output = (CrossResult, CrossUse)>>>;
    }

    /// In every isolate's `OpState`.
    pub struct CrossEnv(pub Rc<dyn CrossCaller>);

    fn module_service_error(
        target: &str,
        name: &str,
        reason: Option<&str>,
        cause: Option<&str>,
    ) -> JsErrorBox {
        op_error(
            "RENOX_MODULE_SERVICE",
            serde_json::json!({ "module": target, "service": name, "reason": reason, "cause_code": cause }),
            &format!("{target}.{name} failed"),
        )
    }

    /// `op_modules_call(token, kind, caller, target, name, argsJson, tx)`:
    /// the JSON of the callee's result, or `RENOX_MODULE_SERVICE` (`details.reason`
    /// `too_large` past [`MAX_CROSS_BYTES`] either way; `cause_code` the
    /// callee's code when it threw a `RenoxError`).
    #[op2]
    #[string]
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn op_modules_call(
        state: Rc<RefCell<OpState>>,
        token: u32,
        #[string] kind: String,
        #[string] caller: String,
        #[string] target: String,
        #[string] name: String,
        #[string] args_json: String,
        tx: u32,
    ) -> Result<String, JsErrorBox> {
        let kind = match kind.as_str() {
            "service" => CrossKind::Service,
            "hook" => CrossKind::Hook,
            _ => return Err(module_service_error(&target, &name, Some("kind"), None)),
        };
        if args_json.len() > MAX_CROSS_BYTES {
            return Err(module_service_error(
                &target,
                &name,
                Some("too_large"),
                None,
            ));
        }
        let request = live_request(&state.borrow(), token)?;
        let caller_env = state.borrow().borrow::<CrossEnv>().0.clone();
        let call = {
            let r = request.borrow();
            CrossCall {
                kind,
                caller,
                target: target.clone(),
                name: name.clone(),
                args_json,
                request_id: r.request_id.clone(),
                deadline: r.deadline,
                // Only the request's own open transaction crosses.
                tx: (tx != 0 && r.resources.db_tx == Some(tx)).then_some(tx),
                principal: r.authz.principal.clone(),
            }
        };
        let (result, used) = caller_env.call(call).await;
        {
            let mut r = request.borrow_mut();
            r.cross_cpu_ms += used.cpu_ms;
            r.db_ms += used.db_ms;
            r.db_rows += used.db_rows;
            r.fetch_blocked += used.fetch_blocked;
            r.logs_dropped += used.logs_dropped;
            r.authz.evals += used.authz_evals;
            r.egress
                .sent
                .fetch_add(used.fetch_sent_bytes, Ordering::Relaxed);
            r.egress
                .received
                .fetch_add(used.fetch_received_bytes, Ordering::Relaxed);
        }
        match result {
            CrossResult::Ok(json) => Ok(json),
            CrossResult::TooLarge => Err(module_service_error(
                &target,
                &name,
                Some("too_large"),
                None,
            )),
            CrossResult::NoHandler => Err(module_service_error(
                &target,
                &name,
                Some("no_handler"),
                None,
            )),
            CrossResult::Threw { code } => Err(module_service_error(
                &target,
                &name,
                Some("threw"),
                code.as_deref(),
            )),
            CrossResult::Failed(code) => Err(module_service_error(
                &target,
                &name,
                Some("isolate"),
                Some(&code),
            )),
        }
    }
}

/// `module.service` spans (#295): services are brokered in the bootstrap's
/// JavaScript, so the bootstrap opens a span before calling a callee and
/// closes it after; the span is a child of the request's (`crate::trace`).
#[cfg(feature = "v8")]
mod span_ops {
    use std::cell::RefCell;
    use std::collections::HashMap;

    use deno_core::{OpState, op2};

    thread_local! {
        static OPEN: RefCell<(u32, HashMap<u32, tracing::Span>)> = RefCell::new((0, HashMap::new()));
    }

    #[op2(fast)]
    pub(crate) fn op_span_service_begin(
        state: &mut OpState,
        token: u32,
        #[string] caller: &str,
        #[string] callee: &str,
        #[string] name: &str,
    ) -> u32 {
        let request_id = state
            .borrow::<crate::ops::request::RequestTable>()
            .get(token)
            .map(|r| r.borrow().request_id.clone());
        let parent = request_id
            .as_deref()
            .map_or_else(tracing::Span::none, crate::trace::parent);
        let span = tracing::info_span!(parent: &parent, "module.service", caller = %caller, callee = %callee, name = %name);
        OPEN.with(|o| {
            let mut o = o.borrow_mut();
            o.0 = o.0.wrapping_add(1).max(1);
            let id = o.0;
            o.1.insert(id, span);
            id
        })
    }

    /// Closes the span `id` (dropping it ends it); an unknown id is ignored.
    #[op2(fast)]
    pub(crate) fn op_span_service_end(id: u32) {
        OPEN.with(|o| {
            o.borrow_mut().1.remove(&id);
        });
    }
}
