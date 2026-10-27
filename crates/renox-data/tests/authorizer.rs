//! Tests for #19 (F1-05): the SQLite authorizer per module prefix.
//!
//! Every refusal here proves the row "SQL touching another module's table"
//! of docs/23-failure-modes.md and "Cross-module table access" of
//! docs/24-threat-model.md section A: the statement is refused at prepare
//! time with RENOX_DB_AUTH naming the table, and nothing runs.

use renox_data::{AuthorizerPolicy, DbError, DbOptions, TenantDb, Value};

struct Fixture {
    _dir: tempfile::TempDir,
    path: std::path::PathBuf,
    platform: TenantDb,
}

/// A tenant file with tables of two modules, a public view of `auth`, and
/// one row in each table, created by a platform handle.
fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("tenant.db");
    let platform = TenantDb::open(&path, DbOptions::default()).unwrap();
    for sql in [
        "create table auth__users (id text primary key, email text, password_hash text)",
        "create view auth__public_users_v1 as select id, email from auth__users",
        "create table billing__invoices (id integer primary key, user_id text, amount integer)",
        "insert into auth__users values ('u1', 'a@example.com', 'secret-hash')",
        "insert into billing__invoices (user_id, amount) values ('u1', 100)",
    ] {
        platform.execute(sql, &[]).unwrap();
    }
    Fixture {
        _dir: dir,
        path,
        platform,
    }
}

impl Fixture {
    fn module(&self, policy: AuthorizerPolicy) -> TenantDb {
        TenantDb::open(&self.path, DbOptions::default())
            .unwrap()
            .with_authorizer(policy)
            .unwrap()
    }
}

fn auth(table: &str, action: &str) -> DbError {
    DbError::Auth {
        table: table.into(),
        action: action.into(),
    }
}

#[test]
fn module_reads_and_writes_its_own_tables() {
    let f = fixture();
    let billing = f.module(AuthorizerPolicy::module("billing"));
    let r = billing
        .execute(
            "insert into billing__invoices (user_id, amount) values (?, ?)",
            &["u1".into(), 250.into()],
        )
        .unwrap();
    assert_eq!(r.changes, 1);
    billing
        .execute("update billing__invoices set amount = amount + 1", &[])
        .unwrap();
    let rows = billing
        .query("select sum(amount) as s from billing__invoices", &[])
        .unwrap();
    assert_eq!(rows[0].get("s"), Some(&Value::Integer(352)));
    billing
        .transaction(|tx| {
            tx.execute("delete from billing__invoices where amount > 300", &[])?;
            Ok::<_, DbError>(())
        })
        .unwrap();
    // The stored (lower-case) name is what the authorizer sees.
    billing
        .query("select * from BILLING__INVOICES", &[])
        .unwrap();
}

#[test]
fn another_modules_table_is_refused_with_its_name() {
    let f = fixture();
    let billing = f.module(AuthorizerPolicy::module("billing"));
    let e = billing.query("select * from auth__users", &[]).unwrap_err();
    assert_eq!(e, auth("auth__users", "READ"));
    assert_eq!(e.code(), "RENOX_DB_AUTH");
    let e = billing
        .execute("insert into auth__users (id) values ('u2')", &[])
        .unwrap_err();
    assert_eq!(e, auth("auth__users", "INSERT"));
    let e = billing.execute("delete from auth__users", &[]).unwrap_err();
    assert_eq!(e, auth("auth__users", "DELETE"));
    // A shorter module name is not a prefix of a longer one.
    let bill = f.module(AuthorizerPolicy::module("bill"));
    let e = bill
        .query("select * from billing__invoices", &[])
        .unwrap_err();
    assert_eq!(e, auth("billing__invoices", "READ"));
    // Nothing was written by the refused statements.
    let n = f
        .platform
        .query_one("select count(*) as n from auth__users", &[])
        .unwrap()
        .unwrap();
    assert_eq!(n.get("n"), Some(&Value::Integer(1)));
}

#[test]
fn declared_dependency_public_view_is_readable_only() {
    let f = fixture();
    let billing = f.module(AuthorizerPolicy::module("billing").with_read_deps(["auth"]));
    let rows = billing
        .query("select id, email from auth__public_users_v1", &[])
        .unwrap();
    assert_eq!(rows[0].get("id"), Some(&Value::Text("u1".into())));
    // A join of an own table with the public view is fine.
    billing
        .query(
            "select i.amount, u.email from billing__invoices i \
             join auth__public_users_v1 u on u.id = i.user_id",
            &[],
        )
        .unwrap();

    let e = billing
        .execute("insert into auth__public_users_v1 (id) values ('x')", &[])
        .unwrap_err();
    assert_eq!(e, auth("auth__public_users_v1", "INSERT"));
    let e = billing.query("select * from auth__users", &[]).unwrap_err();
    assert_eq!(e, auth("auth__users", "READ"));

    // Without the dependency the view is refused too.
    let other = f.module(AuthorizerPolicy::module("billing"));
    let e = other
        .query("select * from auth__public_users_v1", &[])
        .unwrap_err();
    assert!(matches!(e, DbError::Auth { .. }), "{e:?}");
}

#[test]
fn own_view_over_a_foreign_table_does_not_grant_access() {
    let f = fixture();
    // Even if a view with the module's prefix reads another module's table,
    // only `<dep>__public_*` views pass reads through.
    f.platform
        .execute(
            "create view billing__leak as select password_hash from auth__users",
            &[],
        )
        .unwrap();
    let billing = f.module(AuthorizerPolicy::module("billing").with_read_deps(["auth"]));
    let e = billing
        .query("select * from billing__leak", &[])
        .unwrap_err();
    assert_eq!(e, auth("auth__users", "READ"));
}

#[test]
fn attach_is_refused() {
    let f = fixture();
    let billing = f.module(AuthorizerPolicy::module("billing"));
    let e = billing
        .execute("attach database ':memory:' as other", &[])
        .unwrap_err();
    assert_eq!(e, auth("", "ATTACH"));
    let e = billing.execute("detach database main", &[]).unwrap_err();
    assert!(matches!(e, DbError::Auth { .. }), "{e:?}");
}

#[test]
fn pragmas_are_refused() {
    let f = fixture();
    let billing = f.module(AuthorizerPolicy::module("billing"));
    let e = billing
        .execute("pragma journal_mode = delete", &[])
        .unwrap_err();
    assert_eq!(e, auth("journal_mode", "PRAGMA"));
    let e = billing
        .query("pragma table_info(auth__users)", &[])
        .unwrap_err();
    assert_eq!(e, auth("table_info", "PRAGMA"));
    let e = billing
        .query("select * from pragma_table_info('auth__users')", &[])
        .unwrap_err();
    assert!(matches!(e, DbError::Auth { .. }), "{e:?}");
    // The platform handle may still read pragmas; journal mode is unchanged.
    assert_eq!(
        f.platform.read_pragma("journal_mode").unwrap()[0],
        Value::Text("wal".into())
    );
}

#[test]
fn join_across_allowed_and_denied_tables_is_refused() {
    let f = fixture();
    let billing = f.module(AuthorizerPolicy::module("billing"));
    let e = billing
        .query(
            "select i.amount, u.password_hash from billing__invoices i \
             join auth__users u on u.id = i.user_id",
            &[],
        )
        .unwrap_err();
    assert_eq!(e, auth("auth__users", "READ"));
}

#[test]
fn cte_and_subquery_over_a_denied_table_are_refused() {
    let f = fixture();
    let billing = f.module(AuthorizerPolicy::module("billing"));
    let e = billing
        .query(
            "with u as (select id from auth__users) select * from billing__invoices \
             where user_id in (select id from u)",
            &[],
        )
        .unwrap_err();
    assert_eq!(e, auth("auth__users", "READ"));
    let e = billing
        .query(
            "select (select password_hash from auth__users limit 1) as h from billing__invoices",
            &[],
        )
        .unwrap_err();
    assert_eq!(e, auth("auth__users", "READ"));
    let e = billing
        .execute(
            "update billing__invoices set user_id = (select email from auth__users)",
            &[],
        )
        .unwrap_err();
    assert_eq!(e, auth("auth__users", "READ"));
    // A recursive CTE over own tables is fine.
    billing
        .query(
            "with recursive c(x) as (select 1 union all select x + 1 from c where x < 3) \
             select x from c",
            &[],
        )
        .unwrap();
}

#[test]
fn platform_trigger_on_a_module_table_does_not_grant_access() {
    let f = fixture();
    f.platform
        .execute(
            "create trigger billing__copy after insert on billing__invoices \
             begin update auth__users set email = 'x' where id = new.user_id; end",
            &[],
        )
        .unwrap();
    let billing = f.module(AuthorizerPolicy::module("billing"));
    let e = billing
        .execute(
            "insert into billing__invoices (user_id, amount) values ('u1', 1)",
            &[],
        )
        .unwrap_err();
    assert!(
        matches!(&e, DbError::Auth { table, .. } if table == "auth__users"),
        "{e:?}"
    );
    let n = f
        .platform
        .query_one("select count(*) as n from billing__invoices", &[])
        .unwrap()
        .unwrap();
    assert_eq!(n.get("n"), Some(&Value::Integer(1)));
    let email = f
        .platform
        .query_one("select email from auth__users", &[])
        .unwrap()
        .unwrap();
    assert_eq!(
        email.get("email"),
        Some(&Value::Text("a@example.com".into()))
    );
}

#[test]
fn schema_table_is_refused_for_modules_and_readable_for_the_platform() {
    let f = fixture();
    let billing = f.module(AuthorizerPolicy::module("billing"));
    let e = billing
        .query("select name from sqlite_master", &[])
        .unwrap_err();
    assert_eq!(e, auth("sqlite_master", "READ"));
    let e = billing
        .query("select name from sqlite_schema", &[])
        .unwrap_err();
    assert!(matches!(e, DbError::Auth { .. }), "{e:?}");
    assert!(
        f.platform
            .query("select name from sqlite_master", &[])
            .unwrap()
            .len()
            >= 4
    );
}

#[test]
fn ddl_needs_allow_ddl_and_stays_inside_the_prefix() {
    let f = fixture();
    let billing = f.module(AuthorizerPolicy::module("billing"));
    // Without allow_ddl SQLite stops at the first refused action, the write
    // to the schema table that every DDL statement starts with.
    for sql in [
        "create table billing__new (id integer primary key)",
        "drop table billing__invoices",
        "alter table billing__invoices add column x text",
    ] {
        let e = billing.execute(sql, &[]).unwrap_err();
        assert!(matches!(e, DbError::Auth { .. }), "{sql}: {e:?}");
    }
    billing
        .query("select * from billing__invoices", &[])
        .unwrap();

    let migr = f.module(AuthorizerPolicy::module("billing").with_ddl(true));
    for sql in [
        "create table billing__new (id integer primary key, code text unique)",
        "create index billing__new_code on billing__new (code)",
        "alter table billing__new add column note text",
        "create view billing__public_new_v1 as select id from billing__new",
        "drop view billing__public_new_v1",
        "drop index billing__new_code",
        "drop table billing__new",
    ] {
        migr.execute(sql, &[])
            .unwrap_or_else(|e| panic!("{sql}: {e}"));
    }
    for (sql, table, action) in [
        (
            "create table auth__evil (id integer)",
            "auth__evil",
            "CREATE_TABLE",
        ),
        (
            "create table renox__evil (id integer)",
            "renox__evil",
            "CREATE_TABLE",
        ),
        (
            "create index billing__i on auth__users (email)",
            "billing__i",
            "CREATE_INDEX",
        ),
        (
            "alter table auth__users add column x text",
            "auth__users",
            "ALTER_TABLE",
        ),
        ("drop table auth__users", "auth__users", "DROP_TABLE"),
        (
            "create temp table billing__tmp (id integer)",
            "billing__tmp",
            "CREATE_TEMP_TABLE",
        ),
        (
            "create trigger billing__t after insert on billing__invoices begin select 1; end",
            "billing__t",
            "CREATE_TRIGGER",
        ),
        ("pragma writable_schema = on", "writable_schema", "PRAGMA"),
    ] {
        assert_eq!(
            migr.execute(sql, &[]).unwrap_err(),
            auth(table, action),
            "{sql}"
        );
    }
    // DDL does not widen data access.
    assert_eq!(
        migr.query("select * from auth__users", &[]).unwrap_err(),
        auth("auth__users", "READ")
    );
}

#[test]
fn statements_cached_under_the_platform_are_not_reused_under_a_module() {
    let f = fixture();
    let db = TenantDb::open(&f.path, DbOptions::default()).unwrap();
    // Prepare and cache on every reader and on the writer.
    for _ in 0..4 {
        db.query("select * from auth__users", &[]).unwrap();
    }
    let db = db
        .with_authorizer(AuthorizerPolicy::module("billing"))
        .unwrap();
    for _ in 0..4 {
        assert_eq!(
            db.query("select * from auth__users", &[]).unwrap_err(),
            auth("auth__users", "READ")
        );
    }
}

#[test]
fn reserved_and_invalid_module_names() {
    let f = fixture();
    // `renox` is the platform: no restrictions.
    let platform = f.module(AuthorizerPolicy::module("renox"));
    platform.query("select * from auth__users", &[]).unwrap();
    assert!(platform.authorizer().unwrap().is_platform());
    // `app` is an ordinary module with the `app__` prefix.
    let app = f.module(AuthorizerPolicy::module("app").with_ddl(true));
    app.execute("create table app__products (id text primary key)", &[])
        .unwrap();
    assert_eq!(
        app.query("select * from billing__invoices", &[])
            .unwrap_err(),
        auth("billing__invoices", "READ")
    );
    for bad in ["", "Auth", "a_", "a__b", "1x", "auth-x", "renox_"] {
        let db = TenantDb::open(&f.path, DbOptions::default()).unwrap();
        assert!(
            matches!(
                db.with_authorizer(AuthorizerPolicy::module(bad)),
                Err(DbError::Param(_))
            ),
            "{bad:?}"
        );
    }
    let db = TenantDb::open(&f.path, DbOptions::default()).unwrap();
    assert!(
        db.with_authorizer(AuthorizerPolicy::module("billing").with_read_deps(["renox"]))
            .is_err()
    );
}

#[test]
fn module_prefix_option_installs_the_authorizer_on_open() {
    let f = fixture();
    let db = TenantDb::open(
        &f.path,
        DbOptions {
            module_prefix: Some("billing".into()),
            ..DbOptions::default()
        },
    )
    .unwrap();
    assert_eq!(db.authorizer().unwrap().module, "billing");
    db.query("select * from billing__invoices", &[]).unwrap();
    assert_eq!(
        db.query("select * from auth__users", &[]).unwrap_err(),
        auth("auth__users", "READ")
    );
}
