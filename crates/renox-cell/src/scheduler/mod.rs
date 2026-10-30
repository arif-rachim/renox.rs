//! The job scheduler of a cell (`docs/contracts/ops.md` 1.6.0 section 20;
//! #297).
//!
//! One task per live cell of a deployment with `job` routes. For each job
//! it computes the next tick of the five-field cron expression in the job's
//! zone (`tz`, UTC when absent; zones from the system tzdb through `jiff`),
//! sleeps until the earliest one, and at the tick writes the job's one
//! durable row through [`renox_runtime::ops::jobs::schedule_tick`]: one row
//! per job and tick, idempotently, coalescing into the waiting row when one
//! exists. The outbox worker runs the row like an event delivery.
//!
//! Missed ticks: every computed next tick is persisted
//! (`job_next:<module>:<name>` in `renox__outbox_meta`). A cell that starts
//! after an eviction, a restart or downtime finds the persisted tick in the
//! past and writes one run for the latest missed tick, then goes on. The
//! manager wakes an evicted tenant's cell at its next tick, so a nightly job
//! runs at night and not at the next request.
//!
//! No overlap: a running job holds a [`Lease`] (in memory: one node owns a
//! tenant). The outbox worker defers a row whose job is leased, and the ack
//! of a scheduled run keeps the row when the job ticked again during the
//! run, so the second tick waits until the first run ends.

use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use jiff::civil::DateTime;
use jiff::tz::TimeZone;
use renox_runtime::ops::db::DbHandle;
use renox_runtime::ops::jobs::{self, JobDef};
use tokio::sync::Notify;

// ---------------------------------------------------------------------------
// Cron expressions (V27: numeric fields; `*`, lists, ranges, steps).

/// A parsed five-field cron expression: minute, hour, day of month, month,
/// day of week (0 and 7 are Sunday).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cron {
    minutes: u64,
    hours: u32,
    dom: u32,
    months: u16,
    dow: u8,
    dom_any: bool,
    dow_any: bool,
}

fn field(spec: &str, lo: u32, hi: u32) -> Result<(u64, bool), String> {
    let mut bits = 0u64;
    let any = spec == "*";
    for part in spec.split(',') {
        let (range, step) = match part.split_once('/') {
            Some((r, s)) => (
                r,
                s.parse::<u32>()
                    .ok()
                    .filter(|s| *s > 0)
                    .ok_or_else(|| format!("bad step in {part}"))?,
            ),
            None => (part, 1),
        };
        let (a, b) = if range == "*" {
            (lo, hi)
        } else if let Some((a, b)) = range.split_once('-') {
            let a: u32 = a.parse().map_err(|_| format!("bad value {a}"))?;
            let b: u32 = b.parse().map_err(|_| format!("bad value {b}"))?;
            (a, b)
        } else {
            let a: u32 = range.parse().map_err(|_| format!("bad value {range}"))?;
            // `5/15` means from 5 to the end, every 15.
            if part.contains('/') { (a, hi) } else { (a, a) }
        };
        if a < lo || b > hi || a > b {
            return Err(format!("{part} is outside {lo}-{hi}"));
        }
        let mut v = a;
        while v <= b {
            bits |= 1u64 << v;
            v += step;
        }
    }
    Ok((bits, any))
}

impl Cron {
    pub fn parse(expr: &str) -> Result<Cron, String> {
        let f: Vec<&str> = expr.split_whitespace().collect();
        if f.len() != 5 {
            return Err("a cron expression has five fields".into());
        }
        let (minutes, _) = field(f[0], 0, 59)?;
        let (hours, _) = field(f[1], 0, 23)?;
        let (dom, dom_any) = field(f[2], 1, 31)?;
        let (months, _) = field(f[3], 1, 12)?;
        let (mut dow, dow_any) = field(f[4], 0, 7)?;
        if dow & (1 << 7) != 0 {
            dow |= 1;
        }
        Ok(Cron {
            minutes,
            hours: hours as u32,
            dom: dom as u32,
            months: months as u16,
            dow: (dow & 0x7f) as u8,
            dom_any,
            dow_any,
        })
    }

    fn day_matches(&self, dt: &DateTime) -> bool {
        let dom = self.dom & (1 << dt.day()) != 0;
        let dow = self.dow & (1 << dt.weekday().to_sunday_zero_offset()) != 0;
        // Vixie cron: both restricted means either matches.
        match (self.dom_any, self.dow_any) {
            (true, true) => true,
            (true, false) => dow,
            (false, true) => dom,
            (false, false) => dom || dow,
        }
    }

    /// The first tick strictly after `after_ms` in `tz` (Unix ms), within
    /// five years.
    pub fn next_after(&self, after_ms: i64, tz: &TimeZone) -> Option<i64> {
        let ts = jiff::Timestamp::from_millisecond(after_ms).ok()?;
        let start = ts.to_zoned(tz.clone()).datetime();
        let mut dt = start
            .date()
            .at(start.hour(), start.minute(), 0, 0)
            .checked_add(jiff::Span::new().minutes(1))
            .ok()?;
        let limit = start.date().year() + 5;
        while dt.year() <= limit {
            if self.months & (1 << dt.month()) == 0 {
                dt = dt
                    .date()
                    .first_of_month()
                    .checked_add(jiff::Span::new().months(1))
                    .ok()?
                    .at(0, 0, 0, 0);
                continue;
            }
            if !self.day_matches(&dt) {
                dt = dt.date().tomorrow().ok()?.at(0, 0, 0, 0);
                continue;
            }
            if self.hours & (1 << dt.hour()) == 0 {
                dt = dt
                    .date()
                    .at(dt.hour(), 0, 0, 0)
                    .checked_add(jiff::Span::new().hours(1))
                    .ok()?;
                continue;
            }
            if self.minutes & (1 << dt.minute()) == 0 {
                dt = dt.checked_add(jiff::Span::new().minutes(1)).ok()?;
                continue;
            }
            let at = dt.to_zoned(tz.clone()).ok()?.timestamp().as_millisecond();
            if at > after_ms {
                return Some(at);
            }
            dt = dt.checked_add(jiff::Span::new().minutes(1)).ok()?;
        }
        None
    }

    /// The last tick at or before `at_ms` in `tz`, within five years.
    pub fn prev_at_or_before(&self, at_ms: i64, tz: &TimeZone) -> Option<i64> {
        let ts = jiff::Timestamp::from_millisecond(at_ms).ok()?;
        let end = ts.to_zoned(tz.clone()).datetime();
        let mut dt = end.date().at(end.hour(), end.minute(), 0, 0);
        let limit = end.date().year() - 5;
        while dt.year() >= limit {
            if self.months & (1 << dt.month()) == 0 {
                dt = dt
                    .date()
                    .first_of_month()
                    .yesterday()
                    .ok()?
                    .at(23, 59, 0, 0);
                continue;
            }
            if !self.day_matches(&dt) {
                dt = dt.date().yesterday().ok()?.at(23, 59, 0, 0);
                continue;
            }
            if self.hours & (1 << dt.hour()) == 0 {
                dt = dt
                    .date()
                    .at(dt.hour(), 0, 0, 0)
                    .checked_sub(jiff::Span::new().minutes(1))
                    .ok()?;
                continue;
            }
            if self.minutes & (1 << dt.minute()) == 0 {
                dt = dt.checked_sub(jiff::Span::new().minutes(1)).ok()?;
                continue;
            }
            let t = dt.to_zoned(tz.clone()).ok()?.timestamp().as_millisecond();
            if t <= at_ms {
                return Some(t);
            }
            dt = dt.checked_sub(jiff::Span::new().minutes(1)).ok()?;
        }
        None
    }
}

/// The zone of a job: its IANA `tz`, or UTC.
pub fn zone(tz: Option<&str>) -> Result<TimeZone, String> {
    match tz {
        None => Ok(TimeZone::UTC),
        Some(name) => TimeZone::get(name).map_err(|e| format!("unknown zone {name}: {e}")),
    }
}

// ---------------------------------------------------------------------------
// Counters (`/metrics`, #297: runs, failures, lag).

/// Job attempts started on this node.
pub static RUNS: AtomicU64 = AtomicU64::new(0);
/// Job attempts that failed (threw, a limit, or dead-lettered).
pub static FAILURES: AtomicU64 = AtomicU64::new(0);
/// Lag of the last scheduled run: its start minus its tick, in ms.
pub static LAST_LAG_MS: AtomicU64 = AtomicU64::new(0);
/// Ticks written (rows added or coalesced).
pub static TICKS: AtomicU64 = AtomicU64::new(0);

// ---------------------------------------------------------------------------
// Lease: one run at a time per job (section 20, "Lease").

static LEASES: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(Mutex::default);

/// A held lease; dropping it releases the job.
pub struct Lease(String);

impl Drop for Lease {
    fn drop(&mut self) {
        LEASES.lock().expect("lease lock").remove(&self.0);
    }
}

/// The lease of job `module.name` of `tenant`, unless another run holds it.
pub fn try_lease(tenant: &str, module: &str, name: &str) -> Option<Lease> {
    let key = format!("{tenant}/{module}/{name}");
    let mut held = LEASES.lock().expect("lease lock");
    if held.insert(key.clone()) {
        Some(Lease(key))
    } else {
        None
    }
}

// ---------------------------------------------------------------------------
// The task.

struct Planned {
    def: JobDef,
    cron: Cron,
    tz: TimeZone,
    next: i64,
}

/// The scheduler's handle on its cell: dropping it stops the task.
pub(crate) struct SchedulerTask {
    stop: Arc<Notify>,
}

impl Drop for SchedulerTask {
    fn drop(&mut self) {
        self.stop.notify_one();
    }
}

/// The earliest next tick of a cell's jobs, kept for the manager's wake-up
/// after an eviction.
pub(crate) type NextTick = Arc<Mutex<Option<i64>>>;

fn log_bad(tenant: &str, d: &JobDef, why: &str) {
    tracing::warn!(tenant_id = %tenant, module = %d.module, job = %d.name, reason = %why, "job not scheduled");
}

/// Start the scheduler of a cell whose deployment has `defs`. Returns
/// `None` when there is nothing to schedule.
pub(crate) fn spawn(
    tenant: String,
    db: DbHandle,
    defs: Vec<JobDef>,
    next_tick: NextTick,
) -> Option<SchedulerTask> {
    if defs.is_empty() {
        return None;
    }
    let stop = Arc::new(Notify::new());
    let task = SchedulerTask { stop: stop.clone() };
    tokio::spawn(async move {
        let now = jobs::now_ms();
        let mut planned = Vec::new();
        for def in defs {
            let cron = match Cron::parse(&def.schedule) {
                Ok(c) => c,
                Err(e) => {
                    log_bad(&tenant, &def, &e);
                    continue;
                }
            };
            let tz = match zone(def.tz.as_deref()) {
                Ok(z) => z,
                Err(e) => {
                    log_bad(&tenant, &def, &e);
                    continue;
                }
            };
            // Missed ticks since the persisted next one coalesce into one
            // run for the latest of them.
            let (m, n) = (def.module.clone(), def.name.clone());
            let stored = db
                .call(move |db| jobs::stored_next(db, &m, &n))
                .await
                .ok()
                .and_then(Result::ok)
                .flatten();
            if let Some(s) = stored
                && s <= now
                && let Some(latest) = cron.prev_at_or_before(now, &tz).filter(|t| *t >= s)
            {
                let (m, n) = (def.module.clone(), def.name.clone());
                let _ = db
                    .call(move |db| jobs::schedule_tick(db, &m, &n, latest, now))
                    .await;
                TICKS.fetch_add(1, Ordering::Relaxed);
                tracing::info!(tenant_id = %tenant, module = %def.module, job = %def.name, tick = latest, "missed job ticks coalesced into one run");
            }
            let Some(next) = cron.next_after(now, &tz) else {
                log_bad(&tenant, &def, "no tick in five years");
                continue;
            };
            let (m, n) = (def.module.clone(), def.name.clone());
            let _ = db.call(move |db| jobs::set_next(db, &m, &n, next)).await;
            planned.push(Planned {
                def,
                cron,
                tz,
                next,
            });
        }
        loop {
            let Some(earliest) = planned.iter().map(|p| p.next).min() else {
                *next_tick.lock().expect("next tick lock") = None;
                return;
            };
            *next_tick.lock().expect("next tick lock") = Some(earliest);
            let wait = u64::try_from(earliest.saturating_sub(jobs::now_ms())).unwrap_or(0);
            tokio::select! {
                _ = stop.notified() => return,
                _ = tokio::time::sleep(Duration::from_millis(wait)) => {}
            }
            let now = jobs::now_ms();
            for p in planned.iter_mut().filter(|p| p.next <= now) {
                let (m, n, tick) = (p.def.module.clone(), p.def.name.clone(), p.next);
                if db
                    .call(move |db| jobs::schedule_tick(db, &m, &n, tick, now))
                    .await
                    .is_err()
                {
                    return;
                }
                TICKS.fetch_add(1, Ordering::Relaxed);
                tracing::info!(tenant_id = %tenant, module = %p.def.module, job = %p.def.name, tick, "job tick");
                match p.cron.next_after(now.max(tick), &p.tz) {
                    Some(next) => {
                        p.next = next;
                        let (m, n) = (p.def.module.clone(), p.def.name.clone());
                        let _ = db.call(move |db| jobs::set_next(db, &m, &n, next)).await;
                    }
                    None => p.next = i64::MAX,
                }
            }
            planned.retain(|p| p.next != i64::MAX);
        }
    });
    Some(task)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(s: &str) -> i64 {
        s.parse::<jiff::Timestamp>().unwrap().as_millisecond()
    }

    #[test]
    fn nightly_at_three_utc_and_in_dubai() {
        let c = Cron::parse("0 3 * * *").unwrap();
        assert_eq!(
            c.next_after(ms("2026-10-30T10:00:00Z"), &TimeZone::UTC),
            Some(ms("2026-10-31T03:00:00Z"))
        );
        let dubai = zone(Some("Asia/Dubai")).unwrap();
        assert_eq!(
            c.next_after(ms("2026-10-30T10:00:00Z"), &dubai),
            Some(ms("2026-10-30T23:00:00Z"))
        );
        assert_eq!(
            c.prev_at_or_before(ms("2026-10-30T10:00:00Z"), &TimeZone::UTC),
            Some(ms("2026-10-30T03:00:00Z"))
        );
    }

    #[test]
    fn steps_ranges_lists_and_day_of_week() {
        let c = Cron::parse("*/15 9-17 * * 1-5").unwrap();
        // Friday 17:50 → Monday 09:00.
        assert_eq!(
            c.next_after(ms("2026-10-30T17:50:00Z"), &TimeZone::UTC),
            Some(ms("2026-11-02T09:00:00Z"))
        );
        let c = Cron::parse("0 0 1,15 * *").unwrap();
        assert_eq!(
            c.next_after(ms("2026-10-15T00:00:00Z"), &TimeZone::UTC),
            Some(ms("2026-11-01T00:00:00Z"))
        );
        let sunday = Cron::parse("0 12 * * 7").unwrap();
        assert_eq!(
            sunday.next_after(ms("2026-10-30T00:00:00Z"), &TimeZone::UTC),
            Some(ms("2026-11-01T12:00:00Z"))
        );
        assert!(Cron::parse("60 * * * *").is_err());
        assert!(Cron::parse("* * *").is_err());
        assert!(Cron::parse("*/0 * * * *").is_err());
    }

    #[test]
    fn a_lease_is_exclusive_until_dropped() {
        let a = try_lease("t1", "app", "report").expect("free");
        assert!(try_lease("t1", "app", "report").is_none());
        assert!(try_lease("t2", "app", "report").is_some());
        drop(a);
        assert!(try_lease("t1", "app", "report").is_some());
    }
}
