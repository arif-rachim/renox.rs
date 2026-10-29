//! The authorization platform tables (`ops.md` 1.5.0 section 17, "Role
//! assignments" and "Audit"; #277): `renox__role_assignments` and the
//! append-only `renox__authz_audit`. Called by the ops (#279) on the
//! platform connection, in the request's transaction when there is one.

use std::collections::BTreeSet;

use crate::error::{DbError, Result};
use crate::value::{ExecResult, Row, Value};
use crate::{TenantDb, Tx};

/// Statement access shared by a handle (autocommit) and a transaction.
pub trait Statements {
    fn execute(&self, sql: &str, params: &[Value]) -> Result<ExecResult>;
    fn query(&self, sql: &str, params: &[Value]) -> Result<Vec<Row>>;
}

impl Statements for TenantDb {
    fn execute(&self, sql: &str, params: &[Value]) -> Result<ExecResult> {
        TenantDb::execute(self, sql, params)
    }
    fn query(&self, sql: &str, params: &[Value]) -> Result<Vec<Row>> {
        TenantDb::query(self, sql, params)
    }
}

impl Statements for Tx<'_> {
    fn execute(&self, sql: &str, params: &[Value]) -> Result<ExecResult> {
        Tx::execute(self, sql, params)
    }
    fn query(&self, sql: &str, params: &[Value]) -> Result<Vec<Row>> {
        Tx::query(self, sql, params)
    }
}

/// One row of `renox__role_assignments`. `scope_id` is `None` for a
/// tenant-wide (`global`) assignment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoleAssignment {
    pub user_id: String,
    pub role: String,
    pub scope_type: String,
    pub scope_id: Option<String>,
    pub granted_by: String,
    pub at: i64,
}

/// The role was not one the caller may assign (a module outside its
/// `[authz.default_roles]`): `RENOX_MODULE_UNDECLARED`, `role:<name>`.
pub fn undeclared_role(role: &str) -> DbError {
    DbError::Param(format!("role:{role}"))
}

fn check(role: &str, allowed: Option<&BTreeSet<String>>) -> Result<()> {
    match allowed {
        Some(set) if !set.contains(role) => Err(undeclared_role(role)),
        _ => Ok(()),
    }
}

/// Assigns `a.role`; assigning an existing assignment again keeps the first
/// one. `allowed`: the roles the caller may assign (`None`: the app, any
/// role). Returns whether a row was written.
pub fn assign<S: Statements + ?Sized>(
    db: &S,
    a: &RoleAssignment,
    allowed: Option<&BTreeSet<String>>,
) -> Result<bool> {
    check(&a.role, allowed)?;
    let r = db.execute(
        "insert or ignore into renox__role_assignments (user_id, role, scope_type, scope_id, granted_by, at) values (?, ?, ?, ?, ?, ?)",
        &[
            a.user_id.as_str().into(),
            a.role.as_str().into(),
            a.scope_type.as_str().into(),
            a.scope_id.as_deref().unwrap_or("").into(),
            a.granted_by.as_str().into(),
            a.at.into(),
        ],
    )?;
    Ok(r.changes == 1)
}

/// Revokes `role`; returns whether a row was removed.
pub fn revoke<S: Statements + ?Sized>(
    db: &S,
    user_id: &str,
    role: &str,
    scope_type: &str,
    scope_id: Option<&str>,
    allowed: Option<&BTreeSet<String>>,
) -> Result<bool> {
    check(role, allowed)?;
    let r = db.execute(
        "delete from renox__role_assignments where user_id = ? and role = ? and scope_type = ? and scope_id = ?",
        &[user_id.into(), role.into(), scope_type.into(), scope_id.unwrap_or("").into()],
    )?;
    Ok(r.changes == 1)
}

/// The user's assignments, by role, scope type, and scope id.
pub fn list<S: Statements + ?Sized>(db: &S, user_id: &str) -> Result<Vec<RoleAssignment>> {
    let rows = db.query(
        "select user_id, role, scope_type, scope_id, granted_by, at from renox__role_assignments where user_id = ? order by role, scope_type, scope_id",
        &[user_id.into()],
    )?;
    Ok(rows
        .iter()
        .map(|r| {
            let text = |k: &str| match r.get(k) {
                Some(Value::Text(s)) => s.clone(),
                _ => String::new(),
            };
            let scope_id = text("scope_id");
            RoleAssignment {
                user_id: text("user_id"),
                role: text("role"),
                scope_type: text("scope_type"),
                scope_id: (!scope_id.is_empty()).then_some(scope_id),
                granted_by: text("granted_by"),
                at: match r.get("at") {
                    Some(Value::Integer(i)) => *i,
                    _ => 0,
                },
            }
        })
        .collect())
}

/// One decision on a sensitive action.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuditRow<'a> {
    pub principal: &'a str,
    pub action: &'a str,
    pub resource: Option<(&'a str, &'a str)>,
    pub allow: bool,
    pub policy: Option<&'a str>,
    pub at: i64,
}

/// Appends one row to `renox__authz_audit`; returns its id.
pub fn record<S: Statements + ?Sized>(db: &S, row: &AuditRow<'_>) -> Result<i64> {
    let r = db.execute(
        "insert into renox__authz_audit (principal, action, resource_type, resource_id, result, policy, at) values (?, ?, ?, ?, ?, ?, ?)",
        &[
            row.principal.into(),
            row.action.into(),
            row.resource.map_or(Value::Null, |(t, _)| t.into()),
            row.resource.map_or(Value::Null, |(_, i)| i.into()),
            if row.allow { "allow" } else { "deny" }.into(),
            row.policy.map_or(Value::Null, Into::into),
            row.at.into(),
        ],
    )?;
    Ok(r.last_insert_rowid)
}

impl RoleAssignment {
    pub fn new(
        user_id: &str,
        role: &str,
        scope_type: &str,
        scope_id: Option<&str>,
        granted_by: &str,
        at: i64,
    ) -> RoleAssignment {
        RoleAssignment {
            user_id: user_id.into(),
            role: role.into(),
            scope_type: scope_type.into(),
            scope_id: scope_id.map(str::to_string),
            granted_by: granted_by.into(),
            at,
        }
    }
}
