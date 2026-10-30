//! The principal and the conversion of values to Cedar (`ops.md` 1.5.0
//! section 17, "Cedar entities and the merged schema").

use std::collections::{HashMap, HashSet};
use std::str::FromStr;

use cedar_policy::{Entity, EntityId, EntityTypeName, EntityUid, RestrictedExpression};
use serde::{Deserialize, Serialize};

/// `user`: a signed-in end user; `system`: a module's event handler or job
/// (`Renox::System::"<module>"`). The anonymous principal is
/// [`Principal::anonymous`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Hash)]
#[serde(rename_all = "lowercase")]
pub enum PrincipalKind {
    User,
    System,
    Anonymous,
}

/// One row of `renox__role_assignments` as the principal carries it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Hash)]
pub struct RoleAssignment {
    pub role: String,
    pub scope_type: String,
    #[serde(default)]
    pub scope_id: Option<String>,
}

/// The principal of a request, as the cell resolved it (`ops.md` section
/// 17, "Principal"). Tenant code never supplies it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Principal {
    pub id: String,
    pub kind: PrincipalKind,
    #[serde(default)]
    pub roles: Vec<RoleAssignment>,
    #[serde(default)]
    pub attrs: serde_json::Map<String, serde_json::Value>,
}

impl Principal {
    /// `Renox::Anonymous::"anonymous"`: no roles, no attributes.
    pub fn anonymous() -> Principal {
        Principal {
            id: "anonymous".into(),
            kind: PrincipalKind::Anonymous,
            roles: Vec::new(),
            attrs: Default::default(),
        }
    }

    /// `Renox::System::"<module>"` (`app` for the app's own jobs).
    pub fn system(module: &str) -> Principal {
        Principal {
            id: module.into(),
            kind: PrincipalKind::System,
            roles: Vec::new(),
            attrs: Default::default(),
        }
    }

    pub fn user(id: &str) -> Principal {
        Principal {
            id: id.into(),
            kind: PrincipalKind::User,
            roles: Vec::new(),
            attrs: Default::default(),
        }
    }

    pub fn with_role(mut self, role: &str, scope_type: &str, scope_id: Option<&str>) -> Principal {
        self.roles.push(RoleAssignment {
            role: role.into(),
            scope_type: scope_type.into(),
            scope_id: scope_id.map(str::to_string),
        });
        self
    }

    pub fn with_attr(mut self, key: &str, value: serde_json::Value) -> Principal {
        self.attrs.insert(key.into(), value);
        self
    }

    /// The roles in effect: a `global` assignment always; any other while
    /// the attribute named by its `scope_type` equals its `scope_id`.
    pub fn roles_in_effect(&self) -> Vec<&str> {
        let mut out: Vec<&str> = self
            .roles
            .iter()
            .filter(|r| {
                r.scope_type == "global"
                    || match (&r.scope_id, self.attrs.get(&r.scope_type)) {
                        (Some(id), Some(serde_json::Value::String(v))) => id == v,
                        (Some(id), Some(serde_json::Value::Number(n))) => id == &n.to_string(),
                        _ => false,
                    }
            })
            .map(|r| r.role.as_str())
            .collect();
        out.sort_unstable();
        out.dedup();
        out
    }

    /// `true` only when `attrs.mfa_verified` is the boolean `true`.
    pub fn mfa_verified(&self) -> bool {
        self.attrs.get("mfa_verified") == Some(&serde_json::Value::Bool(true))
    }

    pub(crate) fn uid(&self) -> EntityUid {
        match self.kind {
            PrincipalKind::User => uid("Renox::User", &self.id),
            PrincipalKind::System => uid("Renox::System", &self.id),
            PrincipalKind::Anonymous => uid("Renox::Anonymous", "anonymous"),
        }
    }

    /// The principal entity and its role entities.
    pub(crate) fn entities(&self) -> Vec<Entity> {
        let me = self.uid();
        if self.kind != PrincipalKind::User {
            return vec![Entity::new_no_attrs(me, HashSet::new())];
        }
        let roles: Vec<&str> = self.roles_in_effect();
        let parents: HashSet<EntityUid> = roles.iter().map(|r| uid("Renox::Role", r)).collect();
        let mut attrs: HashMap<String, RestrictedExpression> = self
            .attrs
            .iter()
            .filter_map(|(k, v)| to_cedar(v).map(|e| (k.clone(), e)))
            .collect();
        // `principal.id` is the platform's, whatever `attrs` says.
        attrs.insert(
            "id".into(),
            RestrictedExpression::new_string(self.id.clone()),
        );
        let user = Entity::new(me.clone(), attrs, parents.clone())
            .unwrap_or_else(|_| Entity::new_no_attrs(me, parents.clone()));
        let mut out = vec![user];
        out.extend(
            parents
                .into_iter()
                .map(|p| Entity::new_no_attrs(p, HashSet::new())),
        );
        out
    }

    /// A stable hash of everything a decision depends on (cache key).
    pub(crate) fn fingerprint(&self) -> u64 {
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        self.id.hash(&mut h);
        self.kind.hash(&mut h);
        self.roles_in_effect().hash(&mut h);
        serde_json::to_string(&self.attrs)
            .unwrap_or_default()
            .hash(&mut h);
        h.finish()
    }
}

pub(crate) fn uid(ty: &str, id: &str) -> EntityUid {
    EntityUid::from_type_name_and_id(
        EntityTypeName::from_str(ty).expect("a valid entity type name"),
        EntityId::new(id),
    )
}

/// JSON → Cedar: string, boolean, integer → `Long`, array → `Set`, object
/// → record; floats and `null` are dropped (`None`), inside sets and
/// records too.
pub(crate) fn to_cedar(v: &serde_json::Value) -> Option<RestrictedExpression> {
    use serde_json::Value;
    match v {
        Value::Null => None,
        Value::Bool(b) => Some(RestrictedExpression::new_bool(*b)),
        Value::Number(n) => n.as_i64().map(RestrictedExpression::new_long),
        Value::String(s) => Some(RestrictedExpression::new_string(s.clone())),
        Value::Array(a) => Some(RestrictedExpression::new_set(a.iter().filter_map(to_cedar))),
        Value::Object(o) => RestrictedExpression::new_record(
            o.iter()
                .filter_map(|(k, v)| to_cedar(v).map(|e| (k.clone(), e))),
        )
        .ok(),
    }
}
