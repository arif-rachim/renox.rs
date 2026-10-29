//! #277: `db.scoped()` (`docs/contracts/ops.md` 1.5.0 section 17;
//! `docs/11-authorization.md`, "the RLS replacement"; ADR D16).
//!
//! Proves the `docs/23-failure-modes.md` F5 row "Unscoped query on an owned
//! table" and the `docs/24-threat-model.md` control "`db.scoped` for module
//! code" at the data layer.
//!
//! Shapes the rewriter **proves** (each has a test below):
//! - `SELECT` from an owned table, with or without an alias;
//! - `SELECT` with an owned table in the top-level `JOIN` (inner, left,
//!   cross; the predicate goes into `ON`, or `WHERE` for a join without one);
//! - a join of an owned and a free table;
//! - `UPDATE` and `DELETE` of an owned table (the predicate is ANDed to the
//!   existing `WHERE`, parenthesised);
//! - `INSERT … VALUES` into an owned table: a missing owner (and org)
//!   column is filled in; an explicit equal value (literal or `?`) passes.
//!
//! Shapes it **refuses** with `RENOX_DB_SCOPE` (the reason in brackets):
//! - an owned table in a subquery, a CTE, a set operation, a `RIGHT`/`FULL`
//!   join, `UPDATE … FROM`, `INSERT … SELECT`, `INSERT` without a column
//!   list, `INSERT OR REPLACE`, an upsert `DO UPDATE` [`unprovable`];
//! - `INSERT` with another owner [`owner_mismatch`];
//! - a scope without the value a table needs [`scope_missing`];
//! - a module's statement on an owned table outside `db.scoped()` [`unscoped`].
//!
//! A trigger reaching an owned table cannot exist: the authorizer allows a
//! module only triggers on its own tables, and the migration runner only
//! bodies that are `select raise(...)` with no subquery (#288), so no
//! trigger writes or reads a table.

use renox_data::scoped::rewrite;
use renox_data::{AuthorizerPolicy, DbError, DbOptions, Ownership, Scope, TenantDb, Value};

fn ownership() -> Ownership {
    Ownership::new()
        .with("shop__orders", "user_id", Some("org_id"))
        .with("shop__cart_items", "session_id", None)
}

fn alice() -> Scope {
    Scope {
        user_id: Some("u_alice".into()),
        org_id: Some("o_1".into()),
        session_id: Some("s_a".into()),
    }
}

struct Fx {
    _dir: tempfile::TempDir,
    path: std::path::PathBuf,
}

fn fixture() -> Fx {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("t.db");
    let p = TenantDb::open(&path, DbOptions::default()).unwrap();
    for sql in [
        "create table shop__orders (id integer primary key, user_id text not null, org_id text, total integer)",
        "create table shop__cart_items (id integer primary key, session_id text not null, sku text)",
        "create table shop__products (sku text primary key, name text)",
        "insert into shop__products values ('p1', 'Pen'), ('p2', 'Ink')",
        "insert into shop__orders (user_id, org_id, total) values ('u_alice', 'o_1', 10), ('u_bob', 'o_1', 20), ('u_alice', 'o_2', 30)",
        "insert into shop__cart_items (session_id, sku) values ('s_a', 'p1'), ('s_b', 'p2')",
    ] {
        p.execute(sql, &[]).unwrap();
    }
    Fx { _dir: dir, path }
}

impl Fx {
    fn module(&self) -> TenantDb {
        TenantDb::open(&self.path, DbOptions::default())
            .unwrap()
            .with_authorizer(
                AuthorizerPolicy::module("shop").with_owned(["shop__orders", "shop__cart_items"]),
            )
            .unwrap()
    }

    /// Runs a scoped statement as the module would through `ctx.db.scoped()`.
    fn scoped(
        &self,
        db: &TenantDb,
        scope: &Scope,
        sql: &str,
        params: &[Value],
    ) -> Result<Vec<renox_data::Row>, DbError> {
        let sql = rewrite(sql, params, scope, &ownership())?;
        let policy = db.authorizer().unwrap().clone().with_scoped(true);
        db.with_policy(Some(policy), || db.query(&sql, params))?
    }
}

fn ints(rows: &[renox_data::Row], col: &str) -> Vec<i64> {
    rows.iter()
        .map(|r| match r.get(col) {
            Some(Value::Integer(i)) => *i,
            v => panic!("{v:?}"),
        })
        .collect()
}

fn reason(e: DbError) -> &'static str {
    match e {
        DbError::Scope { reason, .. } => reason.as_str(),
        other => panic!("not a scope error: {other:?}"),
    }
}

#[test]
fn select_by_owner_and_org() {
    let fx = fixture();
    let db = fx.module();
    let rows = fx
        .scoped(
            &db,
            &alice(),
            "select total from shop__orders order by total",
            &[],
        )
        .unwrap();
    assert_eq!(ints(&rows, "total"), vec![10], "only alice's rows in o_1");
    // Without an org in the scope, only the owner predicate applies.
    let no_org = Scope {
        org_id: None,
        ..alice()
    };
    let rows = fx
        .scoped(
            &db,
            &no_org,
            "select o.total from shop__orders as o where o.total > ? order by o.total",
            &[5.into()],
        )
        .unwrap();
    assert_eq!(ints(&rows, "total"), vec![10, 30]);
}

#[test]
fn cart_items_by_session() {
    let fx = fixture();
    let db = fx.module();
    let rows = fx
        .scoped(&db, &alice(), "select id from shop__cart_items", &[])
        .unwrap();
    assert_eq!(rows.len(), 1);
    let no_session = Scope {
        session_id: None,
        ..alice()
    };
    assert_eq!(
        reason(
            fx.scoped(&db, &no_session, "select id from shop__cart_items", &[])
                .unwrap_err()
        ),
        "scope_missing"
    );
}

#[test]
fn join_of_an_owned_and_a_free_table_and_of_two_owned() {
    let fx = fixture();
    let db = fx.module();
    let rows = fx
        .scoped(
            &db,
            &alice(),
            "select c.id, p.name from shop__products p join shop__cart_items c on c.sku = p.sku",
            &[],
        )
        .unwrap();
    assert_eq!(rows.len(), 1);
    let rows = fx
        .scoped(&db, &alice(), "select p.sku from shop__products p left join shop__cart_items c on c.sku = p.sku where c.id is null order by p.sku", &[])
        .unwrap();
    assert_eq!(
        rows.len(),
        1,
        "the left join drops only bob's cart row, not the product"
    );
    let rows = fx
        .scoped(
            &db,
            &alice(),
            "select o.id from shop__orders o, shop__cart_items c",
            &[],
        )
        .unwrap();
    assert_eq!(rows.len(), 1);
    let sql = rewrite(
        "select * from shop__orders o join shop__products p on 1",
        &[],
        &alice(),
        &ownership(),
    )
    .unwrap();
    assert!(sql.contains("\"o\".\"user_id\" = 'u_alice'"), "{sql}");
}

#[test]
fn update_and_delete_are_fenced() {
    let fx = fixture();
    let db = fx.module();
    let sql = rewrite(
        "update shop__orders set total = total + 1 where total < 100 or 1 = 1",
        &[],
        &alice(),
        &ownership(),
    )
    .unwrap();
    assert!(
        sql.contains("(total < 100 OR 1 = 1) AND"),
        "the original WHERE is parenthesised: {sql}"
    );
    let pol = db.authorizer().unwrap().clone().with_scoped(true);
    let r = db
        .with_policy(Some(pol.clone()), || db.execute(&sql, &[]))
        .unwrap()
        .unwrap();
    assert_eq!(r.changes, 1);
    let sql = rewrite("delete from shop__orders", &[], &alice(), &ownership()).unwrap();
    let r = db
        .with_policy(Some(pol), || db.execute(&sql, &[]))
        .unwrap()
        .unwrap();
    assert_eq!(r.changes, 1);
    let platform = TenantDb::open(&fx.path, DbOptions::default()).unwrap();
    assert_eq!(
        platform
            .query("select total from shop__orders order by total", &[])
            .unwrap()
            .len(),
        2,
        "bob's and alice's o_2 row stay"
    );
}

#[test]
fn insert_fills_or_checks_the_owner() {
    let fx = fixture();
    let own = ownership();
    let sql = rewrite(
        "insert into shop__orders (total) values (?), (?)",
        &[1.into(), 2.into()],
        &alice(),
        &own,
    )
    .unwrap();
    assert!(sql.contains("\"user_id\", \"org_id\""), "{sql}");
    let db = fx.module();
    let pol = db.authorizer().unwrap().clone().with_scoped(true);
    db.with_policy(Some(pol), || db.execute(&sql, &[1.into(), 2.into()]))
        .unwrap()
        .unwrap();
    // An equal explicit owner passes, as a literal or as a parameter.
    rewrite(
        "insert into shop__orders (user_id, org_id, total) values ('u_alice', 'o_1', 1)",
        &[],
        &alice(),
        &own,
    )
    .unwrap();
    rewrite(
        "insert into shop__orders (total, user_id, org_id) values (?, ?, ?)",
        &[1.into(), "u_alice".into(), "o_1".into()],
        &alice(),
        &own,
    )
    .unwrap();
    rewrite(
        "insert into shop__orders (total, user_id, org_id) values (?3, ?1, ?2)",
        &["u_alice".into(), "o_1".into(), 1.into()],
        &alice(),
        &own,
    )
    .unwrap();
    // Another owner is refused, as a literal or as a parameter.
    for (sql, params) in [
        (
            "insert into shop__orders (user_id, total) values ('u_bob', 1)",
            vec![],
        ),
        (
            "insert into shop__orders (total, user_id) values (?, ?)",
            vec![Value::from(1), Value::from("u_bob")],
        ),
        (
            "insert into shop__orders (user_id, org_id) values ('u_alice', 'o_2')",
            vec![],
        ),
    ] {
        assert_eq!(
            reason(rewrite(sql, &params, &alice(), &own).unwrap_err()),
            "owner_mismatch",
            "{sql}"
        );
    }
}

#[test]
fn unprovable_shapes_are_refused_whole() {
    let own = ownership();
    for sql in [
        "select * from shop__products where sku in (select sku from shop__cart_items)",
        "with mine as (select * from shop__orders) select * from mine",
        "select id from shop__orders union select id from shop__cart_items",
        "select * from shop__products p right join shop__orders o on o.id = p.sku",
        "insert into shop__orders (user_id, total) select user_id, total from shop__orders",
        "insert into shop__orders values (1, 'u_alice', 'o_1', 1)",
        "insert or replace into shop__orders (id, user_id, org_id) values (1, 'u_alice', 'o_1')",
        "replace into shop__orders (id, user_id, org_id) values (1, 'u_alice', 'o_1')",
        "insert into shop__orders (id, user_id, org_id) values (1, 'u_alice', 'o_1') on conflict (id) do update set total = 0",
        "update shop__products set name = 'x' from shop__orders where shop__orders.total = 1",
        "select (select count(*) from shop__orders) as n",
        "select * from shop__products p join (select * from shop__orders) o on 1",
    ] {
        assert_eq!(
            reason(rewrite(sql, &[], &alice(), &own).unwrap_err()),
            "unprovable",
            "{sql}"
        );
    }
    // Upsert DO NOTHING and INSERT OR IGNORE cannot touch another's row: proven.
    rewrite(
        "insert into shop__orders (id, total) values (1, 1) on conflict do nothing",
        &[],
        &alice(),
        &own,
    )
    .unwrap();
    rewrite(
        "insert or ignore into shop__orders (id, total) values (1, 1)",
        &[],
        &alice(),
        &own,
    )
    .unwrap();
    // A statement without an owned table is returned as it was.
    let s = "select name from shop__products where sku = ?";
    assert_eq!(rewrite(s, &[], &alice(), &own).unwrap(), s);
}

#[test]
fn module_unscoped_refused_app_unscoped_allowed() {
    let fx = fixture();
    let db = fx.module();
    match db.query("select * from shop__orders", &[]).unwrap_err() {
        DbError::Scope {
            table,
            module,
            reason,
        } => {
            assert_eq!(
                (&*table, &*module, reason.as_str()),
                ("shop__orders", "shop", "unscoped")
            );
        }
        e => panic!("{e:?}"),
    }
    assert_eq!(
        DbError::Scope {
            table: "".into(),
            module: "".into(),
            reason: renox_data::ScopeReason::Unscoped
        }
        .code(),
        "RENOX_DB_SCOPE"
    );
    assert!(matches!(
        db.execute("delete from shop__cart_items", &[]),
        Err(DbError::Scope { .. })
    ));
    assert!(matches!(
        db.execute("insert into shop__orders (user_id) values ('x')", &[]),
        Err(DbError::Scope { .. })
    ));
    // A free table needs no scope.
    assert_eq!(
        db.query("select * from shop__products", &[]).unwrap().len(),
        2
    );
    // The app's owned tables are only warned about by `renox check`.
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("a.db");
    TenantDb::open(&path, DbOptions::default())
        .unwrap()
        .execute(
            "create table app__orders (id integer primary key, user_id text)",
            &[],
        )
        .unwrap();
    let app = TenantDb::open(&path, DbOptions::default())
        .unwrap()
        .with_authorizer(AuthorizerPolicy::module("app").with_owned(["app__orders"]))
        .unwrap();
    assert!(app.query("select * from app__orders", &[]).is_ok());
}
