//! `op_db_*` (`docs/contracts/ops.md` section 1): `ctx.db` backed by the
//! tenant's SQLite file (`renox-data`).
//!
//! **Thread model.** `TenantDb` is `Send` but not `Sync`, and
//! `TenantDb::transaction` is a closure, while `db.transaction(async (tx) =>
//! ...)` runs JavaScript between statements. So the file gets one dedicated
//! **DB thread** ([`DbHandle::spawn`]), owned by the cell and shared by every
//! isolate of the tenant: ops send jobs over a channel and await the reply,
//! so a statement never blocks the isolate thread. A transaction is the DB
//! thread sitting inside `TenantDb::transaction`, serving that transaction's
//! statements until its commit or rollback arrives:
//!
//! - statements of the open transaction run on it (the writer);
//! - reads with no transaction run on a reader connection, outside it;
//! - writes with no transaction, another `begin`, and cell calls wait in a
//!   queue until it ends, each at most `min(busy_timeout, its deadline)`,
//!   then fail with `RENOX_DB_BUSY` (one writer per file, SQLite's rule);
//! - it is rolled back when its request ends for any reason (the runtime
//!   sends the rollback, `end_request`), and in any case at its request's
//!   deadline, so the writer is never held by a request that is gone.
//!
//! The pure part (the thread, parameter and result conversion) compiles
//! without V8; the ops themselves are behind the `v8` feature.

use std::collections::VecDeque;
use std::sync::{Arc, mpsc};
use std::time::{Duration, Instant};

use renox_data::{AuthorizerPolicy, DbError, ExecResult, QueryCtx, Row, TenantDb, Value};
use tokio::sync::oneshot;

/// SQL text longer than this is refused (`RENOX_DB_PARAM`).
pub const MAX_SQL_BYTES: usize = 100 * 1024;
/// Parameters per statement (`RENOX_DB_PARAM`).
pub const MAX_PARAMS: usize = 1_000;
/// Rows returned by one `op_db_query` (`RENOX_DB_RESULT_LIMIT`).
pub const MAX_ROWS: usize = 10_000;
/// Bytes returned by one call (`RENOX_DB_RESULT_LIMIT`).
pub const MAX_RESULT_BYTES: usize = 8 * 1024 * 1024;
/// Largest integer a JavaScript `number` holds exactly.
const MAX_SAFE_INTEGER: i64 = (1 << 53) - 1;

/// Which statement op.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StmtKind {
    Query,
    QueryOne,
    Execute,
}

/// What a statement returned.
#[derive(Debug)]
pub enum StmtOut {
    Rows(Vec<Row>),
    Row(Option<Row>),
    Exec(ExecResult),
}

/// A statement's result plus what it cost (`db_ms`, `db_rows`).
#[derive(Debug)]
pub struct Measured {
    pub value: Result<StmtOut, DbError>,
    pub ms: f64,
    pub rows: u64,
}

type Reply<T> = oneshot::Sender<T>;

enum Job {
    Stmt {
        kind: StmtKind,
        sql: String,
        params: Vec<Value>,
        /// Transaction handle; `None` runs outside any transaction.
        tx: Option<u32>,
        /// The calling module's authorizer (`ops.md` 1.3.0 section 1,
        /// "Module argument"); `None` keeps the handle's own (the app's).
        policy: Option<Arc<AuthorizerPolicy>>,
        deadline: Instant,
        reply: Reply<Measured>,
    },
    /// A savepoint of the open transaction `tx` (`ops.md` 1.3.0 section 1).
    Savepoint {
        tx: u32,
        op: SavepointOp,
        reply: Reply<Result<u32, DbError>>,
    },
    Begin {
        deadline: Instant,
        reply: Reply<Result<u32, DbError>>,
    },
    End {
        tx: u32,
        commit: bool,
        reply: Option<Reply<Result<(), DbError>>>,
    },
    Call(Box<dyn FnOnce(&TenantDb) + Send>),
    /// Run on the DB thread inside the open transaction `tx`, or outside
    /// any transaction for `None` (a platform write such as an outbox row,
    /// `ops/events.rs`). A mismatched handle gets `TxState`.
    TxCall {
        tx: Option<u32>,
        f: TxFn,
    },
    Close(Reply<Result<(), DbError>>),
    /// Answered once the file is open ([`DbHandle::ready`]).
    Ready(Reply<Result<(), DbError>>),
}

type TxFn = Box<dyn FnOnce(&TenantDb, Result<Option<&renox_data::Tx<'_>>, DbError>) + Send>;

/// What a savepoint job does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SavepointOp {
    Begin,
    Release(u32),
    Rollback(u32),
}

/// A job waiting for the writer, with the time it gives up.
struct Deferred {
    job: Job,
    busy_until: Option<Instant>,
}

/// The handle of a tenant file's DB thread. Cheap to clone, `Send + Sync`.
#[derive(Clone)]
pub struct DbHandle {
    tx: mpsc::Sender<Job>,
}

impl std::fmt::Debug for DbHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Never print the file path.
        f.write_str("DbHandle")
    }
}

fn closed() -> DbError {
    DbError::Open("the database is closed".into())
}

impl DbHandle {
    /// Move `db` onto its own thread.
    pub fn spawn(db: TenantDb) -> std::io::Result<DbHandle> {
        let (tx, rx) = mpsc::channel();
        std::thread::Builder::new()
            .name("renox-db".into())
            .spawn(move || db_thread(db, rx))?;
        Ok(DbHandle { tx })
    }

    /// Open the file on its DB thread and return the handle at once (#157:
    /// the cell opens the tenant file while the isolate is created). Jobs
    /// sent before the open finishes wait for it; if `open` fails, every
    /// job is answered with that error (a [`DbHandle::call`] with
    /// "the database is closed") until the last handle is dropped.
    pub fn open_in_background(
        open: impl FnOnce() -> Result<TenantDb, DbError> + Send + 'static,
    ) -> std::io::Result<DbHandle> {
        let (tx, rx) = mpsc::channel();
        std::thread::Builder::new()
            .name("renox-db".into())
            .spawn(move || match open() {
                Ok(db) => db_thread(db, rx),
                Err(e) => failed_thread(e, rx),
            })?;
        Ok(DbHandle { tx })
    }

    /// Wait until the file is open: `Err` with the open error if it failed.
    pub async fn ready(&self) -> Result<(), DbError> {
        let (reply, rx) = oneshot::channel();
        self.tx.send(Job::Ready(reply)).map_err(|_| closed())?;
        rx.await.unwrap_or_else(|_| Err(closed()))
    }

    /// Run one statement, under `policy` when it is a module's.
    pub async fn statement(
        &self,
        kind: StmtKind,
        sql: String,
        params: Vec<Value>,
        tx: Option<u32>,
        policy: Option<Arc<AuthorizerPolicy>>,
        deadline: Instant,
    ) -> Measured {
        let (reply, rx) = oneshot::channel();
        let job = Job::Stmt {
            kind,
            sql,
            params,
            tx,
            policy,
            deadline,
            reply,
        };
        let failed = |e| Measured {
            value: Err(e),
            ms: 0.0,
            rows: 0,
        };
        if self.tx.send(job).is_err() {
            return failed(closed());
        }
        rx.await.unwrap_or_else(|_| failed(closed()))
    }

    /// Begin an immediate transaction; resolves once the writer is held.
    pub async fn begin(&self, deadline: Instant) -> Result<u32, DbError> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Job::Begin { deadline, reply })
            .map_err(|_| closed())?;
        rx.await.unwrap_or_else(|_| Err(closed()))
    }

    /// Begin, release, or roll back to a savepoint of the open transaction
    /// `tx`; `Begin` answers the savepoint handle, the others `0`.
    pub async fn savepoint(&self, tx: u32, op: SavepointOp) -> Result<u32, DbError> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Job::Savepoint { tx, op, reply })
            .map_err(|_| closed())?;
        rx.await.unwrap_or_else(|_| Err(closed()))
    }

    /// Commit (`commit = true`) or roll back a transaction.
    pub async fn end(&self, tx: u32, commit: bool) -> Result<(), DbError> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Job::End {
                tx,
                commit,
                reply: Some(reply),
            })
            .map_err(|_| closed())?;
        rx.await.unwrap_or_else(|_| Err(closed()))
    }

    /// Roll back without waiting (a request that ended, `end_request`). The
    /// DB thread handles it before any job sent after it, so the next
    /// request on the tenant finds the writer free.
    pub fn rollback_detached(&self, tx: u32) {
        let _ = self.tx.send(Job::End {
            tx,
            commit: false,
            reply: None,
        });
    }

    /// Run `f` on the DB thread with the handle (migrations, checkpoints,
    /// stats). Waits for an open transaction to end first.
    pub async fn call<T: Send + 'static>(
        &self,
        f: impl FnOnce(&TenantDb) -> T + Send + 'static,
    ) -> Result<T, DbError> {
        let (reply, rx) = oneshot::channel();
        let job = Job::Call(Box::new(move |db| {
            let _ = reply.send(f(db));
        }));
        self.tx.send(job).map_err(|_| closed())?;
        rx.await.map_err(|_| closed())
    }

    /// Run `f` inside the open transaction `tx` (`Some`), or as its own
    /// autocommit work once no transaction holds the writer (`None`).
    pub async fn call_tx<T: Send + 'static>(
        &self,
        tx: Option<u32>,
        f: impl FnOnce(&TenantDb, Option<&renox_data::Tx<'_>>) -> Result<T, DbError> + Send + 'static,
    ) -> Result<T, DbError> {
        let (reply, rx) = oneshot::channel();
        let job = Job::TxCall {
            tx,
            f: Box::new(move |db, t| {
                let _ = reply.send(t.and_then(|t| f(db, t)));
            }),
        };
        self.tx.send(job).map_err(|_| closed())?;
        rx.await.unwrap_or_else(|_| Err(closed()))
    }

    /// Roll back an open transaction, truncate the WAL, and close the file
    /// (`TenantDb::close`); the thread then exits.
    pub async fn close(&self) -> Result<(), DbError> {
        let (reply, rx) = oneshot::channel();
        self.tx.send(Job::Close(reply)).map_err(|_| closed())?;
        rx.await.unwrap_or_else(|_| Err(closed()))
    }
}

fn busy_until(db: &TenantDb, deadline: Instant) -> Instant {
    let busy = Duration::from_millis(db.options().busy_timeout_ms);
    (Instant::now() + busy).min(deadline)
}

fn run_stmt(
    db: &TenantDb,
    f: impl FnOnce(&QueryCtx) -> Result<StmtOut, DbError>,
    deadline: Instant,
) -> Measured {
    let before = db.stats();
    let value = f(&QueryCtx::with_deadline(deadline));
    let d = db.stats().since(&before);
    Measured {
        value,
        ms: d.db_ms(),
        rows: d.db_rows(),
    }
}

/// Run `f` under the module's policy, or the handle's own for `None`.
fn with_module(
    db: &TenantDb,
    policy: Option<&Arc<AuthorizerPolicy>>,
    f: impl FnOnce() -> Measured,
) -> Measured {
    match policy {
        None => f(),
        Some(p) => db
            .with_policy(Some((**p).clone()), f)
            .unwrap_or_else(|e| Measured {
                value: Err(e),
                ms: 0.0,
                rows: 0,
            }),
    }
}

fn on_db(
    db: &TenantDb,
    kind: StmtKind,
    sql: &str,
    params: &[Value],
    deadline: Instant,
) -> Measured {
    run_stmt(
        db,
        |ctx| match kind {
            StmtKind::Query => db.query_with(ctx, sql, params).map(StmtOut::Rows),
            StmtKind::QueryOne => db.query_one_with(ctx, sql, params).map(StmtOut::Row),
            StmtKind::Execute => db.execute_with(ctx, sql, params).map(StmtOut::Exec),
        },
        deadline,
    )
}

fn on_tx(
    db: &TenantDb,
    tx: &renox_data::Tx<'_>,
    kind: StmtKind,
    sql: &str,
    params: &[Value],
    deadline: Instant,
) -> Measured {
    run_stmt(
        db,
        |ctx| match kind {
            StmtKind::Query => tx.query_with(ctx, sql, params).map(StmtOut::Rows),
            StmtKind::QueryOne => tx.query_one_with(ctx, sql, params).map(StmtOut::Row),
            StmtKind::Execute => tx.execute_with(ctx, sql, params).map(StmtOut::Exec),
        },
        deadline,
    )
}

fn tx_state(msg: &str) -> DbError {
    DbError::TxState(msg.into())
}

/// Answer a job that gave up waiting for the writer.
fn fail_busy(job: Job) {
    match job {
        Job::Stmt { reply, .. } => {
            let _ = reply.send(Measured {
                value: Err(DbError::Busy),
                ms: 0.0,
                rows: 0,
            });
        }
        Job::Begin { reply, .. } => {
            let _ = reply.send(Err(DbError::Busy));
        }
        _ => {}
    }
}

/// How a transaction closure ended.
enum TxEnd {
    Rollback,
    Db(DbError),
}

impl From<DbError> for TxEnd {
    fn from(e: DbError) -> Self {
        TxEnd::Db(e)
    }
}

struct DbLoop {
    deferred: VecDeque<Deferred>,
    next_tx: u32,
    close: Option<Reply<Result<(), DbError>>>,
}

impl DbLoop {
    fn defer(&mut self, db: &TenantDb, job: Job) {
        let busy_until = match &job {
            Job::Stmt { deadline, .. } | Job::Begin { deadline, .. } => {
                Some(busy_until(db, *deadline))
            }
            _ => None,
        };
        self.deferred.push_back(Deferred { job, busy_until });
    }

    /// Fail every deferred job whose busy wait is over.
    fn expire(&mut self, now: Instant) {
        let mut keep = VecDeque::with_capacity(self.deferred.len());
        for d in self.deferred.drain(..) {
            if d.busy_until.is_some_and(|b| b <= now) {
                fail_busy(d.job);
            } else {
                keep.push_back(d);
            }
        }
        self.deferred = keep;
    }

    /// The next job with no transaction open: deferred ones first.
    fn next(&mut self, rx: &mpsc::Receiver<Job>) -> Option<Job> {
        self.expire(Instant::now());
        if let Some(d) = self.deferred.pop_front() {
            return Some(d.job);
        }
        rx.recv().ok()
    }

    /// Serve one transaction from `begin` to its end.
    fn transaction(
        &mut self,
        db: &TenantDb,
        rx: &mpsc::Receiver<Job>,
        deadline: Instant,
        reply: Reply<Result<u32, DbError>>,
    ) {
        self.next_tx = self.next_tx.wrapping_add(1).max(1);
        let id = self.next_tx;
        let mut begin_reply = Some(reply);
        let mut end_reply = None;
        let result = db.transaction(|tx| -> Result<(), TxEnd> {
            // The requester may have gone (deadline) while waiting for the
            // writer: then nobody will ever end this transaction.
            let reply = begin_reply.take().expect("begin reply sent once");
            if reply.send(Ok(id)).is_err() {
                return Err(TxEnd::Rollback);
            }
            loop {
                let now = Instant::now();
                self.expire(now);
                if now >= deadline {
                    // Safety net: the request is over whatever the runtime
                    // did; never keep the writer past it.
                    return Err(TxEnd::Rollback);
                }
                let wake = self
                    .deferred
                    .iter()
                    .filter_map(|d| d.busy_until)
                    .min()
                    .map_or(deadline, |b| b.min(deadline));
                let job = match rx.recv_timeout(wake.saturating_duration_since(now)) {
                    Ok(job) => job,
                    Err(mpsc::RecvTimeoutError::Timeout) => continue,
                    Err(mpsc::RecvTimeoutError::Disconnected) => return Err(TxEnd::Rollback),
                };
                match job {
                    Job::Stmt {
                        kind,
                        sql,
                        params,
                        tx: Some(t),
                        policy,
                        deadline,
                        reply,
                    } if t == id => {
                        let _ = reply.send(with_module(db, policy.as_ref(), || {
                            on_tx(db, tx, kind, &sql, &params, deadline)
                        }));
                    }
                    Job::Savepoint { tx: t, op, reply } if t == id => {
                        let r = match op {
                            SavepointOp::Begin => tx.savepoint_begin(),
                            SavepointOp::Release(sp) => tx.savepoint_release(sp).map(|()| 0),
                            SavepointOp::Rollback(sp) => tx.savepoint_rollback(sp).map(|()| 0),
                        };
                        let _ = reply.send(r);
                    }
                    Job::Savepoint { reply, .. } => {
                        let _ = reply.send(Err(tx_state("the transaction is not open")));
                    }
                    Job::Stmt {
                        tx: Some(_), reply, ..
                    } => {
                        let _ = reply.send(Measured {
                            value: Err(tx_state("the transaction is not open")),
                            ms: 0.0,
                            rows: 0,
                        });
                    }
                    Job::Stmt {
                        kind: kind @ (StmtKind::Query | StmtKind::QueryOne),
                        sql,
                        params,
                        tx: None,
                        policy,
                        deadline,
                        reply,
                    } => {
                        // Reads outside the transaction run on a reader.
                        let _ = reply.send(with_module(db, policy.as_ref(), || {
                            on_db(db, kind, &sql, &params, deadline)
                        }));
                    }
                    Job::TxCall { tx: Some(t), f } if t == id => f(db, Ok(Some(tx))),
                    Job::TxCall { tx: Some(_), f } => {
                        f(db, Err(tx_state("the transaction is not open")));
                    }
                    job @ (Job::Stmt { .. }
                    | Job::Begin { .. }
                    | Job::Call(_)
                    | Job::TxCall { .. }) => {
                        self.defer(db, job);
                    }
                    Job::End {
                        tx: t,
                        commit,
                        reply,
                    } if t == id => {
                        end_reply = reply;
                        return if commit { Ok(()) } else { Err(TxEnd::Rollback) };
                    }
                    Job::End { reply, .. } => {
                        if let Some(r) = reply {
                            let _ = r.send(Err(tx_state("the transaction is not open")));
                        }
                    }
                    Job::Close(r) => {
                        self.close = Some(r);
                        return Err(TxEnd::Rollback);
                    }
                    Job::Ready(r) => {
                        let _ = r.send(Ok(()));
                    }
                }
            }
        });
        if let Some(reply) = begin_reply {
            // `begin immediate` itself failed.
            let e = match result {
                Err(TxEnd::Db(e)) => e,
                _ => DbError::Busy,
            };
            let _ = reply.send(Err(e));
            return;
        }
        if let Some(reply) = end_reply {
            let _ = reply.send(match result {
                Ok(()) | Err(TxEnd::Rollback) => Ok(()),
                Err(TxEnd::Db(e)) => Err(e),
            });
        }
    }
}

/// The DB thread of a file that failed to open: every job gets the open
/// error, and a `call` is dropped (its caller sees a closed database).
fn failed_thread(e: DbError, rx: mpsc::Receiver<Job>) {
    while let Ok(job) = rx.recv() {
        match job {
            Job::Stmt { reply, .. } => {
                let _ = reply.send(Measured {
                    value: Err(e.clone()),
                    ms: 0.0,
                    rows: 0,
                });
            }
            Job::Begin { reply, .. } | Job::Savepoint { reply, .. } => {
                let _ = reply.send(Err(e.clone()));
            }
            Job::End { reply, .. } => {
                if let Some(r) = reply {
                    let _ = r.send(Err(e.clone()));
                }
            }
            Job::Call(_) => {}
            Job::TxCall { .. } => {}
            Job::Close(reply) | Job::Ready(reply) => {
                let _ = reply.send(Err(e.clone()));
            }
        }
    }
}

fn db_thread(db: TenantDb, rx: mpsc::Receiver<Job>) {
    let mut lp = DbLoop {
        deferred: VecDeque::new(),
        next_tx: 0,
        close: None,
    };
    loop {
        if let Some(reply) = lp.close.take() {
            for d in lp.deferred.drain(..) {
                fail_busy(d.job);
            }
            let _ = reply.send(db.close());
            return;
        }
        let Some(job) = lp.next(&rx) else {
            // Every handle is gone: close the file.
            let _ = db.close();
            return;
        };
        match job {
            Job::Stmt {
                kind,
                sql,
                params,
                tx: None,
                policy,
                deadline,
                reply,
            } => {
                let _ = reply.send(with_module(&db, policy.as_ref(), || {
                    on_db(&db, kind, &sql, &params, deadline)
                }));
            }
            Job::Savepoint { reply, .. } => {
                let _ = reply.send(Err(tx_state("the transaction is not open")));
            }
            Job::Stmt { reply, .. } => {
                let _ = reply.send(Measured {
                    value: Err(tx_state("the transaction is not open")),
                    ms: 0.0,
                    rows: 0,
                });
            }
            Job::Begin { deadline, reply } => lp.transaction(&db, &rx, deadline, reply),
            Job::End { reply, .. } => {
                if let Some(r) = reply {
                    let _ = r.send(Err(tx_state("the transaction is not open")));
                }
            }
            Job::Call(f) => f(&db),
            Job::TxCall { tx: None, f } => f(&db, Ok(None)),
            Job::TxCall { f, .. } => f(&db, Err(tx_state("the transaction is not open"))),
            Job::Close(reply) => lp.close = Some(reply),
            Job::Ready(reply) => {
                let _ = reply.send(Ok(()));
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Values across the op boundary (ops.md sections 1 and 12). Pure Rust.

/// A parameter as the bootstrap encodes it: `[tag, number, string]`
/// (`js/bootstrap.js`, `encodeParam`); bytes travel separately.
#[derive(Debug, Clone, PartialEq)]
pub enum ParamIn {
    Null,
    Bool(bool),
    Number(f64),
    /// Decimal text of a `bigint`.
    BigInt(String),
    Text(String),
    Bytes(Vec<u8>),
    /// A string with a lone UTF-16 surrogate.
    IllFormed,
    /// Anything else; the payload is the JavaScript type name.
    Unsupported(String),
}

/// Why a parameter list or statement was refused before it ran.
#[derive(Debug, Clone, PartialEq)]
pub struct UsageError {
    pub code: &'static str,
    pub message: String,
    pub index: Option<usize>,
}

fn param_error(index: Option<usize>, message: String) -> UsageError {
    UsageError {
        code: "RENOX_DB_PARAM",
        message,
        index,
    }
}

/// Check the SQL text and convert the parameters per `ops.md` section 1.
pub fn convert_params(sql: &str, params: Vec<ParamIn>) -> Result<Vec<Value>, UsageError> {
    if sql.len() > MAX_SQL_BYTES {
        return Err(param_error(
            None,
            format!("SQL text is longer than {MAX_SQL_BYTES} bytes"),
        ));
    }
    if params.len() > MAX_PARAMS {
        return Err(param_error(
            None,
            format!("more than {MAX_PARAMS} parameters"),
        ));
    }
    params
        .into_iter()
        .enumerate()
        .map(|(i, p)| match p {
            ParamIn::Null => Ok(Value::Null),
            ParamIn::Bool(b) => Ok(Value::Integer(i64::from(b))),
            ParamIn::Number(n) if !n.is_finite() => Err(param_error(
                Some(i),
                format!("parameter {i} is NaN or Infinity"),
            )),
            ParamIn::Number(n) if n.fract() == 0.0 && n.abs() <= MAX_SAFE_INTEGER as f64 => {
                Ok(Value::Integer(n as i64))
            }
            ParamIn::Number(n) => Ok(Value::Real(n)),
            ParamIn::BigInt(s) => s.parse::<i64>().map(Value::Integer).map_err(|_| {
                param_error(Some(i), format!("parameter {i} is a bigint outside i64"))
            }),
            ParamIn::Text(s) => Ok(Value::Text(s)),
            ParamIn::Bytes(b) => Ok(Value::Blob(b)),
            ParamIn::IllFormed => Err(param_error(
                Some(i),
                format!("parameter {i} is a string with a lone surrogate"),
            )),
            ParamIn::Unsupported(t) => Err(param_error(
                Some(i),
                format!("parameter {i} has unsupported type {t}"),
            )),
        })
        .collect()
}

/// One result value for JavaScript.
#[derive(Debug, Clone, PartialEq)]
pub enum CellOut {
    Null,
    Number(f64),
    /// An INTEGER outside ±(2^53 − 1): becomes a `bigint`.
    BigInt(String),
    Text(String),
    Bytes(Vec<u8>),
}

impl CellOut {
    fn from_value(v: Value) -> CellOut {
        match v {
            Value::Null => CellOut::Null,
            Value::Integer(i) if (-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(&i) => {
                CellOut::Number(i as f64)
            }
            Value::Integer(i) => CellOut::BigInt(i.to_string()),
            Value::Real(f) => CellOut::Number(f),
            Value::Text(s) => CellOut::Text(s),
            Value::Blob(b) => CellOut::Bytes(b),
        }
    }

    fn size(&self) -> usize {
        match self {
            CellOut::Text(s) => s.len(),
            CellOut::Bytes(b) => b.len(),
            _ => 8,
        }
    }
}

/// Rows for JavaScript: the column names once, then the values per row.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct RowsOut {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<CellOut>>,
}

/// Convert rows and apply the row and byte limits of one call.
pub fn rows_out(rows: Vec<Row>, max_rows: usize) -> Result<RowsOut, UsageError> {
    let limit = |message: String| UsageError {
        code: "RENOX_DB_RESULT_LIMIT",
        message,
        index: None,
    };
    if rows.len() > max_rows {
        return Err(limit(format!(
            "the query returned more than {max_rows} rows"
        )));
    }
    let mut out = RowsOut::default();
    let mut bytes = 0usize;
    for (i, row) in rows.into_iter().enumerate() {
        let mut cells = Vec::with_capacity(row.len());
        for (name, v) in row.into_columns() {
            if i == 0 {
                bytes += name.len();
                out.columns.push(name);
            }
            let c = CellOut::from_value(v);
            bytes += c.size();
            cells.push(c);
        }
        if bytes > MAX_RESULT_BYTES {
            return Err(limit(format!(
                "the result is larger than {MAX_RESULT_BYTES} bytes"
            )));
        }
        out.rows.push(cells);
    }
    Ok(out)
}

/// `lastInsertRowid` for JavaScript.
pub fn rowid_out(id: i64) -> CellOut {
    CellOut::from_value(Value::Integer(id))
}

/// The `details` object of a `RenoxError` for a database error. Never the
/// file path: `renox-data` messages do not carry it.
pub fn error_details(e: &DbError) -> serde_json::Value {
    match e {
        DbError::Auth { table, action } => serde_json::json!({ "table": table, "action": action }),
        DbError::Constraint { kind, .. } => serde_json::json!({ "kind": kind.as_str() }),
        // ops.md 1.5.0 section 17: logged with these, never the SQL.
        DbError::Scope {
            table,
            module,
            reason,
        } => serde_json::json!({ "table": table, "module": module, "reason": reason.as_str() }),
        _ => serde_json::Value::Null,
    }
}

/// The tenant-visible message of a database error.
pub fn error_message(e: &DbError) -> String {
    match e {
        // The open error may describe the file; say nothing about it.
        DbError::Open(_) => "The database is not available.".into(),
        other => other.to_string(),
    }
}

// ---------------------------------------------------------------------------
// The ops (V8).

#[cfg(feature = "v8")]
pub(crate) use v8_ops::*;

#[cfg(feature = "v8")]
mod v8_ops {
    use std::cell::RefCell;
    use std::rc::Rc;
    use std::sync::Arc;

    use deno_core::{CancelFuture, JsBuffer, OpState, ToJsBuffer, op2};
    use deno_error::JsErrorBox;
    use serde::{Deserialize, Serialize, Serializer};

    use super::*;
    use crate::ops::request::{live_request, op_error};
    use crate::ops::secrets::Redactor;

    /// The database environment of one isolate.
    pub(crate) struct DbEnv {
        pub db: Option<DbHandle>,
        pub redactor: Arc<Redactor>,
        /// The installed modules: their authorizer policies (ops.md 1.3.0).
        pub modules: Arc<crate::ops::modules::ModuleRegistry>,
    }

    /// `[tag, number, string]`, with the bytes of tag 5 in a separate list.
    #[derive(Deserialize)]
    pub(crate) struct WireParam(u8, Option<f64>, Option<String>);

    /// Wire form of [`CellOut`]: `null`, `number`, `[decimal]` (bigint),
    /// `string`, or `Uint8Array`.
    struct WireCell(CellOut);

    impl Serialize for WireCell {
        fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
            match &self.0 {
                CellOut::Null => s.serialize_unit(),
                CellOut::Number(n) => s.serialize_f64(*n),
                CellOut::BigInt(d) => (d.as_str(),).serialize(s),
                CellOut::Text(t) => s.serialize_str(t),
                CellOut::Bytes(b) => ToJsBuffer::from(b.clone()).serialize(s),
            }
        }
    }

    #[derive(Serialize)]
    pub(crate) struct WireRows {
        columns: Vec<String>,
        rows: Vec<Vec<WireCell>>,
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    pub(crate) struct WireExec {
        changes: f64,
        last_insert_rowid: WireCell,
    }

    fn wire_rows(r: RowsOut) -> WireRows {
        WireRows {
            columns: r.columns,
            rows: r
                .rows
                .into_iter()
                .map(|row| row.into_iter().map(WireCell).collect())
                .collect(),
        }
    }

    fn usage(e: UsageError) -> JsErrorBox {
        let details = match e.index {
            Some(i) => serde_json::json!({ "index": i }),
            None => serde_json::Value::Null,
        };
        op_error(e.code, details, &e.message)
    }

    fn db_error(redactor: &Redactor, e: &DbError) -> JsErrorBox {
        op_error(
            e.code(),
            error_details(e),
            &redactor.redact(&error_message(e)),
        )
    }

    fn decode(params: Vec<WireParam>, bytes: Vec<JsBuffer>) -> Vec<ParamIn> {
        let mut bytes = bytes.into_iter();
        params
            .into_iter()
            .map(|WireParam(tag, n, s)| match tag {
                0 => ParamIn::Null,
                1 => ParamIn::Bool(n.unwrap_or(0.0) != 0.0),
                2 => ParamIn::Number(n.unwrap_or(f64::NAN)),
                3 => ParamIn::BigInt(s.unwrap_or_default()),
                4 => ParamIn::Text(s.unwrap_or_default()),
                5 => match bytes.next() {
                    Some(b) => ParamIn::Bytes(b.to_vec()),
                    None => ParamIn::Unsupported("Uint8Array".into()),
                },
                7 => ParamIn::IllFormed,
                _ => ParamIn::Unsupported(s.unwrap_or_else(|| "unknown".into())),
            })
            .collect()
    }

    fn env(state: &Rc<RefCell<OpState>>) -> Rc<DbEnv> {
        state.borrow().borrow::<Rc<DbEnv>>().clone()
    }

    #[allow(clippy::too_many_arguments)]
    async fn statement(
        state: Rc<RefCell<OpState>>,
        token: u32,
        kind: StmtKind,
        sql: String,
        params: Vec<WireParam>,
        bytes: Vec<JsBuffer>,
        tx: u32,
        module: Option<String>,
        scope: Option<serde_json::Value>,
    ) -> Result<StmtOut, JsErrorBox> {
        let request = live_request(&state.borrow(), token)?;
        let env = env(&state);
        let Some(db) = env.db.clone() else {
            return Err(db_error(&env.redactor, &DbError::Open(String::new())));
        };
        // ops.md 1.3.0 section 1, "Module argument": checked before the
        // statement is prepared.
        let policy = env.modules.policy(module.as_deref()).map_err(|_| {
            op_error(
                "RENOX_DB_PARAM",
                serde_json::json!({ "reason": "module" }),
                "unknown module",
            )
        })?;
        let params = convert_params(&sql, decode(params, bytes)).map_err(usage)?;
        // ops.md 1.5.0 section 17, `db.scoped()`: the owner predicates of
        // the calling module's (or the app's) owned tables, and the policy
        // marked scoped so the authorizer lets the owned tables through.
        let (sql, policy) = match scope {
            None => (sql, policy),
            Some(scope) => {
                let field = |k: &str| {
                    scope.get(k).and_then(|v| match v {
                        serde_json::Value::String(s) => Some(s.clone()),
                        serde_json::Value::Number(n) => Some(n.to_string()),
                        _ => None,
                    })
                };
                let sc = renox_data::Scope {
                    user_id: field("user_id"),
                    org_id: field("org_id"),
                    session_id: field("session_id"),
                };
                let owned = env
                    .modules
                    .ownership(module.as_deref().filter(|m| *m != crate::ops::modules::APP));
                let sql = renox_data::scoped::rewrite(&sql, &params, &sc, &owned).map_err(|e| {
                    let e = match e {
                        DbError::Scope { table, reason, .. } => DbError::Scope {
                            table,
                            module: module.clone().unwrap_or_else(|| "app".into()).into(),
                            reason,
                        },
                        e => e,
                    };
                    db_error(&env.redactor, &e)
                })?;
                (
                    sql,
                    policy.map(|p| Arc::new((*p).clone().with_scoped(true))),
                )
            }
        };
        let tx = if tx == 0 {
            None
        } else if request.borrow().resources.db_tx == Some(tx) {
            Some(tx)
        } else {
            return Err(db_error(
                &env.redactor,
                &DbError::TxState("the transaction is not open".into()),
            ));
        };
        let (deadline, cancel) = {
            let r = request.borrow();
            (r.deadline, r.cancel.clone())
        };
        let fut = db.statement(kind, sql, params, tx, policy, deadline);
        let measured = match fut.or_cancel(cancel).await {
            Ok(m) => m,
            Err(_) => {
                return Err(op_error(
                    "RENOX_DEADLINE",
                    serde_json::Value::Null,
                    "The request deadline passed.",
                ));
            }
        };
        {
            let mut r = request.borrow_mut();
            r.db_ms += measured.ms;
            r.db_rows += measured.rows;
        }
        measured.value.map_err(|e| match (&e, module.as_deref()) {
            // ops.md 1.3.0: a module's refused statement names the module.
            (DbError::Auth { table, action }, Some(m)) if m != crate::ops::modules::APP => {
                op_error(
                    e.code(),
                    serde_json::json!({ "table": table, "action": action, "module": m }),
                    &env.redactor.redact(&error_message(&e)),
                )
            }
            _ => db_error(&env.redactor, &e),
        })
    }

    #[op2]
    #[serde]
    pub(crate) async fn op_db_query(
        state: Rc<RefCell<OpState>>,
        token: u32,
        #[string] sql: String,
        #[serde] params: Vec<WireParam>,
        #[serde] bytes: Vec<JsBuffer>,
        tx: u32,
        #[string] module: Option<String>,
        #[serde] scope: Option<serde_json::Value>,
    ) -> Result<WireRows, JsErrorBox> {
        match statement(
            state,
            token,
            StmtKind::Query,
            sql,
            params,
            bytes,
            tx,
            module,
            scope,
        )
        .await?
        {
            StmtOut::Rows(rows) => rows_out(rows, MAX_ROWS).map(wire_rows).map_err(usage),
            _ => unreachable!("query returns rows"),
        }
    }

    #[op2]
    #[serde]
    pub(crate) async fn op_db_query_one(
        state: Rc<RefCell<OpState>>,
        token: u32,
        #[string] sql: String,
        #[serde] params: Vec<WireParam>,
        #[serde] bytes: Vec<JsBuffer>,
        tx: u32,
        #[string] module: Option<String>,
        #[serde] scope: Option<serde_json::Value>,
    ) -> Result<WireRows, JsErrorBox> {
        match statement(
            state,
            token,
            StmtKind::QueryOne,
            sql,
            params,
            bytes,
            tx,
            module,
            scope,
        )
        .await?
        {
            StmtOut::Row(row) => rows_out(row.into_iter().collect(), 1)
                .map(wire_rows)
                .map_err(usage),
            _ => unreachable!("query_one returns a row"),
        }
    }

    #[op2]
    #[serde]
    pub(crate) async fn op_db_execute(
        state: Rc<RefCell<OpState>>,
        token: u32,
        #[string] sql: String,
        #[serde] params: Vec<WireParam>,
        #[serde] bytes: Vec<JsBuffer>,
        tx: u32,
        #[string] module: Option<String>,
        #[serde] scope: Option<serde_json::Value>,
    ) -> Result<WireExec, JsErrorBox> {
        match statement(
            state,
            token,
            StmtKind::Execute,
            sql,
            params,
            bytes,
            tx,
            module,
            scope,
        )
        .await?
        {
            StmtOut::Exec(e) => Ok(WireExec {
                changes: e.changes as f64,
                last_insert_rowid: WireCell(rowid_out(e.last_insert_rowid)),
            }),
            _ => unreachable!("execute returns a result"),
        }
    }

    /// Begin a transaction for the calling request. `mode` is accepted for
    /// the contract's signature; every transaction is `immediate`
    /// (`TenantDb::transaction`), which is what the SDK asks for.
    #[op2]
    pub(crate) async fn op_db_tx_begin(
        state: Rc<RefCell<OpState>>,
        token: u32,
        #[string] mode: String,
    ) -> Result<u32, JsErrorBox> {
        let request = live_request(&state.borrow(), token)?;
        let env = env(&state);
        let Some(db) = env.db.clone() else {
            return Err(db_error(&env.redactor, &DbError::Open(String::new())));
        };
        if mode != "immediate" && mode != "deferred" {
            return Err(op_error(
                "RENOX_DB_PARAM",
                serde_json::Value::Null,
                "transaction mode must be \"immediate\" or \"deferred\"",
            ));
        }
        let (deadline, cancel) = {
            let mut r = request.borrow_mut();
            if r.resources.db_tx.is_some() || r.resources.db_tx_pending {
                return Err(db_error(
                    &env.redactor,
                    &DbError::TxState("a transaction is already open for this request".into()),
                ));
            }
            r.resources.db_tx_pending = true;
            (r.deadline, r.cancel.clone())
        };
        let result = db.begin(deadline).or_cancel(cancel).await;
        let mut r = request.borrow_mut();
        r.resources.db_tx_pending = false;
        match result {
            Ok(Ok(id)) => {
                if r.ended {
                    // The request ended while waiting: give the writer back.
                    db.rollback_detached(id);
                    return Err(crate::ops::request::no_request());
                }
                r.resources.db_tx = Some(id);
                Ok(id)
            }
            Ok(Err(e)) => Err(db_error(&env.redactor, &e)),
            // Cancelled: if the begin still succeeds on the DB thread, its
            // reply finds no receiver and the thread rolls back at once.
            Err(_) => Err(op_error(
                "RENOX_DEADLINE",
                serde_json::Value::Null,
                "The request deadline passed.",
            )),
        }
    }

    async fn end_tx(
        state: Rc<RefCell<OpState>>,
        token: u32,
        tx: u32,
        commit: bool,
    ) -> Result<(), JsErrorBox> {
        let request = live_request(&state.borrow(), token)?;
        let env = env(&state);
        let Some(db) = env.db.clone() else {
            return Err(db_error(&env.redactor, &DbError::Open(String::new())));
        };
        {
            let mut r = request.borrow_mut();
            if r.resources.db_tx != Some(tx) {
                return Err(db_error(
                    &env.redactor,
                    &DbError::TxState("the transaction is not open".into()),
                ));
            }
            r.resources.db_tx = None;
        }
        db.end(tx, commit)
            .await
            .map_err(|e| db_error(&env.redactor, &e))
    }

    /// Savepoints of the request's open transaction (ops.md 1.3.0 section
    /// 1, "Savepoints"): the nested `db.transaction`.
    async fn savepoint(
        state: Rc<RefCell<OpState>>,
        token: u32,
        tx: u32,
        op: SavepointOp,
    ) -> Result<u32, JsErrorBox> {
        let request = live_request(&state.borrow(), token)?;
        let env = env(&state);
        let Some(db) = env.db.clone() else {
            return Err(db_error(&env.redactor, &DbError::Open(String::new())));
        };
        if request.borrow().resources.db_tx != Some(tx) {
            return Err(db_error(
                &env.redactor,
                &DbError::TxState("the transaction is not open".into()),
            ));
        }
        db.savepoint(tx, op)
            .await
            .map_err(|e| db_error(&env.redactor, &e))
    }

    #[op2]
    pub(crate) async fn op_db_savepoint_begin(
        state: Rc<RefCell<OpState>>,
        token: u32,
        tx: u32,
    ) -> Result<u32, JsErrorBox> {
        savepoint(state, token, tx, SavepointOp::Begin).await
    }

    #[op2]
    pub(crate) async fn op_db_savepoint_release(
        state: Rc<RefCell<OpState>>,
        token: u32,
        tx: u32,
        sp: u32,
    ) -> Result<(), JsErrorBox> {
        savepoint(state, token, tx, SavepointOp::Release(sp))
            .await
            .map(|_| ())
    }

    #[op2]
    pub(crate) async fn op_db_savepoint_rollback(
        state: Rc<RefCell<OpState>>,
        token: u32,
        tx: u32,
        sp: u32,
    ) -> Result<(), JsErrorBox> {
        savepoint(state, token, tx, SavepointOp::Rollback(sp))
            .await
            .map(|_| ())
    }

    #[op2]
    pub(crate) async fn op_db_tx_commit(
        state: Rc<RefCell<OpState>>,
        token: u32,
        tx: u32,
    ) -> Result<(), JsErrorBox> {
        end_tx(state, token, tx, true).await
    }

    #[op2]
    pub(crate) async fn op_db_tx_rollback(
        state: Rc<RefCell<OpState>>,
        token: u32,
        tx: u32,
    ) -> Result<(), JsErrorBox> {
        end_tx(state, token, tx, false).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_bind_as_integer_or_real() {
        let v = convert_params(
            "select ?",
            vec![
                ParamIn::Number(3.0),
                ParamIn::Number(2.5),
                ParamIn::Number(9007199254740992.0),
                ParamIn::Bool(true),
                ParamIn::BigInt("-9223372036854775808".into()),
            ],
        )
        .unwrap();
        assert_eq!(
            v,
            vec![
                Value::Integer(3),
                Value::Real(2.5),
                Value::Real(9007199254740992.0),
                Value::Integer(1),
                Value::Integer(i64::MIN),
            ]
        );
    }

    #[test]
    fn invalid_params_are_refused_with_their_index() {
        for (p, idx) in [
            (ParamIn::Number(f64::NAN), 0),
            (ParamIn::Number(f64::INFINITY), 0),
            (ParamIn::BigInt("9223372036854775808".into()), 0),
            (ParamIn::IllFormed, 0),
            (ParamIn::Unsupported("undefined".into()), 0),
        ] {
            let e = convert_params("select ?", vec![p]).unwrap_err();
            assert_eq!(e.code, "RENOX_DB_PARAM");
            assert_eq!(e.index, Some(idx));
        }
        let long = "x".repeat(MAX_SQL_BYTES + 1);
        assert_eq!(
            convert_params(&long, vec![]).unwrap_err().code,
            "RENOX_DB_PARAM"
        );
        let many = vec![ParamIn::Null; MAX_PARAMS + 1];
        assert_eq!(
            convert_params("select 1", many).unwrap_err().code,
            "RENOX_DB_PARAM"
        );
    }

    fn block_on<F: std::future::Future>(f: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap()
            .block_on(f)
    }

    fn scratch_file(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "renox-db-bg-{name}-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("app.db")
    }

    /// #157: the handle exists before the file is open; jobs sent early
    /// wait for the open and then run.
    #[test]
    fn background_open_queues_jobs_until_the_file_is_open() {
        let path = scratch_file("ok");
        let (gate_tx, gate_rx) = mpsc::channel::<()>();
        let p = path.clone();
        let db = DbHandle::open_in_background(move || {
            gate_rx.recv().unwrap();
            TenantDb::open(p, renox_data::DbOptions::default())
        })
        .unwrap();
        let early = db.clone();
        let call = std::thread::spawn(move || {
            block_on(early.call(|db| db.query_one("select 41 + 1 as n", &[])))
        });
        gate_tx.send(()).unwrap();
        block_on(db.ready()).unwrap();
        let row = call.join().unwrap().unwrap().unwrap().unwrap();
        assert_eq!(row.get("n"), Some(&Value::Integer(42)));
        let deadline = Instant::now() + Duration::from_secs(5);
        let m = block_on(db.statement(
            StmtKind::QueryOne,
            "select 1".into(),
            vec![],
            None,
            None,
            deadline,
        ));
        assert!(m.value.is_ok());
        block_on(db.close()).unwrap();
    }

    /// `docs/23-failure-modes.md`, "SQLite file corrupted, WAL unreadable"
    /// (#157, the open fails):
    /// a failed background open is reported by `ready` and by every later
    /// job, never as a hang.
    #[test]
    fn failed_background_open_answers_every_job_with_the_error() {
        let db = DbHandle::open_in_background(|| Err(DbError::Open("disk full".into()))).unwrap();
        let e = block_on(db.ready()).unwrap_err();
        assert_eq!(e, DbError::Open("disk full".into()));
        let deadline = Instant::now() + Duration::from_secs(5);
        let m = block_on(db.statement(
            StmtKind::Query,
            "select 1".into(),
            vec![],
            None,
            None,
            deadline,
        ));
        assert_eq!(m.value.unwrap_err(), DbError::Open("disk full".into()));
        assert_eq!(
            block_on(db.begin(deadline)).unwrap_err(),
            DbError::Open("disk full".into())
        );
        assert!(block_on(db.call(|_| ())).is_err());
    }

    #[test]
    fn large_integers_come_back_as_bigint() {
        assert_eq!(
            rowid_out(1 << 53),
            CellOut::BigInt("9007199254740992".into())
        );
        assert_eq!(
            rowid_out((1 << 53) - 1),
            CellOut::Number(9007199254740991.0)
        );
    }
}
