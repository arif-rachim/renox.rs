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
static SECURITY: LazyLock<Mutex<BTreeMap<(String, &'static str), u64>>> =
    LazyLock::new(Mutex::default);
static GATEWAY_RATE_LIMITED: OnceLock<Box<dyn Fn() -> u64 + Send + Sync>> = OnceLock::new();
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

/// The kinds of `renox_security_events_total` (#659, `docs/24` "Security
/// events not visible to operators").
pub const SECURITY_KINDS: [&str; 5] = [
    "fetch_denied",
    "db_auth_refused",
    "csrf_failed",
    "rate_limited",
    "login_failed",
];

/// `n` security events of `kind` for `tenant` (#659). `kind` is one of
/// [`SECURITY_KINDS`]: a fixed word, never tenant text.
pub fn security_events(tenant: &str, kind: &'static str, n: u64) {
    debug_assert!(SECURITY_KINDS.contains(&kind), "{kind}");
    if n == 0 {
        return;
    }
    *SECURITY
        .lock()
        .expect("counters lock")
        .entry((tenant.to_string(), kind))
        .or_default() += n;
}

/// One security event of `kind` for `tenant` (#659).
pub fn security_event(tenant: &str, kind: &'static str) {
    security_events(tenant, kind, 1);
}

/// The gateway's rate-limited count (it refuses before any tenant is known,
/// so it has no tenant label), read at scrape time. Only the first call has
/// an effect.
pub fn register_gateway_rate_limited(read: impl Fn() -> u64 + Send + Sync + 'static) {
    let _ = GATEWAY_RATE_LIMITED.set(Box::new(read));
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
    pub security: BTreeMap<(String, &'static str), u64>,
    pub gateway_rate_limited: u64,
    pub db_unavailable: u64,
    pub log_lines_sampled_out: u64,
}

pub fn view() -> View {
    View {
        restarts: RESTARTS.lock().expect("counters lock").clone(),
        denials: DENIALS.lock().expect("counters lock").clone(),
        lags: LAGS.lock().expect("counters lock").clone(),
        security: SECURITY.lock().expect("counters lock").clone(),
        gateway_rate_limited: GATEWAY_RATE_LIMITED.get().map_or(0, |f| f()),
        db_unavailable: DB_UNAVAILABLE.load(Ordering::Relaxed),
        log_lines_sampled_out: PRUNING
            .get()
            .map_or(0, |c| c.log_lines_sampled_out.load(Ordering::Relaxed)),
    }
}
