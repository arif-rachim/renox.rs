//! The merged schema of a deployment (`ops.md` 1.5.0 section 17, "Cedar
//! entities and the merged schema"; `artifact.md` 1.3, "Policies", V24).
//!
//! The platform part (`Renox::User`, `Renox::Role`, `Renox::Anonymous`,
//! `Renox::System`, `Renox::Topic`, every action of the merged action set
//! and the `Renox::Action::"sensitive"` group) is generated here, one
//! namespace per owner is generated from its `authz.entities`, and the app's
//! `policies/schema.cedarschema` is merged in. A duplicate entity type or
//! action is an error, like any schema error.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;

use cedar_policy::{Schema, SchemaFragment};
use miette::Diagnostic;
use serde::Deserialize;

use crate::PolicyError;

/// The platform action every app may use without declaring it (`ops.md`
/// section 18, "Authorization: topics as Cedar resources").
pub const REALTIME_SUBSCRIBE: &str = "realtime.subscribe";

/// The file name errors in the generated part of the schema carry.
pub const GENERATED: &str = "<generated schema>";
/// Where the app's schema lives in the artifact.
pub const APP_SCHEMA: &str = "policies/schema.cedarschema";

/// Attributes of `Renox::User` the merged schema declares, with their
/// types: `id` (the principal id, always set by the platform, so a topic
/// policy can test `resource.segments.contains(principal.id)`, `ops.md`
/// section 18) and what `auth.principal` and the official fillers set (#291:
/// `email_verified`, `phone_verified`, `created_at`; `2fa`: `mfa_verified`;
/// `org`: `org`). A policy may only name these (strict validation); a
/// principal that lacks one a policy reads is an evaluation error, hence a
/// deny.
pub const USER_ATTRS: &[(&str, AttrType)] = &[
    ("created_at", AttrType::Long),
    ("email_verified", AttrType::Bool),
    ("id", AttrType::String),
    ("mfa_verified", AttrType::Bool),
    ("org", AttrType::String),
    ("phone_verified", AttrType::Bool),
];

/// The `authz` block of the app or of a module entry (`artifact.md` 1.3,
/// "Authorization and realtime"). `ownership` is `renox-data`'s.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct AuthzBlock {
    #[serde(default)]
    pub actions: Vec<String>,
    #[serde(default)]
    pub entities: BTreeMap<String, EntityDecl>,
    #[serde(default)]
    pub default_roles: BTreeMap<String, Vec<String>>,
    #[serde(default)]
    pub sensitive: Vec<String>,
}

/// One `[authz.entities]` entry.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct EntityDecl {
    #[serde(default)]
    pub table: Option<String>,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub attrs: Vec<String>,
}

/// The Cedar type of a declared attribute. The manifest names attributes
/// only; the caller supplies the types (the cell from the SQLite declared
/// type of the entity's table column), `String` when it does not know.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttrType {
    String,
    Long,
    Bool,
    /// A set of strings (a JSON array column, tags).
    StringSet,
}

impl AttrType {
    fn cedar(self) -> &'static str {
        match self {
            AttrType::String => "String",
            AttrType::Long => "Long",
            AttrType::Bool => "Bool",
            AttrType::StringSet => "Set<String>",
        }
    }

    /// From a SQLite declared column type, by SQLite's affinity rules:
    /// `INT` → `Long`, `BOOL` → `Bool`, everything else → `String` (a
    /// `REAL` column cannot be a Cedar attribute: floats are dropped).
    pub fn from_sqlite(decl: &str) -> AttrType {
        let d = decl.to_ascii_uppercase();
        if d.contains("BOOL") {
            AttrType::Bool
        } else if d.contains("INT") {
            AttrType::Long
        } else {
            AttrType::String
        }
    }
}

/// An owner of actions and entity types: the app (`"app"`) or a module.
#[derive(Debug, Clone, Default)]
pub struct Owner {
    pub name: String,
    pub authz: AuthzBlock,
    /// `type → attr → Cedar type` for the declared attributes; missing ones are `String`.
    pub attr_types: BTreeMap<String, BTreeMap<String, AttrType>>,
}

impl Owner {
    pub fn new(name: &str, authz: AuthzBlock) -> Owner {
        Owner {
            name: name.to_string(),
            authz,
            attr_types: BTreeMap::new(),
        }
    }

    pub fn with_type(mut self, entity: &str, attr: &str, ty: AttrType) -> Owner {
        self.attr_types
            .entry(entity.to_string())
            .or_default()
            .insert(attr.to_string(), ty);
        self
    }
}

/// `billing` → `Billing`, `app` → `App` (`ops.md` section 17).
pub fn namespace_of(owner: &str) -> String {
    let mut c = owner.chars();
    match c.next() {
        Some(f) => f.to_uppercase().chain(c).collect(),
        None => String::new(),
    }
}

/// A declared entity type: `<Namespace>::<Type>` with its attributes.
#[derive(Debug, Clone)]
pub struct EntityType {
    pub owner: String,
    pub name: String,
    pub cedar: String,
    pub decl: EntityDecl,
}

/// The validated schema and what the engine needs from it.
#[derive(Debug, Clone)]
pub struct MergedSchema {
    pub(crate) schema: Schema,
    /// The merged action set (the platform's `realtime.subscribe` included).
    pub actions: BTreeSet<String>,
    /// `[authz] sensitive` of every owner.
    pub sensitive: BTreeSet<String>,
    /// Declared entity types by `(owner, type)`.
    pub entities: BTreeMap<(String, String), EntityType>,
    /// Roles named by any `default_roles`.
    pub roles: BTreeSet<String>,
}

fn quote(s: &str) -> String {
    serde_json::to_string(s).expect("a string serialises")
}

impl MergedSchema {
    /// Generates the platform and owner schemas and merges the app's
    /// `policies/schema.cedarschema` (`app_schema`, optional). Every error
    /// is collected; nothing is half-built.
    pub fn build(
        owners: &[Owner],
        app_schema: Option<&str>,
    ) -> Result<MergedSchema, Vec<PolicyError>> {
        let mut errors = Vec::new();
        let mut actions: BTreeMap<String, String> = BTreeMap::new();
        let mut sensitive = BTreeSet::new();
        let mut roles = BTreeSet::new();
        let mut entities = BTreeMap::new();
        let err = |message: String| PolicyError {
            file: GENERATED.into(),
            line: 0,
            column: 0,
            message,
        };
        // The app's schema first: the entity types it declares itself are
        // not generated again (its `authz.entities` may name them).
        let mut app_declared: BTreeSet<String> = BTreeSet::new();
        let mut app_actions: BTreeSet<String> = BTreeSet::new();
        let app_fragment = match app_schema {
            None => None,
            Some(text) => match SchemaFragment::from_cedarschema_str(text) {
                Ok((fragment, _)) => {
                    if let Ok(json) = fragment.clone().to_json_value()
                        && let Some(nss) = json.as_object()
                    {
                        {
                            for (ns, body) in nss {
                                let prefix = if ns.is_empty() {
                                    String::new()
                                } else {
                                    format!("{ns}::")
                                };
                                for t in body["entityTypes"]
                                    .as_object()
                                    .into_iter()
                                    .flatten()
                                    .map(|(k, _)| k)
                                {
                                    app_declared.insert(format!("{prefix}{t}"));
                                }
                                for a in body["actions"]
                                    .as_object()
                                    .into_iter()
                                    .flatten()
                                    .map(|(k, _)| k)
                                {
                                    app_actions.insert(a.clone());
                                }
                            }
                        }
                    }
                    Some(fragment)
                }
                Err(e) => {
                    errors.push(PolicyError::from_diagnostic(APP_SCHEMA, text, &e));
                    None
                }
            },
        };
        for a in &app_actions {
            errors.push(PolicyError {
                file: APP_SCHEMA.into(),
                line: 0,
                column: 0,
                message: format!("the app's schema declares the action {a:?}; actions are declared in [authz] actions"),
            });
        }
        for owner in owners {
            for a in &owner.authz.actions {
                if a == REALTIME_SUBSCRIBE {
                    errors.push(err(format!(
                        "{}: {REALTIME_SUBSCRIBE:?} is a platform action and cannot be declared",
                        owner.name
                    )));
                } else if let Some(prev) = actions.insert(a.clone(), owner.name.clone()) {
                    errors.push(err(format!(
                        "duplicate action {a:?}: declared by {prev} and {}",
                        owner.name
                    )));
                }
            }
            for s in &owner.authz.sensitive {
                if !owner.authz.actions.contains(s) {
                    errors.push(err(format!(
                        "{}: sensitive action {s:?} is not one of its actions",
                        owner.name
                    )));
                }
                sensitive.insert(s.clone());
            }
            roles.extend(owner.authz.default_roles.keys().cloned());
            let ns = namespace_of(&owner.name);
            for (ty, decl) in &owner.authz.entities {
                entities.insert(
                    (owner.name.clone(), ty.clone()),
                    EntityType {
                        owner: owner.name.clone(),
                        name: ty.clone(),
                        cedar: format!("{ns}::{ty}"),
                        decl: decl.clone(),
                    },
                );
            }
        }
        for owner in owners {
            for (role, granted) in &owner.authz.default_roles {
                for a in granted {
                    if !actions.contains_key(a) && a != REALTIME_SUBSCRIBE {
                        errors.push(err(format!(
                            "{}: role {role:?} names the unknown action {a:?}",
                            owner.name
                        )));
                    }
                }
            }
        }
        // The generated text: the platform namespace, then one per owner.
        let mut text = String::from("namespace Renox {\n  entity Role;\n");
        let user_attrs: Vec<String> = USER_ATTRS
            .iter()
            .map(|(k, t)| format!("{}: {}", quote(k), t.cedar()))
            .collect();
        let _ = writeln!(
            text,
            "  entity User in [Role] = {{ {} }};",
            user_attrs.join(", ")
        );
        text.push_str("  entity Anonymous;\n  entity System;\n");
        // The type-checking stand-in for a request without a resource: the
        // request itself names `Renox::Action::"<action>"` (section 17), a
        // type a Cedar schema cannot list as a resource.
        text.push_str("  entity Global;\n");
        text.push_str("  entity Topic = { \"name\": String, \"segments\": Set<String> };\n");
        text.push_str("  type Request = { \"method\": String, \"path\": String };\n");
        text.push_str(
            "  type Context = { \"mfa_verified\": Bool, \"now\": Long, \"request\"?: Request };\n",
        );
        text.push_str("  action \"sensitive\";\n");
        let mut resources: Vec<String> = entities.values().map(|e| e.cedar.clone()).collect();
        resources.push("Renox::Global".into());
        for a in actions.keys() {
            let group = if sensitive.contains(a) {
                " in [\"sensitive\"]"
            } else {
                ""
            };
            let _ = writeln!(
                text,
                "  action {}{group} appliesTo {{ principal: [User, Anonymous, System], resource: [{}], context: Context }};",
                quote(a),
                resources.join(", ")
            );
        }
        let _ = writeln!(
            text,
            "  action {} appliesTo {{ principal: [User, Anonymous, System], resource: [Topic], context: Context }};",
            quote(REALTIME_SUBSCRIBE)
        );
        text.push_str("}\n");
        let mut by_ns: BTreeMap<String, Vec<&EntityType>> = BTreeMap::new();
        for e in entities.values() {
            if !app_declared.contains(&e.cedar) {
                by_ns.entry(namespace_of(&e.owner)).or_default().push(e);
            }
        }
        for (ns, types) in by_ns {
            let _ = writeln!(text, "namespace {ns} {{");
            for e in types {
                let owner = owners.iter().find(|o| o.name == e.owner);
                let attrs: Vec<String> = e
                    .decl
                    .attrs
                    .iter()
                    .map(|a| {
                        let ty = owner
                            .and_then(|o| o.attr_types.get(&e.name))
                            .and_then(|m| m.get(a))
                            .copied()
                            .unwrap_or(AttrType::String);
                        format!("{}: {}", quote(a), ty.cedar())
                    })
                    .collect();
                let _ = writeln!(text, "  entity {} = {{ {} }};", e.name, attrs.join(", "));
            }
            text.push_str("}\n");
        }
        let generated = match SchemaFragment::from_cedarschema_str(&text) {
            Ok((f, _)) => Some(f),
            Err(e) => {
                errors.push(PolicyError::from_diagnostic(GENERATED, &text, &e));
                None
            }
        };
        if !errors.is_empty() {
            return Err(errors);
        }
        let fragments = generated.into_iter().chain(app_fragment);
        let schema = Schema::from_schema_fragments(fragments).map_err(|e| {
            vec![PolicyError {
                file: if app_schema.is_some() {
                    APP_SCHEMA.into()
                } else {
                    GENERATED.into()
                },
                line: 0,
                column: 0,
                message: diagnostic_text(&e),
            }]
        })?;
        let mut actions: BTreeSet<String> = actions.into_keys().collect();
        actions.insert(REALTIME_SUBSCRIBE.into());
        Ok(MergedSchema {
            schema,
            actions,
            sensitive,
            entities,
            roles,
        })
    }

    /// The entity type a `ResourceRef.type` names for a call through
    /// `module`'s `ctx` (`None`: the app): `"Invoice"` is the owner's own
    /// type, `"billing:Invoice"` a module's type named by the app.
    pub fn resolve_type(&self, module: Option<&str>, ty: &str) -> Option<&EntityType> {
        let (owner, name) = match ty.split_once(':') {
            Some((m, t)) if module.is_none() => (m.to_string(), t),
            Some(_) => return None,
            None => (module.unwrap_or("app").to_string(), ty),
        };
        self.entities.get(&(owner, name.to_string()))
    }
}

/// The message and its help, without a source excerpt.
pub(crate) fn diagnostic_text(d: &(dyn Diagnostic + 'static)) -> String {
    let mut out = d.to_string();
    let mut src = std::error::Error::source(d);
    while let Some(s) = src {
        let t = s.to_string();
        if !out.contains(&t) {
            out.push_str(": ");
            out.push_str(&t);
        }
        src = s.source();
    }
    if let Some(help) = d.help() {
        out.push_str(" (");
        out.push_str(&help.to_string());
        out.push(')');
    }
    out
}
