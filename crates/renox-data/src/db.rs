//! One tenant SQLite file: a writer connection and a small reader pool
//! (`docs/06-data.md`, "Connection settings").
//!
//! A `TenantDb` lives on one thread (the cell's worker thread); it is `Send`
//! but not `Sync`, so its connections are never used by two threads at once.

use std::cell::{Cell, OnceCell};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use rusqlite::config::DbConfig;
use rusqlite::{CachedStatement, Connection, OpenFlags};

use crate::authorizer::{AuthorizerPolicy, Denial, decide};
use crate::error::{DbError, Result};
use crate::limits::{CheckpointMode, CheckpointResult, PROGRESS_STEPS, QueryCtx, StatementClock};
use crate::stats::{DbStats, Outcome};
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

/// Platform migrations under `migrations/`, applied on open in order. Each
/// is idempotent (`if not exists`), so reopening a file is a no-op.
const PLATFORM_MIGRATIONS: &[&str] = &[
    include_str!("../migrations/0001_outbox.sql"),
    include_str!("../migrations/0002_authz.sql"),
    include_str!("../migrations/0003_files.sql"),
];

/// Savepoints one transaction may hold open at once (`ops.md` section 1).
pub const MAX_SAVEPOINTS: usize = 32;

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
    /// WAL size in pages above which `maybe_checkpoint` runs a passive
    /// checkpoint. At four times this size the writer checkpoints on commit
    /// by itself, so the WAL stays bounded if the scheduler stalls.
    pub wal_checkpoint_pages: u64,
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
            wal_checkpoint_pages: 1_000,
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
    /// Tables the statement being prepared read through a dependency's
    /// public view (`AuthorizerPolicy::check`).
    via_view: Mutex<Vec<String>>,
    /// Limit of the running statement, checked by the progress handler.
    clock: StatementClock,
    /// Pages in the WAL after the last commit (writer only).
    wal_pages: AtomicU64,
    /// WAL size (pages) at which a commit checkpoints by itself (writer only).
    wal_safety_net: AtomicU64,
    /// A row was inserted into `renox__outbox` since the last commit or
    /// rollback (writer only, SQLite's update hook).
    outbox_dirty: AtomicBool,
    /// Called after a commit that inserted into `renox__outbox`
    /// ([`TenantDb::on_outbox_commit`], D14: the outbox worker's wake-up).
    on_outbox: Mutex<Option<OutboxWake>>,
    /// The change feed's subscription ([`TenantDb::on_rows_changed`]).
    feed: Mutex<Option<Arc<FeedSubscription>>>,
    /// Rows changed in the open transaction (or the running autocommit
    /// statement), delivered after its commit and dropped on rollback.
    feed_buf: Mutex<FeedBuffer>,
}

/// One committed change of a row in a table the change feed watches
/// (`ops.md` 1.5.0 section 18, "Change feed").
#[derive(Debug, Clone, PartialEq)]
pub struct RowChange {
    pub table: String,
    /// The row's rowid (the old one for a delete); 0 for [`ChangeOp::Many`].
    pub rowid: i64,
    pub op: ChangeOp,
    /// The columns the subscription asked for, in its order, read from the
    /// row as SQLite changed it (the old row for a delete, the new one
    /// otherwise), never by a second query. Empty for [`ChangeOp::Many`].
    pub columns: Vec<(String, Value)>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChangeOp {
    Insert,
    Update,
    Delete,
    /// More than [`FEED_MAX_ROWS`] rows changed in one transaction: one event
    /// per table instead of the rows.
    Many,
}

impl ChangeOp {
    pub fn as_str(self) -> &'static str {
        match self {
            ChangeOp::Insert => "insert",
            ChangeOp::Update => "update",
            ChangeOp::Delete => "delete",
            ChangeOp::Many => "many",
        }
    }
}

/// Rows of one transaction the feed buffers before it gives up and sends one
/// [`ChangeOp::Many`] per table (*proposed*, #305).
pub const FEED_MAX_ROWS: usize = 1_000;

/// Called on the committing thread with the committed changes, in order; it
/// must not block (send on a channel).
pub type RowsChanged = Arc<dyn Fn(Vec<RowChange>) + Send + Sync>;

/// What the feed watches: table → the columns to read from each changed row.
struct FeedSubscription {
    /// table → (column name, column index in the table).
    tables: std::collections::HashMap<String, Vec<(String, i32)>>,
    deliver: RowsChanged,
}

#[derive(Default)]
struct FeedBuffer {
    rows: Vec<RowChange>,
    /// Tables with changes past [`FEED_MAX_ROWS`], in first-seen order.
    overflow: Vec<String>,
    /// `rows.len()` when each open savepoint began, innermost last.
    marks: Vec<usize>,
}

impl FeedBuffer {
    fn push(&mut self, change: RowChange) {
        if !self.overflow.is_empty() || self.rows.len() >= FEED_MAX_ROWS {
            if self.overflow.is_empty() {
                for r in std::mem::take(&mut self.rows) {
                    if !self.overflow.contains(&r.table) {
                        self.overflow.push(r.table);
                    }
                }
                self.marks.clear();
            }
            if !self.overflow.contains(&change.table) {
                self.overflow.push(change.table);
            }
            return;
        }
        self.rows.push(change);
    }

    /// The committed changes; the buffer is empty afterwards.
    fn take(&mut self) -> Vec<RowChange> {
        let rows = std::mem::take(&mut self.rows);
        let overflow = std::mem::take(&mut self.overflow);
        self.marks.clear();
        if overflow.is_empty() {
            return rows;
        }
        overflow
            .into_iter()
            .map(|table| RowChange {
                table,
                rowid: 0,
                op: ChangeOp::Many,
                columns: Vec::new(),
            })
            .collect()
    }

    fn clear(&mut self) {
        *self = FeedBuffer::default();
    }

    /// Forget what was buffered after `mark` (a failed statement, a rolled
    /// back savepoint). After an overflow the rows are gone already; the
    /// `many` events stay, which only costs subscribers a refetch.
    fn truncate(&mut self, mark: usize) {
        if self.overflow.is_empty() {
            self.rows.truncate(mark);
        }
    }
}

fn feed_value(v: rusqlite::types::ValueRef<'_>) -> Value {
    use rusqlite::types::ValueRef;
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => Value::Integer(i),
        ValueRef::Real(f) => Value::Real(f),
        ValueRef::Text(t) => Value::Text(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => Value::Blob(b.to_vec()),
    }
}

/// SQLite's pre-update hook on the writer: buffer a change of a watched
/// table with the columns the subscription needs, read from the row now.
fn feed_preupdate(h: &Hooks, db: &str, table: &str, case: &rusqlite::hooks::PreUpdateCase) {
    use rusqlite::hooks::PreUpdateCase;
    if db != "main" {
        return;
    }
    let Some(sub) = lock(&h.feed).clone() else {
        return;
    };
    let Some(columns) = sub.tables.get(table) else {
        return;
    };
    let read = |get: &dyn Fn(i32) -> Option<Value>| {
        columns
            .iter()
            .map(|(name, i)| (name.clone(), get(*i).unwrap_or(Value::Null)))
            .collect::<Vec<_>>()
    };
    let change = match case {
        PreUpdateCase::Insert(new) => RowChange {
            table: table.to_owned(),
            rowid: new.get_new_row_id(),
            op: ChangeOp::Insert,
            columns: read(&|i| new.get_new_column_value(i).ok().map(feed_value)),
        },
        PreUpdateCase::Update {
            new_value_accessor: new,
            ..
        } => RowChange {
            table: table.to_owned(),
            rowid: new.get_new_row_id(),
            op: ChangeOp::Update,
            columns: read(&|i| new.get_new_column_value(i).ok().map(feed_value)),
        },
        PreUpdateCase::Delete(old) => RowChange {
            table: table.to_owned(),
            rowid: old.get_old_row_id(),
            op: ChangeOp::Delete,
            columns: read(&|i| old.get_old_column_value(i).ok().map(feed_value)),
        },
        PreUpdateCase::Unknown => return,
    };
    lock(&h.feed_buf).push(change);
}

/// The outbox worker's wake-up: called on the committing thread, so it must
/// not block (send on a channel).
pub type OutboxWake = Arc<dyn Fn() + Send + Sync>;

thread_local! {
    /// The writer whose commit is running on this thread. rusqlite 0.40's
    /// WAL hook is a plain `fn` (it cannot capture), and SQLite calls it
    /// synchronously on the committing thread, so the writer sets this
    /// around every call that can commit ([`Conn::committing`]).
    static WAL_TARGET: std::cell::RefCell<Option<Arc<Hooks>>> = const { std::cell::RefCell::new(None) };
}

/// SQLite's WAL hook, run after each commit on a writer: record the WAL
/// size and, past the safety net, run a passive checkpoint. Replaces
/// SQLite's automatic checkpoint, so the platform schedules checkpoints
/// (`maybe_checkpoint`).
fn wal_hook(wal: &rusqlite::hooks::Wal, pages: std::os::raw::c_int) -> rusqlite::Result<()> {
    WAL_TARGET.with(|t| {
        if let Some(h) = t.borrow().as_ref() {
            let mut pages = u64::try_from(pages).unwrap_or(0);
            if pages >= h.wal_safety_net.load(Ordering::Relaxed)
                && let Ok((log, done)) = wal.checkpoint_v2(rusqlite::hooks::CheckpointMode::PASSIVE)
                && log == done
            {
                pages = 0;
            }
            h.wal_pages.store(pages, Ordering::Relaxed);
            if h.outbox_dirty.swap(false, Ordering::SeqCst)
                && let Some(wake) = lock(&h.on_outbox).clone()
            {
                wake();
            }
            // The change feed: what this commit changed, after the commit.
            let changes = lock(&h.feed_buf).take();
            if !changes.is_empty()
                && let Some(sub) = lock(&h.feed).clone()
            {
                (sub.deliver)(changes);
            }
        }
    });
    Ok(())
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    // The callbacks never panic while holding a lock; recover anyway.
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// One connection of the pool.
pub(crate) struct Conn {
    pub(crate) inner: Connection,
    hooks: Arc<Hooks>,
    busy_timeout: Duration,
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
        let inner = Connection::open_with_flags(path, flags).map_err(open_error)?;
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
                let (answer, denial) =
                    decide(lock(&h.policy).as_deref(), &ctx, &mut lock(&h.via_view));
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
        let h = Arc::clone(&hooks);
        inner
            .progress_handler(PROGRESS_STEPS, Some(move || h.clock.expired()))
            .map_err(open_error)?;
        if !read_only {
            // Replaces SQLite's automatic checkpoint on commit: the platform
            // schedules checkpoints (`maybe_checkpoint`), with a safety net.
            hooks.wal_safety_net.store(
                options.wal_checkpoint_pages.saturating_mul(4),
                Ordering::Relaxed,
            );
            inner.wal_hook(Some(wal_hook));
            // The outbox worker is woken after a commit that inserted into
            // renox__outbox, never by polling (D14); a rollback forgets it.
            let h = Arc::clone(&hooks);
            inner
                .update_hook(Some(
                    move |action: rusqlite::hooks::Action, _db: &str, table: &str, _rowid: i64| {
                        if action == rusqlite::hooks::Action::SQLITE_INSERT
                            && table == crate::outbox::TABLE
                        {
                            h.outbox_dirty.store(true, Ordering::SeqCst);
                        }
                    },
                ))
                .map_err(open_error)?;
            let h = Arc::clone(&hooks);
            inner
                .rollback_hook(Some(move || {
                    h.outbox_dirty.store(false, Ordering::SeqCst);
                    lock(&h.feed_buf).clear();
                }))
                .map_err(open_error)?;
            // The change feed (#305): rows of watched tables, buffered per
            // transaction and delivered by the WAL hook after the commit.
            let h = Arc::clone(&hooks);
            inner
                .preupdate_hook(Some(
                    move |_action: rusqlite::hooks::Action,
                          db: &str,
                          table: &str,
                          case: &rusqlite::hooks::PreUpdateCase| {
                        feed_preupdate(&h, db, table, case);
                    },
                ))
                .map_err(open_error)?;
        }
        Ok(Conn {
            inner,
            hooks,
            busy_timeout: Duration::from_millis(options.busy_timeout_ms),
        })
    }

    /// Start the clock of one call. The statement limit counts from the
    /// first VM instructions; the busy wait is capped by the deadline.
    fn scope(&self, limit: Duration, ctx: &QueryCtx) -> Scope<'_> {
        self.hooks.clock.start(limit, ctx.deadline);
        let capped = ctx
            .remaining(Instant::now())
            .filter(|r| *r < self.busy_timeout);
        if let Some(r) = capped {
            let _ = self.inner.busy_timeout(r);
        }
        Scope {
            conn: self,
            restore_busy: capped.is_some(),
        }
    }

    /// Replace the authorizer policy; returns the previous one.
    pub(crate) fn set_policy(
        &self,
        policy: Option<Arc<AuthorizerPolicy>>,
    ) -> Option<Arc<AuthorizerPolicy>> {
        let policy = policy.filter(|p| !p.is_platform());
        let mut slot = lock(&self.hooks.policy);
        let same = match (slot.as_deref(), policy.as_deref()) {
            (None, None) => true,
            (Some(a), Some(b)) => a == b,
            _ => false,
        };
        let old = std::mem::replace(&mut *slot, policy);
        drop(slot);
        // The authorizer runs at prepare time: statements cached under the
        // old policy must not be reused under a different one.
        if !same {
            self.inner.flush_prepared_statement_cache();
        }
        old
    }

    /// Start a new statement: forget a denial left from an earlier one.
    pub(crate) fn clear_denial(&self) {
        lock(&self.hooks.denial).take();
        lock(&self.hooks.via_view).clear();
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
        let names: Vec<String> = stmt.column_names().into_iter().map(str::to_owned).collect();
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

    /// Run `f`, which may commit on this connection, with this connection
    /// as the WAL hook's target ([`WAL_TARGET`]).
    fn committing<T>(&self, f: impl FnOnce() -> T) -> T {
        let previous = WAL_TARGET.with(|t| t.replace(Some(Arc::clone(&self.hooks))));
        let out = f();
        WAL_TARGET.with(|t| *t.borrow_mut() = previous);
        out
    }

    /// `PRAGMA main.wal_checkpoint(MODE)`: (frames in the WAL, frames
    /// checkpointed). `busy` (the checkpoint could not finish) is `Busy`.
    fn wal_checkpoint(&self, mode: &str) -> Result<(i64, i64)> {
        let (busy, log, done) = self
            .inner
            .query_row(&format!("PRAGMA main.wal_checkpoint({mode})"), [], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, i64>(2)?,
                ))
            })
            .map_err(|e| self.error(e))?;
        if busy != 0 {
            return Err(DbError::Busy);
        }
        Ok((log, done))
    }

    /// Map a SQLite error raised on this connection.
    pub(crate) fn error(&self, e: rusqlite::Error) -> DbError {
        match DbError::from(e) {
            DbError::Auth { .. } => {
                let d = lock(&self.hooks.denial).take();
                if let Some(d) = d.as_ref().filter(|d| d.action == crate::authorizer::SCOPE) {
                    return DbError::Scope {
                        table: d.table.as_str().into(),
                        module: lock(&self.hooks.policy)
                            .as_ref()
                            .map(|p| p.module.as_str().into())
                            .unwrap_or_default(),
                        reason: crate::error::ScopeReason::Unscoped,
                    };
                }
                DbError::Auth {
                    table: d.as_ref().map(|d| d.table.clone()).unwrap_or_default(),
                    action: d.map(|d| d.action.to_owned()).unwrap_or_default(),
                }
            }
            other => other,
        }
    }
}

/// Stops the statement clock and restores the busy timeout.
struct Scope<'a> {
    conn: &'a Conn,
    restore_busy: bool,
}

impl Drop for Scope<'_> {
    fn drop(&mut self) {
        self.conn.hooks.clock.stop();
        if self.restore_busy {
            let _ = self.conn.inner.busy_timeout(self.conn.busy_timeout);
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

/// A tenant's SQLite file with one writer and a pool of readers. The
/// readers are opened on first use, so a cell that only serves requests
/// without reads pays for one connection (#145).
pub struct TenantDb {
    path: PathBuf,
    options: DbOptions,
    writer: Conn,
    readers: Vec<OnceCell<Conn>>,
    next_reader: Cell<usize>,
    in_tx: Cell<bool>,
    policy: Option<Arc<AuthorizerPolicy>>,
    /// Set by `with_policy` while it runs: the policy readers opened in the
    /// meantime get (`Some(None)` = the platform).
    policy_override: std::cell::RefCell<Option<Option<Arc<AuthorizerPolicy>>>>,
    stats: Cell<DbStats>,
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
        for sql in std::iter::once(PLATFORM_SCHEMA).chain(PLATFORM_MIGRATIONS.iter().copied()) {
            writer
                .committing(|| writer.inner.execute_batch(sql))
                .map_err(|e| writer.error(e))?;
        }
        // A new file's platform tables are in the WAL now; start the
        // tenant's own WAL accounting from an empty log (a reopen wrote
        // nothing, and this is a no-op).
        if writer.hooks.wal_pages.load(Ordering::Relaxed) > 0
            && let Ok((log, done)) = writer.wal_checkpoint("PASSIVE")
            && log == done
        {
            writer.hooks.wal_pages.store(0, Ordering::Relaxed);
        }
        let readers = (0..options.readers.max(1))
            .map(|_| OnceCell::new())
            .collect();
        Ok(TenantDb {
            path,
            options,
            writer,
            readers,
            next_reader: Cell::new(0),
            in_tx: Cell::new(false),
            policy: None,
            policy_override: std::cell::RefCell::new(None),
            stats: Cell::new(DbStats::default()),
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

    /// Call `wake` after every commit on the writer that inserted into
    /// `renox__outbox` (an emit or a fan-out), never after a rollback; `None`
    /// removes it. The cell's outbox worker uses it instead of polling (D14).
    pub fn on_outbox_commit(&self, wake: Option<OutboxWake>) {
        *lock(&self.writer.hooks.on_outbox) = wake;
    }

    /// The change feed (`ops.md` 1.5.0 section 18): after every commit on the
    /// writer that changed a row of one of `tables`, call `deliver` with the
    /// changes in order (insert, update, delete, rowid, and the values of the
    /// named columns read from the row at change time); nothing after a
    /// rollback, a failed statement, or a rolled-back savepoint. More than
    /// [`FEED_MAX_ROWS`] rows in one transaction give one [`ChangeOp::Many`]
    /// per table. `tables` maps a table to the columns to read (a topic
    /// pattern's placeholders); a table or column that does not exist is
    /// `DbError::Param`. An empty map removes the subscription.
    pub fn on_rows_changed(
        &self,
        tables: &[(String, Vec<String>)],
        deliver: RowsChanged,
    ) -> Result<()> {
        if tables.is_empty() {
            *lock(&self.writer.hooks.feed) = None;
            return Ok(());
        }
        let mut resolved = std::collections::HashMap::new();
        for (table, wanted) in tables {
            let names: Vec<String> = self.with_writer_policy(None, || {
                let mut stmt = self
                    .writer
                    .inner
                    .prepare("select name from pragma_table_info(?1) order by cid")
                    .map_err(|e| self.writer.error(e))?;
                let rows = stmt
                    .query_map([table], |r| r.get::<_, String>(0))
                    .map_err(|e| self.writer.error(e))?;
                rows.collect::<rusqlite::Result<Vec<_>>>()
                    .map_err(|e| self.writer.error(e))
            })?;
            if names.is_empty() {
                return Err(DbError::Param(format!("change feed: no table {table}")));
            }
            let mut cols = Vec::with_capacity(wanted.len());
            for w in wanted {
                let i = names.iter().position(|n| n == w).ok_or_else(|| {
                    DbError::Param(format!("change feed: {table} has no column {w}"))
                })?;
                cols.push((w.clone(), i32::try_from(i).unwrap_or(i32::MAX)));
            }
            resolved.insert(table.clone(), cols);
        }
        *lock(&self.writer.hooks.feed) = Some(Arc::new(FeedSubscription {
            tables: resolved,
            deliver,
        }));
        Ok(())
    }

    /// The policy installed by `with_authorizer`, if any.
    pub fn authorizer(&self) -> Option<&AuthorizerPolicy> {
        self.policy.as_deref()
    }

    /// Run `f` with `policy` on the writer instead of the handle's policy;
    /// the handle's policy is back when `f` returns or panics. The readers
    /// keep the handle's policy. Used by the migration runner (`allow_ddl`).
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

    /// Run `f` with `policy` on every connection instead of the handle's
    /// own (`None` = the platform); the handle's policy is back when `f`
    /// returns or panics. The runtime calls it per statement with the
    /// calling module's policy (`ops.md` section 1, "Module argument"), so
    /// one transaction can carry statements of several modules, each under
    /// its own authorizer. Switching to an equal policy keeps the statement
    /// cache.
    pub fn with_policy<T>(
        &self,
        policy: Option<AuthorizerPolicy>,
        f: impl FnOnce() -> T,
    ) -> Result<T> {
        if let Some(p) = &policy {
            p.validate()?;
        }
        let policy = policy.map(Arc::new);
        struct Restore<'a> {
            db: &'a TenantDb,
            old: Vec<(&'a Conn, Option<Arc<AuthorizerPolicy>>)>,
            override_old: Option<Option<Arc<AuthorizerPolicy>>>,
        }
        impl Drop for Restore<'_> {
            fn drop(&mut self) {
                // Readers opened inside `f` got the override: give them the
                // handle's policy back too.
                for c in self.db.connections() {
                    if !self.old.iter().any(|(o, _)| std::ptr::eq(*o, c)) {
                        c.set_policy(self.db.policy.clone());
                    }
                }
                for (c, p) in self.old.drain(..) {
                    c.set_policy(p);
                }
                *self.db.policy_override.borrow_mut() = self.override_old.take();
            }
        }
        let old = self
            .connections()
            .map(|c| (c, c.set_policy(policy.clone())))
            .collect();
        let override_old = self.policy_override.replace(Some(policy));
        let _restore = Restore {
            db: self,
            old,
            override_old,
        };
        Ok(f())
    }

    pub fn options(&self) -> &DbOptions {
        &self.options
    }

    /// Path of the file. For the platform only; never hand it to tenant code.
    pub fn path(&self) -> &Path {
        &self.path
    }

    fn reader(&self) -> Result<&Conn> {
        let i = self.next_reader.get();
        self.next_reader.set((i + 1) % self.readers.len());
        self.open_reader(i)
    }

    /// Reader `i`, opened now if it is not yet, with the handle's policy.
    fn open_reader(&self, i: usize) -> Result<&Conn> {
        let slot = &self.readers[i];
        if let Some(c) = slot.get() {
            return Ok(c);
        }
        let c = Conn::open(&self.path, true, &self.options)?;
        let policy = match &*self.policy_override.borrow() {
            Some(p) => p.clone(),
            None => self.policy.clone(),
        };
        c.set_policy(policy);
        Ok(slot.get_or_init(|| c))
    }

    /// The writer and the readers opened so far.
    pub(crate) fn connections(&self) -> impl Iterator<Item = &Conn> {
        std::iter::once(&self.writer).chain(self.readers.iter().filter_map(OnceCell::get))
    }

    fn limit(&self) -> Duration {
        Duration::from_millis(self.options.statement_timeout_ms)
    }

    /// Run one call: refuse it if the deadline has passed, time it, and
    /// record it in the stats. `f` returns its value and (rows read, rows
    /// written).
    fn measured<T>(
        &self,
        ctx: &QueryCtx,
        sql: &str,
        f: impl FnOnce() -> Result<(T, u64, u64)>,
    ) -> Result<T> {
        // #295: one span per statement with its verb and table names; the
        // SQL text and the parameters never leave this function.
        let span = tracing::info_span!(
            "db.query",
            kind = tracing::field::Empty,
            tables = tracing::field::Empty
        );
        if !span.is_disabled() {
            let (kind, tables) = statement_shape(sql);
            span.record("kind", kind.as_str());
            span.record("tables", tables.join(",").as_str());
        }
        let _entered = span.enter();
        let start = Instant::now();
        let result = if ctx.expired(start) {
            Err(DbError::Timeout)
        } else {
            f()
        };
        let outcome = match &result {
            Ok((_, read, written)) => Outcome::Rows {
                read: *read,
                written: *written,
            },
            Err(DbError::Busy) => Outcome::Busy,
            Err(DbError::Timeout) => Outcome::Timeout,
            Err(_) => Outcome::Failed,
        };
        let mut stats = self.stats.get();
        stats.record(start.elapsed(), outcome);
        self.stats.set(stats);
        result.map(|(v, _, _)| v)
    }

    /// Run a statement on the writer, collecting rows.
    fn on_writer(
        &self,
        ctx: &QueryCtx,
        sql: &str,
        params: &[Value],
        limit_one: bool,
    ) -> Result<(Vec<Row>, u64, u64)> {
        let mut stmt = self.writer.prepare(sql)?;
        let writes = !stmt.readonly();
        let _scope = self.writer.scope(self.limit(), ctx);
        // A statement that fails is undone by SQLite; so are its feed rows.
        let mark = lock(&self.writer.hooks.feed_buf).rows.len();
        let rows = self
            .writer
            .committing(|| self.writer.rows(&mut stmt, params, limit_one))
            .inspect_err(|_| lock(&self.writer.hooks.feed_buf).truncate(mark))?;
        let written = if writes {
            self.writer.inner.changes()
        } else {
            0
        };
        let read = rows.len() as u64;
        Ok((rows, read, written))
    }

    /// Run a read on a reader connection. A statement that writes
    /// (`insert ... returning`) goes to the writer instead.
    fn run_query(
        &self,
        ctx: &QueryCtx,
        sql: &str,
        params: &[Value],
        limit_one: bool,
    ) -> Result<Vec<Row>> {
        self.measured(ctx, sql, || {
            let reader = self.reader()?;
            let mut stmt = reader.prepare(sql)?;
            if stmt.readonly() {
                let _scope = reader.scope(self.limit(), ctx);
                let rows = reader.rows(&mut stmt, params, limit_one)?;
                let read = rows.len() as u64;
                return Ok((rows, read, 0));
            }
            drop(stmt);
            self.check_no_tx()?;
            self.on_writer(ctx, sql, params, limit_one)
        })
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
        self.query_with(&QueryCtx::default(), sql, params)
    }

    /// `query` bounded by the request deadline in `ctx`.
    pub fn query_with(&self, ctx: &QueryCtx, sql: &str, params: &[Value]) -> Result<Vec<Row>> {
        self.run_query(ctx, sql, params, false)
    }

    /// The first row of a query; the statement stops after it.
    pub fn query_one(&self, sql: &str, params: &[Value]) -> Result<Option<Row>> {
        self.query_one_with(&QueryCtx::default(), sql, params)
    }

    /// `query_one` bounded by the request deadline in `ctx`.
    pub fn query_one_with(
        &self,
        ctx: &QueryCtx,
        sql: &str,
        params: &[Value],
    ) -> Result<Option<Row>> {
        Ok(self.run_query(ctx, sql, params, true)?.into_iter().next())
    }

    /// Run a statement on the writer.
    pub fn execute(&self, sql: &str, params: &[Value]) -> Result<ExecResult> {
        self.execute_with(&QueryCtx::default(), sql, params)
    }

    /// `execute` bounded by the request deadline in `ctx`.
    pub fn execute_with(&self, ctx: &QueryCtx, sql: &str, params: &[Value]) -> Result<ExecResult> {
        self.check_no_tx()?;
        self.run_execute(ctx, sql, params)
    }

    fn run_execute(&self, ctx: &QueryCtx, sql: &str, params: &[Value]) -> Result<ExecResult> {
        // #311: at the disk's write watermark a tenant or module write is
        // refused here as well (SQLite would answer SQLITE_FULL later).
        if crate::limits::writes_refused() && !matches!(&*self.policy_override.borrow(), Some(None))
        {
            return Err(DbError::QuotaExceeded);
        }
        self.measured(ctx, sql, || {
            let (rows, read, written) = self.on_writer(ctx, sql, params, false)?;
            let _ = rows;
            Ok((
                ExecResult {
                    changes: self.writer.inner.changes(),
                    last_insert_rowid: self.writer.inner.last_insert_rowid(),
                },
                read,
                written,
            ))
        })
    }

    /// Counters since the handle was opened (`db_ms`, `db_rows` for the meter).
    pub fn stats(&self) -> DbStats {
        self.stats.get()
    }

    /// Checkpoint the WAL into the database file. The checkpoint is platform
    /// work: it runs with the platform policy on the writer, so a handle with
    /// a module authorizer can checkpoint too (#147).
    pub fn checkpoint(&self, mode: CheckpointMode) -> Result<CheckpointResult> {
        let mode = match mode {
            CheckpointMode::Passive => "PASSIVE",
            CheckpointMode::Truncate => "TRUNCATE",
        };
        let (log, done) = self.with_writer_policy(None, || self.writer.wal_checkpoint(mode))?;
        let log = u64::try_from(log).unwrap_or(0);
        let done = u64::try_from(done).unwrap_or(0);
        self.writer
            .hooks
            .wal_pages
            .store(log - done.min(log), Ordering::Relaxed);
        Ok(CheckpointResult {
            wal_frames: log,
            checkpointed_frames: done,
        })
    }

    /// Pages in the WAL after the last commit on this handle.
    pub fn wal_pages(&self) -> u64 {
        self.writer.hooks.wal_pages.load(Ordering::Relaxed)
    }

    /// Run a passive checkpoint if the WAL holds `wal_checkpoint_pages` or
    /// more. The cell calls it on a schedule and when the tenant is idle.
    pub fn maybe_checkpoint(&self) -> Result<Option<CheckpointResult>> {
        if self.in_tx.get() || self.wal_pages() < self.options.wal_checkpoint_pages {
            return Ok(None);
        }
        self.checkpoint(CheckpointMode::Passive).map(Some)
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
        let tx = Tx {
            db: self,
            rolled_back: Cell::new(false),
            savepoints: std::cell::RefCell::new(Vec::new()),
            next_savepoint: Cell::new(1),
        };
        let out = f(&tx)?;
        if tx.rolled_back.get() {
            // A statement timed out and the transaction was rolled back; the
            // caller swallowed the error, but nothing may be committed.
            return Err(DbError::Timeout.into());
        }
        self.writer
            .committing(|| self.writer.inner.execute_batch("commit"))
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
        for i in 0..self.readers.len() {
            self.open_reader(i)?;
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

    /// Truncate the WAL and close every connection. The cell calls this on
    /// idle eviction.
    pub fn close(self) -> Result<()> {
        let TenantDb {
            writer, readers, ..
        } = self;
        for r in readers.into_iter().filter_map(OnceCell::into_inner) {
            r.inner.close().map_err(|(_, e)| DbError::from(e))?;
        }
        // With the readers gone nothing holds the WAL; a failure here still
        // closes the writer, which checkpoints on close as well. Platform
        // work: the module authorizer would refuse the pragma (#147).
        writer.set_policy(None);
        let truncated = writer.wal_checkpoint("TRUNCATE");
        writer.inner.close().map_err(|(_, e)| DbError::from(e))?;
        truncated.map(|_| ())
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
    rolled_back: Cell<bool>,
    /// Open savepoints, innermost last.
    savepoints: std::cell::RefCell<Vec<u32>>,
    next_savepoint: Cell<u32>,
}

impl Tx<'_> {
    /// Open a savepoint inside this transaction (`ops.md` section 1,
    /// "Savepoints"): a nested `db.transaction`. The name is the platform's
    /// `renox_sp_<n>`, never tenant text; at most `MAX_SAVEPOINTS` at once.
    pub fn savepoint_begin(&self) -> Result<u32> {
        self.run(|| {
            if self.savepoints.borrow().len() >= MAX_SAVEPOINTS {
                return Err(DbError::TxState(format!(
                    "more than {MAX_SAVEPOINTS} savepoints are open"
                )));
            }
            let sp = self.next_savepoint.get();
            self.platform_batch(&format!("savepoint renox_sp_{sp}"))?;
            let mut buf = lock(&self.db.writer.hooks.feed_buf);
            let mark = buf.rows.len();
            buf.marks.push(mark);
            drop(buf);
            self.next_savepoint.set(sp + 1);
            self.savepoints.borrow_mut().push(sp);
            Ok(sp)
        })
    }

    /// Release the innermost savepoint `sp`: its statements become part of
    /// the transaction.
    pub fn savepoint_release(&self, sp: u32) -> Result<()> {
        self.run(|| {
            self.innermost(sp)?;
            self.platform_batch(&format!("release savepoint renox_sp_{sp}"))?;
            self.savepoints.borrow_mut().pop();
            lock(&self.db.writer.hooks.feed_buf).marks.pop();
            Ok(())
        })
    }

    /// Undo the statements since the innermost savepoint `sp`, then release
    /// it; the transaction goes on.
    pub fn savepoint_rollback(&self, sp: u32) -> Result<()> {
        self.run(|| {
            self.innermost(sp)?;
            self.platform_batch(&format!(
                "rollback to savepoint renox_sp_{sp}; release savepoint renox_sp_{sp}"
            ))?;
            self.savepoints.borrow_mut().pop();
            let mut buf = lock(&self.db.writer.hooks.feed_buf);
            if let Some(mark) = buf.marks.pop() {
                buf.truncate(mark);
            }
            Ok(())
        })
    }

    /// `f` inside a savepoint: released when it returns `Ok`, rolled back to
    /// when it returns `Err`; the outer transaction goes on either way.
    pub fn savepoint<T, E>(&self, f: impl FnOnce(&Self) -> Result<T, E>) -> Result<T, E>
    where
        E: From<DbError>,
    {
        let sp = self.savepoint_begin()?;
        match f(self) {
            Ok(v) => {
                self.savepoint_release(sp)?;
                Ok(v)
            }
            Err(e) => {
                // A timeout inside `f` rolled the whole transaction back.
                if !self.rolled_back.get() {
                    self.savepoint_rollback(sp)?;
                }
                Err(e)
            }
        }
    }

    /// Savepoints open now.
    pub fn savepoint_depth(&self) -> usize {
        self.savepoints.borrow().len()
    }

    fn innermost(&self, sp: u32) -> Result<()> {
        match self.savepoints.borrow().last() {
            Some(&top) if top == sp => Ok(()),
            Some(_) if self.savepoints.borrow().contains(&sp) => Err(DbError::TxState(format!(
                "savepoint {sp} is not the innermost open savepoint"
            ))),
            _ => Err(DbError::TxState(format!("savepoint {sp} is not open"))),
        }
    }

    /// Platform statements on the writer, outside any module policy.
    fn platform_batch(&self, sql: &str) -> Result<()> {
        let writer = &self.db.writer;
        self.db.with_writer_policy(None, || {
            writer.clear_denial();
            writer
                .committing(|| writer.inner.execute_batch(sql))
                .map_err(|e| writer.error(e))
        })
    }

    pub fn query(&self, sql: &str, params: &[Value]) -> Result<Vec<Row>> {
        self.query_with(&QueryCtx::default(), sql, params)
    }

    pub fn query_with(&self, ctx: &QueryCtx, sql: &str, params: &[Value]) -> Result<Vec<Row>> {
        self.run(|| {
            self.db
                .measured(ctx, sql, || self.db.on_writer(ctx, sql, params, false))
        })
    }

    pub fn query_one(&self, sql: &str, params: &[Value]) -> Result<Option<Row>> {
        self.query_one_with(&QueryCtx::default(), sql, params)
    }

    pub fn query_one_with(
        &self,
        ctx: &QueryCtx,
        sql: &str,
        params: &[Value],
    ) -> Result<Option<Row>> {
        let rows = self.run(|| {
            self.db
                .measured(ctx, sql, || self.db.on_writer(ctx, sql, params, true))
        })?;
        Ok(rows.into_iter().next())
    }

    pub fn execute(&self, sql: &str, params: &[Value]) -> Result<ExecResult> {
        self.execute_with(&QueryCtx::default(), sql, params)
    }

    pub fn execute_with(&self, ctx: &QueryCtx, sql: &str, params: &[Value]) -> Result<ExecResult> {
        self.run(|| self.db.run_execute(ctx, sql, params))
    }

    /// Run several statements (a migration file) with one time limit.
    pub(crate) fn execute_batch(&self, sql: &str, limit: Duration) -> Result<()> {
        self.run(|| {
            let writer = &self.db.writer;
            writer.clear_denial();
            let _scope = writer.scope(limit, &QueryCtx::default());
            writer
                .committing(|| writer.inner.execute_batch(sql))
                .map_err(|e| writer.error(e))
        })
    }

    /// A timeout rolls the whole transaction back (`docs/contracts/ops.md`
    /// section 1, "Limits"); later statements on this `Tx` are refused
    /// instead of silently running in autocommit mode.
    fn run<T>(&self, f: impl FnOnce() -> Result<T>) -> Result<T> {
        if self.rolled_back.get() {
            return Err(DbError::TxState(
                "the transaction was rolled back after a timeout".into(),
            ));
        }
        let result = f();
        if matches!(result, Err(DbError::Timeout)) {
            if !self.db.writer.inner.is_autocommit() {
                let _ = self.db.writer.inner.execute_batch("rollback");
            }
            self.rolled_back.set(true);
        }
        result
    }
}

/// The verb of a statement (`select`, `insert`, …) and the names that
/// follow `from`, `join`, `into`, `update` and `table` (#295, the `db.query`
/// span). Identifiers only: a literal or a parameter is never taken.
pub(crate) fn statement_shape(sql: &str) -> (String, Vec<String>) {
    let words: Vec<String> = sql
        .split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .filter(|w| !w.is_empty())
        .map(str::to_ascii_lowercase)
        .collect();
    let kind = words.first().cloned().unwrap_or_default();
    let mut tables: Vec<String> = Vec::new();
    for pair in words.windows(2) {
        if matches!(
            pair[0].as_str(),
            "from" | "join" | "into" | "update" | "table"
        ) && pair[1].starts_with(|c: char| c.is_ascii_alphabetic() || c == '_')
            && !matches!(pair[1].as_str(), "select" | "if" | "not" | "exists")
            && !tables.contains(&pair[1])
        {
            tables.push(pair[1].clone());
        }
    }
    (kind, tables)
}

#[cfg(test)]
mod shape_tests {
    #[test]
    fn verb_and_tables_without_values() {
        let (k, t) = super::statement_shape(
            "SELECT o.id FROM app__orders o JOIN app__lines l ON l.o = o.id WHERE o.token = 'sk_live_x'",
        );
        assert_eq!(k, "select");
        assert_eq!(t, vec!["app__orders", "app__lines"]);
        let (k, t) = super::statement_shape("insert into app__notes (body) values (?)");
        assert_eq!((k.as_str(), t), ("insert", vec!["app__notes".to_string()]));
    }
}
