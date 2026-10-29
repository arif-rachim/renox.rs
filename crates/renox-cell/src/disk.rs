//! Node disk watermarks (#103, `docs/23-failure-modes.md` "Disk full on
//! node"): the data directory's file system is polled, and each level
//! changes what the node accepts.
//!
//! | Used | Level | The node |
//! | --- | --- | --- |
//! | < 80 % | `ok` | serves everything |
//! | ≥ 80 % | `warn` | serves everything; `/healthz` reports `disk` degraded; pruning runs |
//! | ≥ 90 % | `stop_scheduling` | no new cell: a request for a tenant whose file is not open answers 503 `RENOX_UNAVAILABLE` |
//! | ≥ 95 % | `refuse_writes` | also every request that is not `GET`, `HEAD` or `OPTIONS` answers 503 `RENOX_UNAVAILABLE` |
//!
//! The refusals and the pressure pruning apply in `controlled` mode (a
//! production node); in `local` mode (`renox dev`, tests, a laptop whose
//! disk is simply full) the levels are only reported
//! ([`DiskMonitor::set_enforcing`]).
//!
//! A level is left only when usage falls two points below its threshold,
//! so a node near a threshold does not flap. The level goes to the
//! operator through `/healthz` (`disk: <level> <pct>% used`, `Health`);
//! the heartbeat has no field for it yet (`control-messages.schema.json`
//! `heartbeat` is closed), so the control plane's placement reads it from
//! there once the contract has one.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU8, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::control::health::Health;

/// How often the file system is polled.
pub const POLL_INTERVAL: Duration = Duration::from_secs(5);

/// Points below a threshold usage must fall before its level is left.
const HYSTERESIS_PCT: f64 = 2.0;

/// The three thresholds, in percent of the file system's size.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Watermarks {
    pub warn_pct: f64,
    pub stop_pct: f64,
    pub refuse_pct: f64,
}

impl Default for Watermarks {
    fn default() -> Self {
        Watermarks {
            warn_pct: 80.0,
            stop_pct: 90.0,
            refuse_pct: 95.0,
        }
    }
}

/// What the node accepts at the current usage.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Level {
    Ok = 0,
    Warn = 1,
    StopScheduling = 2,
    RefuseWrites = 3,
}

impl Level {
    pub fn as_str(self) -> &'static str {
        match self {
            Level::Ok => "ok",
            Level::Warn => "warn",
            Level::StopScheduling => "stop_scheduling",
            Level::RefuseWrites => "refuse_writes",
        }
    }

    fn from_u8(v: u8) -> Level {
        match v {
            1 => Level::Warn,
            2 => Level::StopScheduling,
            3 => Level::RefuseWrites,
            _ => Level::Ok,
        }
    }
}

impl Watermarks {
    /// The level at `used_pct`, coming from `current` (hysteresis).
    pub fn level(&self, used_pct: f64, current: Level) -> Level {
        let raw = |pct: f64| {
            if pct >= self.refuse_pct {
                Level::RefuseWrites
            } else if pct >= self.stop_pct {
                Level::StopScheduling
            } else if pct >= self.warn_pct {
                Level::Warn
            } else {
                Level::Ok
            }
        };
        let up = raw(used_pct);
        if up >= current {
            return up;
        }
        // Going down: only as far as the usage is clear of each threshold.
        raw(used_pct + HYSTERESIS_PCT).min(current)
    }
}

/// Size and free space of a file system, in bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Usage {
    pub total: u64,
    /// Available to an unprivileged writer (`f_bavail`).
    pub available: u64,
}

impl Usage {
    pub fn used_pct(&self) -> f64 {
        if self.total == 0 {
            return 0.0;
        }
        100.0 * (self.total.saturating_sub(self.available)) as f64 / self.total as f64
    }
}

/// `statvfs(2)` of the file system holding `path`. Linux with glibc only
/// (where `libc` is a dependency, `src/alloc.rs`); elsewhere it answers
/// `Unsupported` and the level stays `ok` (development hosts).
#[cfg(all(target_os = "linux", target_env = "gnu"))]
// The `statvfs` fields are C typedefs whose width depends on the target.
#[allow(clippy::unnecessary_cast)]
pub fn usage(path: &Path) -> std::io::Result<Usage> {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(path.as_os_str().as_bytes())
        .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    let mut s = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    // SAFETY: `c` is a valid NUL-terminated path and `s` points to writable
    // memory of the size of `statvfs`, which the call fills in; it is read
    // only after the call reported success.
    let rc = unsafe { libc::statvfs(c.as_ptr(), s.as_mut_ptr()) };
    if rc != 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: initialised by the successful call above.
    let s = unsafe { s.assume_init() };
    let frsize = s.f_frsize as u64;
    Ok(Usage {
        total: (s.f_blocks as u64).saturating_mul(frsize),
        available: (s.f_bavail as u64).saturating_mul(frsize),
    })
}

#[cfg(not(all(target_os = "linux", target_env = "gnu")))]
pub fn usage(_path: &Path) -> std::io::Result<Usage> {
    Err(std::io::Error::from(std::io::ErrorKind::Unsupported))
}

/// Why a request is refused at the current level.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// No new cell at `stop_scheduling` and above.
    NewCell,
    /// No write at `refuse_writes`.
    Write,
}

type Probe = Box<dyn Fn() -> std::io::Result<Usage> + Send + Sync>;
type OnLevel = Box<dyn Fn(Level) + Send + Sync>;

/// The node's disk level. Cheap to clone.
#[derive(Clone)]
pub struct DiskMonitor {
    inner: Arc<Inner>,
}

struct Inner {
    path: PathBuf,
    watermarks: Watermarks,
    probe: Probe,
    level: AtomicU8,
    /// The refusals apply (controlled mode); otherwise levels are reported only.
    enforcing: std::sync::atomic::AtomicBool,
    /// Last usage in hundredths of a percent.
    used_centi_pct: AtomicU64,
    /// Level changes since start (metrics, tests).
    changes: AtomicU64,
    health: Option<Arc<Health>>,
    /// Called on each poll at `warn` or above (pruning).
    on_pressure: Mutex<Vec<OnLevel>>,
}

impl DiskMonitor {
    /// A monitor of the file system that holds `path`.
    pub fn new(path: &Path, watermarks: Watermarks, health: Option<Arc<Health>>) -> DiskMonitor {
        let p = path.to_path_buf();
        Self::with_probe(path, watermarks, health, Box::new(move || usage(&p)))
    }

    /// A monitor with its own usage source (tests).
    pub fn with_probe(
        path: &Path,
        watermarks: Watermarks,
        health: Option<Arc<Health>>,
        probe: Probe,
    ) -> DiskMonitor {
        DiskMonitor {
            inner: Arc::new(Inner {
                path: path.to_path_buf(),
                watermarks,
                probe,
                level: AtomicU8::new(Level::Ok as u8),
                enforcing: std::sync::atomic::AtomicBool::new(true),
                used_centi_pct: AtomicU64::new(0),
                changes: AtomicU64::new(0),
                health,
                on_pressure: Mutex::new(Vec::new()),
            }),
        }
    }

    /// Runs `f` on every poll that finds `warn` or above.
    pub fn on_pressure(&self, f: impl Fn(Level) + Send + Sync + 'static) {
        self.inner
            .on_pressure
            .lock()
            .expect("disk lock")
            .push(Box::new(f));
    }

    /// Whether [`Self::refuses`] refuses anything and the pressure
    /// callbacks run (default: yes).
    pub fn set_enforcing(&self, on: bool) {
        self.inner.enforcing.store(on, Ordering::SeqCst);
    }

    pub fn level(&self) -> Level {
        Level::from_u8(self.inner.level.load(Ordering::SeqCst))
    }

    /// Usage at the last poll, in percent.
    pub fn used_pct(&self) -> f64 {
        self.inner.used_centi_pct.load(Ordering::SeqCst) as f64 / 100.0
    }

    /// Level changes since start.
    pub fn changes(&self) -> u64 {
        self.inner.changes.load(Ordering::SeqCst)
    }

    /// Polls now and returns the level. A failing probe keeps the level
    /// (logged): a node does not stop serving because `statvfs` failed once.
    pub fn poll(&self) -> Level {
        let usage = match (self.inner.probe)() {
            Ok(u) => u,
            Err(e) => {
                tracing::warn!(path = %self.inner.path.display(), error = %e, "disk usage unreadable");
                return self.level();
            }
        };
        let pct = usage.used_pct();
        self.inner
            .used_centi_pct
            .store((pct * 100.0).round() as u64, Ordering::SeqCst);
        let before = self.level();
        let after = self.inner.watermarks.level(pct, before);
        if after != before {
            self.inner.level.store(after as u8, Ordering::SeqCst);
            self.inner.changes.fetch_add(1, Ordering::SeqCst);
            if after > before {
                tracing::error!(
                    level = after.as_str(),
                    used_pct = pct,
                    available = usage.available,
                    "disk watermark reached"
                );
            } else {
                tracing::warn!(
                    level = after.as_str(),
                    used_pct = pct,
                    "disk watermark cleared"
                );
            }
        }
        if let Some(h) = &self.inner.health {
            if after == Level::Ok {
                h.recover("disk");
            } else {
                h.degrade(
                    "disk",
                    format!("{} {:.0}% used", after.as_str(), pct.floor()),
                );
            }
        }
        if after >= Level::Warn && self.inner.enforcing.load(Ordering::SeqCst) {
            for f in self.inner.on_pressure.lock().expect("disk lock").iter() {
                f(after);
            }
        }
        after
    }

    /// Polls every `every` on the current runtime.
    pub fn spawn(&self, every: Duration) -> tokio::task::JoinHandle<()> {
        let me = self.clone();
        tokio::spawn(async move {
            loop {
                let m = me.clone();
                // `statvfs` and the pruning callbacks block.
                let _ = tokio::task::spawn_blocking(move || m.poll()).await;
                tokio::time::sleep(every).await;
            }
        })
    }

    /// Whether a request is refused now: `method` is the HTTP method and
    /// `warm` says the tenant's file is already open on this node.
    pub fn refuses(&self, method: &http::Method, warm: bool) -> Option<Refusal> {
        if !self.inner.enforcing.load(Ordering::SeqCst) {
            return None;
        }
        let level = self.level();
        let safe = matches!(
            *method,
            http::Method::GET | http::Method::HEAD | http::Method::OPTIONS
        );
        if level >= Level::RefuseWrites && !safe {
            return Some(Refusal::Write);
        }
        if level >= Level::StopScheduling && !warm {
            return Some(Refusal::NewCell);
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU64;

    fn monitor(pct: Arc<AtomicU64>, health: Option<Arc<Health>>) -> DiskMonitor {
        DiskMonitor::with_probe(
            Path::new("/"),
            Watermarks::default(),
            health,
            Box::new(move || {
                let used = pct.load(Ordering::SeqCst);
                Ok(Usage {
                    total: 10_000,
                    available: 10_000 - used * 100,
                })
            }),
        )
    }

    /// `docs/23-failure-modes.md` "Disk full on node": each watermark and
    /// what the node refuses at it.
    #[test]
    fn each_watermark_refuses_what_it_documents() {
        let pct = Arc::new(AtomicU64::new(50));
        let health = Arc::new(Health::default());
        let m = monitor(pct.clone(), Some(health.clone()));
        let post = http::Method::POST;
        let get = http::Method::GET;

        assert_eq!(m.poll(), Level::Ok);
        assert_eq!(m.refuses(&post, false), None);
        assert!(!health.has("disk"));

        pct.store(80, Ordering::SeqCst);
        assert_eq!(m.poll(), Level::Warn);
        assert_eq!(m.refuses(&post, false), None);
        assert!(health.reasons().iter().any(|r| r == "disk: warn 80% used"));

        pct.store(90, Ordering::SeqCst);
        assert_eq!(m.poll(), Level::StopScheduling);
        assert_eq!(m.refuses(&get, false), Some(Refusal::NewCell));
        assert_eq!(m.refuses(&post, true), None, "a warm tenant still writes");

        pct.store(96, Ordering::SeqCst);
        assert_eq!(m.poll(), Level::RefuseWrites);
        assert_eq!(m.refuses(&post, true), Some(Refusal::Write));
        assert_eq!(m.refuses(&http::Method::DELETE, true), Some(Refusal::Write));
        assert_eq!(m.refuses(&get, true), None, "reads continue");
        assert_eq!(m.refuses(&http::Method::HEAD, true), None);
        m.set_enforcing(false);
        assert_eq!(m.refuses(&post, false), None, "local mode reports only");
        m.set_enforcing(true);

        pct.store(10, Ordering::SeqCst);
        assert_eq!(m.poll(), Level::Ok);
        assert!(!health.has("disk"));
        assert_eq!(m.changes(), 4);
    }

    #[test]
    fn a_level_is_left_two_points_below_its_threshold() {
        let w = Watermarks::default();
        assert_eq!(w.level(90.0, Level::Ok), Level::StopScheduling);
        assert_eq!(w.level(89.0, Level::StopScheduling), Level::StopScheduling);
        assert_eq!(w.level(87.9, Level::StopScheduling), Level::Warn);
        assert_eq!(w.level(94.0, Level::RefuseWrites), Level::RefuseWrites);
        assert_eq!(w.level(92.5, Level::RefuseWrites), Level::StopScheduling);
        assert_eq!(w.level(50.0, Level::RefuseWrites), Level::Ok);
    }

    #[test]
    fn pressure_callbacks_run_at_warn_and_above() {
        let pct = Arc::new(AtomicU64::new(50));
        let m = monitor(pct.clone(), None);
        let calls = Arc::new(AtomicU64::new(0));
        let c = calls.clone();
        m.on_pressure(move |_| {
            c.fetch_add(1, Ordering::SeqCst);
        });
        m.poll();
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        pct.store(85, Ordering::SeqCst);
        m.poll();
        m.poll();
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        m.set_enforcing(false);
        m.poll();
        assert_eq!(calls.load(Ordering::SeqCst), 2, "local mode reports only");
    }

    #[test]
    fn a_failing_probe_keeps_the_level() {
        let m = DiskMonitor::with_probe(
            Path::new("/"),
            Watermarks::default(),
            None,
            Box::new(|| Err(std::io::Error::other("gone"))),
        );
        assert_eq!(m.poll(), Level::Ok);
    }

    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    #[test]
    fn statvfs_reads_the_root_file_system() {
        let u = usage(Path::new("/")).unwrap();
        assert!(u.total > 0 && u.available <= u.total, "{u:?}");
    }
}
