//! #311: at the disk's write watermark the data layer refuses tenant and
//! module writes (`RENOX_DB_QUOTA`), reads go on, and platform work is not
//! refused (`docs/23-failure-modes.md` "Disk full on node").
//!
//! The watermark is one flag per process, so the tests of this file take
//! `SERIAL` and never run side by side.

use std::sync::Mutex;

use renox_data::{DbError, DbOptions, MigrationFile, TenantDb, migrate};

static SERIAL: Mutex<()> = Mutex::new(());

/// Clears the watermark when a test ends, also when it panics.
struct Watermark;

impl Watermark {
    fn on() -> Watermark {
        renox_data::limits::refuse_writes(true);
        Watermark
    }
}

impl Drop for Watermark {
    fn drop(&mut self) {
        renox_data::limits::refuse_writes(false);
    }
}

#[test]
fn writes_are_refused_at_the_watermark_and_platform_work_is_not() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let dir = tempfile::tempdir().unwrap();
    let db = TenantDb::open(dir.path().join("app.db"), DbOptions::default()).unwrap();
    db.execute("create table app__t (x integer)", &[]).unwrap();
    db.execute("insert into app__t (x) values (1)", &[])
        .unwrap();
    let watermark = Watermark::on();
    let refused = db.execute("insert into app__t (x) values (2)", &[]);
    assert!(
        matches!(refused, Err(DbError::WritesRefused)),
        "{refused:?}"
    );
    let err = refused.unwrap_err();
    // Same code as the file quota (the contract is unchanged), but the
    // message names the node's disk, not the tenant's own quota (#382).
    assert_eq!(err.code(), "RENOX_DB_QUOTA");
    assert!(err.to_string().contains("write watermark"), "{err}");
    assert_eq!(
        db.query("select x from app__t", &[]).unwrap().len(),
        1,
        "reads go on"
    );
    let platform = db
        .with_policy(None, || {
            db.execute(
                "insert into renox__outbox_meta (key, value) values ('k', 1)",
                &[],
            )
        })
        .unwrap();
    assert!(
        platform.is_ok(),
        "platform work is not refused: {platform:?}"
    );
    drop(watermark);
    assert!(db.execute("insert into app__t (x) values (3)", &[]).is_ok());
}

/// #382: a deployment's migrations are platform work and apply at the
/// write watermark. Before the fix the bookkeeping insert into
/// `renox__migrations` (run under `with_writer_policy(None)`) counted as a
/// tenant write, so activation failed at `stage=migrate` with
/// `QuotaExceeded` on a node past 95 % (`docs/23-failure-modes.md` "Disk
/// full on node": platform work is not refused).
#[test]
fn migrations_apply_at_the_watermark() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let dir = tempfile::tempdir().unwrap();
    let db = TenantDb::open(dir.path().join("app.db"), DbOptions::default()).unwrap();
    let files = [MigrationFile {
        name: "001_init.sql".into(),
        sql: "create table app__items (id integer primary key, name text not null);".into(),
    }];
    let _watermark = Watermark::on();
    let report = migrate(&db, "app", &files).expect("migrations apply at the watermark");
    assert_eq!(report.applied, ["001_init.sql"]);
    let rows = db
        .with_policy(None, || {
            db.query(
                "select name from renox__migrations where module = 'app'",
                &[],
            )
        })
        .unwrap()
        .unwrap();
    assert_eq!(rows.len(), 1, "the bookkeeping row is written");
    // The platform scope ends with the migration: a tenant write after it is
    // refused again, and so is one through the migrated table.
    let after = db.execute("insert into app__items (name) values ('a')", &[]);
    assert!(matches!(after, Err(DbError::WritesRefused)), "{after:?}");
}
