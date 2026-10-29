//! The durable event outbox in the tenant file (ADR D14;
//! `docs/contracts/ops.md` section 15.4): `renox__outbox` and
//! `renox__outbox_dead`, created by `migrations/0001_outbox.sql`.
//!
//! Every function here is platform work: it runs with the platform policy on
//! the writer even on a handle that carries a module authorizer, because a
//! module's own SQL can never name a `renox__*` table.
//!
//! The emit side (#231) calls [`emit`] inside the emitter's transaction (or
//! [`emit_autocommit`] outside one), so a rolled-back transaction never
//! delivers. The delivery worker (#229) reads [`due`] rows, fans an event out
//! to its handler modules with [`fan_out`], acknowledges a delivery in the
//! handler's own transaction with [`delivered`], and records failures with
//! [`failed`] or [`dead_letter`].

use crate::db::{TenantDb, Tx};
use crate::error::{DbError, Result};
use crate::stats::OutboxStats;
use crate::value::{Row, Value};

/// Payload cap: 64 KiB of JSON (`ops.md` section 15.4, "Payload").
pub const MAX_PAYLOAD_BYTES: usize = 64 * 1024;

/// A durable event as `op_events_emit` writes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutboxEvent {
    /// A ULID.
    pub id: String,
    /// `<module>.<event>`.
    pub name: String,
    /// The payload as JSON text, already validated against the exported schema.
    pub payload: String,
    /// The emitting module.
    pub module: String,
    /// Unix ms.
    pub created_at: i64,
}

/// One row of `renox__outbox`: a pending fan-out (`target` empty) or one
/// delivery to one handler module.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutboxRow {
    pub id: String,
    /// The handling module; empty while the event waits for its fan-out.
    pub target: String,
    pub name: String,
    pub payload: String,
    pub module: String,
    pub created_at: i64,
    pub attempts: u32,
    pub next_at: i64,
    pub last_error: Option<String>,
}

/// The dead-letter cap: whichever bound is reached first prunes the oldest
/// rows (`docs/23-failure-modes.md`, "Outbox or logs grow unbounded").
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DeadLetterCap {
    pub max_rows: u64,
    /// Sum of payload and error bytes.
    pub max_bytes: u64,
}

impl Default for DeadLetterCap {
    /// 10,000 rows (`ops.md` section 15.4, "Outbox limits") or 8 MiB (#228).
    fn default() -> Self {
        DeadLetterCap {
            max_rows: 10_000,
            max_bytes: 8 * 1024 * 1024,
        }
    }
}

const INSERT: &str = "insert into renox__outbox \
     (id, target, name, payload, module, created_at, attempts, next_at) \
     values (?, '', ?, ?, ?, ?, 0, ?)";

fn check(ev: &OutboxEvent) -> Result<()> {
    if ev.payload.len() > MAX_PAYLOAD_BYTES {
        return Err(DbError::Param(format!(
            "event payload is over {MAX_PAYLOAD_BYTES} bytes"
        )));
    }
    if ev.id.is_empty() || ev.name.is_empty() || ev.module.is_empty() {
        return Err(DbError::Param(
            "event id, name and module are required".into(),
        ));
    }
    Ok(())
}

fn params(ev: &OutboxEvent) -> [Value; 6] {
    [
        ev.id.as_str().into(),
        ev.name.as_str().into(),
        ev.payload.as_str().into(),
        ev.module.as_str().into(),
        Value::Integer(ev.created_at),
        Value::Integer(ev.created_at),
    ]
}

/// Insert `ev` in the open transaction `tx`: it is delivered only if `tx`
/// commits.
pub fn emit(db: &TenantDb, tx: &Tx<'_>, ev: &OutboxEvent) -> Result<()> {
    check(ev)?;
    db.with_policy(None, || tx.execute(INSERT, &params(ev)))??;
    Ok(())
}

/// Insert `ev` as its own autocommit write (an emit outside a transaction).
pub fn emit_autocommit(db: &TenantDb, ev: &OutboxEvent) -> Result<()> {
    check(ev)?;
    db.with_policy(None, || db.execute(INSERT, &params(ev)))??;
    Ok(())
}

fn text(r: &Row, c: &str) -> String {
    match r.get(c) {
        Some(Value::Text(s)) => s.clone(),
        _ => String::new(),
    }
}

fn int(r: &Row, c: &str) -> i64 {
    match r.get(c) {
        Some(Value::Integer(i)) => *i,
        _ => 0,
    }
}

fn row(r: &Row) -> OutboxRow {
    OutboxRow {
        id: text(r, "id"),
        target: text(r, "target"),
        name: text(r, "name"),
        payload: text(r, "payload"),
        module: text(r, "module"),
        created_at: int(r, "created_at"),
        attempts: u32::try_from(int(r, "attempts")).unwrap_or(0),
        next_at: int(r, "next_at"),
        last_error: match r.get("last_error") {
            Some(Value::Text(s)) => Some(s.clone()),
            _ => None,
        },
    }
}

/// Rows due at `now_ms`, oldest first, at most `limit`. Reads only the
/// `next_at` index range.
pub fn due(db: &TenantDb, now_ms: i64, limit: u32) -> Result<Vec<OutboxRow>> {
    let rows = db.with_policy(None, || {
        db.query(
            "select id, target, name, payload, module, created_at, attempts, next_at, last_error \
             from renox__outbox where next_at <= ? order by next_at, id, target limit ?",
            &[Value::Integer(now_ms), Value::Integer(i64::from(limit))],
        )
    })??;
    Ok(rows.iter().map(row).collect())
}

/// The earliest `next_at` of any row, or `None` when the outbox is empty.
pub fn next_due_at(db: &TenantDb) -> Result<Option<i64>> {
    let r = db.with_policy(None, || {
        db.query_one("select min(next_at) as n from renox__outbox", &[])
    })??;
    Ok(r.and_then(|r| match r.get("n") {
        Some(Value::Integer(n)) => Some(*n),
        _ => None,
    }))
}

/// Replace the pending fan-out row of event `id` with one delivery per
/// handler module in `targets`, all due at `now_ms`. No targets: the event
/// has no handler and is dropped. One transaction; a second call for the
/// same id is a no-op.
pub fn fan_out(db: &TenantDb, id: &str, targets: &[String], now_ms: i64) -> Result<()> {
    db.with_policy(None, || {
        db.transaction(|tx| {
            for t in targets {
                if t.is_empty() {
                    return Err(DbError::Param("empty handler module".into()));
                }
                tx.execute(
                    "insert or ignore into renox__outbox \
                     (id, target, name, payload, module, created_at, attempts, next_at) \
                     select id, ?, name, payload, module, created_at, 0, ? \
                     from renox__outbox where id = ? and target = ''",
                    &[t.as_str().into(), Value::Integer(now_ms), id.into()],
                )?;
            }
            tx.execute(
                "delete from renox__outbox where id = ? and target = ''",
                &[id.into()],
            )?;
            Ok(())
        })
    })?
}

/// Acknowledge the delivery `(id, target)` inside the handler's own
/// transaction, so its writes and the acknowledgement commit together.
/// Returns false when the row was already gone (a duplicate delivery).
pub fn delivered(db: &TenantDb, tx: &Tx<'_>, id: &str, target: &str) -> Result<bool> {
    let r = db.with_policy(None, || {
        tx.execute(
            "delete from renox__outbox where id = ? and target = ?",
            &[id.into(), target.into()],
        )
    })??;
    Ok(r.changes > 0)
}

/// Record a failed attempt: `attempts` becomes `attempts`, the row is due
/// again at `next_at`, `error` is kept (the caller redacts it).
pub fn failed(
    db: &TenantDb,
    id: &str,
    target: &str,
    attempts: u32,
    next_at: i64,
    error: &str,
) -> Result<()> {
    db.with_policy(None, || {
        db.execute(
            "update renox__outbox set attempts = ?, next_at = ?, last_error = ? \
             where id = ? and target = ?",
            &[
                Value::Integer(i64::from(attempts)),
                Value::Integer(next_at),
                error.into(),
                id.into(),
                target.into(),
            ],
        )
    })??;
    Ok(())
}

/// Move the delivery `(id, target)` to `renox__outbox_dead` after its last
/// attempt, then prune the dead letters to `cap`, oldest first. Returns the
/// number of dead letters pruned.
pub fn dead_letter(
    db: &TenantDb,
    id: &str,
    target: &str,
    attempts: u32,
    error: &str,
    now_ms: i64,
    cap: DeadLetterCap,
) -> Result<u64> {
    db.with_policy(None, || {
        db.transaction(|tx| {
            tx.execute(
                "insert or replace into renox__outbox_dead \
                 (id, target, name, payload, module, created_at, attempts, next_at, last_error, dead_at) \
                 select id, target, name, payload, module, created_at, ?, next_at, ?, ? \
                 from renox__outbox where id = ? and target = ?",
                &[
                    Value::Integer(i64::from(attempts)),
                    error.into(),
                    Value::Integer(now_ms),
                    id.into(),
                    target.into(),
                ],
            )?;
            tx.execute(
                "delete from renox__outbox where id = ? and target = ?",
                &[id.into(), target.into()],
            )?;
            prune(tx, cap)
        })
    })?
}

/// Delete the oldest dead letters until both bounds of `cap` hold.
fn prune(tx: &Tx<'_>, cap: DeadLetterCap) -> Result<u64> {
    let mut pruned = 0;
    let by_rows = tx.execute(
        "delete from renox__outbox_dead where rowid in ( \
           select rowid from renox__outbox_dead order by dead_at desc, rowid desc \
           limit -1 offset ?)",
        &[Value::Integer(
            i64::try_from(cap.max_rows).unwrap_or(i64::MAX),
        )],
    )?;
    pruned += by_rows.changes;
    // Keep the newest rows whose running size stays within max_bytes.
    let by_bytes = tx.execute(
        "delete from renox__outbox_dead where rowid in ( \
           select rowid from ( \
             select rowid, sum(length(payload) + coalesce(length(last_error), 0)) \
               over (order by dead_at desc, rowid desc) as running \
             from renox__outbox_dead) \
           where running > ?)",
        &[Value::Integer(
            i64::try_from(cap.max_bytes).unwrap_or(i64::MAX),
        )],
    )?;
    pruned += by_bytes.changes;
    if pruned > 0 {
        tx.execute(
            "insert into renox__outbox_meta (key, value) values ('dead_pruned', ?) \
             on conflict (key) do update set value = value + excluded.value",
            &[Value::Integer(i64::try_from(pruned).unwrap_or(i64::MAX))],
        )?;
    }
    Ok(pruned)
}

/// Pending deliveries, dead letters, and dead letters pruned so far.
pub fn stats(db: &TenantDb) -> Result<OutboxStats> {
    let r = db.with_policy(None, || {
        db.query_one(
            "select (select count(*) from renox__outbox) as pending, \
                    (select count(*) from renox__outbox_dead) as dead, \
                    (select coalesce(sum(length(payload) + coalesce(length(last_error), 0)), 0) \
                       from renox__outbox_dead) as dead_bytes, \
                    coalesce((select value from renox__outbox_meta where key = 'dead_pruned'), 0) \
                      as dead_pruned",
            &[],
        )
    })??;
    let n = |c: &str| {
        r.as_ref()
            .map(|r| u64::try_from(int(r, c)).unwrap_or(0))
            .unwrap_or(0)
    };
    Ok(OutboxStats {
        pending: n("pending"),
        dead: n("dead"),
        dead_bytes: n("dead_bytes"),
        dead_pruned: n("dead_pruned"),
    })
}

/// The dead letters, newest first (dashboard, tests).
pub fn dead_letters(db: &TenantDb, limit: u32) -> Result<Vec<OutboxRow>> {
    let rows = db.with_policy(None, || {
        db.query(
            "select id, target, name, payload, module, created_at, attempts, next_at, last_error \
             from renox__outbox_dead order by dead_at desc, rowid desc limit ?",
            &[Value::Integer(i64::from(limit))],
        )
    })??;
    Ok(rows.iter().map(row).collect())
}
