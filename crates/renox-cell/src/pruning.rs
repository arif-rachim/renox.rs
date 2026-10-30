//! Bounded growth of what the node keeps (#103, `docs/23-failure-modes.md`
//! "Outbox or logs grow unbounded", `docs/16-risks.md`):
//!
//! - **Dead letters** older than [`DEAD_LETTER_RETENTION`] are deleted, on
//!   top of the row and byte cap the delivery worker already applies
//!   (`renox_data::outbox::DeadLetterCap`). Delivered rows need no pruning:
//!   the acknowledgement deletes them (`renox_data::outbox::delivered`).
//! - **Idle tenant files** are swept: each file no cell has open gets the
//!   integrity check and the dead-letter pruning; a damaged one is handed
//!   to the restore ([`Sweeper::on_corrupt`]).
//! - **Tenant log volume**: past [`LogVolume::bytes_per_window`] in a window a
//!   tenant's lines are sampled, one in [`LogVolume::sample_one_in`] kept,
//!   with one summary line per window. This is on top of the per-minute
//!   line rate of `ops.md` section 4, which the runtime enforces.
//! - **Disk pressure** (`crate::disk`, `warn` and above): a sweep runs and
//!   spooled log batches are dropped oldest first. Spooled meters are never
//!   dropped here: they are billing.
//!
//! Every action is counted ([`Counters`]); the counters are logged after
//! each sweep and read by the operator through [`Pruning::counters`].

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use renox_data::integrity::{self, Integrity};
use renox_data::{DbOptions, TenantDb};
use renox_runtime::{LogLine, LogSink};
use serde_json::{Value, json};

use crate::spool::Queue;

/// Dead letters older than this are deleted (7 days).
pub const DEAD_LETTER_RETENTION: Duration = Duration::from_secs(7 * 24 * 3600);

/// How often idle files are swept.
pub const SWEEP_INTERVAL: Duration = Duration::from_secs(3600);

/// The integrity check of one idle file in a sweep.
pub const SWEEP_CHECK_LIMIT: Duration = Duration::from_secs(30);

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// What pruning did since start.
#[derive(Debug, Default)]
pub struct Counters {
    pub dead_letters_pruned: AtomicU64,
    pub files_swept: AtomicU64,
    pub files_corrupt: AtomicU64,
    pub log_lines_sampled_out: AtomicU64,
    pub log_bytes_sampled_out: AtomicU64,
    pub spool_files_dropped: AtomicU64,
    pub sweeps: AtomicU64,
}

impl Counters {
    pub fn snapshot(&self) -> Value {
        let n = |a: &AtomicU64| a.load(Ordering::Relaxed);
        json!({
            "dead_letters_pruned": n(&self.dead_letters_pruned),
            "files_swept": n(&self.files_swept),
            "files_corrupt": n(&self.files_corrupt),
            "log_lines_sampled_out": n(&self.log_lines_sampled_out),
            "log_bytes_sampled_out": n(&self.log_bytes_sampled_out),
            "spool_files_dropped": n(&self.spool_files_dropped),
            "sweeps": n(&self.sweeps),
        })
    }
}

/// Deletes the dead letters of `db` that died before `now_ms - retention`.
/// Platform work: runs under the platform policy.
pub fn prune_dead_letters(
    db: &TenantDb,
    now_ms: i64,
    retention: Duration,
) -> renox_data::Result<u64> {
    let before = now_ms - retention.as_millis() as i64;
    let r = db.with_policy(None, || {
        db.execute(
            "delete from renox__outbox_dead where dead_at < ?",
            &[before.into()],
        )
    })??;
    Ok(r.changes)
}

/// Drops spooled batches of `queue`, oldest first, until at most `keep`
/// files are left. Returns the files dropped.
pub fn drop_spooled(queue: &Queue, keep: usize) -> u64 {
    let files = queue.pending();
    let mut dropped = 0;
    for f in files.iter().take(files.len().saturating_sub(keep)) {
        // A `.replaying` file is being sent right now; leave it.
        if f.extension().is_some_and(|x| x == "replaying") {
            continue;
        }
        if std::fs::remove_file(f).is_ok() {
            dropped += 1;
        }
    }
    if dropped > 0 {
        tracing::warn!(
            queue = queue.name,
            dropped,
            "disk pressure: spooled batches dropped"
        );
    }
    dropped
}

/// Called with the database id (`<tenant_id>` or `<tenant_id>.<app>`) and
/// the file of a damaged idle file.
pub type OnCorrupt = Arc<dyn Fn(&str, &Path) + Send + Sync>;

/// Whether a database id is open on this node (its cells hold it).
pub type IsOpen = Arc<dyn Fn(&str) -> bool + Send + Sync>;

/// The sweep of idle tenant files under `data_dir`.
pub struct Sweeper {
    pub data_dir: PathBuf,
    pub is_open: IsOpen,
    pub on_corrupt: Option<OnCorrupt>,
    pub retention: Duration,
    pub check_limit: Duration,
}

impl Sweeper {
    /// The tenant files under `data_dir`: `<data_dir>/<database>/app.db`.
    fn files(&self) -> Vec<(String, PathBuf)> {
        let Ok(rd) = std::fs::read_dir(&self.data_dir) else {
            return Vec::new();
        };
        let mut out: Vec<(String, PathBuf)> = rd
            .flatten()
            .filter_map(|e| {
                let name = e.file_name().to_str()?.to_string();
                let file = e.path().join("app.db");
                file.is_file().then_some((name, file))
            })
            .collect();
        out.sort();
        out
    }

    /// One sweep: every file no cell has open is checked and pruned.
    /// Blocking.
    pub fn run(&self, counters: &Counters) {
        counters.sweeps.fetch_add(1, Ordering::Relaxed);
        for (database, file) in self.files() {
            if (self.is_open)(&database) {
                continue;
            }
            counters.files_swept.fetch_add(1, Ordering::Relaxed);
            match integrity::check_file(&file, self.check_limit) {
                Integrity::Corrupt(why) => {
                    counters.files_corrupt.fetch_add(1, Ordering::Relaxed);
                    tracing::error!(%database, finding = %why, "idle tenant file failed its integrity check");
                    if let Some(f) = &self.on_corrupt {
                        f(&database, &file);
                    }
                    continue;
                }
                Integrity::TimedOut => {
                    tracing::warn!(%database, "integrity check of an idle file ran out of time")
                }
                Integrity::Ok => {}
            }
            // A cell may have opened the file since: SQLite's own locking
            // keeps both correct, and the busy timeout covers the overlap.
            if (self.is_open)(&database) {
                continue;
            }
            let opened = TenantDb::open(
                &file,
                DbOptions {
                    readers: 1,
                    ..DbOptions::default()
                },
            );
            match opened {
                Ok(db) => {
                    match prune_dead_letters(&db, now_ms(), self.retention) {
                        Ok(n) => {
                            counters.dead_letters_pruned.fetch_add(n, Ordering::Relaxed);
                        }
                        Err(e) => {
                            tracing::warn!(%database, error = %e, "dead-letter pruning failed")
                        }
                    }
                    if let Err(e) = db.close() {
                        tracing::warn!(%database, error = %e, "closing a swept file failed");
                    }
                }
                Err(e) => tracing::warn!(%database, error = %e, "swept file did not open"),
            }
        }
    }
}

/// The node's pruning: the sweeper, the log volume limit, the counters.
/// Cheap to clone.
#[derive(Clone)]
pub struct Pruning {
    sweeper: Arc<Sweeper>,
    logs_spool: Option<Queue>,
    counters: Arc<Counters>,
    /// One sweep at a time; pressure polls arrive every few seconds.
    running: Arc<Mutex<Option<Instant>>>,
}

impl Pruning {
    pub fn new(sweeper: Sweeper, logs_spool: Option<Queue>, counters: Arc<Counters>) -> Pruning {
        crate::telemetry::counters::register_pruning(counters.clone());
        Pruning {
            sweeper: Arc::new(sweeper),
            logs_spool,
            counters,
            running: Arc::new(Mutex::new(None)),
        }
    }

    pub fn counters(&self) -> Value {
        self.counters.snapshot()
    }

    /// Runs a sweep unless one runs, or ran less than `min_gap` ago.
    /// Blocking. Returns whether it ran.
    pub fn sweep(&self, min_gap: Duration) -> bool {
        {
            let mut last = self.running.lock().expect("pruning lock");
            if last.is_some_and(|t| t.elapsed() < min_gap) {
                return false;
            }
            *last = Some(Instant::now());
        }
        self.sweeper.run(&self.counters);
        tracing::info!(counters = %self.counters.snapshot(), "pruning sweep done");
        true
    }

    /// Disk pressure (`crate::disk`): spooled logs go first, then a sweep
    /// (at most one a minute).
    pub fn on_pressure(&self, level: crate::disk::Level) {
        if let Some(q) = &self.logs_spool {
            let keep = if level >= crate::disk::Level::StopScheduling {
                0
            } else {
                16
            };
            let n = drop_spooled(q, keep);
            self.counters
                .spool_files_dropped
                .fetch_add(n, Ordering::Relaxed);
        }
        self.sweep(Duration::from_secs(60));
    }

    /// Sweeps every [`SWEEP_INTERVAL`] on the current runtime.
    pub fn spawn(&self, every: Duration) -> tokio::task::JoinHandle<()> {
        let me = self.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(every).await;
                let m = me.clone();
                let _ = tokio::task::spawn_blocking(move || m.sweep(Duration::ZERO)).await;
            }
        })
    }
}

/// The per-tenant log volume limit, in front of the node's log sink.
pub struct LogVolume {
    inner: Arc<dyn LogSink>,
    pub bytes_per_window: u64,
    pub window: Duration,
    pub sample_one_in: u64,
    counters: Arc<Counters>,
    tenants: Mutex<HashMap<String, Window>>,
}

struct Window {
    started: Instant,
    bytes: u64,
    /// Lines over the budget in this window.
    over: u64,
    sampled_out: u64,
}

/// 16 MiB per tenant per hour, then one line in 100.
pub const LOG_BYTES_PER_HOUR: u64 = 16 * 1024 * 1024;
pub const LOG_SAMPLE_ONE_IN: u64 = 100;

impl LogVolume {
    pub fn new(inner: Arc<dyn LogSink>, counters: Arc<Counters>) -> LogVolume {
        LogVolume {
            inner,
            bytes_per_window: LOG_BYTES_PER_HOUR,
            window: Duration::from_secs(3600),
            sample_one_in: LOG_SAMPLE_ONE_IN,
            counters,
            tenants: Mutex::new(HashMap::new()),
        }
    }

    fn size(line: &LogLine) -> u64 {
        (line.message.len()
            + line.tenant_id.len()
            + line.deployment_hash.len()
            + line.request_id.as_ref().map_or(0, String::len)
            + serde_json::to_string(&line.fields).map_or(0, |s| s.len())) as u64
    }

    fn summary(line: &LogLine, sampled_out: u64, budget: u64, one_in: u64) -> LogLine {
        let mut fields = serde_json::Map::new();
        fields.insert("reason".into(), "log_volume".into());
        fields.insert("sampled_out".into(), sampled_out.into());
        fields.insert("limit_bytes".into(), budget.into());
        fields.insert("sample_one_in".into(), one_in.into());
        LogLine {
            level: "warn",
            tenant_id: line.tenant_id.clone(),
            deployment_hash: line.deployment_hash.clone(),
            request_id: None,
            message: "log volume limit reached; lines sampled".into(),
            fields,
        }
    }
}

impl LogSink for LogVolume {
    fn log(&self, line: LogLine) {
        let size = Self::size(&line);
        let mut out = Vec::with_capacity(2);
        {
            let mut tenants = self.tenants.lock().expect("log volume lock");
            let w = tenants
                .entry(line.tenant_id.clone())
                .or_insert_with(|| Window {
                    started: Instant::now(),
                    bytes: 0,
                    over: 0,
                    sampled_out: 0,
                });
            if w.started.elapsed() >= self.window {
                if w.sampled_out > 0 {
                    out.push(Self::summary(
                        &line,
                        w.sampled_out,
                        self.bytes_per_window,
                        self.sample_one_in,
                    ));
                }
                *w = Window {
                    started: Instant::now(),
                    bytes: 0,
                    over: 0,
                    sampled_out: 0,
                };
            }
            if w.bytes + size <= self.bytes_per_window {
                w.bytes += size;
                out.push(line);
            } else {
                if w.over == 0 {
                    // The first line over the budget says so at once.
                    out.push(Self::summary(
                        &line,
                        0,
                        self.bytes_per_window,
                        self.sample_one_in,
                    ));
                }
                w.over += 1;
                if w.over.is_multiple_of(self.sample_one_in.max(1)) {
                    out.push(line);
                } else {
                    w.sampled_out += 1;
                    self.counters
                        .log_lines_sampled_out
                        .fetch_add(1, Ordering::Relaxed);
                    self.counters
                        .log_bytes_sampled_out
                        .fetch_add(size, Ordering::Relaxed);
                }
            }
        }
        for l in out {
            self.inner.log(l);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct Capture(Mutex<Vec<LogLine>>);
    impl LogSink for Capture {
        fn log(&self, line: LogLine) {
            self.0.lock().unwrap().push(line);
        }
    }

    fn line(tenant: &str, msg: &str) -> LogLine {
        LogLine {
            level: "info",
            tenant_id: tenant.into(),
            deployment_hash: "h".into(),
            request_id: None,
            message: msg.into(),
            fields: Default::default(),
        }
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "renox-pruning-{}-{name}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// `docs/23-failure-modes.md` "Outbox or logs grow unbounded": past the
    /// per-tenant volume one line in N is kept, another tenant is untouched,
    /// and the counters say how much was sampled out.
    #[test]
    fn log_volume_samples_past_the_limit_per_tenant() {
        let cap = Arc::new(Capture::default());
        let counters = Arc::new(Counters::default());
        let mut v = LogVolume::new(cap.clone(), counters.clone());
        let one = LogVolume::size(&line("t_a", "0123456789"));
        v.bytes_per_window = one * 10;
        v.sample_one_in = 10;
        for _ in 0..110 {
            v.log(line("t_a", "0123456789"));
        }
        v.log(line("t_b", "0123456789"));
        let lines = cap.0.lock().unwrap();
        let a: Vec<_> = lines.iter().filter(|l| l.tenant_id == "t_a").collect();
        // 10 within the budget, one notice, then 1 in 10 of the 100 over it.
        assert_eq!(a.iter().filter(|l| l.message == "0123456789").count(), 20);
        assert_eq!(
            a.iter()
                .filter(|l| l.fields.get("reason").is_some_and(|r| r == "log_volume"))
                .count(),
            1
        );
        assert_eq!(lines.iter().filter(|l| l.tenant_id == "t_b").count(), 1);
        assert_eq!(counters.log_lines_sampled_out.load(Ordering::Relaxed), 90);
        assert_eq!(
            counters.log_bytes_sampled_out.load(Ordering::Relaxed),
            90 * one
        );
    }

    #[test]
    fn a_new_window_reports_what_was_sampled_and_starts_over() {
        let cap = Arc::new(Capture::default());
        let counters = Arc::new(Counters::default());
        let mut v = LogVolume::new(cap.clone(), counters);
        v.bytes_per_window = LogVolume::size(&line("t", "x"));
        v.window = Duration::from_millis(30);
        v.sample_one_in = 1_000;
        for _ in 0..5 {
            v.log(line("t", "x"));
        }
        std::thread::sleep(Duration::from_millis(40));
        v.log(line("t", "x"));
        let lines = cap.0.lock().unwrap();
        let summary = lines
            .iter()
            .find(|l| l.fields.get("sampled_out").is_some_and(|n| n == 4))
            .expect("the window's summary");
        assert_eq!(summary.level, "warn");
        assert_eq!(
            lines.last().unwrap().message,
            "x",
            "the new window logs again"
        );
    }

    fn dead_letters(db: &TenantDb, ages_ms: &[i64]) {
        for (i, age) in ages_ms.iter().enumerate() {
            db.with_policy(None, || {
                db.execute(
                    "insert into renox__outbox_dead \
                     (id, target, name, payload, module, created_at, attempts, next_at, last_error, dead_at) \
                     values (?, 'm', 'a.b', '{}', 'a', 0, 5, 0, 'x', ?)",
                    &[format!("e{i}").into(), (now_ms() - age).into()],
                )
            })
            .unwrap()
            .unwrap();
        }
    }

    fn dead_count(file: &Path) -> i64 {
        let db = TenantDb::open(file, DbOptions::default()).unwrap();
        let n = match db
            .query_one("select count(*) as n from renox__outbox_dead", &[])
            .unwrap()
            .unwrap()
            .get("n")
        {
            Some(renox_data::Value::Integer(n)) => *n,
            other => panic!("{other:?}"),
        };
        db.close().unwrap();
        n
    }

    /// Same row: dead letters older than 7 days are pruned by the sweep of
    /// an idle file, newer ones stay, and an open file is left alone.
    #[test]
    fn sweep_prunes_old_dead_letters_of_idle_files_only() {
        let data = scratch("sweep");
        let day = 24 * 3600 * 1000;
        for t in ["t_idle", "t_open"] {
            std::fs::create_dir_all(data.join(t)).unwrap();
            let db = TenantDb::open(data.join(t).join("app.db"), DbOptions::default()).unwrap();
            dead_letters(&db, &[day, 6 * day, 8 * day, 30 * day]);
            db.close().unwrap();
        }
        let counters = Counters::default();
        let sweeper = Sweeper {
            data_dir: data.clone(),
            is_open: Arc::new(|db| db == "t_open"),
            on_corrupt: None,
            retention: DEAD_LETTER_RETENTION,
            check_limit: SWEEP_CHECK_LIMIT,
        };
        sweeper.run(&counters);
        assert_eq!(dead_count(&data.join("t_idle/app.db")), 2);
        assert_eq!(dead_count(&data.join("t_open/app.db")), 4);
        let c = counters.snapshot();
        assert_eq!(c["dead_letters_pruned"], 2);
        assert_eq!(c["files_swept"], 1);
        assert_eq!(c["files_corrupt"], 0);
    }

    /// `docs/23-failure-modes.md` "SQLite file corrupted, WAL unreadable":
    /// the sweep finds a damaged idle file and hands it to the restore.
    #[test]
    fn sweep_hands_a_damaged_idle_file_to_the_restore() {
        let data = scratch("corrupt");
        std::fs::create_dir_all(data.join("t_bad")).unwrap();
        std::fs::write(data.join("t_bad/app.db"), vec![0xAB; 8192]).unwrap();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let s = seen.clone();
        let counters = Counters::default();
        Sweeper {
            data_dir: data.clone(),
            is_open: Arc::new(|_| false),
            on_corrupt: Some(Arc::new(move |db, _file| {
                s.lock().unwrap().push(db.to_string())
            })),
            retention: DEAD_LETTER_RETENTION,
            check_limit: SWEEP_CHECK_LIMIT,
        }
        .run(&counters);
        assert_eq!(*seen.lock().unwrap(), vec!["t_bad".to_string()]);
        assert_eq!(counters.snapshot()["files_corrupt"], 1);
    }

    /// Disk pressure drops spooled logs oldest first and counts them;
    /// at `stop_scheduling` all of them.
    #[test]
    fn pressure_drops_spooled_logs_oldest_first() {
        let data = scratch("spool");
        let q = Queue::logs(&data);
        std::fs::create_dir_all(&q.dir).unwrap();
        for i in 0..20 {
            std::fs::write(q.dir.join(format!("{:013}.ndjson", 1_000 + i)), b"{}\n").unwrap();
        }
        let counters = Arc::new(Counters::default());
        let p = Pruning::new(
            Sweeper {
                data_dir: data.join("none"),
                is_open: Arc::new(|_| false),
                on_corrupt: None,
                retention: DEAD_LETTER_RETENTION,
                check_limit: SWEEP_CHECK_LIMIT,
            },
            Some(q.clone()),
            counters.clone(),
        );
        p.on_pressure(crate::disk::Level::Warn);
        let left = q.pending();
        assert_eq!(left.len(), 16);
        assert!(left[0].ends_with("0000000001004.ndjson"), "{left:?}");
        p.on_pressure(crate::disk::Level::StopScheduling);
        assert!(q.pending().is_empty());
        assert_eq!(p.counters()["spool_files_dropped"], 20);
        assert_eq!(p.counters()["sweeps"], 1, "one sweep a minute at most");
    }
}
