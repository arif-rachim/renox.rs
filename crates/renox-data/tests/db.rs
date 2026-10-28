//! Tests for #18 (F1-04): open, pragmas, reader/writer routing, values,
//! transactions, busy timeout, size quota. No V8.

use std::time::{Duration, Instant};

use renox_data::{ConstraintKind, DbError, DbOptions, TenantDb, Value};

fn open(dir: &tempfile::TempDir, options: DbOptions) -> TenantDb {
    TenantDb::open(dir.path().join("tenant.db"), options).expect("open")
}

#[test]
fn pragmas_are_applied_on_every_connection() {
    let dir = tempfile::tempdir().unwrap();
    let options = DbOptions {
        busy_timeout_ms: 1234,
        max_page_count: 5000,
        readers: 3,
        ..DbOptions::default()
    };
    let db = open(&dir, options);
    let all = |name: &str| db.read_pragma(name).unwrap();

    // writer + 3 readers
    assert_eq!(all("journal_mode").len(), 4);
    for v in all("journal_mode") {
        assert_eq!(v, Value::Text("wal".into()));
    }
    for v in all("busy_timeout") {
        assert_eq!(v, Value::Integer(1234));
    }
    for v in all("foreign_keys") {
        assert_eq!(v, Value::Integer(1));
    }
    for v in all("trusted_schema") {
        assert_eq!(v, Value::Integer(0));
    }
    for v in all("max_page_count") {
        assert_eq!(v, Value::Integer(5000));
    }
    // synchronous: 1 = NORMAL; it matters on the writer only.
    assert_eq!(all("synchronous")[0], Value::Integer(1));
    assert_eq!(all("page_size")[0], Value::Integer(4096));
}

#[test]
fn defaults_follow_the_ops_contract() {
    let o = DbOptions::default();
    assert_eq!(o.busy_timeout_ms, 2_000);
    assert_eq!(o.statement_timeout_ms, 1_000);
    assert_eq!(o.readers, 2);
    assert_eq!(o.max_page_count, 100 * 1024 * 1024 / 4096);
    assert_eq!(
        DbOptions::with_quota_bytes(renox_data::PAID_QUOTA_BYTES).max_page_count,
        10 * 1024 * 1024 * 1024 / 4096
    );
}

#[test]
fn platform_tables_exist_after_open() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir, DbOptions::default());
    let row = db
        .query_one(
            "select name from sqlite_master where type = 'table' and name = ?",
            &["renox__migrations".into()],
        )
        .unwrap();
    assert!(row.is_some());
    // Re-opening an existing file is fine.
    db.close().unwrap();
    open(&dir, DbOptions::default()).close().unwrap();
}

#[test]
fn every_value_variant_round_trips() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir, DbOptions::default());
    db.execute("create table app__v (id integer primary key, v any)", &[])
        .unwrap();
    let values = [
        Value::Null,
        Value::Integer(0),
        Value::Integer(i64::MAX),
        Value::Integer(i64::MIN),
        Value::Real(3.85),
        Value::Real(-0.5e-300),
        Value::Text(String::new()),
        Value::Text("dates 1 kg — تمر".into()),
        Value::Blob(Vec::new()),
        Value::Blob(vec![0, 1, 2, 255, 0]),
    ];
    for (i, v) in values.iter().enumerate() {
        let r = db
            .execute(
                "insert into app__v (id, v) values (?, ?)",
                &[Value::Integer(i as i64), v.clone()],
            )
            .unwrap();
        assert_eq!(r.changes, 1);
        assert_eq!(r.last_insert_rowid, i as i64);
    }
    let rows = db
        .query("select id, v from app__v order by id", &[])
        .unwrap();
    assert_eq!(rows.len(), values.len());
    for (row, v) in rows.iter().zip(values.iter()) {
        assert_eq!(row.get("v"), Some(v));
        let cols: Vec<&str> = row.iter().map(|(n, _)| n).collect();
        assert_eq!(cols, ["id", "v"]);
    }
    // bool binds as INTEGER 1/0 (ops.md section 1).
    assert_eq!(Value::from(true), Value::Integer(1));
}

#[test]
fn query_one_and_insert_returning() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir, DbOptions::default());
    db.execute(
        "create table app__t (id integer primary key, name text)",
        &[],
    )
    .unwrap();
    assert_eq!(db.query_one("select * from app__t", &[]).unwrap(), None);
    // A writing statement passed to query runs on the writer.
    let rows = db
        .query(
            "insert into app__t (name) values (?) returning id",
            &["a".into()],
        )
        .unwrap();
    assert_eq!(rows[0].get("id"), Some(&Value::Integer(1)));
    // Readers see the writer's committed rows.
    let one = db
        .query_one("select name from app__t", &[])
        .unwrap()
        .unwrap();
    assert_eq!(one.get("name"), Some(&Value::Text("a".into())));
}

#[test]
fn transaction_commits_on_ok() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir, DbOptions::default());
    db.execute("create table app__t (id integer primary key)", &[])
        .unwrap();
    let n = db
        .transaction(|tx| {
            tx.execute("insert into app__t (id) values (1)", &[])?;
            tx.execute("insert into app__t (id) values (2)", &[])?;
            // The transaction sees its own writes.
            Ok::<_, DbError>(tx.query("select id from app__t", &[])?.len())
        })
        .unwrap();
    assert_eq!(n, 2);
    assert_eq!(db.query("select id from app__t", &[]).unwrap().len(), 2);
}

#[test]
fn transaction_rolls_back_on_error() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir, DbOptions::default());
    db.execute("create table app__t (id integer primary key)", &[])
        .unwrap();
    let err = db
        .transaction(|tx| {
            tx.execute("insert into app__t (id) values (1)", &[])?;
            // Primary key violation: the whole transaction is rolled back.
            tx.execute("insert into app__t (id) values (1)", &[])?;
            Ok::<_, DbError>(())
        })
        .unwrap_err();
    assert!(matches!(
        err,
        DbError::Constraint {
            kind: ConstraintKind::PrimaryKey,
            ..
        }
    ));
    assert!(db.query("select id from app__t", &[]).unwrap().is_empty());
    // The writer is usable again.
    db.execute("insert into app__t (id) values (7)", &[])
        .unwrap();
}

#[test]
fn transaction_rolls_back_on_panic() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir, DbOptions::default());
    db.execute("create table app__t (id integer primary key)", &[])
        .unwrap();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = db.transaction(|tx| {
            tx.execute("insert into app__t (id) values (1)", &[])?;
            panic!("handler bug");
            #[allow(unreachable_code)]
            Ok::<_, DbError>(())
        });
    }));
    assert!(result.is_err());
    assert!(db.query("select id from app__t", &[]).unwrap().is_empty());
    db.execute("insert into app__t (id) values (1)", &[])
        .unwrap();
}

#[test]
fn nested_transaction_and_outside_write_are_refused() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir, DbOptions::default());
    db.execute("create table app__t (id integer primary key)", &[])
        .unwrap();
    db.transaction(|_tx| {
        let nested = db.transaction(|_| Ok::<_, DbError>(()));
        assert!(matches!(nested, Err(DbError::TxState(_))));
        let outside = db.execute("insert into app__t (id) values (1)", &[]);
        assert!(matches!(outside, Err(DbError::TxState(_))));
        // A read outside the transaction runs on a reader.
        assert!(db.query("select id from app__t", &[]).unwrap().is_empty());
        Ok::<_, DbError>(())
    })
    .unwrap();
}

/// docs/contracts/ops.md section 1, "Limits": busy wait for the write lock.
#[test]
fn busy_timeout_is_observed() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(
        &dir,
        DbOptions {
            busy_timeout_ms: 200,
            ..DbOptions::default()
        },
    );
    db.execute("create table app__t (id integer primary key)", &[])
        .unwrap();
    // A second connection to the same file holds the write lock.
    let other = rusqlite::Connection::open(db.path()).unwrap();
    other.execute_batch("begin immediate").unwrap();

    let start = Instant::now();
    let err = db
        .execute("insert into app__t (id) values (1)", &[])
        .unwrap_err();
    let waited = start.elapsed();
    assert_eq!(err, DbError::Busy);
    assert_eq!(err.code(), "RENOX_DB_BUSY");
    assert!(waited >= Duration::from_millis(190), "waited {waited:?}");
    assert!(waited < Duration::from_millis(1500), "waited {waited:?}");

    other.execute_batch("commit").unwrap();
    db.execute("insert into app__t (id) values (1)", &[])
        .unwrap();
}

/// docs/23-failure-modes.md, "Database file over quota": writes fail with
/// RENOX_DB_QUOTA, reads continue.
#[test]
fn quota_makes_writes_fail_and_reads_continue() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(
        &dir,
        DbOptions {
            max_page_count: 16,
            ..DbOptions::default()
        },
    );
    db.execute("create table app__t (id integer primary key, b blob)", &[])
        .unwrap();
    db.execute("insert into app__t (b) values (zeroblob(100))", &[])
        .unwrap();
    let mut err = None;
    for _ in 0..64 {
        if let Err(e) = db.execute("insert into app__t (b) values (zeroblob(8000))", &[]) {
            err = Some(e);
            break;
        }
    }
    let err = err.expect("quota never reached");
    assert_eq!(err, DbError::QuotaExceeded);
    assert_eq!(err.code(), "RENOX_DB_QUOTA");
    assert!(!db.query("select id from app__t", &[]).unwrap().is_empty());
}

#[test]
fn usage_errors_follow_the_contract() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir, DbOptions::default());
    db.execute(
        "create table app__t (id integer primary key, name text)",
        &[],
    )
    .unwrap();

    let e = db.query("select * from app__t where id = :id", &[1.into()]);
    assert!(matches!(e, Err(DbError::Param(_))));
    let e = db.query("select * from app__t where id = ?", &[]);
    assert!(matches!(e, Err(DbError::Param(_))));
    let e = db.execute("insert into app__t (id) values (1); drop table app__t", &[]);
    assert_eq!(e.unwrap_err(), DbError::MultiStatement);
    let e = db.query("select id, name as id from app__t", &[]);
    assert_eq!(e.unwrap_err(), DbError::ColumnName("id".into()));
    let e = db.query("select nope from app__t", &[]).unwrap_err();
    assert_eq!(e.code(), "RENOX_DB_SQL");
    // Positional ?NNN is allowed.
    db.query("select * from app__t where id = ?1", &[1.into()])
        .unwrap();
    // The table was not dropped by the refused multi-statement call.
    assert!(db.query("select * from app__t", &[]).unwrap().is_empty());
}

#[test]
fn errors_and_debug_do_not_contain_the_path() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir, DbOptions::default());
    let path = dir.path().to_string_lossy().into_owned();
    assert!(!format!("{db:?}").contains(&path));
    let e = db.query("select * from missing", &[]).unwrap_err();
    assert!(!e.to_string().contains(&path));
    let e = TenantDb::open(dir.path().join("no/such/dir/x.db"), DbOptions::default()).unwrap_err();
    assert!(!e.to_string().contains(&path), "{e}");
}

#[test]
fn close_closes_all_connections() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir, DbOptions::default());
    db.execute("create table app__t (id integer primary key)", &[])
        .unwrap();
    db.close().unwrap();
    let db = open(&dir, DbOptions::default());
    assert!(db.query("select * from app__t", &[]).unwrap().is_empty());
}

/// #145: `open` opens the writer only; a reader is opened by the first
/// read that needs it, with the same pragmas.
#[test]
fn readers_are_opened_on_first_use() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("tenant.db");
    let db = TenantDb::open(&path, DbOptions::default()).unwrap();
    let fds = || {
        std::fs::read_dir("/proc/self/fd")
            .unwrap()
            .filter_map(|e| std::fs::read_link(e.unwrap().path()).ok())
            .filter(|t| t == &path)
            .count()
    };
    assert_eq!(fds(), 1, "only the writer holds the file after open");
    db.execute("create table app__t (x integer)", &[]).unwrap();
    assert_eq!(fds(), 1, "a write does not open a reader");
    db.query("select * from app__t", &[]).unwrap();
    assert_eq!(fds(), 2, "the first read opened one reader");
    for v in db.read_pragma("busy_timeout").unwrap() {
        assert_eq!(v, Value::Integer(2_000));
    }
    db.close().unwrap();
}
