//! #311: at the disk's write watermark the data layer refuses tenant and
//! module writes (`RENOX_DB_QUOTA`), reads go on, and platform work is not
//! refused (`docs/23-failure-modes.md` "Disk full on node").

use renox_data::{DbError, DbOptions, TenantDb};

#[test]
fn writes_are_refused_at_the_watermark_and_platform_work_is_not() {
    let dir = std::env::temp_dir().join(format!("renox-watermark-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let db = TenantDb::open(dir.join("app.db"), DbOptions::default()).unwrap();
    db.execute("create table app__t (x integer)", &[]).unwrap();
    db.execute("insert into app__t (x) values (1)", &[])
        .unwrap();
    renox_data::limits::refuse_writes(true);
    let refused = db.execute("insert into app__t (x) values (2)", &[]);
    assert!(
        matches!(refused, Err(DbError::QuotaExceeded)),
        "{refused:?}"
    );
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
    renox_data::limits::refuse_writes(false);
    assert!(db.execute("insert into app__t (x) values (3)", &[]).is_ok());
    let _ = std::fs::remove_dir_all(&dir);
}
