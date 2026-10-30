//! The outbox delivery worker of a cell (`docs/contracts/ops.md` 1.3.0,
//! section 15.4, "Delivery"; ADR D14).
//!
//! One task per live cell. It sleeps until SQLite's update hook says a
//! commit inserted into `renox__outbox` (`TenantDb::on_outbox_commit`) or
//! until the earliest retry is due; it never polls. On start it scans the
//! rows already due, so events written before a restart or an eviction are
//! delivered by the next cell of the tenant.
//!
//! For each due row:
//!
//! | Row | What happens |
//! | --- | --- |
//! | Pending fan-out (`target` empty) | Replaced by one delivery per module with an `on` handler for the event, by module name; none: dropped |
//! | Delivery `(id, module)` | The isolate runs the handler with the event envelope; on success the handler's transaction deleted the row (the ack) |
//! | Failed attempt | `attempts + 1`, due again after the backoff; after the last attempt moved to `renox__outbox_dead`, one `event_dead` log line (id, name, module, last error; never the payload) |
//! | No handler any more | Deleted and logged, not retried |
//!
//! Every attempt is one meter record with `kind: "event"` (`meter.md` 0.2).
//!
//! Job runs (`ops.md` 1.6.0 section 20, #297) are rows of the same table
//! with `name` `job:<name>` and the job's module as `target`: delivered the
//! same way with `kind: "job"` envelopes, one at a time per job (a
//! [`crate::scheduler::Lease`]), metered `kind: "job"`. The cell's scheduler
//! starts and stops with this worker.

use std::sync::{Arc, Weak};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use renox_data::outbox::{self, DeadLetterCap, OutboxRow};
use renox_meter::{Meter, MeterKind, MeterRecord, MeterStatus};
use renox_runtime::isolate::MeterStatus as RuntimeStatus;
use renox_runtime::ops::db::DbHandle;
use renox_runtime::{EventEnvelope, EventOutcome, RequestCtx};
use tokio::sync::Notify;

use crate::cell::Cell;

/// Delivery settings (ops.md 1.3.0 section 15.4, "Retries"; the numbers
/// are the contract's proposed ones, Open 5).
#[derive(Debug, Clone, Copy)]
pub struct OutboxConfig {
    /// Delay after the first failed attempt; doubled after each one.
    pub base: Duration,
    /// Longest delay.
    pub cap: Duration,
    /// Jitter, as a fraction of the delay (0.2 = ± 20 %).
    pub jitter: f64,
    /// Attempts before a delivery is dead-lettered.
    pub max_attempts: u32,
    /// Dead letters kept per tenant.
    pub dead: DeadLetterCap,
    /// Wall clock of one attempt, before the tier's own limit lowers it.
    pub attempt_wall: Duration,
    /// Rows read per pass.
    pub batch: u32,
}

impl Default for OutboxConfig {
    fn default() -> Self {
        OutboxConfig {
            base: Duration::from_secs(10),
            cap: Duration::from_secs(3600),
            jitter: 0.2,
            max_attempts: 8,
            dead: DeadLetterCap::default(),
            attempt_wall: Duration::from_secs(60),
            batch: 100,
        }
    }
}

impl OutboxConfig {
    /// The delay after failed attempt `attempt` (1-based): `base × 2^(n−1)`,
    /// capped, then ± `jitter`, with `unit` ∈ [0, 1) choosing the jitter.
    pub fn backoff(&self, attempt: u32, unit: f64) -> Duration {
        let exp = attempt.saturating_sub(1).min(30);
        let raw = self.base.saturating_mul(1u32 << exp).min(self.cap);
        let factor = 1.0 + self.jitter * (2.0 * unit.clamp(0.0, 1.0) - 1.0);
        Duration::from_secs_f64((raw.as_secs_f64() * factor).max(0.0))
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// A number in [0, 1) for the jitter; no need for a strong source.
fn jitter_unit(id: &str, attempt: u32) -> f64 {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    let mut h: u64 = 0xcbf2_9ce4_8422_2325 ^ u64::from(nanos);
    for b in id.bytes().chain(attempt.to_le_bytes()) {
        h = (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3);
    }
    (h >> 11) as f64 / (1u64 << 53) as f64
}

/// Admit one delivery on the cell under the manager's map lock.
pub(crate) type Admit = Box<dyn Fn(&Arc<Cell>) -> bool + Send + Sync>;

/// What the worker needs from the manager: admit a delivery on the cell
/// under the eviction lock, the meter, and the tenant's ids.
pub(crate) struct Delivery {
    pub cell: Weak<Cell>,
    pub db: DbHandle,
    pub meter: Meter,
    pub config: OutboxConfig,
    /// Admit one delivery on the cell (false: it is being evicted).
    pub admit: Admit,
    /// The deployment's `job` routes to schedule (empty: no scheduler,
    /// as under `renox dev` without `--jobs`); queued runs are delivered
    /// either way.
    pub jobs: Vec<renox_runtime::ops::jobs::JobDef>,
    /// Where the scheduler keeps its earliest next tick (the manager's
    /// wake-up after an eviction).
    pub next_tick: crate::scheduler::NextTick,
    /// `[jobs] poll_ms` of a development worker: also pass every `poll`
    /// (rows the CLI wrote from another connection). `None` in production.
    pub poll: Option<Duration>,
}

/// The worker's handle on its cell: dropping it stops the task.
pub(crate) struct OutboxWorker {
    stop: Arc<Notify>,
    _scheduler: Option<crate::scheduler::SchedulerTask>,
}

impl Drop for OutboxWorker {
    fn drop(&mut self) {
        self.stop.notify_one();
    }
}

/// Start the delivery task of a cell.
pub(crate) fn spawn(d: Delivery) -> OutboxWorker {
    let stop = Arc::new(Notify::new());
    let wake = Arc::new(Notify::new());
    let tenant = d
        .cell
        .upgrade()
        .map(|c| c.key.tenant_id.clone())
        .unwrap_or_default();
    let scheduler =
        crate::scheduler::spawn(tenant, d.db.clone(), d.jobs.clone(), d.next_tick.clone());
    let worker = OutboxWorker {
        stop: stop.clone(),
        _scheduler: scheduler,
    };
    tokio::spawn(async move {
        // Section 20, "Lease": a row left running by a dead process is
        // queued again, attempts unchanged.
        let _ = d.db.call(renox_runtime::ops::jobs::requeue_running).await;
        // The hook holds only a weak reference: a stopped worker's wake-up
        // does nothing, and the next cell of the tenant installs its own.
        let w = Arc::downgrade(&wake);
        let hook: renox_data::OutboxWake = Arc::new(move || {
            if let Some(w) = w.upgrade() {
                w.notify_one();
            }
        });
        if d.db
            .call(move |db| db.on_outbox_commit(Some(hook)))
            .await
            .is_err()
        {
            return;
        }
        loop {
            let next = match pass(&d).await {
                Some(next) => next,
                None => return,
            };
            let poll = async {
                match d.poll {
                    Some(p) => tokio::time::sleep(p).await,
                    None => std::future::pending::<()>().await,
                }
            };
            let sleep = async {
                match next {
                    Some(at) => {
                        let ms = u64::try_from(at.saturating_sub(now_ms())).unwrap_or(0);
                        tokio::time::sleep(Duration::from_millis(ms)).await
                    }
                    None => std::future::pending::<()>().await,
                }
            };
            tokio::select! {
                _ = stop.notified() => return,
                _ = wake.notified() => {}
                _ = sleep => {}
                _ = poll => {}
            }
        }
    });
    worker
}

/// Deliver everything due now. `None`: stop (the cell or the database is
/// gone); else the next time a row is due.
async fn pass(d: &Delivery) -> Option<Option<i64>> {
    loop {
        let now = now_ms();
        let batch = d.config.batch;
        let rows =
            d.db.call(move |db| outbox::due(db, now, batch))
                .await
                .ok()?
                .ok()?;
        if rows.is_empty() {
            break;
        }
        for row in rows {
            let cell = d.cell.upgrade()?;
            if row.target.is_empty() {
                // ops.md 1.5.0 section 17: authz.roles_changed, auth.login
                // and auth.logout drop the user's cached principal.
                crate::authz::on_event(&cell.isolate.authz_slot(), &row.name, &row.payload);
                // #285: a revoked agent token leaves the MCP cache.
                cell.mcp.on_event(&row.name, &row.payload);
                let targets = cell.isolate.event_handlers(&row.name);
                let id = row.id.clone();
                d.db.call(move |db| outbox::fan_out(db, &id, &targets, now))
                    .await
                    .ok()?
                    .ok()?;
                continue;
            }
            if !(d.admit)(&cell) {
                return None;
            }
            let _guard = crate::cell::InFlightGuard(&cell);
            attempt(d, &cell, row).await?;
        }
    }
    d.db.call(outbox::next_due_at).await.ok()?.ok()
}

/// One delivery attempt and its bookkeeping.
async fn attempt(d: &Delivery, cell: &Arc<Cell>, row: OutboxRow) -> Option<()> {
    // #295: one span per attempt (never the payload).
    let span = tracing::info_span!(
        "outbox.deliver",
        tenant_id = %cell.key.tenant_id,
        event = %row.name,
        module = %row.target,
        attempt = row.attempts + 1,
    );
    tracing::Instrument::instrument(attempt_inner(d, cell, row), span).await
}

async fn attempt_inner(d: &Delivery, cell: &Arc<Cell>, row: OutboxRow) -> Option<()> {
    use renox_runtime::ops::jobs;
    let job_name = jobs::job_name(&row.name).map(str::to_string);
    let mut _lease = None;
    let mut job = None;
    if let Some(name) = &job_name {
        // One run at a time per job: a leased job's row waits a second.
        match crate::scheduler::try_lease(&cell.key.tenant_id, &row.target, name) {
            Some(l) => _lease = Some(l),
            None => {
                let (id, target) = (row.id.clone(), row.target.clone());
                let at = now_ms() + 1000;
                d.db.call(move |db| jobs::defer(db, &id, &target, at))
                    .await
                    .ok()?
                    .ok()?;
                return Some(());
            }
        }
        let (m, n, p) = (row.target.clone(), name.clone(), row.payload.clone());
        let tick =
            d.db.call(move |db| jobs::run_tick(db, &m, &n, &p))
                .await
                .ok()?
                .ok()?;
        let id = row.id.clone();
        let now = now_ms();
        d.db.call(move |db| jobs::started(db, &id, now))
            .await
            .ok()?
            .ok()?;
        crate::scheduler::RUNS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        if let Some(t) = tick {
            crate::scheduler::LAST_LAG_MS.store(
                u64::try_from(now.saturating_sub(t)).unwrap_or(0),
                std::sync::atomic::Ordering::Relaxed,
            );
        }
        job = Some(renox_runtime::JobRun {
            name: name.clone(),
            tick,
        });
    }
    let ev = EventEnvelope {
        id: row.id.clone(),
        name: row.name.clone(),
        payload_json: row.payload.clone(),
        attempt: row.attempts + 1,
        module: row.target.clone(),
        job,
    };
    let started_at = now_ms();
    let t0 = Instant::now();
    let ctx = RequestCtx {
        request_id: ev.request_id(),
        deadline: Instant::now() + d.config.attempt_wall,
    };
    let out = cell.isolate.deliver_event(ctx, ev.clone()).await;
    let wall_ms = t0.elapsed().as_secs_f64() * 1000.0;
    let status = match out.meter.status {
        RuntimeStatus::Ok if out.outcome == EventOutcome::Ok => Some(MeterStatus::Ok),
        RuntimeStatus::Timeout => Some(MeterStatus::Timeout),
        RuntimeStatus::CpuLimit => Some(MeterStatus::CpuLimit),
        RuntimeStatus::Oom => Some(MeterStatus::Oom),
        // No tenant code ran: no record (meter.md: an event record is never `busy`).
        RuntimeStatus::Busy => None,
        _ if out.outcome == EventOutcome::NoHandler => None,
        _ => Some(MeterStatus::Error),
    };
    if let Some(status) = status {
        let m = &out.meter;
        d.meter.record(MeterRecord {
            request_id: ev.request_id(),
            tenant_id: cell.key.tenant_id.clone(),
            deployment_hash: cell.key.deployment_hash.clone(),
            route: ev.route(),
            started_at: u64::try_from(started_at).unwrap_or(0),
            cpu_ms: m.cpu_ms,
            wall_ms,
            peak_heap_bytes: m.peak_heap_bytes,
            ingress_bytes: 0,
            egress_bytes: 0,
            fetch_sent_bytes: m.fetch_sent_bytes,
            fetch_received_bytes: m.fetch_received_bytes,
            fetch_blocked: m.fetch_blocked,
            db_ms: m.db_ms,
            db_rows: m.db_rows,
            render_fuel: 0,
            render_ms: None,
            logs_dropped: m.logs_dropped,
            http_status: if status == MeterStatus::Ok { 200 } else { 500 },
            status,
            kind: Some(if job_name.is_some() {
                MeterKind::Job
            } else {
                MeterKind::Event
            }),
            authz_evals: (m.authz_evals > 0).then_some(m.authz_evals),
            realtime_conn_seconds: None,
            realtime_messages: None,
        });
    }
    let (id, target) = (row.id.clone(), row.target.clone());
    if job_name.is_some() && out.outcome != EventOutcome::Ok {
        // The run ended without its ack: no longer running.
        let id = id.clone();
        d.db.call(move |db| jobs::stopped(db, &id))
            .await
            .ok()?
            .ok()?;
        if !matches!(out.outcome, EventOutcome::NoHandler) {
            crate::scheduler::FAILURES.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
    }
    match out.outcome {
        // The handler's transaction deleted the row with its writes.
        EventOutcome::Ok => Some(()),
        EventOutcome::NoHandler => {
            // Logged by the runtime; dropped, not retried.
            d.db.call(move |db| db.transaction(|tx| outbox::delivered(db, tx, &id, &target)))
                .await
                .ok()?
                .ok()?;
            if let Some(name) = &job_name {
                // ops.md section 20: the deployment has no such job any more.
                let (m, n) = (row.target.clone(), name.clone());
                d.db.call(move |db| jobs::forget_tick(db, &m, &n))
                    .await
                    .ok()?
                    .ok()?;
            }
            Some(())
        }
        EventOutcome::Threw | EventOutcome::Failed(_) => {
            // The last error, never the handler's message (it may carry data).
            let error = match out.outcome {
                EventOutcome::Failed(code) => code.as_str().to_string(),
                _ => "threw".to_string(),
            };
            let attempts = row.attempts + 1;
            let now = now_ms();
            if attempts >= d.config.max_attempts {
                let cap = d.config.dead;
                let e = error.clone();
                let pruned = d
                    .db
                    .call(move |db| outbox::dead_letter(db, &id, &target, attempts, &e, now, cap))
                    .await
                    .ok()?
                    .ok()?;
                let mut f = serde_json::Map::new();
                f.insert(
                    "reason".into(),
                    if job_name.is_some() {
                        "job_dead"
                    } else {
                        "event_dead"
                    }
                    .into(),
                );
                if let Some(name) = &job_name {
                    // The next tick writes a new row (the dead one waits for a retry).
                    let (m, n) = (row.target.clone(), name.clone());
                    d.db.call(move |db| jobs::forget_tick(db, &m, &n))
                        .await
                        .ok()?
                        .ok()?;
                }
                f.insert("event_id".into(), row.id.clone().into());
                f.insert("event".into(), row.name.clone().into());
                f.insert("module".into(), row.target.clone().into());
                f.insert("attempt".into(), attempts.into());
                f.insert("cause".into(), error.into());
                cell.isolate
                    .log("error", Some(&ev.request_id()), "event_dead", f);
                if pruned > 0 {
                    let mut f = serde_json::Map::new();
                    f.insert("reason".into(), "dead_letters_pruned".into());
                    f.insert("pruned".into(), pruned.into());
                    cell.isolate.log("warn", None, "dead letters pruned", f);
                }
            } else {
                let delay = d.config.backoff(attempts, jitter_unit(&row.id, attempts));
                let next_at =
                    now.saturating_add(i64::try_from(delay.as_millis()).unwrap_or(i64::MAX));
                d.db.call(move |db| outbox::failed(db, &id, &target, attempts, next_at, &error))
                    .await
                    .ok()?
                    .ok()?;
            }
            Some(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_doubles_from_ten_seconds_capped_at_an_hour_with_jitter() {
        let c = OutboxConfig::default();
        assert_eq!(c.backoff(1, 0.5), Duration::from_secs(10));
        assert_eq!(c.backoff(2, 0.5), Duration::from_secs(20));
        assert_eq!(c.backoff(4, 0.5), Duration::from_secs(80));
        assert_eq!(c.backoff(12, 0.5), Duration::from_secs(3600));
        assert_eq!(c.backoff(1, 0.0), Duration::from_secs(8));
        assert!(c.backoff(1, 0.999_999) <= Duration::from_secs(12));
        let u = jitter_unit("01J", 3);
        assert!((0.0..1.0).contains(&u));
    }
}
