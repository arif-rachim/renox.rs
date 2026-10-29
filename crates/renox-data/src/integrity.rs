//! Integrity of a tenant file (#103, `docs/23-failure-modes.md` "SQLite
//! file corrupted, WAL unreadable"): a time-bounded `PRAGMA quick_check`
//! on open, a full `PRAGMA integrity_check` on demand, and the
//! classification of the SQLite errors that mean the file is damaged
//! (`SQLITE_CORRUPT`, `SQLITE_NOTADB`).
//!
//! A damaged file is never served: the caller answers 503
//! `RENOX_DB_UNAVAILABLE` (`docs/contracts/errors.md`, `reason:
//! integrity`) and restores it from the replica.

use std::path::Path;
use std::time::{Duration, Instant};

use rusqlite::ffi;

use crate::db::{DbOptions, TenantDb};
use crate::error::DbError;
use crate::limits::QueryCtx;
use crate::value::Value;

/// The time `quick_check` may take on open. A check that runs out of time
/// reports [`Integrity::TimedOut`]: the file is opened (a large file is
/// not condemned for being large) and the full check runs later.
pub const QUICK_CHECK_LIMIT: Duration = Duration::from_secs(5);

/// The error code of a damaged file (`errors.md`).
pub const UNAVAILABLE_CODE: &str = "RENOX_DB_UNAVAILABLE";

/// What a check found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Integrity {
    /// Every page and index the check reads is sound.
    Ok,
    /// The check (or opening the file) found damage; the text is SQLite's
    /// first finding, for the operator log only (it names pages, never
    /// row values or the file path).
    Corrupt(String),
    /// The check did not finish within its limit.
    TimedOut,
}

impl Integrity {
    pub fn is_corrupt(&self) -> bool {
        matches!(self, Integrity::Corrupt(_))
    }
}

/// Whether `e` says the file itself is damaged: `SQLITE_CORRUPT` (and its
/// extended codes) or `SQLITE_NOTADB`. Busy, I/O, quota and authorizer
/// errors are not damage.
pub fn is_corruption(e: &DbError) -> bool {
    match e {
        DbError::Sqlite { code, .. } => {
            let primary = code & 0xff;
            primary == ffi::SQLITE_CORRUPT || primary == ffi::SQLITE_NOTADB
        }
        DbError::Open(message) => {
            let m = message.to_ascii_lowercase();
            m.contains("malformed") || m.contains("not a database")
        }
        _ => false,
    }
}

/// `PRAGMA quick_check` on `db` (a reader: it sees every committed
/// page), bounded by `limit` (and by
/// the handle's statement time limit, whichever is shorter).
pub fn quick_check(db: &TenantDb, limit: Duration) -> Integrity {
    run_check(db, "pragma quick_check", limit)
}

/// `PRAGMA integrity_check` (indexes against tables, too) bounded by
/// `limit`: the on-demand check of an operator or an idle-file sweep.
pub fn integrity_check(db: &TenantDb, limit: Duration) -> Integrity {
    run_check(db, "pragma integrity_check", limit)
}

fn run_check(db: &TenantDb, sql: &str, limit: Duration) -> Integrity {
    let ctx = QueryCtx::with_deadline(Instant::now() + limit);
    let rows = db.with_policy(None, || db.execute_rows_with(&ctx, sql));
    match rows {
        Ok(Ok(values)) => verdict(&values),
        Ok(Err(DbError::Timeout)) | Err(DbError::Timeout) => Integrity::TimedOut,
        Ok(Err(e)) | Err(e) => {
            if is_corruption(&e) {
                Integrity::Corrupt(e.to_string())
            } else {
                // Not damage (busy, I/O): the check did not answer.
                Integrity::TimedOut
            }
        }
    }
}

/// `ok` alone is sound; anything else is SQLite's list of findings.
fn verdict(values: &[Value]) -> Integrity {
    let mut findings = values.iter().filter_map(|v| match v {
        Value::Text(t) if t == "ok" => None,
        Value::Text(t) => Some(t.clone()),
        other => Some(format!("{other:?}")),
    });
    match findings.next() {
        None if !values.is_empty() => Integrity::Ok,
        None => Integrity::Corrupt("no answer".into()),
        Some(first) => Integrity::Corrupt(first),
    }
}

/// Opens `path` and runs [`quick_check`] within `limit`. A file SQLite
/// cannot open because it is damaged is [`Integrity::Corrupt`]; a missing
/// file is not checked (`Ok`): there is nothing to be damaged. The
/// connection is closed before returning.
pub fn check_file(path: &Path, limit: Duration) -> Integrity {
    if !path.exists() {
        return Integrity::Ok;
    }
    let options = DbOptions {
        readers: 1,
        statement_timeout_ms: limit.as_millis().max(1) as u64,
        ..DbOptions::default()
    };
    match TenantDb::open(path, options) {
        Ok(db) => {
            let verdict = quick_check(&db, limit);
            let _ = db.close();
            verdict
        }
        Err(e) if is_corruption(&e) => Integrity::Corrupt(e.to_string()),
        // Opening failed for another reason (permissions, I/O): reported
        // as damage too, because the file cannot be served either way.
        Err(e) => Integrity::Corrupt(format!("open: {e}")),
    }
}

/// Why [`TenantDb::open_checked`] refused a file.
#[derive(Debug, Clone, PartialEq)]
pub enum CheckedOpenError {
    /// The file is damaged: 503 `RENOX_DB_UNAVAILABLE`, `reason: integrity`.
    Corrupt(String),
    /// Any other open failure.
    Db(DbError),
}

impl CheckedOpenError {
    pub fn code(&self) -> &'static str {
        match self {
            CheckedOpenError::Corrupt(_) => UNAVAILABLE_CODE,
            CheckedOpenError::Db(e) => e.code(),
        }
    }
}

impl std::fmt::Display for CheckedOpenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CheckedOpenError::Corrupt(why) => write!(f, "integrity check failed: {why}"),
            CheckedOpenError::Db(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for CheckedOpenError {}

impl TenantDb {
    /// [`TenantDb::open`] followed by [`quick_check`] within `limit`. A
    /// damaged file is closed again and refused; a check that runs out of
    /// time opens the file (see [`QUICK_CHECK_LIMIT`]).
    pub fn open_checked(
        path: impl AsRef<Path>,
        options: DbOptions,
        limit: Duration,
    ) -> Result<TenantDb, CheckedOpenError> {
        let db = TenantDb::open(path, options).map_err(|e| {
            if is_corruption(&e) {
                CheckedOpenError::Corrupt(e.to_string())
            } else {
                CheckedOpenError::Db(e)
            }
        })?;
        match quick_check(&db, limit) {
            Integrity::Corrupt(why) => {
                let _ = db.close();
                Err(CheckedOpenError::Corrupt(why))
            }
            Integrity::Ok | Integrity::TimedOut => Ok(db),
        }
    }

    /// Every row's first column of `sql`, bounded by `ctx`
    /// (pragmas that answer several rows, such as the checks above).
    fn execute_rows_with(&self, ctx: &QueryCtx, sql: &str) -> crate::Result<Vec<Value>> {
        let rows = self.query_with(ctx, sql, &[])?;
        Ok(rows
            .into_iter()
            .filter_map(|r| r.into_columns().into_iter().next().map(|(_, v)| v))
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Seek, SeekFrom, Write};

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "renox-integrity-{}-{name}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("app.db")
    }

    fn populated(path: &Path) {
        let db = TenantDb::open(path, DbOptions::default()).unwrap();
        db.execute(
            "create table app__t (id integer primary key, v text not null)",
            &[],
        )
        .unwrap();
        db.execute("create index app__t_v on app__t (v)", &[])
            .unwrap();
        db.transaction(|tx| {
            for i in 0..2_000 {
                tx.execute(
                    "insert into app__t (v) values (?)",
                    &[format!("row {i:05} {}", "x".repeat(64)).into()],
                )?;
            }
            Ok::<_, DbError>(())
        })
        .unwrap();
        db.close().unwrap();
    }

    #[test]
    fn a_sound_file_passes_both_checks() {
        let path = scratch("sound");
        populated(&path);
        assert_eq!(check_file(&path, QUICK_CHECK_LIMIT), Integrity::Ok);
        let db = TenantDb::open_checked(&path, DbOptions::default(), QUICK_CHECK_LIMIT).unwrap();
        assert_eq!(integrity_check(&db, QUICK_CHECK_LIMIT), Integrity::Ok);
        db.close().unwrap();
    }

    /// `docs/23-failure-modes.md` "SQLite file corrupted, WAL unreadable":
    /// a header overwritten with garbage is refused on open.
    #[test]
    fn garbage_is_refused_as_not_a_database() {
        let path = scratch("garbage");
        populated(&path);
        std::fs::write(&path, vec![0xAB; 8192]).unwrap();
        assert!(check_file(&path, QUICK_CHECK_LIMIT).is_corrupt());
        let err = TenantDb::open_checked(&path, DbOptions::default(), QUICK_CHECK_LIMIT)
            .expect_err("a damaged file is refused");
        assert!(matches!(err, CheckedOpenError::Corrupt(_)), "{err:?}");
        assert_eq!(err.code(), "RENOX_DB_UNAVAILABLE");
    }

    /// Same row: pages overwritten in the middle of a sound file (header
    /// intact) are found by `quick_check`.
    #[test]
    fn overwritten_pages_are_found_by_quick_check() {
        let path = scratch("pages");
        populated(&path);
        let len = std::fs::metadata(&path).unwrap().len();
        let mut f = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
        // Pages 2.. are the table and index b-trees; leave page 1 (header
        // and schema) alone so the file still opens.
        let page = crate::PAGE_SIZE;
        let mut at = page;
        while at + page <= len {
            f.seek(SeekFrom::Start(at)).unwrap();
            f.write_all(&vec![0x5A; 512]).unwrap();
            at += page * 3;
        }
        f.sync_all().unwrap();
        drop(f);
        let verdict = check_file(&path, QUICK_CHECK_LIMIT);
        assert!(verdict.is_corrupt(), "{verdict:?}");
    }

    #[test]
    fn a_check_out_of_time_is_timed_out_not_corrupt() {
        let path = scratch("slow");
        populated(&path);
        let db = TenantDb::open(&path, DbOptions::default()).unwrap();
        assert_eq!(quick_check(&db, Duration::ZERO), Integrity::TimedOut);
        db.close().unwrap();
    }

    #[test]
    fn corruption_codes_are_classified() {
        let corrupt = DbError::Sqlite {
            code: ffi::SQLITE_CORRUPT,
            message: "database disk image is malformed".into(),
        };
        let notadb = DbError::Sqlite {
            code: ffi::SQLITE_NOTADB,
            message: "file is not a database".into(),
        };
        // SQLITE_CORRUPT_INDEX (779): an extended code of SQLITE_CORRUPT.
        let extended = DbError::Sqlite {
            code: 779,
            message: "corrupt index".into(),
        };
        assert!(is_corruption(&corrupt));
        assert!(is_corruption(&notadb));
        assert!(is_corruption(&extended));
        assert!(!is_corruption(&DbError::Busy));
        assert!(!is_corruption(&DbError::QuotaExceeded));
        assert!(!is_corruption(&DbError::Sqlite {
            code: ffi::SQLITE_ERROR,
            message: "no such table".into()
        }));
    }

    #[test]
    fn a_missing_file_is_not_checked() {
        let path = scratch("missing");
        assert_eq!(check_file(&path, QUICK_CHECK_LIMIT), Integrity::Ok);
        assert!(!path.exists(), "the check never creates the file");
    }
}
