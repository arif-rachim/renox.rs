//! One tenant SQLite file: a writer connection and a small reader pool
//! (`docs/06-data.md`, "Connection settings").
//!
//! A `TenantDb` lives on one thread (the cell's worker thread); it is `Send`
//! but not `Sync`, so its connections are never used by two threads at once.

use std::cell::Cell;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use rusqlite::config::DbConfig;
use rusqlite::{CachedStatement, Connection, OpenFlags};

use crate::authorizer::{AuthorizerPolicy, Denial, decide};
use crate::error::{DbError, Result};
use crate::value::{ExecResult, Row, Value};

/// SQLite page size of every tenant file.
pub const PAGE_SIZE: u64 = 4096;
/// File size quota of the free tier (`docs/04-isolation-security.md`).
pub const FREE_QUOTA_BYTES: u64 = 100 * 1024 * 1024;
/// File size quota of the paid tiers.
pub const PAID_QUOTA_BYTES: u64 = 10 * 1024 * 1024 * 1024;

/// Prepared statements kept per connection.
const STATEMENT_CACHE_CAPACITY: usize = 64;

/// Platform tables created in every tenant file on open.
const PLATFORM_SCHEMA: &str = "
create table if not exists renox__migrations (
  module     text    not null,
  name       text    not null,
  checksum   text    not null,
  applied_at integer not null,
  primary key (module, name)
) strict;
";

/// Settings for one tenant file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DbOptions {
    /// How long a write waits for the write lock before `DbError::Busy`.
    pub busy_timeout_ms: u64,
    /// File size quota in pages of `PAGE_SIZE` bytes.
    pub max_page_count: u64,
    /// Reader connections in the pool (at least 1).
    pub readers: usize,
    /// Per-statement time limit.
    pub statement_timeout_ms: u64,
    /// Module whose authorizer every connection gets on open; `None` opens a
    /// platform handle with no authorizer.
    pub module_prefix: Option<String>,
}

impl Default for DbOptions {
    /// Free-tier values from `docs/contracts/ops.md` section 1 ("Limits").
    fn default() -> Self {
        DbOptions {
            busy_timeout_ms: 2_000,
            max_page_count: FREE_QUOTA_BYTES / PAGE_SIZE,
            readers: 2,
            statement_timeout_ms: 1_000,
            module_prefix: None,
        }
    }
}

impl DbOptions {
    /// Options with a file size quota of `bytes`, rounded down to whole pages.
    pub fn with_quota_bytes(bytes: u64) -> Self {
        DbOptions {
            max_page_count: bytes / PAGE_SIZE,
            ..DbOptions::default()
        }
    }
}

/// State shared between a connection and its SQLite callbacks.
#[derive(Default)]
struct Hooks {
    /// `None`: platform connection, everything allowed.
    policy: Mutex<Option<Arc<AuthorizerPolicy>>>,
    /// First action the authorizer refused since the last prepare.
    denial: Mutex<Option<Denial>>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    // The callbacks never panic while holding a lock; recover anyway.
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// One connection of the pool.
pub(crate) struct Conn {
    pub(crate) inner: Connection,
    hooks: Arc<Hooks>,
}

impl Conn {
    fn open(path: &Path, read_only: bool, options: &DbOptions) -> Result<Conn> {
        // No URI filenames, no shared cache; NO_MUTEX because a connection
        // never crosses threads concurrently.
        let flags = if read_only {
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX
        } else {
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_NO_MUTEX
        };
        let mut inner = Connection::open_with_flags(path, flags).map_err(open_error)?;
        inner.set_prepared_statement_cache_capacity(STATEMENT_CACHE_CAPACITY);
        // Defensive mode: no writable_schema, no direct shadow table writes.
        inner
            .set_db_config(DbConfig::SQLITE_DBCONFIG_DEFENSIVE, true)
            .map_err(open_error)?;
        inner
            .busy_timeout(Duration::from_millis(options.busy_timeout_ms))
            .map_err(open_error)?;
        // Functions in views, triggers, and defaults run only if harmless.
        inner
            .pragma_update(None, "trusted_schema", false)
            .map_err(open_error)?;
        inner
            .pragma_update(None, "foreign_keys", true)
            .map_err(open_error)?;
        if !read_only {
            // page_size only takes effect on a new file, before WAL is set.
            inner
                .pragma_update(None, "page_size", PAGE_SIZE as i64)
                .map_err(open_error)?;
            let mode: String = inner
                .pragma_update_and_check(None, "journal_mode", "wal", |r| r.get(0))
                .map_err(open_error)?;
            if !mode.eq_ignore_ascii_case("wal") {
                return Err(DbError::Open(format!("journal_mode is {mode}, not wal")));
            }
            inner
                .pragma_update(None, "synchronous", "NORMAL")
                .map_err(open_error)?;
        }
        inner
            .pragma_update(
                None,
                "max_page_count",
                i64::try_from(options.max_page_count).unwrap_or(i64::MAX),
            )
            .map_err(open_error)?;
        // The authorizer is installed once and reads the current policy from
        // `hooks`, so the policy can change without `&mut` (see `set_policy`).
        let hooks = Arc::new(Hooks::default());
        let h = Arc::clone(&hooks);
        inner
            .authorizer(Some(move |ctx: rusqlite::hooks::AuthContext<'_>| {
                let (answer, denial) = decide(lock(&h.policy).as_deref(), &ctx);
                if let Some(d) = denial {
                    let mut slot = lock(&h.denial);
                    // Keep the first denial, but prefer the object a DDL
                    // statement names over the schema table it writes first.
                    if slot.as_ref().is_none_or(Denial::is_schema_table) {
                        *slot = Some(d);
                    }
                }
                answer
            }))
            .map_err(open_error)?;
        Ok(Conn { inner, hooks })
    }

    /// Replace the authorizer policy; returns the previous one.
    pub(crate) fn set_policy(
        &self,
        policy: Option<Arc<AuthorizerPolicy>>,
    ) -> Option<Arc<AuthorizerPolicy>> {
        let policy = policy.filter(|p| !p.is_platform());
        let old = std::mem::replace(&mut *lock(&self.hooks.policy), policy);
        // The authorizer runs at prepare time: statements cached under the
        // old policy must not be reused under the new one.
        self.inner.flush_prepared_statement_cache();
        old
    }

    /// Start a new statement: forget a denial left from an earlier one.
    pub(crate) fn clear_denial(&self) {
        lock(&self.hooks.denial).take();
    }

    fn prepare(&self, sql: &str) -> Result<CachedStatement<'_>> {
        self.clear_denial();
        let stmt = self.inner.prepare_cached(sql).map_err(|e| self.error(e))?;
        for i in 1..=stmt.parameter_count() {
            if let Some(name) = stmt.parameter_name(i)
                && !name.starts_with('?')
            {
                return Err(DbError::Param(format!(
                    "named parameter {name} is not supported, use ?"
                )));
            }
        }
        Ok(stmt)
    }

    /// Run a statement and collect its rows; `limit_one` stops after the first.
    fn rows(
        &self,
        stmt: &mut CachedStatement<'_>,
        params: &[Value],
        limit_one: bool,
    ) -> Result<Vec<Row>> {
        let names: Vec<String> = stmt.column_names().map(str::to_owned).collect();
        for (i, name) in names.iter().enumerate() {
            if names[..i].contains(name) {
                return Err(DbError::ColumnName(name.clone()));
            }
        }
        let mut rows = stmt
            .query(rusqlite::params_from_iter(params))
            .map_err(|e| self.error(e))?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().map_err(|e| self.error(e))? {
            let mut columns = Vec::with_capacity(names.len());
            for (i, name) in names.iter().enumerate() {
                columns.push((
                    name.clone(),
                    row.get::<_, Value>(i).map_err(|e| self.error(e))?,
                ));
            }
            out.push(Row::from_columns(columns));
            if limit_one {
                break;
            }
        }
        Ok(out)
    }

    fn execute(&self, sql: &str, params: &[Value]) -> Result<ExecResult> {
        let mut stmt = self.prepare(sql)?;
        // Step to the end so `insert ... returning` works here too.
        let mut rows = stmt
            .query(rusqlite::params_from_iter(params))
            .map_err(|e| self.error(e))?;
        while rows.next().map_err(|e| self.error(e))?.is_some() {}
        Ok(ExecResult {
            changes: self.inner.changes(),
            last_insert_rowid: self.inner.last_insert_rowid(),
        })
    }

    /// Map a SQLite error raised on this connection.
    pub(crate) fn error(&self, e: rusqlite::Error) -> DbError {
        match DbError::from(e) {
            DbError::Auth { .. } => {
                let d = lock(&self.hooks.denial).take();
                DbError::Auth {
                    table: d.as_ref().map(|d| d.table.clone()).unwrap_or_default(),
                    action: d.map(|d| d.action.to_owned()).unwrap_or_default(),
                }
            }
            other => other,
        }
    }
}

fn open_error(e: rusqlite::Error) -> DbError {
    // rusqlite appends the file path to open errors; keep only the code.
    match e {
        rusqlite::Error::SqliteFailure(err, _) => DbError::Open(format!(
            "sqlite error {}: {}",
            err.extended_code,
            rusqlite::ffi::code_to_str(err.extended_code)
        )),
        _ => DbError::Open("could not configure the connection".into()),
    }
}

/// A tenant's SQLite file with one writer and a pool of readers.
pub struct TenantDb {
    path: PathBuf,
    options: DbOptions,
    writer: Conn,
    readers: Vec<Conn>,
    next_reader: Cell<usize>,
    in_tx: Cell<bool>,
    policy: Option<Arc<AuthorizerPolicy>>,
}

impl std::fmt::Debug for TenantDb {
    // The path stays out of Debug output so it cannot reach a log by accident.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TenantDb")
            .field("readers", &self.readers.len())
            .field("in_tx", &self.in_tx.get())
            .finish_non_exhaustive()
    }
}

impl TenantDb {
    /// Open (or create) the tenant file at `path`, apply the pragmas, and
    /// create the platform tables if missing.
    pub fn open(path: impl AsRef<Path>, options: DbOptions) -> Result<TenantDb> {
        let path = path.as_ref().to_path_buf();
        let writer = Conn::open(&path, false, &options)?;
        writer
            .inner
            .execute_batch(PLATFORM_SCHEMA)
            .map_err(|e| writer.error(e))?;
        let readers = (0..options.readers.max(1))
            .map(|_| Conn::open(&path, true, &options))
            .collect::<Result<Vec<_>>>()?;
        Ok(TenantDb {
            path,
            options,
            writer,
            readers,
            next_reader: Cell::new(0),
            in_tx: Cell::new(false),
            policy: None,
        })
        .and_then(|db| match db.options.module_prefix.clone() {
            Some(module) => db.with_authorizer(AuthorizerPolicy::module(module)),
            None => Ok(db),
        })
    }

    /// Install `policy` on every connection of this handle: a statement that
    /// touches anything outside it fails at prepare time with
    /// `DbError::Auth`. The `renox` policy removes all restrictions.
    pub fn with_authorizer(mut self, policy: AuthorizerPolicy) -> Result<TenantDb> {
        policy.validate()?;
        let policy = Arc::new(policy);
        for c in self.connections() {
            c.set_policy(Some(Arc::clone(&policy)));
        }
        self.policy = Some(policy);
        Ok(self)
    }

    /// The policy installed by `with_authorizer`, if any.
    pub fn authorizer(&self) -> Option<&AuthorizerPolicy> {
        self.policy.as_deref()
    }

    /// Run `f` with `policy` on the writer instead of the handle's policy;
    /// the handle's policy is back when `f` returns or panics. The readers
    /// keep the handle's policy. Used by the migration runner (`allow_ddl`).
    #[allow(dead_code)]
    pub(crate) fn with_writer_policy<T>(
        &self,
        policy: Option<Arc<AuthorizerPolicy>>,
        f: impl FnOnce() -> T,
    ) -> T {
        struct Restore<'a>(&'a Conn, Option<Arc<AuthorizerPolicy>>);
        impl Drop for Restore<'_> {
            fn drop(&mut self) {
                self.0.set_policy(self.1.take());
            }
        }
        let _restore = Restore(&self.writer, self.writer.set_policy(policy));
        f()
    }

    pub fn options(&self) -> &DbOptions {
        &self.options
    }

    /// Path of the file. For the platform only; never hand it to tenant code.
    pub fn path(&self) -> &Path {
        &self.path
    }

    fn reader(&self) -> &Conn {
        let i = self.next_reader.get();
        self.next_reader.set((i + 1) % self.readers.len());
        &self.readers[i]
    }

    pub(crate) fn connections(&self) -> impl Iterator<Item = &Conn> {
        std::iter::once(&self.writer).chain(self.readers.iter())
    }

    /// Run a read on a reader connection. A statement that writes
    /// (`insert ... returning`) goes to the writer instead.
    fn run_query(&self, sql: &str, params: &[Value], limit_one: bool) -> Result<Vec<Row>> {
        let reader = self.reader();
        let mut stmt = reader.prepare(sql)?;
        if stmt.readonly() {
            return reader.rows(&mut stmt, params, limit_one);
        }
        drop(stmt);
        self.check_no_tx()?;
        let mut stmt = self.writer.prepare(sql)?;
        self.writer.rows(&mut stmt, params, limit_one)
    }

    fn check_no_tx(&self) -> Result<()> {
        if self.in_tx.get() {
            return Err(DbError::TxState(
                "a write outside the open transaction would block on its lock".into(),
            ));
        }
        Ok(())
    }

    /// All rows of a query.
    pub fn query(&self, sql: &str, params: &[Value]) -> Result<Vec<Row>> {
        self.run_query(sql, params, false)
    }

    /// The first row of a query; the statement stops after it.
    pub fn query_one(&self, sql: &str, params: &[Value]) -> Result<Option<Row>> {
        Ok(self.run_query(sql, params, true)?.into_iter().next())
    }

    /// Run a statement on the writer.
    pub fn execute(&self, sql: &str, params: &[Value]) -> Result<ExecResult> {
        self.check_no_tx()?;
        self.writer.execute(sql, params)
    }

    /// Run `f` in an immediate transaction on the writer: commit if it
    /// returns `Ok`, roll back if it returns `Err` or panics.
    pub fn transaction<T, E>(&self, f: impl FnOnce(&Tx<'_>) -> Result<T, E>) -> Result<T, E>
    where
        E: From<DbError>,
    {
        if self.in_tx.get() {
            return Err(DbError::TxState("transaction already open".into()).into());
        }
        self.writer
            .inner
            .execute_batch("begin immediate")
            .map_err(|e| self.writer.error(e))?;
        self.in_tx.set(true);
        let guard = TxGuard { db: self };
        let tx = Tx { db: self };
        let out = f(&tx)?;
        self.writer
            .inner
            .execute_batch("commit")
            .map_err(|e| self.writer.error(e))?;
        drop(guard);
        Ok(out)
    }

    /// Read a pragma from every connection, writer first. For the platform
    /// (health checks, tests); `name` must be a plain identifier. A handle
    /// with a module authorizer refuses it like any other `PRAGMA`.
    pub fn read_pragma(&self, name: &str) -> Result<Vec<Value>> {
        if name.is_empty() || !name.bytes().all(|b| b.is_ascii_lowercase() || b == b'_') {
            return Err(DbError::Param(format!("invalid pragma name {name:?}")));
        }
        self.connections()
            .map(|c| {
                c.clear_denial();
                c.inner
                    .query_row(&format!("pragma {name}"), [], |r| r.get::<_, Value>(0))
                    .map_err(|e| c.error(e))
            })
            .collect()
    }

    /// Close every connection. The cell calls this on idle eviction.
    pub fn close(self) -> Result<()> {
        let TenantDb {
            writer, readers, ..
        } = self;
        for r in readers {
            r.inner.close().map_err(|(_, e)| DbError::from(e))?;
        }
        writer.inner.close().map_err(|(_, e)| DbError::from(e))?;
        Ok(())
    }
}

/// Rolls back the open transaction unless it was committed.
struct TxGuard<'a> {
    db: &'a TenantDb,
}

impl Drop for TxGuard<'_> {
    fn drop(&mut self) {
        if !self.db.writer.inner.is_autocommit() {
            // A failed rollback leaves the connection in a transaction; the
            // next begin then fails and the cell closes the file.
            let _ = self.db.writer.inner.execute_batch("rollback");
        }
        self.db.in_tx.set(false);
    }
}

/// The open transaction: the same API as `TenantDb`, always on the writer.
pub struct Tx<'a> {
    db: &'a TenantDb,
}

impl Tx<'_> {
    pub fn query(&self, sql: &str, params: &[Value]) -> Result<Vec<Row>> {
        let mut stmt = self.db.writer.prepare(sql)?;
        self.db.writer.rows(&mut stmt, params, false)
    }

    pub fn query_one(&self, sql: &str, params: &[Value]) -> Result<Option<Row>> {
        let mut stmt = self.db.writer.prepare(sql)?;
        Ok(self
            .db
            .writer
            .rows(&mut stmt, params, true)?
            .into_iter()
            .next())
    }

    pub fn execute(&self, sql: &str, params: &[Value]) -> Result<ExecResult> {
        self.db.writer.execute(sql, params)
    }
}
