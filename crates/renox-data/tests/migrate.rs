//! Tests for #21 (F1-07): forward-only migration runner with checksums.
//!
//! The refusal tests prove the F1 part of "Module migration touching another
//! module's tables" in docs/24-threat-model.md (authorizer attached to
//! migration connections) and the "renox__migrations unchanged" outcome of
//! "Migration fails half-way during activation" in docs/23-failure-modes.md.

use std::collections::BTreeMap;

use renox_data::{
    AuthorizerPolicy, DbError, DbOptions, MigrationError, MigrationFile, TenantDb, Value, checksum,
    migrate, migrate_with_checksums,
};

fn file(name: &str, sql: &str) -> MigrationFile {
    MigrationFile {
        name: name.into(),
        sql: sql.into(),
    }
}

fn two_files() -> Vec<MigrationFile> {
    vec![
        file(
            "001_init.sql",
            "create table app__products (id text primary key, name text not null);\n\
             create index app__products_name on app__products (name);",
        ),
        file(
            "002_stock.sql",
            "alter table app__products add column stock integer not null default 0;\n\
             create table app__orders (id integer primary key autoincrement, \
               product_id text not null references app__products (id));",
        ),
    ]
}

fn db() -> (tempfile::TempDir, TenantDb) {
    let dir = tempfile::tempdir().unwrap();
    let db = TenantDb::open(dir.path().join("tenant.db"), DbOptions::default()).unwrap();
    (dir, db)
}

fn recorded(db: &TenantDb) -> Vec<(String, String, String)> {
    db.query(
        "select module, name, checksum from renox__migrations order by module, name",
        &[],
    )
    .unwrap()
    .into_iter()
    .map(|r| {
        let t = |c: &str| match r.get(c) {
            Some(Value::Text(s)) => s.clone(),
            other => panic!("{c}: {other:?}"),
        };
        (t("module"), t("name"), t("checksum"))
    })
    .collect()
}

fn table_exists(db: &TenantDb, name: &str) -> bool {
    db.query_one("select 1 from sqlite_master where name = ?", &[name.into()])
        .unwrap()
        .is_some()
}

#[test]
fn applies_files_in_order_and_records_them() {
    let (_dir, db) = db();
    let mut files = two_files();
    files.reverse(); // order comes from the names, not the slice
    let report = migrate(&db, "app", &files).unwrap();
    assert_eq!(report.applied, ["001_init.sql", "002_stock.sql"]);
    assert!(report.skipped.is_empty());
    db.execute(
        "insert into app__products (id, name, stock) values ('p1', 'Dates', 3)",
        &[],
    )
    .unwrap();
    let rec = recorded(&db);
    assert_eq!(rec.len(), 2);
    assert_eq!(
        rec[0],
        (
            "app".into(),
            "001_init.sql".into(),
            checksum(&two_files()[0].sql)
        )
    );
    let at = db
        .query_one("select min(applied_at) as t from renox__migrations", &[])
        .unwrap()
        .unwrap();
    assert!(matches!(at.get("t"), Some(Value::Integer(t)) if *t > 1_700_000_000));
}

#[test]
fn rerun_is_a_no_op_and_new_files_are_applied() {
    let (_dir, db) = db();
    migrate(&db, "app", &two_files()).unwrap();
    let report = migrate(&db, "app", &two_files()).unwrap();
    assert!(report.applied.is_empty());
    assert_eq!(report.skipped, ["001_init.sql", "002_stock.sql"]);

    let mut files = two_files();
    files.push(file(
        "010_notes.sql",
        "create table app__notes (id integer primary key);",
    ));
    let report = migrate(&db, "app", &files).unwrap();
    assert_eq!(report.applied, ["010_notes.sql"]);
    assert_eq!(recorded(&db).len(), 3);

    // Rename and drop of an autoincrement table (SQLite updates
    // sqlite_sequence for both).
    db.execute(
        "insert into app__products (id, name) values ('p', 'n')",
        &[],
    )
    .unwrap();
    db.execute("insert into app__orders (product_id) values ('p')", &[])
        .unwrap();
    files.push(file(
        "011_rename.sql",
        "alter table app__orders rename to app__orders_v2;",
    ));
    files.push(file("012_drop.sql", "drop table app__orders_v2;"));
    let report = migrate(&db, "app", &files).unwrap();
    assert_eq!(report.applied, ["011_rename.sql", "012_drop.sql"]);
    assert!(!table_exists(&db, "app__orders_v2"));
}

/// ADR D17: an applied file cannot change silently.
#[test]
fn modified_applied_file_is_refused() {
    let (_dir, db) = db();
    migrate(&db, "app", &two_files()).unwrap();
    let mut files = two_files();
    files[0].sql.push_str("\n-- edited");
    files.push(file(
        "003_more.sql",
        "create table app__more (id integer primary key);",
    ));
    let e = migrate(&db, "app", &files).unwrap_err();
    assert_eq!(
        e,
        MigrationError::ChecksumMismatch {
            name: "001_init.sql".into()
        }
    );
    // Nothing ran, not even the new file.
    assert!(!table_exists(&db, "app__more"));
    assert_eq!(recorded(&db).len(), 2);
}

#[test]
fn files_must_match_checksums_json() {
    let (_dir, db) = db();
    let files = two_files();
    let mut sums: BTreeMap<String, String> = files
        .iter()
        .map(|f| (format!("app/{}", f.name), checksum(&f.sql)))
        .collect();
    migrate_with_checksums(&db, "app", &files[..1], &sums).unwrap();

    sums.insert("app/002_stock.sql".into(), "0".repeat(64));
    let e = migrate_with_checksums(&db, "app", &files, &sums).unwrap_err();
    assert_eq!(
        e,
        MigrationError::ChecksumMismatch {
            name: "002_stock.sql".into()
        }
    );
    sums.remove("app/002_stock.sql");
    let e = migrate_with_checksums(&db, "app", &files, &sums).unwrap_err();
    assert!(matches!(e, MigrationError::ChecksumMismatch { .. }));
    assert_eq!(recorded(&db).len(), 1);
}

#[test]
fn checksum_is_lower_case_sha256_hex() {
    assert_eq!(
        checksum(""),
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
}

#[test]
fn table_outside_the_prefix_is_refused_and_rolled_back() {
    let (_dir, db) = db();
    let files = [file(
        "001_init.sql",
        "create table app__ok (id integer primary key);\n\
         create table other__t (id integer primary key);",
    )];
    let e = migrate(&db, "app", &files).unwrap_err();
    assert_eq!(
        e,
        MigrationError::Failed {
            module: "app".into(),
            name: "001_init.sql".into(),
            statement: Some("create table other__t (id integer primary key);".into()),
            source: DbError::Auth {
                table: "other__t".into(),
                action: "CREATE_TABLE".into()
            }
        }
    );
    assert!(!table_exists(&db, "app__ok"));
    assert!(!table_exists(&db, "other__t"));
    assert!(recorded(&db).is_empty());
}

#[test]
fn migration_cannot_touch_another_modules_data_or_the_platform_tables() {
    let (_dir, db) = db();
    db.execute("create table auth__users (id text primary key)", &[])
        .unwrap();
    for sql in [
        "insert into auth__users values ('x');",
        "drop table auth__users;",
        "insert into renox__migrations values ('app', '999_x.sql', 'x', 0);",
        "pragma foreign_keys = off;",
        "attach database ':memory:' as x;",
        "commit; create table other__t (id integer);",
    ] {
        let e = migrate(&db, "app", &[file("001_x.sql", sql)]).unwrap_err();
        assert!(
            matches!(
                e,
                MigrationError::Failed {
                    source: DbError::Auth { .. },
                    ..
                }
            ),
            "{sql}: {e:?}"
        );
    }
    assert!(table_exists(&db, "auth__users"));
    assert!(recorded(&db).is_empty());
}

#[test]
fn rename_out_of_the_prefix_is_refused() {
    let (_dir, db) = db();
    migrate(
        &db,
        "app",
        &[file(
            "001_init.sql",
            "create table app__a (id integer primary key);",
        )],
    )
    .unwrap();
    let e = migrate(
        &db,
        "app",
        &[
            file(
                "001_init.sql",
                "create table app__a (id integer primary key);",
            ),
            file("002_rename.sql", "alter table app__a rename to auth__a;"),
        ],
    )
    .unwrap_err();
    assert_eq!(
        e,
        MigrationError::OutsidePrefix {
            name: "002_rename.sql".into(),
            object: "auth__a".into()
        }
    );
    assert!(table_exists(&db, "app__a"));
    assert!(!table_exists(&db, "auth__a"));
    assert_eq!(recorded(&db).len(), 1);
}

#[test]
fn failing_statement_leaves_renox_migrations_unchanged() {
    let (_dir, db) = db();
    let mut files = two_files();
    files.push(file(
        "003_broken.sql",
        "create table app__half (id integer primary key);\n\
         insert into app__nope values (1);",
    ));
    let e = migrate(&db, "app", &files).unwrap_err();
    match e {
        MigrationError::Failed { name, source, .. } => {
            assert_eq!(name, "003_broken.sql");
            assert_eq!(source.code(), "RENOX_DB_SQL");
        }
        other => panic!("{other:?}"),
    }
    // Earlier files stay applied; the failing file left nothing behind.
    let names: Vec<String> = recorded(&db).into_iter().map(|r| r.1).collect();
    assert_eq!(names, ["001_init.sql", "002_stock.sql"]);
    assert!(!table_exists(&db, "app__half"));
}

#[test]
fn names_are_validated() {
    let (_dir, db) = db();
    for bad in [
        "1_init.sql",
        "001init.sql",
        "001_Init.sql",
        "001_init.SQL",
        "001_.sql",
        "x001_a.sql",
        "001_a-b.sql",
    ] {
        let e = migrate(&db, "app", &[file(bad, "select 1;")]).unwrap_err();
        assert_eq!(e, MigrationError::InvalidName { name: bad.into() }, "{bad}");
    }
    let e = migrate(
        &db,
        "app",
        &[
            file("001_a.sql", "select 1;"),
            file("001_a.sql", "select 2;"),
        ],
    )
    .unwrap_err();
    assert_eq!(
        e,
        MigrationError::DuplicateName {
            name: "001_a.sql".into()
        }
    );
    // Gaps are allowed; long numbers too.
    migrate(
        &db,
        "app",
        &[
            file("001_a.sql", "create table app__a (id integer);"),
            file("0007_b.sql", "create table app__b (id integer);"),
        ],
    )
    .unwrap();
    assert!(matches!(
        migrate(&db, "renox", &[]),
        Err(MigrationError::Db(DbError::Param(_)))
    ));
}

#[test]
fn runs_on_a_module_handle_and_keeps_its_policy() {
    let dir = tempfile::tempdir().unwrap();
    let db = TenantDb::open(dir.path().join("tenant.db"), DbOptions::default())
        .unwrap()
        .with_authorizer(AuthorizerPolicy::module("app"))
        .unwrap();
    migrate(&db, "app", &two_files()).unwrap();
    // The handle still refuses DDL and other prefixes after the run.
    assert!(matches!(
        db.execute("create table app__x (id integer)", &[]),
        Err(DbError::Auth { .. })
    ));
    assert!(matches!(
        db.query("select * from renox__migrations", &[]),
        Err(DbError::Auth { .. })
    ));
    db.query("select * from app__products", &[]).unwrap();
}
