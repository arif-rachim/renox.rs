//! Forward-only migration runner with checksums (ADR D17, `docs/06-data.md`,
//! "Layout inside a tenant file"; `docs/contracts/artifact.md` section 4).
//!
//! `migrate` runs one module's files; `migrate_all` runs an artifact's plan
//! (`docs/contracts/artifact.md` section 3, "Modules": the `modules` order,
//! the app last), each module under its own DDL authorizer.

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
    /// `module` is the file's module and `statement` the failing statement
    /// (clipped to 200 characters) when it could be told apart.
    #[error("migration {module}/{name} failed{}: {source}", statement.as_deref().map(|s| format!(" at `{s}`")).unwrap_or_default())]
    Failed {
        module: String,
        name: String,
        statement: Option<String>,
        source: DbError,
    },
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
    run_inner(db, module, files, expected, None)
}

fn run_with_policy(
    db: &TenantDb,
    module: &str,
    files: &[MigrationFile],
    expected: Option<&BTreeMap<String, String>>,
    policy: Arc<AuthorizerPolicy>,
) -> Result<MigrationReport, MigrationError> {
    run_inner(db, module, files, expected, Some(policy))
}

fn run_inner(
    db: &TenantDb,
    module: &str,
    files: &[MigrationFile],
    expected: Option<&BTreeMap<String, String>>,
    policy: Option<Arc<AuthorizerPolicy>>,
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
        let policy =
            policy.unwrap_or_else(|| Arc::new(AuthorizerPolicy::module(module).with_ddl(true)));
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
    // One statement at a time, so a failure names its statement; the file
    // keeps one time limit and one transaction.
    let started = std::time::Instant::now();
    for statement in split_statements(&file.sql) {
        let left = MIGRATION_FILE_TIMEOUT.saturating_sub(started.elapsed());
        db.with_writer_policy(Some(Arc::clone(policy)), || {
            if left.is_zero() {
                Err(DbError::Timeout)
            } else {
                tx.execute_batch(statement, left)
            }
        })
        .map_err(|source| MigrationError::Failed {
            module: module.to_owned(),
            name: file.name.clone(),
            statement: Some(clip(statement.trim())),
            source,
        })?;
    }
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

/// One module of a migration plan: its files and the modules whose public
/// views its migrations may read (its declared dependencies).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModuleMigrations {
    pub module: String,
    pub dependencies: Vec<String>,
    pub files: Vec<MigrationFile>,
}

/// What `migrate_all` did, per module in plan order.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PlanReport {
    pub modules: Vec<(String, MigrationReport)>,
}

/// `migrate_all` stopped at `module`; the modules before it are reported in
/// `done` and stay applied (forward-only).
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
#[error("migrations of module {module} failed: {error}")]
pub struct PlanError {
    pub module: String,
    pub error: MigrationError,
    pub done: PlanReport,
}

/// Run an artifact's migration plan: the modules in the given order (the
/// artifact's `modules` order, every module after its dependencies, the app
/// last), each file in its own transaction under
/// `module(m).with_read_deps(deps).with_ddl(true)`, so DDL on another prefix
/// fails naming the module, the file, and the statement
/// (`docs/24-threat-model.md`, "Module migration touching another module's
/// tables"). The first failure stops the plan. With `checksums`
/// (`migrations/checksums.json` `files`, keys `<module>/<name>`), every file
/// is checked before anything runs.
pub fn migrate_all(
    db: &TenantDb,
    plan: &[ModuleMigrations],
    checksums: Option<&BTreeMap<String, String>>,
) -> Result<PlanReport, Box<PlanError>> {
    let mut done = PlanReport::default();
    let mut seen = BTreeSet::new();
    for m in plan {
        let fail = |error: MigrationError, done: &PlanReport| {
            Box::new(PlanError {
                module: m.module.clone(),
                error,
                done: done.clone(),
            })
        };
        if !seen.insert(m.module.as_str()) {
            return Err(fail(
                DbError::Param(format!("module {} is twice in the plan", m.module)).into(),
                &done,
            ));
        }
        if let Some(dep) = m.dependencies.iter().find(|d| !seen.contains(d.as_str())) {
            return Err(fail(
                DbError::Param(format!(
                    "module {} runs before its dependency {dep}",
                    m.module
                ))
                .into(),
                &done,
            ));
        }
    }
    for m in plan {
        match run_module(db, m, checksums) {
            Ok(report) => done.modules.push((m.module.clone(), report)),
            Err(error) => {
                return Err(Box::new(PlanError {
                    module: m.module.clone(),
                    error,
                    done,
                }));
            }
        }
    }
    Ok(done)
}

fn run_module(
    db: &TenantDb,
    m: &ModuleMigrations,
    expected: Option<&BTreeMap<String, String>>,
) -> Result<MigrationReport, MigrationError> {
    let policy = AuthorizerPolicy::module(m.module.as_str())
        .with_read_deps(m.dependencies.iter().cloned())
        .with_ddl(true);
    policy.validate()?;
    run_with_policy(db, &m.module, &m.files, expected, Arc::new(policy))
}

fn clip(s: &str) -> String {
    match s.char_indices().nth(200) {
        Some((i, _)) => format!("{}…", &s[..i]),
        None => s.to_owned(),
    }
}

/// Split a migration file into statements at `;` outside quotes, comments,
/// and `create trigger ... end` bodies. Only used to name the failing
/// statement and run one at a time: every piece is still compiled by SQLite
/// under the authorizer, so a wrong split can only fail, never widen access.
pub(crate) fn split_statements(sql: &str) -> Vec<&str> {
    let b = sql.as_bytes();
    let mut out = Vec::new();
    let (mut start, mut i) = (0, 0);
    let mut words: Vec<String> = Vec::new();
    let mut word = String::new();
    let flush = |word: &mut String, words: &mut Vec<String>| {
        if !word.is_empty() {
            words.push(std::mem::take(word).to_ascii_lowercase());
        }
    };
    while i < b.len() {
        let c = b[i];
        match c {
            b'\'' | b'"' | b'`' => {
                flush(&mut word, &mut words);
                let q = c;
                i += 1;
                while i < b.len() && b[i] != q {
                    i += 1;
                }
            }
            b'[' => {
                flush(&mut word, &mut words);
                while i < b.len() && b[i] != b']' {
                    i += 1;
                }
            }
            b'-' if b.get(i + 1) == Some(&b'-') => {
                flush(&mut word, &mut words);
                while i < b.len() && b[i] != b'\n' {
                    i += 1;
                }
            }
            b'/' if b.get(i + 1) == Some(&b'*') => {
                flush(&mut word, &mut words);
                i += 2;
                while i + 1 < b.len() && !(b[i] == b'*' && b[i + 1] == b'/') {
                    i += 1;
                }
                i += 1;
            }
            b';' => {
                flush(&mut word, &mut words);
                let trigger = words.len() >= 2
                    && words[0] == "create"
                    && (words[1] == "trigger" || words.get(2).is_some_and(|w| w == "trigger"));
                if !trigger || words.last().is_some_and(|w| w == "end") {
                    let piece = &sql[start..=i];
                    if !piece.trim_end_matches(';').trim().is_empty() {
                        out.push(piece);
                    }
                    start = i + 1;
                    words.clear();
                }
            }
            c if c.is_ascii_alphanumeric() || c == b'_' => word.push(c as char),
            _ => flush(&mut word, &mut words),
        }
        i += 1;
    }
    let rest = &sql[start.min(sql.len())..];
    if has_code(rest) {
        out.push(rest);
    }
    out
}

/// Whether `s` holds anything but whitespace and comments.
fn has_code(s: &str) -> bool {
    let mut rest = s.trim_start();
    loop {
        if let Some(r) = rest.strip_prefix("--") {
            rest = r.find('\n').map_or("", |n| &r[n..]).trim_start();
        } else if let Some(r) = rest.strip_prefix("/*") {
            rest = r.find("*/").map_or("", |n| &r[n + 2..]).trim_start();
        } else {
            return !rest.is_empty();
        }
    }
}
