//! Tests for #20 (F1-06): statement time limit, request deadline, busy wait,
//! WAL checkpoints, and stats for the meter.

use std::time::{Duration, Instant};

use renox_data::{CheckpointMode, DbError, DbOptions, QueryCtx, TenantDb, Value};

const RUNAWAY: &str = "with recursive c(x) as (select 1 union all select x + 1 from c) \
                       select count(*) as n from c";

fn open(dir: &tempfile::TempDir, options: DbOptions) -> TenantDb {
    TenantDb::open(dir.path().join("tenant.db"), options).unwrap()
}

fn wal_len(dir: &tempfile::TempDir) -> u64 {
    std::fs::metadata(dir.path().join("tenant.db-wal")).map_or(0, |m| m.len())
}

fn table(db: &TenantDb) {
    db.execute(
        "create table app__t (id integer primary key, body text)",
        &[],
    )
    .unwrap();
}

/// docs/23-failure-modes.md, "Runaway query": progress_handler interrupts
/// the statement with RENOX_DB_TIMEOUT at the statement limit.
#[test]
fn runaway_recursive_query_stops_at_the_statement_limit() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(
        &dir,
        DbOptions {
            statement_timeout_ms: 100,
            ..DbOptions::default()
        },
    );
    for _ in 0..3 {
        let start = Instant::now();
        let e = db.query(RUNAWAY, &[]).unwrap_err();
        let took = start.elapsed();
        assert_eq!(e, DbError::Timeout);
        assert_eq!(e.code(), "RENOX_DB_TIMEOUT");
        assert!(
            took >= Duration::from_millis(100) && took <= Duration::from_millis(120),
            "took {took:?}"
        );
    }
    // On the writer too, and the handle stays usable.
    table(&db);
    let e = db
        .execute(
            &format!("insert into app__t (body) select n from ({RUNAWAY})"),
            &[],
        )
        .unwrap_err();
    assert_eq!(e, DbError::Timeout);
    assert!(db.query("select * from app__t", &[]).unwrap().is_empty());
    db.execute("insert into app__t (body) values ('ok')", &[])
        .unwrap();
}

#[test]
fn request_deadline_stops_a_statement_before_the_statement_limit() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir, DbOptions::default()); // 1 s statement limit
    let ctx = QueryCtx::with_deadline(Instant::now() + Duration::from_millis(50));
    let start = Instant::now();
    assert_eq!(
        db.query_with(&ctx, RUNAWAY, &[]).unwrap_err(),
        DbError::Timeout
    );
    let took = start.elapsed();
    assert!(took <= Duration::from_millis(70), "took {took:?}");
}

#[test]
fn past_deadline_fails_immediately_without_running() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir, DbOptions::default());
    table(&db);
    let past = QueryCtx::with_deadline(Instant::now() - Duration::from_millis(1));
    let start = Instant::now();
    assert_eq!(
        db.execute_with(&past, "insert into app__t (body) values ('x')", &[])
            .unwrap_err(),
        DbError::Timeout
    );
    assert_eq!(
        db.query_with(&past, "select 1", &[]).unwrap_err(),
        DbError::Timeout
    );
    assert_eq!(
        db.query_one_with(&past, "select 1", &[]).unwrap_err(),
        DbError::Timeout
    );
    assert!(start.elapsed() < Duration::from_millis(5));
    assert!(db.query("select * from app__t", &[]).unwrap().is_empty());
}

/// docs/contracts/ops.md section 1: RENOX_DB_TIMEOUT rolls the transaction back.
#[test]
fn timeout_inside_a_transaction_rolls_it_back() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(
        &dir,
        DbOptions {
            statement_timeout_ms: 50,
            ..DbOptions::default()
        },
    );
    table(&db);
    let result = db.transaction(|tx| {
        tx.execute("insert into app__t (body) values ('a')", &[])?;
        // The handler catches the timeout and carries on.
        assert_eq!(tx.query(RUNAWAY, &[]).unwrap_err(), DbError::Timeout);
        assert!(matches!(
            tx.execute("insert into app__t (body) values ('b')", &[]),
            Err(DbError::TxState(_))
        ));
        Ok::<_, DbError>(())
    });
    assert_eq!(result.unwrap_err(), DbError::Timeout);
    assert!(db.query("select * from app__t", &[]).unwrap().is_empty());
    db.execute("insert into app__t (body) values ('c')", &[])
        .unwrap();
}

/// docs/contracts/ops.md section 1: busy wait = min(busy_timeout, remaining deadline).
#[test]
fn busy_wait_is_capped_by_the_deadline() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir, DbOptions::default()); // 2 s busy timeout
    table(&db);
    let other = rusqlite::Connection::open(db.path()).unwrap();
    other.execute_batch("begin immediate").unwrap();

    let ctx = QueryCtx::with_deadline(Instant::now() + Duration::from_millis(150));
    let start = Instant::now();
    let e = db
        .execute_with(&ctx, "insert into app__t (body) values ('x')", &[])
        .unwrap_err();
    let took = start.elapsed();
    assert_eq!(e, DbError::Busy);
    assert!(took < Duration::from_millis(600), "took {took:?}");
    // The configured busy timeout is back after the call.
    assert_eq!(
        db.read_pragma("busy_timeout").unwrap()[0],
        Value::Integer(2000)
    );
    assert_eq!(db.stats().busy_waits, 1);
    other.execute_batch("commit").unwrap();
}

#[test]
fn wait_for_the_write_lock_does_not_count_against_the_statement_limit() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(
        &dir,
        DbOptions {
            statement_timeout_ms: 50,
            busy_timeout_ms: 2_000,
            ..DbOptions::default()
        },
    );
    table(&db);
    let path = db.path().to_path_buf();
    let holder = std::thread::spawn(move || {
        let other = rusqlite::Connection::open(path).unwrap();
        other.execute_batch("begin immediate").unwrap();
        std::thread::sleep(Duration::from_millis(200));
        other.execute_batch("commit").unwrap();
    });
    std::thread::sleep(Duration::from_millis(30));
    // Waits ~170 ms for the lock, longer than the 50 ms statement limit.
    db.execute("insert into app__t (body) values ('x')", &[])
        .unwrap();
    holder.join().unwrap();
}

#[test]
fn truncate_checkpoint_shrinks_the_wal() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir, DbOptions::default());
    table(&db);
    for i in 0..50 {
        db.execute(
            "insert into app__t (body) values (?)",
            &[Value::Text(format!("{i:0>2000}"))],
        )
        .unwrap();
    }
    assert!(wal_len(&dir) > 0);
    assert!(db.wal_pages() > 0);
    let r = db.checkpoint(CheckpointMode::Truncate).unwrap();
    assert_eq!(r.wal_frames, r.checkpointed_frames);
    assert_eq!(wal_len(&dir), 0);
    assert_eq!(db.wal_pages(), 0);
    assert_eq!(db.query("select id from app__t", &[]).unwrap().len(), 50);
}

#[test]
fn maybe_checkpoint_runs_only_above_the_threshold() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(
        &dir,
        DbOptions {
            wal_checkpoint_pages: 20,
            ..DbOptions::default()
        },
    );
    table(&db);
    db.execute("insert into app__t (body) values ('x')", &[])
        .unwrap();
    assert!(db.wal_pages() < 20);
    assert_eq!(db.maybe_checkpoint().unwrap(), None);
    // About 3 pages per commit; stay below the 4 x 20 safety net.
    for _ in 0..8 {
        db.execute(
            "insert into app__t (body) values (?)",
            &[Value::Text("y".repeat(3000))],
        )
        .unwrap();
    }
    assert!(db.wal_pages() >= 20, "wal pages {}", db.wal_pages());
    let r = db.maybe_checkpoint().unwrap().expect("checkpoint ran");
    assert!(r.checkpointed_frames > 0);
    assert_eq!(db.wal_pages(), 0);
}

#[test]
fn wal_stays_bounded_without_scheduled_checkpoints() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(
        &dir,
        DbOptions {
            wal_checkpoint_pages: 10,
            ..DbOptions::default()
        },
    );
    table(&db);
    for _ in 0..300 {
        db.execute(
            "insert into app__t (body) values (?)",
            &[Value::Text("z".repeat(1000))],
        )
        .unwrap();
    }
    // The safety net checkpoints at 4 x 10 pages on commit.
    assert!(db.wal_pages() < 45, "wal pages {}", db.wal_pages());
    assert!(wal_len(&dir) < 60 * 4120, "wal bytes {}", wal_len(&dir));
}

#[test]
fn close_truncates_the_wal() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir, DbOptions::default());
    table(&db);
    for _ in 0..20 {
        db.execute(
            "insert into app__t (body) values (?)",
            &[Value::Text("w".repeat(2000))],
        )
        .unwrap();
    }
    assert!(wal_len(&dir) > 0);
    db.close().unwrap();
    assert_eq!(wal_len(&dir), 0);
    let db = open(&dir, DbOptions::default());
    assert_eq!(db.query("select id from app__t", &[]).unwrap().len(), 20);
}

#[test]
fn stats_count_rows_time_and_failures() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(
        &dir,
        DbOptions {
            statement_timeout_ms: 20,
            ..DbOptions::default()
        },
    );
    table(&db);
    let before = db.stats();
    for i in 0..3 {
        db.execute("insert into app__t (body) values (?)", &[Value::Integer(i)])
            .unwrap();
    }
    db.execute("update app__t set body = 'u'", &[]).unwrap(); // 3 rows changed
    assert_eq!(db.query("select * from app__t", &[]).unwrap().len(), 3);
    db.query_one("select * from app__t", &[]).unwrap();
    db.transaction(|tx| {
        tx.execute("delete from app__t where id = 1", &[])?;
        tx.query("select * from app__t", &[])
    })
    .unwrap();
    let _ = db.query(RUNAWAY, &[]);

    let s = db.stats().since(&before);
    assert_eq!(s.statements, 9);
    assert_eq!(s.rows_written, 3 + 3 + 1);
    // The timed-out count(*) returns no row.
    assert_eq!(s.rows_read, 3 + 1 + 2);
    assert_eq!(s.db_rows(), s.rows_read + s.rows_written);
    assert_eq!(s.timeouts, 1);
    assert!(s.db_ms() >= 20.0, "db_ms {}", s.db_ms());
}
