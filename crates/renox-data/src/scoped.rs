//! `db.scoped()`: the owner fence of `docs/11-authorization.md` ("the RLS
//! replacement"; ADR D16) and `docs/contracts/ops.md` 1.5.0 section 17.
//!
//! [`rewrite`] parses one statement (`sqlparser`, SQLite dialect) and adds
//! the owner predicate to every reference of an owned table it can prove:
//!
//! | Shape | What happens |
//! | --- | --- |
//! | `SELECT` whose top-level `FROM` and `JOIN`s name owned tables (aliases included) | `AND <alias>.<owner> = '<scope>'` in the `WHERE` (base relation) or the join's `ON` |
//! | `UPDATE` / `DELETE` of an owned table | the predicate added to the `WHERE` |
//! | `INSERT … VALUES` into an owned table | the owner (and org) column filled with the scope's value when absent; an explicit different value (literal or parameter) is refused, `owner_mismatch` |
//! | An owned table anywhere else: a subquery, a CTE, a set operation (`UNION`), `UPDATE … FROM`, `INSERT … SELECT`, `INSERT OR REPLACE`, an upsert `DO UPDATE` | refused whole, `unprovable` |
//! | A scope without the value an owned table needs | refused, `scope_missing` |
//!
//! Unowned tables are untouched. A statement without an owned table is
//! returned unchanged. Scope values are written as SQL string literals
//! (quotes doubled), never as parameters, so the caller's `?` numbering
//! stays as it was. The rewritten statement runs under the module's
//! authorizer with [`crate::AuthorizerPolicy::with_scoped`]; without it, a
//! module's statement on an owned table is refused (`unscoped`).

use std::collections::BTreeMap;
use std::ops::ControlFlow;

use sqlparser::ast::{
    Expr, FromTable, Insert, JoinConstraint, JoinOperator, ObjectName, OnInsert, Query, SetExpr,
    SqliteOnConflict, Statement, TableFactor, TableObject, TableWithJoins, Value as SqlValue,
    visit_expressions, visit_relations,
};
use sqlparser::dialect::SQLiteDialect;
use sqlparser::parser::Parser;

use crate::error::{DbError, Result};
use crate::value::Value;

/// The scope of a `ctx.db.scoped(scope)` handle.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Scope {
    pub user_id: Option<String>,
    pub org_id: Option<String>,
    pub session_id: Option<String>,
}

/// One `[authz.ownership]` entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnedTable {
    /// The owner column: the user, or the session when it is named `session_id`.
    pub owner: String,
    /// The organisation column, if the table declares one.
    pub org: Option<String>,
}

/// The owned tables of the app and the installed modules.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Ownership {
    tables: BTreeMap<String, OwnedTable>,
}

impl Ownership {
    pub fn new() -> Ownership {
        Ownership::default()
    }

    pub fn with(mut self, table: &str, owner: &str, org: Option<&str>) -> Ownership {
        self.insert(table, owner, org);
        self
    }

    pub fn insert(&mut self, table: &str, owner: &str, org: Option<&str>) {
        self.tables.insert(
            table.to_ascii_lowercase(),
            OwnedTable {
                owner: owner.to_string(),
                org: org.map(str::to_string),
            },
        );
    }

    pub fn get(&self, table: &str) -> Option<&OwnedTable> {
        self.tables.get(&table.to_ascii_lowercase())
    }

    /// The owned tables, lower-case.
    pub fn tables(&self) -> impl Iterator<Item = &str> {
        self.tables.keys().map(String::as_str)
    }

    pub fn is_empty(&self) -> bool {
        self.tables.is_empty()
    }
}

use crate::error::ScopeReason::{
    OwnerMismatch as OWNER_MISMATCH, ScopeMissing as SCOPE_MISSING, Unprovable as UNPROVABLE,
};

fn refuse(table: &str, reason: crate::error::ScopeReason) -> DbError {
    DbError::Scope {
        table: table.into(),
        module: "".into(),
        reason,
    }
}

fn table_of(name: &ObjectName) -> String {
    name.0
        .last()
        .and_then(|p| p.as_ident())
        .map(|i| i.value.to_ascii_lowercase())
        .unwrap_or_default()
}

fn quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

fn ident(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}

fn parse_expr(text: &str) -> Expr {
    Parser::new(&SQLiteDialect {})
        .try_with_sql(text)
        .and_then(|mut p| p.parse_expr())
        .expect("a predicate built from quoted identifiers and literals parses")
}

/// The `(column, value)` pairs that fence `table` for `scope`.
fn fence(table: &str, owned: &OwnedTable, scope: &Scope) -> Result<Vec<(String, String)>> {
    let owner_value = if owned.owner.eq_ignore_ascii_case("session_id") {
        scope.session_id.as_ref()
    } else {
        scope.user_id.as_ref()
    };
    let Some(owner_value) = owner_value else {
        return Err(refuse(table, SCOPE_MISSING));
    };
    let mut out = vec![(owned.owner.clone(), owner_value.clone())];
    if let (Some(org), Some(org_id)) = (&owned.org, &scope.org_id) {
        out.push((org.clone(), org_id.clone()));
    }
    Ok(out)
}

fn predicate(qualifier: &str, cols: &[(String, String)]) -> Expr {
    let text = cols
        .iter()
        .map(|(c, v)| format!("{}.{} = {}", ident(qualifier), ident(c), quote(v)))
        .collect::<Vec<_>>()
        .join(" AND ");
    parse_expr(&text)
}

fn and(existing: Option<Expr>, add: Expr) -> Expr {
    match existing {
        None => add,
        Some(e) => Expr::BinaryOp {
            left: Box::new(Expr::Nested(Box::new(e))),
            op: sqlparser::ast::BinaryOperator::And,
            right: Box::new(add),
        },
    }
}

/// Rewrites the owned references of one `FROM` item; returns how many.
fn fence_from(
    twj: &mut TableWithJoins,
    own: &Ownership,
    scope: &Scope,
    where_: &mut Option<Expr>,
) -> Result<usize> {
    let mut n = 0;
    if let TableFactor::Table {
        name,
        alias,
        args: None,
        ..
    } = &twj.relation
    {
        let t = table_of(name);
        if let Some(o) = own.get(&t) {
            let q = alias.as_ref().map_or(t.clone(), |a| a.name.value.clone());
            *where_ = Some(and(where_.take(), predicate(&q, &fence(&t, o, scope)?)));
            n += 1;
        }
    }
    for j in &mut twj.joins {
        let TableFactor::Table {
            name,
            alias,
            args: None,
            ..
        } = &j.relation
        else {
            continue;
        };
        let t = table_of(name);
        let Some(o) = own.get(&t) else { continue };
        let q = alias.as_ref().map_or(t.clone(), |a| a.name.value.clone());
        let p = predicate(&q, &fence(&t, o, scope)?);
        let inner = matches!(
            j.join_operator,
            JoinOperator::Join(_) | JoinOperator::Inner(_) | JoinOperator::CrossJoin(_)
        );
        let constraint = match &mut j.join_operator {
            JoinOperator::Join(c)
            | JoinOperator::Inner(c)
            | JoinOperator::Left(c)
            | JoinOperator::LeftOuter(c)
            | JoinOperator::CrossJoin(c) => c,
            // RIGHT and FULL joins keep rows of the other side whatever the
            // predicate says: not provable here.
            _ => return Err(refuse(&t, UNPROVABLE)),
        };
        match constraint {
            JoinConstraint::On(e) => *e = and(Some(e.clone()), p),
            // A predicate in ON would be lost for these; an inner or cross
            // join is filtered as well in the WHERE.
            JoinConstraint::None if inner => {
                *where_ = Some(and(where_.take(), p));
            }
            _ => return Err(refuse(&t, UNPROVABLE)),
        }
        n += 1;
    }
    Ok(n)
}

/// How many references of owned tables the statement holds, and the first.
fn owned_refs(stmt: &Statement, own: &Ownership) -> (usize, Option<String>) {
    let mut n = 0;
    let mut first = None;
    let _ = visit_relations(stmt, |name| {
        let t = table_of(name);
        if own.get(&t).is_some() {
            n += 1;
            first.get_or_insert(t);
        }
        ControlFlow::<()>::Continue(())
    });
    (n, first)
}

/// The parameter number (1-based) of each `?`/`?NNN` placeholder, in text
/// order, by SQLite's rule: `?` is one more than the largest so far.
fn placeholder_numbers(stmt: &Statement) -> Vec<(*const Expr, usize)> {
    let mut out = Vec::new();
    let mut max = 0usize;
    let _ = visit_expressions(stmt, |e| {
        if let Expr::Value(v) = e
            && let SqlValue::Placeholder(p) = &v.value
        {
            let n = match p.strip_prefix('?') {
                Some("") => max + 1,
                Some(num) => num.parse().unwrap_or(max + 1),
                None => max + 1,
            };
            max = max.max(n);
            out.push((e as *const Expr, n));
        }
        ControlFlow::<()>::Continue(())
    });
    out
}

fn literal_matches(
    e: &Expr,
    want: &str,
    numbers: &[(*const Expr, usize)],
    params: &[Value],
) -> Option<bool> {
    match e {
        Expr::Value(v) => match &v.value {
            SqlValue::SingleQuotedString(s) | SqlValue::DoubleQuotedString(s) => Some(s == want),
            SqlValue::Number(n, _) => Some(n == want),
            SqlValue::Placeholder(_) => {
                let n = numbers.iter().find(|(p, _)| std::ptr::eq(*p, e))?.1;
                Some(match params.get(n.checked_sub(1)?)? {
                    Value::Text(s) => s == want,
                    Value::Integer(i) => i.to_string() == want,
                    _ => false,
                })
            }
            _ => None,
        },
        Expr::Nested(inner) => literal_matches(inner, want, numbers, params),
        _ => None,
    }
}

fn fence_insert(
    ins: &mut Insert,
    own: &Ownership,
    scope: &Scope,
    numbers: &[(*const Expr, usize)],
    params: &[Value],
) -> Result<usize> {
    let TableObject::TableName(name) = &ins.table else {
        return Ok(0);
    };
    let t = table_of(name);
    let Some(o) = own.get(&t) else { return Ok(0) };
    let cols = fence(&t, o, scope)?;
    if ins.replace_into || matches!(ins.or, Some(SqliteOnConflict::Replace)) {
        return Err(refuse(&t, UNPROVABLE));
    }
    if let Some(OnInsert::OnConflict(c)) = &ins.on
        && !matches!(c.action, sqlparser::ast::OnConflictAction::DoNothing)
    {
        return Err(refuse(&t, UNPROVABLE));
    }
    if ins
        .on
        .as_ref()
        .is_some_and(|o| !matches!(o, OnInsert::OnConflict(_)))
    {
        return Err(refuse(&t, UNPROVABLE));
    }
    let Some(source) = ins.source.as_mut() else {
        return Err(refuse(&t, UNPROVABLE));
    };
    if source.with.is_some() {
        return Err(refuse(&t, UNPROVABLE));
    }
    let SetExpr::Values(values) = source.body.as_mut() else {
        return Err(refuse(&t, UNPROVABLE));
    };
    if ins.columns.is_empty() {
        // Without a column list the positions are the table's: not provable here.
        return Err(refuse(&t, UNPROVABLE));
    }
    for (col, want) in &cols {
        let at = ins
            .columns
            .iter()
            .position(|c| table_of(c).eq_ignore_ascii_case(col));
        match at {
            Some(i) => {
                for row in &values.rows {
                    let Some(e) = row.get(i) else {
                        return Err(refuse(&t, UNPROVABLE));
                    };
                    match literal_matches(e, want, numbers, params) {
                        Some(true) => {}
                        Some(false) => return Err(refuse(&t, OWNER_MISMATCH)),
                        None => return Err(refuse(&t, UNPROVABLE)),
                    }
                }
            }
            None => {
                ins.columns
                    .push(ObjectName::from(vec![sqlparser::ast::Ident::with_quote(
                        '"', col,
                    )]));
                for row in &mut values.rows {
                    row.push(parse_expr(&quote(want)));
                }
            }
        }
    }
    Ok(1)
}

/// Rewrites `sql` for `scope`; `params` are the statement's parameters
/// (to check an owner column given as `?`). Statements without an owned
/// table come back unchanged.
pub fn rewrite(sql: &str, params: &[Value], scope: &Scope, own: &Ownership) -> Result<String> {
    if own.is_empty() || !own.tables().any(|t| sql.to_ascii_lowercase().contains(t)) {
        return Ok(sql.to_string());
    }
    let mut stmts = Parser::parse_sql(&SQLiteDialect {}, sql).map_err(|e| DbError::Sqlite {
        code: rusqlite::ffi::SQLITE_ERROR,
        message: format!("db.scoped(): {e}"),
    })?;
    if stmts.len() != 1 {
        return Err(DbError::MultiStatement);
    }
    let mut stmt = stmts.remove(0);
    let (total, first) = owned_refs(&stmt, own);
    let Some(first) = first else {
        return Ok(sql.to_string());
    };
    let numbers = placeholder_numbers(&stmt);
    let done = match &mut stmt {
        Statement::Query(q) => fence_query(q, own, scope)?,
        Statement::Update(u) => {
            if u.from.is_some() {
                0
            } else {
                let mut w = u.selection.take();
                let n = fence_from(&mut u.table, own, scope, &mut w)?;
                u.selection = w;
                n
            }
        }
        Statement::Delete(d) => {
            let froms = match &mut d.from {
                FromTable::WithFromKeyword(f) | FromTable::WithoutKeyword(f) => f,
            };
            if froms.len() == 1 && d.using.is_none() && d.tables.is_empty() {
                let mut w = d.selection.take();
                let n = fence_from(&mut froms[0], own, scope, &mut w)?;
                d.selection = w;
                n
            } else {
                0
            }
        }
        Statement::Insert(ins) => fence_insert(ins, own, scope, &numbers, params)?,
        _ => 0,
    };
    if done != total {
        return Err(refuse(&first, UNPROVABLE));
    }
    Ok(stmt.to_string())
}

fn fence_query(q: &mut Query, own: &Ownership, scope: &Scope) -> Result<usize> {
    // A CTE body is not rewritten: an owned table there stays uncounted.
    let SetExpr::Select(sel) = q.body.as_mut() else {
        return Ok(0);
    };
    let mut w = sel.selection.take();
    let mut n = 0;
    for twj in &mut sel.from {
        n += fence_from(twj, own, scope, &mut w)?;
    }
    sel.selection = w;
    Ok(n)
}
