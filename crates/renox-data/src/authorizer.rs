//! SQLite authorizer per module prefix (ADR D13, `docs/06-data.md`,
//! "Layout inside a tenant file").
//!
//! SQLite calls the authorizer for every table, column, and action while it
//! compiles a statement, so a refused statement never runs. No SQL is parsed
//! in Rust.

use rusqlite::hooks::{AuthAction, AuthContext, Authorization};

use crate::error::{DbError, Result};

/// The module that owns the app's own tables (`app__*`, `docs/07-app-model.md`).
pub const APP_MODULE: &str = "app";
/// The platform: `renox__*` tables; a handle for it has no restrictions.
pub const PLATFORM_MODULE: &str = "renox";

/// What one module's connections may touch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthorizerPolicy {
    /// Tables, indexes, and views named `<module>__*` are the module's own.
    pub module: String,
    /// Modules whose `<dep>__public_*` views this module may read.
    pub read_deps: Vec<String>,
    /// Allow `create`/`alter`/`drop` of the module's own objects. Only the
    /// migration runner sets it.
    pub allow_ddl: bool,
}

impl AuthorizerPolicy {
    /// Policy for `module` with no dependencies and no DDL.
    pub fn module(module: impl Into<String>) -> Self {
        AuthorizerPolicy {
            module: module.into(),
            read_deps: Vec::new(),
            allow_ddl: false,
        }
    }

    pub fn with_read_deps<I, S>(mut self, deps: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.read_deps = deps.into_iter().map(Into::into).collect();
        self
    }

    pub fn with_ddl(mut self, allow_ddl: bool) -> Self {
        self.allow_ddl = allow_ddl;
        self
    }

    /// The platform policy needs no authorizer.
    pub fn is_platform(&self) -> bool {
        self.module == PLATFORM_MODULE
    }

    /// Module names follow the artifact contract (`^[a-z][a-z0-9_]{0,31}$`)
    /// and additionally may not contain `__` or end with `_`, so that one
    /// module's prefix is never a prefix of another's (`a__` and `a___x`).
    pub fn validate(&self) -> Result<()> {
        for name in std::iter::once(&self.module).chain(self.read_deps.iter()) {
            validate_module_name(name)?;
        }
        if self.read_deps.iter().any(|d| d == PLATFORM_MODULE) {
            return Err(DbError::Param("renox is not a dependency".into()));
        }
        Ok(())
    }

    fn owns(&self, name: &str) -> bool {
        has_prefix(name, &self.module, "__")
    }

    fn owns_index(&self, index: &str) -> bool {
        self.owns(index)
            || index
                .strip_prefix("sqlite_autoindex_")
                .is_some_and(|rest| self.owns(rest))
    }

    fn is_dep_public(&self, name: &str) -> bool {
        self.read_deps
            .iter()
            .any(|d| has_prefix(name, d, "__public_"))
    }

    /// Decide one authorizer call; `Err` carries the object and the action.
    pub(crate) fn check(&self, ctx: &AuthContext<'_>) -> Result<(), Denial> {
        let ddl = self.allow_ddl;
        // Only the main database; `temp` objects are refused (the migration
        // runner's `alter table ... rename` reads `sqlite_temp_master`).
        let main_db = matches!(ctx.database_name, None | Some("main"));
        let ok = match ctx.action {
            AuthAction::Select | AuthAction::Recursive => true,
            AuthAction::Transaction { .. } | AuthAction::Savepoint { .. } => !ddl,
            AuthAction::Function { function_name } => {
                !matches!(function_name, "load_extension" | "fts3_tokenizer")
            }
            AuthAction::Read { table_name, .. } => {
                (main_db && (self.owns(table_name) || self.is_dep_public(table_name)))
                    // A column read inside a dependency's public view.
                    || (main_db && ctx.accessor.is_some_and(|a| self.is_dep_public(a)))
                    || (ddl && is_schema_table(table_name))
            }
            AuthAction::Insert { table_name }
            | AuthAction::Update { table_name, .. }
            | AuthAction::Delete { table_name } => {
                (main_db && self.owns(table_name)) || (ddl && is_schema_table(table_name))
            }
            AuthAction::CreateTable { table_name } | AuthAction::DropTable { table_name } => {
                ddl && main_db && self.owns(table_name)
            }
            AuthAction::CreateView { view_name } | AuthAction::DropView { view_name } => {
                ddl && main_db && self.owns(view_name)
            }
            AuthAction::CreateIndex {
                index_name,
                table_name,
            }
            | AuthAction::DropIndex {
                index_name,
                table_name,
            } => ddl && main_db && self.owns(table_name) && self.owns_index(index_name),
            AuthAction::Reindex { index_name } => ddl && main_db && self.owns_index(index_name),
            AuthAction::AlterTable {
                database_name,
                table_name,
            } => ddl && database_name == "main" && self.owns(table_name),
            AuthAction::DropTrigger {
                trigger_name,
                table_name,
            } => ddl && main_db && self.owns(trigger_name) && self.owns(table_name),
            // Everything else: PRAGMA, ATTACH, DETACH, triggers, temp
            // objects, virtual tables, ANALYZE, and unknown codes.
            _ => false,
        };
        if ok { Ok(()) } else { Err(Denial::of(ctx)) }
    }
}

fn has_prefix(name: &str, module: &str, sep: &str) -> bool {
    name.len() > module.len() + sep.len()
        && name.starts_with(module)
        && name[module.len()..].starts_with(sep)
}

fn is_schema_table(name: &str) -> bool {
    matches!(
        name,
        "sqlite_master" | "sqlite_schema" | "sqlite_temp_master" | "sqlite_temp_schema"
    )
}

pub(crate) fn validate_module_name(name: &str) -> Result<()> {
    let b = name.as_bytes();
    let ok = !b.is_empty()
        && b.len() <= 32
        && b[0].is_ascii_lowercase()
        && b.iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'_')
        && !name.contains("__")
        && !name.ends_with('_');
    if ok {
        Ok(())
    } else {
        Err(DbError::Param(format!("invalid module name {name:?}")))
    }
}

/// The first refused action of a statement.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Denial {
    pub(crate) table: String,
    pub(crate) action: &'static str,
}

impl Denial {
    pub(crate) fn is_schema_table(&self) -> bool {
        is_schema_table(&self.table)
    }

    fn of(ctx: &AuthContext<'_>) -> Self {
        let (action, object): (&'static str, &str) = match ctx.action {
            AuthAction::Read { table_name, .. } => ("READ", table_name),
            AuthAction::Insert { table_name } => ("INSERT", table_name),
            AuthAction::Update { table_name, .. } => ("UPDATE", table_name),
            AuthAction::Delete { table_name } => ("DELETE", table_name),
            AuthAction::CreateTable { table_name } => ("CREATE_TABLE", table_name),
            AuthAction::CreateTempTable { table_name } => ("CREATE_TEMP_TABLE", table_name),
            AuthAction::DropTable { table_name } => ("DROP_TABLE", table_name),
            AuthAction::CreateView { view_name } => ("CREATE_VIEW", view_name),
            AuthAction::CreateTempView { view_name } => ("CREATE_TEMP_VIEW", view_name),
            AuthAction::DropView { view_name } => ("DROP_VIEW", view_name),
            AuthAction::CreateIndex { index_name, .. } => ("CREATE_INDEX", index_name),
            AuthAction::DropIndex { index_name, .. } => ("DROP_INDEX", index_name),
            AuthAction::CreateTrigger { trigger_name, .. } => ("CREATE_TRIGGER", trigger_name),
            AuthAction::CreateTempTrigger { trigger_name, .. } => {
                ("CREATE_TEMP_TRIGGER", trigger_name)
            }
            AuthAction::DropTrigger { trigger_name, .. } => ("DROP_TRIGGER", trigger_name),
            AuthAction::AlterTable { table_name, .. } => ("ALTER_TABLE", table_name),
            AuthAction::Reindex { index_name } => ("REINDEX", index_name),
            AuthAction::Analyze { table_name } => ("ANALYZE", table_name),
            AuthAction::Pragma { pragma_name, .. } => ("PRAGMA", pragma_name),
            AuthAction::Attach { .. } => ("ATTACH", ""),
            AuthAction::Detach { database_name } => ("DETACH", database_name),
            AuthAction::CreateVtable { table_name, .. } => ("CREATE_VTABLE", table_name),
            AuthAction::DropVtable { table_name, .. } => ("DROP_VTABLE", table_name),
            AuthAction::Function { function_name } => ("FUNCTION", function_name),
            AuthAction::Transaction { .. } => ("TRANSACTION", ""),
            AuthAction::Savepoint { savepoint_name, .. } => ("SAVEPOINT", savepoint_name),
            _ => ("UNKNOWN", ""),
        };
        Denial {
            table: object.to_owned(),
            action,
        }
    }
}

/// Map an authorizer decision to SQLite's answer.
pub(crate) fn decide(
    policy: Option<&AuthorizerPolicy>,
    ctx: &AuthContext<'_>,
) -> (Authorization, Option<Denial>) {
    match policy {
        None => (Authorization::Allow, None),
        Some(p) => match p.check(ctx) {
            Ok(()) => (Authorization::Allow, None),
            Err(d) => (Authorization::Deny, Some(d)),
        },
    }
}
