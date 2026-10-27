//! Forward-only migration runner with checksums (ADR D17, `docs/06-data.md`,
//! "Layout inside a tenant file"; `docs/contracts/artifact.md` section 4).
//!
//! In F1 only the app's own migrations (module `app`) run; ordering across
//! modules arrives with the resolver in F4.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use std::time::Duration;

use sha2::{Digest, Sha256};

use crate::authorizer::{AuthorizerPolicy, PLATFORM_MODULE, validate_module_name};
use crate::db::{TenantDb, Tx};
use crate::error::DbError;
use crate::value::Value;

/// Time limit for one migration file.
pub const MIGRATION_FILE_TIMEOUT: Duration = Duration::from_secs(30);

/// One file of `migrations/<module>/`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MigrationFile {
    /// `NNN_name.sql`.
    pub name: String,
    pub sql: String,
}

/// What a run did, in name order.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MigrationReport {
    pub applied: Vec<String>,
    /// Files applied by an earlier run (checksum verified).
    pub skipped: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum MigrationError {
    #[error("invalid migration file name {name:?}, expected NNN_name.sql")]
    InvalidName { name: String },
    #[error("migration file {name} is listed twice")]
    DuplicateName { name: String },
    /// An applied file changed, or a file does not match `checksums.json`.
    #[error("checksum of migration {name} does not match")]
    ChecksumMismatch { name: String },
    /// The file created or renamed a schema object outside the module prefix.
    #[error("migration {name} left {object} outside the module prefix")]
    OutsidePrefix { name: String, object: String },
    /// A statement of the file failed; the file's transaction was rolled back.
    #[error("migration {name} failed: {source}")]
    Failed { name: String, source: DbError },
    #[error(transparent)]
    Db(#[from] DbError),
}

/// Lower-case hex SHA-256 of the file bytes, as in `checksums.json`.
pub fn checksum(sql: &str) -> String {
    Sha256::digest(sql.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Apply the unapplied `files` of `module` in name order, each in its own
/// transaction, recording `(module, name, checksum, applied_at)` in
/// `renox__migrations`. Refuses to run anything if an applied file changed.
pub fn migrate(
    db: &TenantDb,
    module: &str,
    files: &[MigrationFile],
) -> Result<MigrationReport, MigrationError> {
    run(db, module, files, None)
}

/// `migrate`, after checking every file against the artifact's
/// `migrations/checksums.json` `files` map (keys `<module>/<name>`).
pub fn migrate_with_checksums(
    db: &TenantDb,
    module: &str,
    files: &[MigrationFile],
    checksums: &BTreeMap<String, String>,
) -> Result<MigrationReport, MigrationError> {
    run(db, module, files, Some(checksums))
}

fn run(
    db: &TenantDb,
    module: &str,
    files: &[MigrationFile],
    expected: Option<&BTreeMap<String, String>>,
) -> Result<MigrationReport, MigrationError> {
    validate_module_name(module)?;
    if module == PLATFORM_MODULE {
        return Err(DbError::Param("renox migrations are not tenant migrations".into()).into());
    }
    let mut files: Vec<&MigrationFile> = files.iter().collect();
    files.sort_by(|a, b| a.name.cmp(&b.name));
    for (i, f) in files.iter().enumerate() {
        if !valid_name(&f.name) {
            return Err(MigrationError::InvalidName {
                name: f.name.clone(),
            });
        }
        if i > 0 && files[i - 1].name == f.name {
            return Err(MigrationError::DuplicateName {
                name: f.name.clone(),
            });
        }
    }
    let sums: Vec<String> = files.iter().map(|f| checksum(&f.sql)).collect();
    if let Some(expected) = expected {
        for (f, sum) in files.iter().zip(&sums) {
            if expected.get(&format!("{module}/{}", f.name)) != Some(sum) {
                return Err(MigrationError::ChecksumMismatch {
                    name: f.name.clone(),
                });
            }
        }
    }

    // Bookkeeping runs on the writer as the platform; each file's SQL runs
    // under the module's DDL policy.
    db.with_writer_policy(None, || {
        let applied = applied(db, module)?;
        for (f, sum) in files.iter().zip(&sums) {
            if applied.get(&f.name).is_some_and(|a| a != sum) {
                return Err(MigrationError::ChecksumMismatch {
                    name: f.name.clone(),
                });
            }
        }
        let policy = Arc::new(AuthorizerPolicy::module(module).with_ddl(true));
        let mut report = MigrationReport::default();
        for (f, sum) in files.iter().zip(&sums) {
            if applied.contains_key(&f.name) {
                report.skipped.push(f.name.clone());
                continue;
            }
            db.transaction(|tx| apply(db, tx, module, &policy, f, sum))?;
            report.applied.push(f.name.clone());
        }
        Ok(report)
    })
}

fn applied(db: &TenantDb, module: &str) -> Result<BTreeMap<String, String>, MigrationError> {
    let rows = db.transaction(|tx| {
        tx.query(
            "select name, checksum from renox__migrations where module = ?",
            &[module.into()],
        )
    })?;
    Ok(rows
        .into_iter()
        .filter_map(|r| match (r.get("name"), r.get("checksum")) {
            (Some(Value::Text(n)), Some(Value::Text(c))) => Some((n.clone(), c.clone())),
            _ => None,
        })
        .collect())
}

fn apply(
    db: &TenantDb,
    tx: &Tx<'_>,
    module: &str,
    policy: &Arc<AuthorizerPolicy>,
    file: &MigrationFile,
    sum: &str,
) -> Result<(), MigrationError> {
    let before = schema(tx)?;
    db.with_writer_policy(Some(Arc::clone(policy)), || {
        tx.execute_batch(&file.sql, MIGRATION_FILE_TIMEOUT)
    })
    .map_err(|source| MigrationError::Failed {
        name: file.name.clone(),
        source,
    })?;
    // `alter table ... rename to` reports only the old name to the
    // authorizer: check every new or renamed object here.
    let prefix = format!("{module}__");
    for (name, table) in schema(tx)?.difference(&before) {
        if name == "sqlite_sequence" {
            continue; // created by SQLite for `autoincrement`
        }
        let inside = |n: &str| n.starts_with(&prefix) && n.len() > prefix.len();
        let name_ok = inside(name) || name.strip_prefix("sqlite_autoindex_").is_some_and(inside);
        if !name_ok || !inside(table) {
            return Err(MigrationError::OutsidePrefix {
                name: file.name.clone(),
                object: name.clone(),
            });
        }
    }
    tx.execute(
        "insert into renox__migrations (module, name, checksum, applied_at) \
         values (?, ?, ?, unixepoch())",
        &[module.into(), file.name.as_str().into(), sum.into()],
    )?;
    Ok(())
}

/// `(name, tbl_name)` of every schema object.
fn schema(tx: &Tx<'_>) -> Result<BTreeSet<(String, String)>, DbError> {
    Ok(tx
        .query("select name, tbl_name from sqlite_master", &[])?
        .into_iter()
        .filter_map(|r| match (r.get("name"), r.get("tbl_name")) {
            (Some(Value::Text(n)), Some(Value::Text(t))) => Some((n.clone(), t.clone())),
            _ => None,
        })
        .collect())
}

/// `^\d{3,}_[a-z0-9_]+\.sql$`
fn valid_name(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(".sql") else {
        return false;
    };
    let digits = stem.bytes().take_while(u8::is_ascii_digit).count();
    let rest = &stem[digits..];
    digits >= 3
        && rest.len() > 1
        && rest.starts_with('_')
        && rest[1..]
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}
