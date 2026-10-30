//! Jobs (`docs/contracts/ops.md` 1.6.0 section 20): the rows of scheduled
//! and queued runs in the tenant file, and the ops `op_jobs_enqueue`,
//! `op_jobs_ack`, `op_jobs_list`, `op_jobs_retry` and `op_jobs_cancel`.
//!
//! A job run is a row of `renox__outbox` (ADR D14) whose `name` is
//! `job:<name>` and whose `target` and `module` are the job's module (`app`
//! for the app's own jobs), so the outbox worker delivers it with the same
//! transaction, retry schedule and dead-letter as an event (section 15.4).
//! What a row cannot hold is kept in `renox__outbox_meta`:
//!
//! | Key | Value |
//! | --- | --- |
//! | `job_tick:<module>:<name>` | the latest unprocessed tick of the job's one scheduled row (the coalescing key) |
//! | `job_next:<module>:<name>` | the next tick the scheduler computed (what `scheduled` lists) |
//! | `job_last:<module>:<name>` | when the last run of the job finished |
//! | `job_running:<id>` | when the run of row `id` started (what `running` lists) |
//!
//! Every function here is platform work and runs with the platform policy:
//! a module's own SQL can never name a `renox__*` table.

use std::time::{SystemTime, UNIX_EPOCH};

use renox_data::roles::Statements;
use renox_data::{DbError, Row, TenantDb, Value};

/// The `name` prefix of a job row in `renox__outbox`.
pub const ROW_PREFIX: &str = "job:";
/// Payload cap: 64 KiB of JSON (section 20, "Queued jobs").
pub const MAX_PAYLOAD_BYTES: usize = 64 * 1024;
/// `runAt` at most 30 days ahead (*proposed*, Open 18).
pub const MAX_AHEAD_MS: i64 = 30 * 24 * 3600 * 1000;
/// `last_error` as listed: at most 512 characters.
pub const MAX_ERROR_CHARS: usize = 512;

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// The job of a row name, `job:<name>` → `<name>`.
pub fn job_name(row_name: &str) -> Option<&str> {
    row_name.strip_prefix(ROW_PREFIX)
}

fn key(kind: &str, module: &str, name: &str) -> String {
    format!("job_{kind}:{module}:{name}")
}

/// Why a retry or a cancel was refused.
#[derive(Debug)]
pub enum JobError {
    NotFound,
    /// The row's state (`queued`, `running`).
    State(&'static str),
    Db(DbError),
}

impl From<DbError> for JobError {
    fn from(e: DbError) -> Self {
        JobError::Db(e)
    }
}

fn int(r: &Row, c: &str) -> Option<i64> {
    match r.get(c) {
        Some(Value::Integer(i)) => Some(*i),
        _ => None,
    }
}

fn text(r: &Row, c: &str) -> String {
    match r.get(c) {
        Some(Value::Text(s)) => s.clone(),
        _ => String::new(),
    }
}

fn meta_get<S: Statements + ?Sized>(db: &S, k: &str) -> Result<Option<i64>, DbError> {
    let rows = db.query(
        "select value from renox__outbox_meta where key = ?",
        &[k.into()],
    )?;
    Ok(rows.first().and_then(|r| int(r, "value")))
}

fn meta_set<S: Statements + ?Sized>(db: &S, k: &str, v: i64) -> Result<(), DbError> {
    db.execute(
        "insert into renox__outbox_meta (key, value) values (?, ?) \
         on conflict (key) do update set value = excluded.value",
        &[k.into(), Value::Integer(v)],
    )?;
    Ok(())
}

fn meta_del<S: Statements + ?Sized>(db: &S, k: &str) -> Result<(), DbError> {
    db.execute("delete from renox__outbox_meta where key = ?", &[k.into()])?;
    Ok(())
}

fn insert_row<S: Statements + ?Sized>(
    db: &S,
    id: &str,
    module: &str,
    name: &str,
    payload: &str,
    now: i64,
    next_at: i64,
) -> Result<(), DbError> {
    db.execute(
        "insert into renox__outbox \
         (id, target, name, payload, module, created_at, attempts, next_at) \
         values (?, ?, ?, ?, ?, ?, 0, ?)",
        &[
            id.into(),
            module.into(),
            format!("{ROW_PREFIX}{name}").into(),
            payload.into(),
            module.into(),
            Value::Integer(now),
            Value::Integer(next_at),
        ],
    )?;
    Ok(())
}

/// A tick of a scheduled job (the scheduler, section 20): one row per job
/// and tick, idempotently. When the job's scheduled row is still waiting
/// (its coalescing key exists), the key's value becomes the later tick and
/// no row is added, so missed ticks coalesce into one run. Returns whether
/// a row was written.
pub fn schedule_tick(
    db: &TenantDb,
    module: &str,
    name: &str,
    tick: i64,
    now: i64,
) -> Result<bool, DbError> {
    db.with_policy(None, || {
        db.transaction(|tx| {
            let k = key("tick", module, name);
            if let Some(v) = meta_get(tx, &k)? {
                if tick > v {
                    meta_set(tx, &k, tick)?;
                }
                return Ok(false);
            }
            let id = crate::ops::events::ulid();
            insert_row(tx, &id, module, name, "null", now, now)?;
            meta_set(tx, &k, tick)?;
            Ok(true)
        })
    })?
}

/// The next tick the scheduler computed, for `scheduled` and for the
/// missed-tick check after a restart.
pub fn set_next(db: &TenantDb, module: &str, name: &str, next: i64) -> Result<(), DbError> {
    db.with_policy(None, || meta_set(db, &key("next", module, name), next))?
}

/// The next tick persisted by the previous cell, if any.
pub fn stored_next(db: &TenantDb, module: &str, name: &str) -> Result<Option<i64>, DbError> {
    db.with_policy(None, || meta_get(db, &key("next", module, name)))?
}

/// The tick a scheduled row runs for (its coalescing key's value), or
/// `None` for a queued run.
pub fn run_tick(
    db: &TenantDb,
    module: &str,
    name: &str,
    payload: &str,
) -> Result<Option<i64>, DbError> {
    if payload != "null" {
        return Ok(None);
    }
    db.with_policy(None, || meta_get(db, &key("tick", module, name)))?
}

/// The run of row `id` starts (what `running` lists).
pub fn started(db: &TenantDb, id: &str, now: i64) -> Result<(), DbError> {
    db.with_policy(None, || meta_set(db, &format!("job_running:{id}"), now))?
}

/// The run of row `id` ended without its ack (a failed attempt).
pub fn stopped(db: &TenantDb, id: &str) -> Result<(), DbError> {
    db.with_policy(None, || meta_del(db, &format!("job_running:{id}")))?
}

/// A row whose job is leased by another run waits: due again at `next_at`,
/// attempts unchanged.
pub fn defer(db: &TenantDb, id: &str, module: &str, next_at: i64) -> Result<(), DbError> {
    db.with_policy(None, || {
        db.execute(
            "update renox__outbox set next_at = ? where id = ? and target = ?",
            &[Value::Integer(next_at), id.into(), module.into()],
        )
        .map(|_| ())
    })?
}

/// At cell start (section 20, "Lease"): the lease is in memory, so a row
/// left `running` by a dead process is `queued` again, attempts unchanged.
pub fn requeue_running(db: &TenantDb) -> Result<u64, DbError> {
    db.with_policy(None, || {
        db.execute(
            "delete from renox__outbox_meta where key like 'job\\_running:%' escape '\\'",
            &[],
        )
        .map(|r| r.changes)
    })?
}

/// A scheduled row was dead-lettered or cancelled: the next tick writes a
/// new row instead of coalescing into a row that no longer waits.
pub fn forget_tick(db: &TenantDb, module: &str, name: &str) -> Result<(), DbError> {
    db.with_policy(None, || meta_del(db, &key("tick", module, name)))?
}

/// The ack of a run, in the run's own transaction `tx` (section 20,
/// "Delivery path"): the row is deleted with the job's writes. A scheduled
/// run whose job ticked again while it ran (`job_tick` later than `ran`)
/// keeps its row, due now, for the later tick: "a second tick of the same
/// job waits until the run ends".
pub fn ack<S: Statements + ?Sized>(
    tx: &S,
    id: &str,
    module: &str,
    name: &str,
    ran: Option<i64>,
    now: i64,
) -> Result<bool, DbError> {
    meta_del(tx, &format!("job_running:{id}"))?;
    meta_set(tx, &key("last", module, name), now)?;
    if let Some(ran) = ran {
        let k = key("tick", module, name);
        if meta_get(tx, &k)?.is_some_and(|v| v > ran) {
            let r = tx.execute(
                "update renox__outbox set attempts = 0, next_at = ?, last_error = null \
                 where id = ? and target = ?",
                &[Value::Integer(now), id.into(), module.into()],
            )?;
            return Ok(r.changes > 0);
        }
        meta_del(tx, &k)?;
    }
    let r = tx.execute(
        "delete from renox__outbox where id = ? and target = ?",
        &[id.into(), module.into()],
    )?;
    Ok(r.changes > 0)
}

/// `ctx.jobs.enqueue` (section 20, "Queued jobs"): a row in the caller's
/// transaction `tx`, due at `run_at` (or now).
pub fn enqueue<S: Statements + ?Sized>(
    tx: &S,
    module: &str,
    name: &str,
    payload: &str,
    run_at: Option<i64>,
    now: i64,
) -> Result<String, DbError> {
    let id = crate::ops::events::ulid();
    insert_row(
        tx,
        &id,
        module,
        name,
        payload,
        now,
        run_at.unwrap_or(now).max(now),
    )?;
    Ok(id)
}

/// One job route of the active deployment, for `scheduled`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JobDef {
    pub module: String,
    pub name: String,
    pub schedule: String,
    pub tz: Option<String>,
}

/// A row of `op_jobs_list` (`ops.schema.json` `$defs/jobRow`): never the payload.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct JobRow {
    pub id: Option<String>,
    pub name: String,
    pub module: String,
    pub tick: Option<i64>,
    pub next_at: Option<i64>,
    pub run_at: Option<i64>,
    pub attempts: u32,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct JobPage {
    pub items: Vec<JobRow>,
    pub next_cursor: Option<String>,
}

/// The redacted error as listed: no newline, at most 512 characters.
fn listed_error(e: Option<String>) -> Option<String> {
    e.map(|e| {
        e.chars()
            .map(|c| if c.is_control() { ' ' } else { c })
            .take(MAX_ERROR_CHARS)
            .collect()
    })
}

/// `op_jobs_list` (1.6.0): one page of jobs in `state`; `cursor` is the
/// offset of the page, as text.
pub fn list(
    db: &TenantDb,
    defs: &[JobDef],
    state: &str,
    limit: u32,
    cursor: Option<&str>,
) -> Result<JobPage, DbError> {
    db.with_policy(None, || list_in(db, defs, state, limit, cursor))?
}

/// [`list`] on `db` as given: a request's open transaction, or the file.
/// The caller sets the platform policy.
pub fn list_in<S: Statements + ?Sized>(
    db: &S,
    defs: &[JobDef],
    state: &str,
    limit: u32,
    cursor: Option<&str>,
) -> Result<JobPage, DbError> {
    let limit = limit.clamp(1, 100) as usize;
    let offset: usize = cursor.and_then(|c| c.parse().ok()).unwrap_or(0);
    let page = |mut items: Vec<JobRow>, more: bool| {
        let next_cursor = more.then(|| (offset + items.len()).to_string());
        items.truncate(limit);
        JobPage { items, next_cursor }
    };
    {
        match state {
            "scheduled" => {
                let mut items = Vec::new();
                for d in defs {
                    items.push(JobRow {
                        id: None,
                        name: d.name.clone(),
                        module: d.module.clone(),
                        tick: meta_get(db, &key("tick", &d.module, &d.name))?,
                        next_at: meta_get(db, &key("next", &d.module, &d.name))?,
                        run_at: None,
                        attempts: 0,
                        started_at: None,
                        finished_at: meta_get(db, &key("last", &d.module, &d.name))?,
                        last_error: None,
                    });
                }
                items.sort_by(|a, b| {
                    (a.next_at.unwrap_or(i64::MAX), &a.module, &a.name).cmp(&(
                        b.next_at.unwrap_or(i64::MAX),
                        &b.module,
                        &b.name,
                    ))
                });
                let rest: Vec<JobRow> = items.into_iter().skip(offset).collect();
                let more = rest.len() > limit;
                Ok(page(rest, more))
            }
            "queued" | "running" => {
                let running = state == "running";
                let rows = db.query(
                    &format!(
                        "select o.id, o.name, o.module, o.payload, o.attempts, o.next_at, o.created_at, \
                                o.last_error, m.value as started_at \
                         from renox__outbox o \
                         left join renox__outbox_meta m on m.key = 'job_running:' || o.id \
                         where o.name like 'job:%' and m.value is {} null \
                         order by o.next_at, o.id limit ? offset ?",
                        if running { "not" } else { "" }
                    ),
                    &[
                        Value::Integer(limit as i64 + 1),
                        Value::Integer(offset as i64),
                    ],
                )?;
                let mut items = Vec::new();
                for r in &rows {
                    let name = job_name(&text(r, "name")).unwrap_or_default().to_string();
                    let module = text(r, "module");
                    let scheduled = text(r, "payload") == "null";
                    items.push(JobRow {
                        id: Some(text(r, "id")),
                        tick: if scheduled {
                            meta_get(db, &key("tick", &module, &name))?
                        } else {
                            None
                        },
                        next_at: int(r, "next_at"),
                        run_at: (!scheduled).then(|| int(r, "next_at")).flatten(),
                        attempts: u32::try_from(int(r, "attempts").unwrap_or(0)).unwrap_or(0),
                        started_at: int(r, "started_at"),
                        finished_at: None,
                        last_error: listed_error(match r.get("last_error") {
                            Some(Value::Text(s)) => Some(s.clone()),
                            _ => None,
                        }),
                        name,
                        module,
                    });
                }
                let more = items.len() > limit;
                Ok(page(items, more))
            }
            "dead" => {
                let rows = db.query(
                    "select id, name, module, payload, attempts, next_at, last_error, dead_at \
                     from renox__outbox_dead where name like 'job:%' \
                     order by dead_at desc, rowid desc limit ? offset ?",
                    &[
                        Value::Integer(limit as i64 + 1),
                        Value::Integer(offset as i64),
                    ],
                )?;
                let items: Vec<JobRow> = rows
                    .iter()
                    .map(|r| JobRow {
                        id: Some(text(r, "id")),
                        name: job_name(&text(r, "name")).unwrap_or_default().to_string(),
                        module: text(r, "module"),
                        tick: None,
                        next_at: None,
                        run_at: (text(r, "payload") != "null")
                            .then(|| int(r, "next_at"))
                            .flatten(),
                        attempts: u32::try_from(int(r, "attempts").unwrap_or(0)).unwrap_or(0),
                        started_at: None,
                        finished_at: int(r, "dead_at"),
                        last_error: listed_error(match r.get("last_error") {
                            Some(Value::Text(s)) => Some(s.clone()),
                            _ => None,
                        }),
                    })
                    .collect();
                let more = items.len() > limit;
                Ok(page(items, more))
            }
            other => Err(DbError::Param(format!("unknown job state {other}"))),
        }
    }
}

fn audit<S: Statements + ?Sized>(
    tx: &S,
    principal: &str,
    action: &str,
    id: &str,
    now: i64,
) -> Result<(), DbError> {
    renox_data::roles::record(
        tx,
        &renox_data::roles::AuditRow {
            principal,
            action,
            resource: Some(("Renox::Job", id)),
            allow: true,
            policy: None,
            at: now,
        },
    )?;
    Ok(())
}

fn running<S: Statements + ?Sized>(tx: &S, id: &str) -> Result<bool, DbError> {
    Ok(meta_get(tx, &format!("job_running:{id}"))?.is_some())
}

/// `op_jobs_retry` (1.6.0): a dead row goes back to the queue with its
/// attempts reset, due now, with one audit row.
pub fn retry<S: Statements + ?Sized>(
    tx: &S,
    id: &str,
    principal: &str,
    now: i64,
) -> Result<(), JobError> {
    let live = tx.query(
        "select id from renox__outbox where id = ? and name like 'job:%'",
        &[id.into()],
    )?;
    if !live.is_empty() {
        return Err(JobError::State(if running(tx, id)? {
            "running"
        } else {
            "queued"
        }));
    }
    let dead = tx.query(
        "select module, name, payload from renox__outbox_dead where id = ? and name like 'job:%'",
        &[id.into()],
    )?;
    let Some(row) = dead.first() else {
        return Err(JobError::NotFound);
    };
    tx.execute(
        "insert into renox__outbox \
         (id, target, name, payload, module, created_at, attempts, next_at) \
         select id, target, name, payload, module, created_at, 0, ? \
         from renox__outbox_dead where id = ? and name like 'job:%'",
        &[Value::Integer(now), id.into()],
    )?;
    tx.execute(
        "delete from renox__outbox_dead where id = ? and name like 'job:%'",
        &[id.into()],
    )?;
    if text(row, "payload") == "null" {
        // A scheduled row again: later ticks coalesce into it.
        let name = job_name(&text(row, "name")).unwrap_or_default().to_string();
        let k = key("tick", &text(row, "module"), &name);
        if meta_get(tx, &k)?.is_none() {
            meta_set(tx, &k, now)?;
        }
    }
    audit(tx, principal, "jobs.retry", id, now)?;
    Ok(())
}

/// `op_jobs_cancel` (1.6.0): a queued or dead row is deleted with one
/// audit row; a running row is refused.
pub fn cancel<S: Statements + ?Sized>(
    tx: &S,
    id: &str,
    principal: &str,
    now: i64,
) -> Result<(), JobError> {
    let live = tx.query(
        "select module, name, payload from renox__outbox where id = ? and name like 'job:%'",
        &[id.into()],
    )?;
    if let Some(row) = live.first() {
        if running(tx, id)? {
            return Err(JobError::State("running"));
        }
        tx.execute(
            "delete from renox__outbox where id = ? and name like 'job:%'",
            &[id.into()],
        )?;
        if text(row, "payload") == "null" {
            let name = job_name(&text(row, "name")).unwrap_or_default().to_string();
            meta_del(tx, &key("tick", &text(row, "module"), &name))?;
        }
        audit(tx, principal, "jobs.cancel", id, now)?;
        return Ok(());
    }
    let r = tx.execute(
        "delete from renox__outbox_dead where id = ? and name like 'job:%'",
        &[id.into()],
    )?;
    if r.changes == 0 {
        return Err(JobError::NotFound);
    }
    audit(tx, principal, "jobs.cancel", id, now)?;
    Ok(())
}

#[cfg(feature = "v8")]
pub(crate) use v8_ops::*;

#[cfg(feature = "v8")]
mod v8_ops {
    use std::cell::RefCell;
    use std::rc::Rc;

    use deno_core::{OpState, op2};
    use deno_error::JsErrorBox;

    use super::*;
    use crate::ops::db::DbEnv;
    use crate::ops::request::{live_request, op_error};

    /// The job routes of the isolate's deployment.
    pub(crate) struct JobsEnv {
        pub defs: Vec<JobDef>,
    }

    /// The module the jobs ops answer to (section 20, 1.6.0).
    const JOBS_MODULE: &str = "jobs";

    fn caller(module: &Option<String>) -> &str {
        module.as_deref().unwrap_or(crate::ops::modules::APP)
    }

    fn only_jobs(module: &Option<String>, action: &str) -> Result<(), JsErrorBox> {
        if caller(module) == JOBS_MODULE {
            return Ok(());
        }
        Err(op_error(
            "RENOX_FORBIDDEN",
            serde_json::json!({ "action": action, "resource": null, "reason": "deny", "policy": null }),
            "You are not allowed to do this.",
        ))
    }

    fn db_error(e: DbError) -> JsErrorBox {
        op_error(e.code(), serde_json::Value::Null, &e.to_string())
    }

    fn job_error(e: JobError, id: &str, op: &str) -> JsErrorBox {
        match e {
            JobError::NotFound => op_error(
                "RENOX_JOB_NOT_FOUND",
                serde_json::json!({ "id": id }),
                &format!("no job row {id}"),
            ),
            JobError::State(state) => op_error(
                "RENOX_JOB_STATE",
                serde_json::json!({ "id": id, "state": state, "op": op }),
                &format!("job row {id} is {state}"),
            ),
            JobError::Db(e) => db_error(e),
        }
    }

    /// The request's open transaction `tx` (0: none).
    fn request_tx(
        state: &Rc<RefCell<OpState>>,
        token: u32,
        tx: u32,
    ) -> Result<Option<u32>, JsErrorBox> {
        let request = live_request(&state.borrow(), token)?;
        if tx == 0 {
            return Ok(None);
        }
        if request.borrow().resources.db_tx == Some(tx) {
            Ok(Some(tx))
        } else {
            Err(op_error(
                "RENOX_DB_TX_STATE",
                serde_json::Value::Null,
                "the transaction is not open",
            ))
        }
    }

    fn envs(state: &Rc<RefCell<OpState>>) -> (Rc<DbEnv>, Rc<JobsEnv>) {
        let s = state.borrow();
        (
            s.borrow::<Rc<DbEnv>>().clone(),
            s.borrow::<Rc<JobsEnv>>().clone(),
        )
    }

    fn principal_of(state: &Rc<RefCell<OpState>>, token: u32) -> String {
        live_request(&state.borrow(), token)
            .ok()
            .and_then(|r| r.borrow().authz.principal.as_ref().map(|p| p.id.clone()))
            .unwrap_or_else(|| "anonymous".into())
    }

    /// `ctx.jobs.enqueue` → the row id.
    #[op2]
    #[string]
    pub(crate) async fn op_jobs_enqueue(
        state: Rc<RefCell<OpState>>,
        token: u32,
        #[string] name: String,
        #[string] payload_json: String,
        run_at: Option<f64>,
        #[string] module: Option<String>,
        tx: u32,
    ) -> Result<String, JsErrorBox> {
        let (db_env, jobs) = envs(&state);
        let owner = caller(&module).to_string();
        if !jobs
            .defs
            .iter()
            .any(|d| d.module == owner && d.name == name)
        {
            return Err(op_error(
                "RENOX_MODULE_UNDECLARED",
                serde_json::json!({ "module": owner, "target": format!("job:{name}") }),
                &format!("module {owner} has no job {name}"),
            ));
        }
        if payload_json.len() > MAX_PAYLOAD_BYTES
            || !matches!(
                serde_json::from_str::<serde_json::Value>(&payload_json),
                Ok(serde_json::Value::Object(_))
            )
        {
            return Err(JsErrorBox::range_error(
                "jobs.enqueue: the payload is a JSON object of at most 64 KiB",
            ));
        }
        let now = now_ms();
        let run_at = run_at.map(|t| t as i64);
        if run_at.is_some_and(|t| t > now + MAX_AHEAD_MS) {
            return Err(JsErrorBox::range_error(
                "jobs.enqueue: runAt is at most 30 days ahead",
            ));
        }
        let tx = request_tx(&state, token, tx)?;
        let Some(db) = db_env.db.clone() else {
            return Err(op_error(
                "RENOX_DB_SQL",
                serde_json::Value::Null,
                "no database",
            ));
        };
        db.call_tx(tx, move |db, t| {
            db.with_policy(None, || match t {
                Some(t) => enqueue(t, &owner, &name, &payload_json, run_at, now),
                None => enqueue(db, &owner, &name, &payload_json, run_at, now),
            })?
        })
        .await
        .map_err(db_error)
    }

    /// The ack of a job run in its own transaction (`deliver`, kind `job`).
    #[op2]
    pub(crate) async fn op_jobs_ack(
        state: Rc<RefCell<OpState>>,
        token: u32,
        tx: u32,
        #[string] id: String,
        #[string] module: String,
        #[string] name: String,
        tick: Option<f64>,
    ) -> Result<bool, JsErrorBox> {
        let (db_env, _) = envs(&state);
        let tx = request_tx(&state, token, tx)?;
        let Some(db) = db_env.db.clone() else {
            return Ok(false);
        };
        let ran = tick.map(|t| t as i64);
        db.call_tx(tx, move |db, t| match t {
            Some(t) => db.with_policy(None, || ack(t, &id, &module, &name, ran, now_ms()))?,
            None => Ok(false),
        })
        .await
        .map_err(db_error)
    }

    #[op2]
    #[serde]
    pub(crate) async fn op_jobs_list(
        state: Rc<RefCell<OpState>>,
        token: u32,
        #[string] job_state: String,
        limit: u32,
        #[string] cursor: Option<String>,
        #[string] module: Option<String>,
    ) -> Result<JobPage, JsErrorBox> {
        live_request(&state.borrow(), token)?;
        only_jobs(&module, "jobs.list")?;
        if !matches!(
            job_state.as_str(),
            "scheduled" | "queued" | "running" | "dead"
        ) {
            return Err(JsErrorBox::type_error(
                "jobs.list: state is scheduled, queued, running or dead",
            ));
        }
        let (db_env, jobs) = envs(&state);
        let Some(db) = db_env.db.clone() else {
            return Ok(JobPage {
                items: Vec::new(),
                next_cursor: None,
            });
        };
        let defs = jobs.defs.clone();
        // In the request's transaction when one is open (a page action
        // holds the writer), else on the file.
        let tx = live_request(&state.borrow(), token)?
            .borrow()
            .resources
            .db_tx;
        db.call_tx(tx, move |db, t| {
            db.with_policy(None, || match t {
                Some(t) => list_in(t, &defs, &job_state, limit, cursor.as_deref()),
                None => list_in(db, &defs, &job_state, limit, cursor.as_deref()),
            })?
        })
        .await
        .map_err(db_error)
    }

    async fn change(
        state: Rc<RefCell<OpState>>,
        token: u32,
        id: String,
        module: Option<String>,
        tx: u32,
        op: &'static str,
    ) -> Result<(), JsErrorBox> {
        only_jobs(&module, &format!("jobs.{op}"))?;
        let tx = request_tx(&state, token, tx)?;
        let principal = principal_of(&state, token);
        let (db_env, _) = envs(&state);
        let Some(db) = db_env.db.clone() else {
            return Err(job_error(JobError::NotFound, &id, op));
        };
        let id2 = id.clone();
        let out = db
            .call_tx(tx, move |db, t| {
                let now = now_ms();
                let go = |s: &dyn Statements| {
                    if op == "retry" {
                        retry(s, &id2, &principal, now)
                    } else {
                        cancel(s, &id2, &principal, now)
                    }
                };
                db.with_policy(None, || match t {
                    Some(t) => go(t),
                    None => db.transaction(|t| go(t)),
                })
            })
            .await
            .map_err(db_error)?;
        out.map_err(|e| job_error(e, &id, op))
    }

    #[op2]
    pub(crate) async fn op_jobs_retry(
        state: Rc<RefCell<OpState>>,
        token: u32,
        #[string] id: String,
        #[string] module: Option<String>,
        tx: u32,
    ) -> Result<(), JsErrorBox> {
        change(state, token, id, module, tx, "retry").await
    }

    #[op2]
    pub(crate) async fn op_jobs_cancel(
        state: Rc<RefCell<OpState>>,
        token: u32,
        #[string] id: String,
        #[string] module: Option<String>,
        tx: u32,
    ) -> Result<(), JsErrorBox> {
        change(state, token, id, module, tx, "cancel").await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> TenantDb {
        let path =
            std::env::temp_dir().join(format!("renox-jobs-{}.db", crate::ops::events::ulid()));
        TenantDb::open(&path, renox_data::DbOptions::default()).unwrap()
    }

    #[test]
    fn three_missed_ticks_coalesce_into_one_row_and_a_tick_during_the_run_keeps_it() {
        let db = db();
        assert!(schedule_tick(&db, "app", "nightly", 1_000, 1_000).unwrap());
        assert!(!schedule_tick(&db, "app", "nightly", 2_000, 2_000).unwrap());
        assert!(!schedule_tick(&db, "app", "nightly", 3_000, 3_000).unwrap());
        let rows = db
            .with_policy(None, || {
                db.query("select id, payload from renox__outbox", &[])
            })
            .unwrap()
            .unwrap();
        assert_eq!(rows.len(), 1);
        let id = text(&rows[0], "id");
        assert_eq!(
            run_tick(&db, "app", "nightly", "null").unwrap(),
            Some(3_000)
        );
        // A tick arrives while the run of 3_000 is in flight.
        schedule_tick(&db, "app", "nightly", 4_000, 4_000).unwrap();
        db.with_policy(None, || {
            db.transaction(|tx| ack(tx, &id, "app", "nightly", Some(3_000), 5_000))
        })
        .unwrap()
        .unwrap();
        assert_eq!(
            db.with_policy(None, || db.query("select id from renox__outbox", &[]))
                .unwrap()
                .unwrap()
                .len(),
            1,
            "the row stays for the later tick"
        );
        db.with_policy(None, || {
            db.transaction(|tx| ack(tx, &id, "app", "nightly", Some(4_000), 6_000))
        })
        .unwrap()
        .unwrap();
        assert!(
            db.with_policy(None, || db.query("select id from renox__outbox", &[]))
                .unwrap()
                .unwrap()
                .is_empty()
        );
        assert_eq!(run_tick(&db, "app", "nightly", "null").unwrap(), None);
    }

    #[test]
    fn list_never_returns_the_payload_and_retry_and_cancel_check_the_state() {
        let db = db();
        let id = db
            .with_policy(None, || {
                enqueue(&db, "app", "report", r#"{"secret":"s3"}"#, None, 10)
            })
            .unwrap()
            .unwrap();
        let defs = vec![JobDef {
            module: "app".into(),
            name: "report".into(),
            schedule: "0 3 * * *".into(),
            tz: None,
        }];
        let q = list(&db, &defs, "queued", 10, None).unwrap();
        assert_eq!(q.items.len(), 1);
        assert!(!serde_json::to_string(&q).unwrap().contains("s3"));
        let r = db
            .with_policy(None, || db.transaction(|tx| retry(tx, &id, "u1", 20)))
            .unwrap();
        assert!(matches!(r, Err(JobError::State("queued"))));
        started(&db, &id, 30).unwrap();
        assert_eq!(
            list(&db, &defs, "running", 10, None).unwrap().items.len(),
            1
        );
        let c = db
            .with_policy(None, || db.transaction(|tx| cancel(tx, &id, "u1", 40)))
            .unwrap();
        assert!(matches!(c, Err(JobError::State("running"))));
        assert_eq!(requeue_running(&db).unwrap(), 1);
        db.with_policy(None, || db.transaction(|tx| cancel(tx, &id, "u1", 50)))
            .unwrap()
            .unwrap();
        let missing = db
            .with_policy(None, || db.transaction(|tx| cancel(tx, &id, "u1", 60)))
            .unwrap();
        assert!(matches!(missing, Err(JobError::NotFound)));
        let audit = db
            .with_policy(None, || {
                db.query("select action from renox__authz_audit", &[])
            })
            .unwrap()
            .unwrap();
        assert_eq!(audit.len(), 1);
        assert_eq!(text(&audit[0], "action"), "jobs.cancel");
        assert_eq!(
            list(&db, &defs, "scheduled", 10, None).unwrap().items.len(),
            1
        );
    }
}
