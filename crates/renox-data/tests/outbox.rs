//! Tests for #228 (F4-13): the outbox tables, savepoints, the multi-module
//! migration runner, and the public-view name rule.

use std::collections::BTreeMap;

use renox_data::outbox::{self, DeadLetterCap, OutboxEvent};
use renox_data::{
    AuthorizerPolicy, DbError, DbOptions, MAX_SAVEPOINTS, MigrationError, MigrationFile,
    ModuleMigrations, TenantDb, Value, checksum, migrate_all,
};

fn open() -> (tempfile::TempDir, TenantDb) {
    let dir = tempfile::tempdir().unwrap();
    let db = TenantDb::open(dir.path().join("tenant.db"), DbOptions::default()).unwrap();
    (dir, db)
}

fn module_handle(dir: &tempfile::TempDir, policy: AuthorizerPolicy) -> TenantDb {
    TenantDb::open(dir.path().join("tenant.db"), DbOptions::default())
        .unwrap()
        .with_authorizer(policy)
        .unwrap()
}

fn event(id: &str) -> OutboxEvent {
    OutboxEvent {
        id: id.into(),
        name: "billing.invoice_paid".into(),
        payload: r#"{"invoice_id":"inv_1"}"#.into(),
        module: "billing".into(),
        created_at: 1_000,
    }
}

fn count(db: &TenantDb, table: &str) -> i64 {
    match db
        .query_one(&format!("select count(*) as n from {table}"), &[])
        .unwrap()
        .unwrap()
        .get("n")
    {
        Some(Value::Integer(n)) => *n,
        other => panic!("{other:?}"),
    }
}

/// docs/24-threat-model.md, "Cross-module table access": the outbox is a
/// platform table, so a tenant (module or app) handle can neither read nor
/// write it, nor its dead letters.
#[test]
fn tenant_handle_is_refused_on_the_outbox() {
    let (dir, db) = open();
    outbox::emit_autocommit(&db, &event("01A")).unwrap();
    for m in ["app", "billing"] {
        let t = module_handle(&dir, AuthorizerPolicy::module(m));
        for (sql, table) in [
            ("select * from renox__outbox", "renox__outbox"),
            ("select * from renox__outbox_dead", "renox__outbox_dead"),
            ("delete from renox__outbox", "renox__outbox"),
        ] {
            let e = if sql.starts_with("select") {
                t.query(sql, &[]).unwrap_err()
            } else {
                t.execute(sql, &[]).unwrap_err()
            };
            assert!(
                matches!(&e, DbError::Auth { table: tb, .. } if tb == table),
                "{m}: {sql}: {e:?}"
            );
        }
        let e = t
            .execute(
                "insert into renox__outbox (id, name, payload, module, created_at, next_at) \
                 values ('x', 'a.b', '{}', 'm', 0, 0)",
                &[],
            )
            .unwrap_err();
        assert!(matches!(e, DbError::Auth { .. }), "{e:?}");
    }
    assert_eq!(count(&db, "renox__outbox"), 1);
}

/// ops.md section 15.4, "Durable": an emit inside a transaction that rolls
/// back leaves no row; a committed one does. A module handle can emit
/// through the platform functions (the op does), never through its own SQL.
#[test]
fn emit_follows_the_transaction() {
    let (dir, db) = open();
    let billing = module_handle(&dir, AuthorizerPolicy::module("billing"));
    billing
        .execute("create table if not exists x (a)", &[])
        .unwrap_err();
    let r: Result<(), DbError> = billing.transaction(|tx| {
        outbox::emit(&billing, tx, &event("01ROLLBACK"))?;
        Err(DbError::Param("handler failed".into()))
    });
    assert!(r.is_err());
    assert_eq!(count(&db, "renox__outbox"), 0);
    billing
        .transaction(|tx| outbox::emit(&billing, tx, &event("01COMMIT")))
        .unwrap();
    let due = outbox::due(&db, 1_000, 10).unwrap();
    assert_eq!(due.len(), 1);
    assert_eq!(due[0].id, "01COMMIT");
    assert_eq!(due[0].target, "");
    // The module's policy is back after the platform write.
    assert!(matches!(
        billing.query("select * from renox__outbox", &[]),
        Err(DbError::Auth { .. })
    ));
    // The payload cap.
    let mut big = event("01BIG");
    big.payload = format!("\"{}\"", "x".repeat(outbox::MAX_PAYLOAD_BYTES));
    assert!(matches!(
        outbox::emit_autocommit(&db, &big),
        Err(DbError::Param(_))
    ));
}

#[test]
fn fan_out_delivery_failure_and_dead_letter() {
    let (_dir, db) = open();
    outbox::emit_autocommit(&db, &event("01E")).unwrap();
    assert_eq!(outbox::next_due_at(&db).unwrap(), Some(1_000));
    outbox::fan_out(&db, "01E", &["email".into(), "audit".into()], 2_000).unwrap();
    // A second fan-out is a no-op.
    outbox::fan_out(&db, "01E", &["email".into()], 2_000).unwrap();
    let due = outbox::due(&db, 2_000, 10).unwrap();
    let targets: Vec<&str> = due.iter().map(|r| r.target.as_str()).collect();
    assert_eq!(targets, ["audit", "email"]);
    // audit's handler commits its write with the acknowledgement.
    db.execute("create table audit__log (id text)", &[])
        .unwrap();
    db.transaction(|tx| {
        tx.execute("insert into audit__log values ('01E')", &[])?;
        assert!(outbox::delivered(&db, tx, "01E", "audit")?);
        Ok::<_, DbError>(())
    })
    .unwrap();
    // email fails, then is dead-lettered without its payload in the error.
    outbox::failed(&db, "01E", "email", 1, 12_000, "threw: boom").unwrap();
    assert!(outbox::due(&db, 11_999, 10).unwrap().is_empty());
    let again = outbox::due(&db, 12_000, 10).unwrap();
    assert_eq!(
        (again[0].attempts, again[0].last_error.as_deref()),
        (1, Some("threw: boom"))
    );
    let pruned = outbox::dead_letter(
        &db,
        "01E",
        "email",
        8,
        "threw: boom",
        20_000,
        DeadLetterCap::default(),
    )
    .unwrap();
    assert_eq!(pruned, 0);
    let s = outbox::stats(&db).unwrap();
    assert_eq!((s.pending, s.dead), (0, 1));
    let dead = outbox::dead_letters(&db, 10).unwrap();
    assert_eq!((dead[0].target.as_str(), dead[0].attempts), ("email", 8));
    assert_eq!(outbox::next_due_at(&db).unwrap(), None);
    // No handler: the fan-out drops the event.
    outbox::emit_autocommit(&db, &event("01NOHANDLER")).unwrap();
    outbox::fan_out(&db, "01NOHANDLER", &[], 3_000).unwrap();
    assert_eq!(outbox::stats(&db).unwrap().pending, 0);
}

/// docs/23-failure-modes.md, "Outbox or logs grow unbounded": the dead-letter
/// cap prunes the oldest rows first and counts what it pruned.
#[test]
fn dead_letter_cap_prunes_oldest() {
    let (_dir, db) = open();
    let cap = DeadLetterCap {
        max_rows: 3,
        max_bytes: 1 << 20,
    };
    for i in 0..5 {
        let id = format!("01D{i}");
        outbox::emit_autocommit(&db, &event(&id)).unwrap();
        outbox::fan_out(&db, &id, &["email".into()], 0).unwrap();
        outbox::dead_letter(&db, &id, "email", 8, "e", 100 + i, cap).unwrap();
    }
    let ids: Vec<String> = outbox::dead_letters(&db, 10)
        .unwrap()
        .into_iter()
        .map(|r| r.id)
        .collect();
    assert_eq!(ids, ["01D4", "01D3", "01D2"]);
    let s = outbox::stats(&db).unwrap();
    assert_eq!((s.dead, s.dead_pruned), (3, 2));
    // The byte bound: each row is 22 + 1 bytes; 50 bytes keep two.
    let tight = DeadLetterCap {
        max_rows: 100,
        max_bytes: 50,
    };
    outbox::emit_autocommit(&db, &event("01D5")).unwrap();
    outbox::fan_out(&db, "01D5", &["email".into()], 0).unwrap();
    outbox::dead_letter(&db, "01D5", "email", 8, "e", 200, tight).unwrap();
    let ids: Vec<String> = outbox::dead_letters(&db, 10)
        .unwrap()
        .into_iter()
        .map(|r| r.id)
        .collect();
    assert_eq!(ids, ["01D5", "01D4"]);
    assert_eq!(outbox::stats(&db).unwrap().dead_pruned, 4);
}

/// ops.md section 1, "Savepoints": rolling back a savepoint undoes only its
/// statements; the outer transaction commits the rest.
#[test]
fn savepoint_rollback_leaves_the_outer_transaction_intact() {
    let (dir, db) = open();
    db.execute("create table app__t (v integer)", &[]).unwrap();
    let app = module_handle(&dir, AuthorizerPolicy::module("app"));
    app.transaction(|tx| {
        tx.execute("insert into app__t values (1)", &[])?;
        let r: Result<(), DbError> = tx.savepoint(|tx| {
            tx.execute("insert into app__t values (2)", &[])?;
            Err(DbError::Param("inner failed".into()))
        });
        assert!(r.is_err());
        assert_eq!(tx.savepoint_depth(), 0);
        tx.savepoint(|tx| tx.execute("insert into app__t values (3)", &[]))?;
        tx.execute("insert into app__t values (4)", &[])?;
        Ok::<_, DbError>(())
    })
    .unwrap();
    let vals: Vec<Value> = db
        .query("select v from app__t order by v", &[])
        .unwrap()
        .into_iter()
        .map(|r| r.get("v").unwrap().clone())
        .collect();
    assert_eq!(vals, [1, 3, 4].map(Value::Integer));
}

#[test]
fn savepoints_nest_lifo_with_a_depth_limit() {
    let (_dir, db) = open();
    db.transaction(|tx| {
        let a = tx.savepoint_begin()?;
        let b = tx.savepoint_begin()?;
        // Not the innermost.
        assert!(matches!(tx.savepoint_release(a), Err(DbError::TxState(_))));
        assert!(matches!(tx.savepoint_rollback(a), Err(DbError::TxState(_))));
        tx.savepoint_rollback(b)?;
        tx.savepoint_release(a)?;
        // Already released.
        assert!(matches!(tx.savepoint_release(a), Err(DbError::TxState(_))));
        let mut open = Vec::new();
        for _ in 0..MAX_SAVEPOINTS {
            open.push(tx.savepoint_begin()?);
        }
        assert!(matches!(tx.savepoint_begin(), Err(DbError::TxState(_))));
        assert_eq!(tx.savepoint_depth(), MAX_SAVEPOINTS);
        Ok::<_, DbError>(())
    })
    .unwrap();
}

/// Tenant SQL cannot name the platform's savepoints (`renox_sp_<n>`).
#[test]
fn tenant_sql_naming_a_platform_savepoint_is_refused() {
    let (dir, _db) = open();
    let app = module_handle(&dir, AuthorizerPolicy::module("app"));
    let e = app.execute("savepoint renox_sp_1", &[]).unwrap_err();
    assert_eq!(
        e,
        DbError::Auth {
            table: "renox_sp_1".into(),
            action: "SAVEPOINT".into()
        }
    );
    let e = app.execute("release RENOX_x", &[]).unwrap_err();
    assert!(matches!(e, DbError::Auth { .. }), "{e:?}");
}

/// `TenantDb::with_policy`: one transaction carries statements of several
/// modules, each under its own authorizer (ops.md section 1, "Module
/// argument").
#[test]
fn per_statement_policy_inside_one_transaction() {
    let (_dir, db) = open();
    for sql in [
        "create table auth__users (id text)",
        "create table org__orgs (id text)",
    ] {
        db.execute(sql, &[]).unwrap();
    }
    let auth = AuthorizerPolicy::module("auth");
    let org = AuthorizerPolicy::module("org").with_read_deps(["auth"]);
    db.transaction(|tx| {
        db.with_policy(Some(auth.clone()), || {
            tx.execute("insert into auth__users values ('u1')", &[])
        })??;
        let e = db
            .with_policy(Some(org.clone()), || {
                tx.query("select * from auth__users", &[])
            })?
            .unwrap_err();
        assert!(matches!(&e, DbError::Auth { table, .. } if table == "auth__users"));
        db.with_policy(Some(org.clone()), || {
            tx.execute("insert into org__orgs values ('o1')", &[])
        })??;
        Ok::<_, DbError>(())
    })
    .unwrap();
    assert_eq!(count(&db, "auth__users"), 1);
    assert_eq!(count(&db, "org__orgs"), 1);
    // Readers opened inside `with_policy` get the handle's policy back.
    let e = db
        .with_policy(Some(AuthorizerPolicy::module("org")), || {
            db.query("select * from auth__users", &[])
        })
        .unwrap()
        .unwrap_err();
    assert!(matches!(e, DbError::Auth { .. }));
    assert_eq!(count(&db, "auth__users"), 1);
}

fn f(name: &str, sql: &str) -> MigrationFile {
    MigrationFile {
        name: name.into(),
        sql: sql.into(),
    }
}

fn auth_module() -> ModuleMigrations {
    ModuleMigrations {
        module: "auth".into(),
        dependencies: vec![],
        files: vec![f(
            "001_users.sql",
            "create table auth__users (id text primary key, email text, password_hash text);\n\
             create view auth__public_users_v1 as select id, email from auth__users;",
        )],
    }
}

fn org_module(sql: &str) -> ModuleMigrations {
    ModuleMigrations {
        module: "org".into(),
        dependencies: vec!["auth".into()],
        files: vec![f("001_orgs.sql", sql)],
    }
}

/// manifest.md section 5 / artifact.md section 3: modules migrate in plan
/// order, every module after its dependencies, the app last.
#[test]
fn migrate_all_applies_auth_before_org() {
    let (_dir, db) = open();
    let org = org_module(
        "create table org__members (org_id text, user_id text);\n\
         -- a view over the dependency's public view is allowed\n\
         create view org__public_members_v1 as \
           select m.org_id, u.email from org__members m join auth__public_users_v1 u on u.id = m.user_id;",
    );
    let app = ModuleMigrations {
        module: "app".into(),
        dependencies: vec!["auth".into(), "org".into()],
        files: vec![f(
            "001_init.sql",
            "create table app__orders (id integer primary key, org_id text);",
        )],
    };
    let plan = [auth_module(), org.clone(), app];
    let sums: BTreeMap<String, String> = plan
        .iter()
        .flat_map(|m| {
            m.files
                .iter()
                .map(|x| (format!("{}/{}", m.module, x.name), checksum(&x.sql)))
                .collect::<Vec<_>>()
        })
        .collect();
    let report = migrate_all(&db, &plan, Some(&sums)).unwrap();
    let order: Vec<&str> = report.modules.iter().map(|(m, _)| m.as_str()).collect();
    assert_eq!(order, ["auth", "org", "app"]);
    let applied: Vec<(String, String)> = db
        .query(
            "select module, name from renox__migrations order by applied_at, rowid",
            &[],
        )
        .unwrap()
        .into_iter()
        .map(|r| match (r.get("module"), r.get("name")) {
            (Some(Value::Text(m)), Some(Value::Text(n))) => (m.clone(), n.clone()),
            other => panic!("{other:?}"),
        })
        .collect();
    assert_eq!(
        applied.iter().map(|(m, _)| m.as_str()).collect::<Vec<_>>(),
        ["auth", "org", "app"]
    );
    // A second run skips everything.
    let again = migrate_all(&db, &plan, Some(&sums)).unwrap();
    assert!(again.modules.iter().all(|(_, r)| r.applied.is_empty()));
    // org before auth is refused before anything runs.
    let e = migrate_all(&db, &[org, auth_module()], None).unwrap_err();
    assert_eq!(e.module, "org");
    assert!(
        matches!(e.error, MigrationError::Db(DbError::Param(_))),
        "{e:?}"
    );
}

/// docs/24-threat-model.md, "Module migration touching another module's
/// tables": a migration of `org` that touches `auth__users` fails, naming the
/// module, the file and the statement; the plan stops there.
#[test]
fn org_migration_touching_auth_users_fails_with_the_statement_named() {
    let (_dir, db) = open();
    let org = org_module(
        "create table org__orgs (id text primary key);\n\
         insert into auth__users (id, email) values ('evil', 'e@example.com');\n\
         create table org__after (id text);",
    );
    let app = ModuleMigrations {
        module: "app".into(),
        dependencies: vec![],
        files: vec![f("001_init.sql", "create table app__x (id text);")],
    };
    let e = migrate_all(&db, &[auth_module(), org, app], None).unwrap_err();
    assert_eq!(e.module, "org");
    assert_eq!(e.done.modules.len(), 1);
    match &e.error {
        MigrationError::Failed {
            module,
            name,
            statement,
            source,
        } => {
            assert_eq!((module.as_str(), name.as_str()), ("org", "001_orgs.sql"));
            assert_eq!(
                statement.as_deref(),
                Some("insert into auth__users (id, email) values ('evil', 'e@example.com');")
            );
            assert_eq!(
                source,
                &DbError::Auth {
                    table: "auth__users".into(),
                    action: "INSERT".into()
                }
            );
        }
        other => panic!("{other:?}"),
    }
    let msg = e.to_string();
    assert!(
        msg.contains("org/001_orgs.sql") && msg.contains("auth__users"),
        "{msg}"
    );
    // The file's transaction rolled back: no org table, no row, no record;
    // the app did not run.
    assert_eq!(count(&db, "auth__users"), 0);
    let left: Vec<String> = db
        .query(
            "select name from sqlite_master where name like 'org__%' or name like 'app__%'",
            &[],
        )
        .unwrap()
        .into_iter()
        .map(|r| format!("{:?}", r.get("name")))
        .collect();
    assert!(left.is_empty(), "{left:?}");
    // DDL on another prefix is refused the same way.
    let drop = org_module("drop view auth__public_users_v1;");
    let e = migrate_all(&db, &[auth_module(), drop], None).unwrap_err();
    assert!(
        matches!(&e.error, MigrationError::Failed { source: DbError::Auth { table, .. }, .. } if table == "auth__public_users_v1"),
        "{e:?}"
    );
}

/// manifest.md MF6: only `<dep>__public_<name>_v<n>` views of a declared
/// dependency are readable; a dependency's other tables and unversioned
/// "public" views are not.
#[test]
fn public_views_need_the_versioned_name() {
    let (dir, db) = open();
    for sql in [
        "create table auth__users (id text, email text, password_hash text)",
        "create view auth__public_users_v1 as select id, email from auth__users",
        "create view auth__public_users as select id, email from auth__users",
        "create view auth__public_x_vbeta as select id from auth__users",
        "create view auth__public__v2 as select id from auth__users",
        "insert into auth__users values ('u1', 'a@example.com', 'h')",
    ] {
        db.execute(sql, &[]).unwrap();
    }
    let org = module_handle(
        &dir,
        AuthorizerPolicy::module("org").with_read_deps(["auth"]),
    );
    assert_eq!(
        org.query("select * from auth__public_users_v1", &[])
            .unwrap()
            .len(),
        1
    );
    // An aggregate over the view reads no column of it: still allowed.
    let n = org
        .query_one("select count(*) as n from auth__public_users_v1", &[])
        .unwrap()
        .unwrap();
    assert_eq!(n.get("n"), Some(&Value::Integer(1)));
    // ...but a count of the base table itself is not.
    let e = org
        .query_one("select count(*) as n from auth__users", &[])
        .unwrap_err();
    assert!(matches!(e, DbError::Auth { .. }), "{e:?}");
    for table in [
        "auth__users",
        "auth__public_users",
        "auth__public_x_vbeta",
        "auth__public__v2",
    ] {
        let e = org
            .query(&format!("select * from {table}"), &[])
            .unwrap_err();
        assert!(matches!(e, DbError::Auth { .. }), "{table}: {e:?}");
    }
}

/// D14 (#229): the wake-up fires after a commit that inserted into the
/// outbox, once per commit, and never for a rollback or other writes.
#[test]
fn outbox_commit_hook_fires_after_commit_only() {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    let (_dir, db) = open();
    let woken = Arc::new(AtomicUsize::new(0));
    let w = woken.clone();
    db.on_outbox_commit(Some(Arc::new(move || {
        w.fetch_add(1, Ordering::SeqCst);
    })));
    db.execute("create table app__x (a)", &[]).unwrap();
    db.execute("insert into app__x values (1)", &[]).unwrap();
    assert_eq!(woken.load(Ordering::SeqCst), 0, "other tables do not wake");
    let r: Result<(), DbError> = db.transaction(|tx| {
        outbox::emit(&db, tx, &event("01ROLLBACK"))?;
        Err(DbError::Param("abort".into()))
    });
    assert!(r.is_err());
    db.execute("insert into app__x values (2)", &[]).unwrap();
    assert_eq!(woken.load(Ordering::SeqCst), 0, "a rollback does not wake");
    db.transaction(|tx| {
        outbox::emit(&db, tx, &event("01A"))?;
        outbox::emit(&db, tx, &event("01B"))
    })
    .unwrap();
    assert_eq!(woken.load(Ordering::SeqCst), 1, "one wake per commit");
    outbox::emit_autocommit(&db, &event("01C")).unwrap();
    assert_eq!(woken.load(Ordering::SeqCst), 2);
    outbox::failed(&db, "01C", "", 1, 5_000, "e").unwrap();
    assert_eq!(woken.load(Ordering::SeqCst), 2, "an update does not wake");
    db.on_outbox_commit(None);
    outbox::emit_autocommit(&db, &event("01D")).unwrap();
    assert_eq!(woken.load(Ordering::SeqCst), 2);
}
