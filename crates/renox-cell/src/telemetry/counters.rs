//! Node-wide counters that live where their events happen, for the metric
//! families of `ops/observability/README.md` that #295 left pending: a
//! sandboxed child killed by seccomp, a per-tenant child restart, the lag
//! of the last replication status computed, the databases being restored
//! after damage, and the log lines the volume limit sampled out.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex, OnceLock};

static RESTARTS: LazyLock<Mutex<BTreeMap<String, u64>>> = LazyLock::new(Mutex::default);
static DENIALS: LazyLock<Mutex<BTreeMap<&'static str, u64>>> = LazyLock::new(Mutex::default);
static LAGS: LazyLock<Mutex<BTreeMap<(String, String), f64>>> = LazyLock::new(Mutex::default);
static DB_UNAVAILABLE: AtomicU64 = AtomicU64::new(0);
static PRUNING: OnceLock<Arc<crate::pruning::Counters>> = OnceLock::new();

/// A tenant's child process exited and will be restarted (#254).
pub fn process_restarted(tenant: &str) {
    *RESTARTS
        .lock()
        .expect("counters lock")
        .entry(tenant.to_string())
        .or_default() += 1;
}

/// A sandbox denial the node can see: `seccomp` is a child killed by
/// `SECCOMP_RET_KILL_PROCESS` (SIGSYS, #253). Landlock refusals are an
/// `EACCES` inside the process and are not counted.
pub fn sandbox_denied(kind: &'static str) {
    *DENIALS
        .lock()
        .expect("counters lock")
        .entry(kind)
        .or_default() += 1;
}

/// The lag of the last `replication_status` computed for a database (#255).
pub fn replication_lag(tenant: &str, database: &str, seconds: f64) {
    LAGS.lock()
        .expect("counters lock")
        .insert((tenant.to_string(), database.to_string()), seconds);
}

/// The number of databases being restored after damage (#103), set by the
/// replication module whenever its set changes.
pub fn set_db_unavailable(n: usize) {
    DB_UNAVAILABLE.store(n as u64, Ordering::Relaxed);
}

/// The node's pruning counters (#103), registered once by `Pruning::new`.
pub fn register_pruning(c: Arc<crate::pruning::Counters>) {
    let _ = PRUNING.set(c);
}

/// What the metrics endpoint renders.
pub struct View {
    pub restarts: BTreeMap<String, u64>,
    pub denials: BTreeMap<&'static str, u64>,
    pub lags: BTreeMap<(String, String), f64>,
    pub db_unavailable: u64,
    pub log_lines_sampled_out: u64,
}

pub fn view() -> View {
    View {
        restarts: RESTARTS.lock().expect("counters lock").clone(),
        denials: DENIALS.lock().expect("counters lock").clone(),
        lags: LAGS.lock().expect("counters lock").clone(),
        db_unavailable: DB_UNAVAILABLE.load(Ordering::Relaxed),
        log_lines_sampled_out: PRUNING
            .get()
            .map_or(0, |c| c.log_lines_sampled_out.load(Ordering::Relaxed)),
    }
}
