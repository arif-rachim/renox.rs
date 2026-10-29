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
}

impl ModuleRegistry {
    /// From the manifest's `modules` field. Absent or `{}` (artifact
    /// versions 0 and 1) means no module; an array (1.1) is the module list.
    /// Each entry's enforcement data is checked here, and a bad entry fails
    /// the deployment (fail closed): a valid name, its own table prefix,
    /// prefixed secrets, a parsable network list, dependencies listed
    /// before it, and no `isolate` mode (not in F4, `ops.md` Open 7).
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
            let policy = AuthorizerPolicy::module(name.as_str())
                .with_read_deps(info.dependencies.iter().cloned());
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
            if info.isolation == "isolate" {
                return Err(format!(
                    "module {name}: isolation \"isolate\" is not available yet"
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

    pub fn modules(&self) -> &[ModuleInfo] {
        &self.modules
    }

    pub fn is_empty(&self) -> bool {
        self.modules.is_empty()
    }

    pub fn get(&self, name: &str) -> Option<&ModuleInfo> {
        self.modules.iter().find(|m| m.name == name)
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
