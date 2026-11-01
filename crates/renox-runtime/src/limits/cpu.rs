//! CPU limit per request (`docs/contracts/ops.md` section 10): the isolate
//! thread's CPU clock plus a watchdog thread that terminates JavaScript when
//! the running request would go over its limit.
//!
//! Accounting (#155): the isolate thread runs JavaScript only inside its
//! loop's poll ("a slice"). Within a slice, [`CpuLedger`] charges each run of
//! JavaScript to the request whose async context it runs in: the isolate
//! sets V8's continuation-preserved embedder data to the request's token
//! when it calls the handler, V8 carries it through every `await`, op and
//! timer of that request, and a promise hook reports each switch. CPU that
//! runs in no request's context (platform glue between reactions) is split
//! evenly among the requests in flight; with one request in flight that is
//! exact, as before. The watchdog's budget follows the running context:
//! the running request's own remaining CPU, or for unattributed work the
//! smallest remaining CPU among the requests in flight (the per-request
//! limit with none in flight), so no run of JavaScript can take any request
//! over its limit unseen.
//!
//! macOS (#212). Measured on a spinning thread (Darwin 21.6, x86_64; the
//! probe is in the PR): a thread's own `thread_info(THREAD_BASIC_INFO)` read
//! is exact (it agrees with `clock_gettime(CLOCK_THREAD_CPUTIME_ID)` to the
//! microsecond), but the **same call from another thread lags in a
//! sawtooth**: the value freezes for several milliseconds while wall time
//! advances, then jumps when the kernel folds the running interval into the
//! thread's timers at a scheduler event. The lag was 5-7 ms at its peak
//! here and up to 11 ms on the CI runner. So:
//!
//! - [`CpuLedger`], which reads the clock on the isolate thread itself,
//!   is accurate and uses the raw reading. Wall-correcting it (as an
//!   earlier version did) charged genuine preemption, 1-3 ms per 50 ms
//!   here, to whichever request happened to be running.
//! - The watchdog, which reads the clock from its own thread, estimates
//!   the run's CPU as `last_cpu_delta + wall_since_last_cpu_delta_change`
//!   ([`RunEstimate`]): the last value the kernel published plus the wall
//!   time since it was published, which assumes the thread kept running
//!   since then, true within a slice. Against the thread's own exact reads
//!   this was within -1.5 ms (one watchdog sample) and +0.4 ms (preemption
//!   since the last publish), where the raw reading was up to 4.8 ms behind
//!   and wall time alone up to 2.8 ms ahead.
//! - Once the watchdog has fired, [`CpuWatch::now_ns`] clamps the isolate
//!   thread's readings to `[fired_at, fired_at + TERMINATION_TAIL_NS]`, so
//!   the killed request is billed between its limit and the limit plus the
//!   ± 5 ms termination tail of `docs/contracts/ops.md` section 10 whatever
//!   V8's unwind costs (5-7 ms of CPU was seen on macOS ARM).
//!
//! Linux's `CLOCK_THREAD_CPUTIME_ID` is current for a running thread read
//! from another thread, so the estimator and the clamp are no-ops there.
//!
//! What the clock counts on a virtual machine (#342): the thread CPU clock
//! is the guest kernel's view. A KVM guest whose host does not report steal
//! time (no `kvm-stealtime` at boot, `/proc/stat` steal always 0) and whose
//! kernel lacks `CONFIG_PARAVIRT_TIME_ACCOUNTING` counts the time the host
//! takes its vCPU away as CPU of the thread that was running. On `node-small`
//! that is 3.5 s per vCPU-minute, in stalls of up to 48–66 ms, mostly on one
//! vCPU at a time; a cold `shop` request that ran 8.6 ms of guest cycles was
//! charged up to 38.8 ms (`bench/results/2026-10-31-cold-request-cpu-node-small.md`).
//! Nothing inside the guest tells such a stall from a spinning tenant, so
//! the charge stays whole and the limit stays the limit. What the worker
//! does control is how long a request is exposed: the first run of the
//! request path is platform work and runs at isolate creation
//! (`isolate.rs`, `warm_request_path`), not in the tenant's first request.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

/// How often the watchdog samples the running slice.
pub const WATCHDOG_INTERVAL: Duration = Duration::from_millis(1);

const IDLE: u64 = u64::MAX;

/// On macOS, how far past `fired_at` [`CpuWatch::now_ns`] lets the isolate
/// thread's readings go once the watchdog has fired: the ± 5 ms termination
/// tail of `docs/contracts/ops.md` section 10 (#212). V8 keeps using CPU
/// between `TerminateExecution` and its next interrupt check; 5-7 ms was
/// seen on macOS ARM, which without the clamp billed 57.7 ms against a 50 ms
/// limit.
#[cfg(target_os = "macos")]
const TERMINATION_TAIL_NS: u64 = 5_000_000;

/// Upper bound of `cpu_ms` returned by [`CpuLedger::release`], added to the
/// request's limit (`limit + 5 ms`). Guards against the small
/// over-count that can slip past the per-run cap: pre-fire charges, the
/// ± 5 ms termination tail, and `used.div_ceil(n)` rounding in
/// [`CpuLedger::flush`] when unattributed CPU is split across concurrent
/// requests (#212, macos-15 ARM saw 55.017 ms without this clamp).
const RELEASE_TAIL_NS: u64 = 5_000_000;

/// The CPU clock of one thread, readable from any thread. Linux:
/// `CLOCK_THREAD_CPUTIME_ID` of that thread (`pthread_getcpuclockid`).
/// macOS (#139): the thread's Mach port and `thread_info(THREAD_BASIC_INFO)`,
/// `user_time + system_time`, at microsecond resolution. Exact when the
/// thread reads its own clock; read from another thread it lags by up to a
/// scheduler quantum for a running thread, which the watchdog compensates
/// for with [`RunEstimate`] (#212, module docs).
#[derive(Debug, Clone)]
pub struct ThreadCpuClock {
    clock: imp::Clock,
}

impl ThreadCpuClock {
    /// The clock of the calling thread.
    pub fn current() -> std::io::Result<ThreadCpuClock> {
        Ok(ThreadCpuClock {
            clock: imp::Clock::current()?,
        })
    }

    /// CPU time consumed by the thread so far. Returns `None` once the
    /// thread has exited.
    pub fn now(&self) -> Option<Duration> {
        self.clock.now()
    }
}

#[cfg(any(target_os = "linux", target_os = "android"))]
mod imp {
    use std::time::Duration;

    #[derive(Debug, Clone, Copy)]
    pub struct Clock {
        clock: libc::clockid_t,
    }

    impl Clock {
        pub fn current() -> std::io::Result<Clock> {
            let mut clock: libc::clockid_t = 0;
            // SAFETY: `pthread_self()` is always a valid handle for the calling
            // thread, and `clock` is a valid out-pointer for the duration of the
            // call. The function only writes a clock id; it has no other effect.
            let rc = unsafe { libc::pthread_getcpuclockid(libc::pthread_self(), &mut clock) };
            if rc != 0 {
                return Err(std::io::Error::from_raw_os_error(rc));
            }
            Ok(Clock { clock })
        }

        /// The kernel reports `EINVAL` once the thread has exited.
        pub fn now(&self) -> Option<Duration> {
            let mut ts = libc::timespec {
                tv_sec: 0,
                tv_nsec: 0,
            };
            // SAFETY: `ts` is a valid out-pointer; `clock_gettime` with a clock
            // id from `pthread_getcpuclockid` reads that thread's CPU time and
            // fails with EINVAL (no UB) if the thread no longer exists.
            let rc = unsafe { libc::clock_gettime(self.clock, &mut ts) };
            (rc == 0).then(|| Duration::new(ts.tv_sec as u64, ts.tv_nsec as u32))
        }
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use std::sync::Arc;
    use std::time::Duration;

    // <mach/mach_init.h>, <mach/mach_port.h>. `libc` deprecates its own
    // declarations of the first two in favour of the `mach2` crate and lacks
    // the third; three symbols do not warrant a dependency.
    unsafe extern "C" {
        static mach_task_self_: libc::mach_port_t;
        fn mach_thread_self() -> libc::mach_port_t;
        fn mach_port_deallocate(
            task: libc::mach_port_t,
            name: libc::mach_port_t,
        ) -> libc::kern_return_t;
    }

    /// A send right to the thread's kernel port, owned by this value. While
    /// it is held the port name cannot be reused for another thread: once
    /// the thread exits it turns into a dead name and `thread_info` fails.
    #[derive(Debug)]
    struct Port(libc::mach_port_t);

    impl Drop for Port {
        fn drop(&mut self) {
            // SAFETY: `mach_task_self_` is set before `main` and never
            // changes; `self.0` is the send right `mach_thread_self` gave
            // this value, released exactly once here.
            unsafe { mach_port_deallocate(mach_task_self_, self.0) };
        }
    }

    #[derive(Debug, Clone)]
    pub struct Clock {
        port: Arc<Port>,
    }

    impl Clock {
        pub fn current() -> std::io::Result<Clock> {
            // SAFETY: no arguments; returns the calling thread's port with a
            // new send-right reference, which `Port` releases on drop.
            let port = unsafe { mach_thread_self() };
            if port == 0 {
                return Err(std::io::Error::other(
                    "mach_thread_self returned MACH_PORT_NULL",
                ));
            }
            Ok(Clock {
                port: Arc::new(Port(port)),
            })
        }

        /// `thread_info` fails (no UB) once the port is a dead name.
        pub fn now(&self) -> Option<Duration> {
            // SAFETY: an all-zero `thread_basic_info` is a valid value (plain
            // integers).
            let mut info: libc::thread_basic_info = unsafe { std::mem::zeroed() };
            let mut count = libc::THREAD_BASIC_INFO_COUNT;
            // SAFETY: `info` is a valid out-buffer of `count` integers for the
            // THREAD_BASIC_INFO flavor, and the port is held by `self.port`.
            let rc = unsafe {
                libc::thread_info(
                    self.port.0,
                    libc::THREAD_BASIC_INFO as libc::thread_flavor_t,
                    (&mut info as *mut libc::thread_basic_info).cast(),
                    &mut count,
                )
            };
            if rc != libc::KERN_SUCCESS {
                return None;
            }
            let t = |v: libc::time_value_t| {
                Duration::from_secs(v.seconds as u64) + Duration::from_micros(v.microseconds as u64)
            };
            Some(t(info.user_time) + t(info.system_time))
        }
    }
}

/// State shared by the isolate thread and its watchdog.
pub struct CpuWatch {
    clock: ThreadCpuClock,
    /// Reference point of [`CpuWatch::wall_ns`]. Fixed at construction;
    /// `Instant` is monotonic and cannot run backwards on either OS.
    wall_origin: Instant,
    /// Thread CPU time (ns) when the current slice started, or `IDLE`.
    slice_start_ns: AtomicU64,
    /// Wall time (ns since [`CpuWatch::wall_origin`]) when the current run
    /// started; with `slice_start_ns` it identifies the run for the
    /// watchdog's [`RunEstimate`] (#212).
    wall_start_ns: AtomicU64,
    /// CPU (ns) the current run may use before the watchdog fires.
    budget_ns: AtomicU64,
    /// Seqlock over (`slice_start_ns`, `wall_start_ns`, `budget_ns`): odd
    /// while the isolate thread rewrites the triple, so the watchdog never
    /// pairs a new start with an old budget.
    seq: AtomicU64,
    fired: AtomicBool,
    /// `cpu_start + budget` of the run the watchdog fired on: the thread CPU
    /// at which the running request reached its limit. `IDLE` until then;
    /// written once by the watchdog thread and never reset (the isolate is
    /// disposed after a fire). On macOS [`CpuWatch::now_ns`] clamps later
    /// readings to `[fired_at_ns, fired_at_ns + TERMINATION_TAIL_NS]` (#212).
    fired_at_ns: AtomicU64,
    stop: AtomicBool,
}

impl CpuWatch {
    pub fn clock(&self) -> ThreadCpuClock {
        self.clock.clone()
    }

    /// Thread CPU time now, in nanoseconds, read by the isolate thread
    /// itself: exact on both OSes (module docs). On macOS, once the watchdog
    /// has fired, the reading is clamped to `[fired_at, fired_at +
    /// TERMINATION_TAIL_NS]`: the killed request is billed its limit plus at
    /// most the termination tail, whatever V8's unwind costs and however
    /// close to the limit the watchdog's estimate landed. The clamp does not
    /// depend on slice state because `release_cpu` reads after `end_slice`
    /// has set `slice_start_ns = IDLE`; `fired_at_ns` is never reset, and
    /// the isolate is disposed after a fire, so it cannot leak into another
    /// request.
    pub fn now_ns(&self) -> u64 {
        let cpu = self.clock.now().map(|d| d.as_nanos() as u64).unwrap_or(0);
        #[cfg(target_os = "macos")]
        {
            let fired_at = self.fired_at_ns.load(Ordering::SeqCst);
            if fired_at != IDLE {
                return cpu.clamp(fired_at, fired_at.saturating_add(TERMINATION_TAIL_NS));
            }
        }
        cpu
    }

    /// Monotonic wall time now, in nanoseconds since [`Self::wall_origin`].
    pub fn wall_ns(&self) -> u64 {
        self.wall_origin.elapsed().as_nanos() as u64
    }

    /// Did the watchdog terminate execution?
    pub fn fired(&self) -> bool {
        self.fired.load(Ordering::SeqCst)
    }

    /// Restart the measured run at `start_ns` (thread CPU) with `budget`:
    /// the running context changed. Only the isolate thread calls it. The
    /// wall-time anchor is read inside, so the two clocks come from the
    /// same instant. `fired_at_ns` is not touched: once the watchdog has
    /// fired, the context switches of V8's unwind (promise reactions) must
    /// not lift the clamp, or [`CpuLedger`] would charge past the ± 5 ms
    /// bound.
    pub fn rebase(&self, start_ns: u64, budget: Duration) {
        let wall_start = if start_ns == IDLE {
            IDLE
        } else {
            self.wall_ns()
        };
        self.seq.fetch_add(1, Ordering::SeqCst);
        self.budget_ns.store(clamp_ns(budget), Ordering::SeqCst);
        self.wall_start_ns.store(wall_start, Ordering::SeqCst);
        self.slice_start_ns.store(start_ns, Ordering::SeqCst);
        self.seq.fetch_add(1, Ordering::SeqCst);
    }

    /// A consistent (cpu_start, wall_start, budget) triple, or `None` while
    /// it is rewritten.
    fn sample(&self) -> Option<(u64, u64, u64)> {
        let g = self.seq.load(Ordering::SeqCst);
        if g % 2 == 1 {
            return None;
        }
        let start = self.slice_start_ns.load(Ordering::SeqCst);
        let wall = self.wall_start_ns.load(Ordering::SeqCst);
        let budget = self.budget_ns.load(Ordering::SeqCst);
        (self.seq.load(Ordering::SeqCst) == g).then_some((start, wall, budget))
    }
}

fn clamp_ns(d: Duration) -> u64 {
    d.as_nanos().min(u128::from(u64::MAX - 1)) as u64
}

/// The watchdog's estimate of the CPU the current run has used, from a
/// clock it reads on its own thread. On Linux that clock is current, and the
/// estimate is the plain delta. On macOS `thread_info` of another thread
/// only moves when the kernel publishes the running interval at a scheduler
/// event (module docs), so the estimate is the last published delta plus the
/// wall time since it was published: the thread is assumed to have kept
/// running since then, which holds within a slice. At a run's start the
/// published value is `cpu_start` itself (the isolate thread read it exactly
/// at `rebase`), so until the first publish the estimate is the wall time
/// since the run started. Error against the thread's own exact reads on a
/// spinning thread: -1.5 ms (one sample late) to +0.4 ms (preemption since
/// the last publish). A new `(cpu_start, wall_start)` pair means a new run
/// and resets the state.
struct RunEstimate {
    key: (u64, u64),
    last_cpu_delta: u64,
    wall_at_change: u64,
}

impl RunEstimate {
    fn new() -> RunEstimate {
        RunEstimate {
            key: (IDLE, IDLE),
            last_cpu_delta: 0,
            wall_at_change: 0,
        }
    }

    /// CPU (ns) used by the run `(cpu_start, wall_start)` as of
    /// `(cpu_now, wall_now)`.
    fn used(&mut self, cpu_start: u64, wall_start: u64, cpu_now: u64, wall_now: u64) -> u64 {
        if self.key != (cpu_start, wall_start) {
            self.key = (cpu_start, wall_start);
            self.last_cpu_delta = 0;
            self.wall_at_change = wall_start;
        }
        let cpu_delta = cpu_now.saturating_sub(cpu_start);
        if cpu_delta > self.last_cpu_delta {
            self.last_cpu_delta = cpu_delta;
            self.wall_at_change = wall_now;
        }
        let published_plus_wall = self
            .last_cpu_delta
            .saturating_add(wall_now.saturating_sub(self.wall_at_change));
        #[cfg(target_os = "macos")]
        {
            published_plus_wall
        }
        #[cfg(not(target_os = "macos"))]
        {
            // The clock is current here; the estimate is kept only so the
            // state is exercised identically on both OSes.
            let _ = published_plus_wall;
            cpu_delta
        }
    }
}

/// The watchdog of one isolate thread. Dropping it stops and joins the
/// watchdog thread.
pub struct Watchdog {
    watch: Arc<CpuWatch>,
    thread: Option<JoinHandle<()>>,
}

impl Watchdog {
    /// Start a watchdog for the **calling** thread. `on_fire` is called once,
    /// from the watchdog thread, when a slice exceeds its budget; it must be
    /// thread-safe (for V8: `IsolateHandle::terminate_execution`).
    pub fn start(on_fire: Box<dyn Fn() + Send + 'static>) -> std::io::Result<Watchdog> {
        let watch = Arc::new(CpuWatch {
            clock: ThreadCpuClock::current()?,
            wall_origin: Instant::now(),
            slice_start_ns: AtomicU64::new(IDLE),
            wall_start_ns: AtomicU64::new(IDLE),
            budget_ns: AtomicU64::new(u64::MAX),
            seq: AtomicU64::new(0),
            fired: AtomicBool::new(false),
            fired_at_ns: AtomicU64::new(IDLE),
            stop: AtomicBool::new(false),
        });
        let w = watch.clone();
        let thread = thread::Builder::new()
            .name("renox-cpu-watchdog".into())
            .spawn(move || {
                let mut estimate = RunEstimate::new();
                while !w.stop.load(Ordering::SeqCst) {
                    let Some((cpu_start, wall_start, budget)) = w.sample() else {
                        thread::yield_now();
                        continue;
                    };
                    if cpu_start == IDLE {
                        // Nothing is running: sleep until a slice is armed.
                        thread::park();
                        continue;
                    }
                    if let Some(cpu_now) = w.clock.now() {
                        let used = estimate.used(
                            cpu_start,
                            wall_start,
                            cpu_now.as_nanos() as u64,
                            w.wall_ns(),
                        );
                        if used > budget && !w.fired.swap(true, Ordering::SeqCst) {
                            // The thread CPU at which the running request
                            // reached its limit; `now_ns` clamps to it.
                            w.fired_at_ns
                                .store(cpu_start.saturating_add(budget), Ordering::SeqCst);
                            on_fire();
                        }
                    }
                    thread::sleep(WATCHDOG_INTERVAL);
                }
            })?;
        Ok(Watchdog {
            watch,
            thread: Some(thread),
        })
    }

    pub fn watch(&self) -> &Arc<CpuWatch> {
        &self.watch
    }

    /// Begin a slice with `budget` of CPU. Returns the slice start (thread
    /// CPU ns), to be passed to [`Watchdog::end_slice`].
    pub fn begin_slice(&self, budget: Duration) -> u64 {
        let start = self.watch.now_ns();
        self.watch.rebase(start, budget);
        if let Some(t) = &self.thread {
            t.thread().unpark();
        }
        start
    }

    /// End the slice; returns the CPU used since `start` (after a fire, the
    /// clamped reading of [`CpuWatch::now_ns`]).
    pub fn end_slice(&self, start: u64) -> Duration {
        let now = self.watch.now_ns();
        self.watch.rebase(IDLE, Duration::MAX);
        Duration::from_nanos(now.saturating_sub(start))
    }
}

impl Drop for Watchdog {
    fn drop(&mut self) {
        self.watch.stop.store(true, Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            t.thread().unpark();
            let _ = t.join();
        }
    }
}

/// Who the JavaScript running now belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Running {
    /// A request in flight, by its token.
    Request(u32),
    /// Platform glue, or a context that is no request in flight (a timer
    /// that outlived its request).
    Unattributed,
}

/// What one request in flight was charged so far (ns).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Charge {
    /// Everything: its own runs, its share of unattributed runs, and CPU
    /// spent for it off this thread.
    pub total: u64,
    /// The runs of JavaScript in its own async context (#342 trace).
    pub own: u64,
}

/// Per-request CPU of one isolate thread (#155). The isolate thread feeds it
/// the thread CPU clock at every context switch; the ledger charges the run
/// that just ended and says what budget the next run gets.
#[derive(Debug)]
pub struct CpuLedger {
    limit_ns: u64,
    /// Per request in flight (token → what it was charged so far).
    charged: HashMap<u32, Charge>,
    running: Running,
    /// The context a promise reaction interrupted, restored when it ends.
    outer: Running,
    /// Thread CPU (ns) when the current run started.
    since_ns: u64,
}

impl CpuLedger {
    pub fn new(limit: Duration) -> CpuLedger {
        CpuLedger {
            limit_ns: clamp_ns(limit),
            charged: HashMap::new(),
            running: Running::Unattributed,
            outer: Running::Unattributed,
            since_ns: 0,
        }
    }

    /// A request is in flight from `now_ns` on, with nothing charged yet.
    /// Called inside a slice: the run so far is charged first, so CPU used
    /// before the request joined is never split onto it.
    pub fn admit(&mut self, token: u32, now_ns: u64) {
        self.flush(now_ns);
        self.charged.insert(token, Charge::default());
    }

    /// The request ended: charge the current run, forget the request, and
    /// return its total CPU (ns). The returned value is clamped to
    /// `limit + 5 ms` so a request's `cpu_ms` never exceeds the ± 5 ms
    /// termination bound of `docs/contracts/ops.md` section 10, no matter
    /// how pre-fire charges (microtask setup during awaits), the firing
    /// run's capped charge, and unattributed-CPU rounding
    /// (`used.div_ceil(n)` in [`CpuLedger::flush`]) add up (#212).
    pub fn release(&mut self, token: u32, now_ns: u64) -> u64 {
        self.release_charge(token, now_ns).total
    }

    /// [`CpuLedger::release`], with the parts of the charge.
    pub fn release_charge(&mut self, token: u32, now_ns: u64) -> Charge {
        self.flush(now_ns);
        if self.running == Running::Request(token) {
            self.running = Running::Unattributed;
        }
        if self.outer == Running::Request(token) {
            self.outer = Running::Unattributed;
        }
        let mut charge = self.charged.remove(&token).unwrap_or_default();
        charge.total = charge
            .total
            .min(self.limit_ns.saturating_add(RELEASE_TAIL_NS));
        charge
    }

    /// CPU charged to a request in flight so far (ns).
    pub fn charged(&self, token: u32) -> u64 {
        self.charged.get(&token).map(|c| c.total).unwrap_or(0)
    }

    /// Charge `ns` of CPU spent for a request off this thread (a password
    /// op on the blocking pool, `ops/password.rs`).
    pub fn add(&mut self, token: u32, ns: u64) {
        if let Some(c) = self.charged.get_mut(&token) {
            c.total = c.total.saturating_add(ns);
        }
    }

    pub fn running(&self) -> Running {
        self.running
    }

    /// Start of a slice: the run starts unattributed.
    pub fn begin(&mut self, now_ns: u64) {
        self.since_ns = now_ns;
        self.running = Running::Unattributed;
        self.outer = Running::Unattributed;
    }

    /// End of a slice: charge the last run.
    pub fn end(&mut self, now_ns: u64) {
        self.flush(now_ns);
        self.running = Running::Unattributed;
        self.outer = Running::Unattributed;
    }

    /// Switch to `to` (a token, or `None` for no request). A token that is
    /// not in flight counts as unattributed. Returns whether the running
    /// context changed (the watchdog then needs a new budget).
    pub fn switch(&mut self, to: Option<u32>, now_ns: u64) -> bool {
        let to = match to {
            Some(t) if self.charged.contains_key(&t) => Running::Request(t),
            _ => Running::Unattributed,
        };
        if to == self.running {
            return false;
        }
        self.flush(now_ns);
        self.running = to;
        true
    }

    /// A promise reaction starts in context `to`: remember what it
    /// interrupted. Returns whether the running context changed.
    pub fn enter(&mut self, to: Option<u32>, now_ns: u64) -> bool {
        self.outer = self.running;
        self.switch(to, now_ns)
    }

    /// The promise reaction ended: back to the context it interrupted.
    pub fn leave(&mut self, now_ns: u64) -> bool {
        let outer = match std::mem::replace(&mut self.outer, Running::Unattributed) {
            Running::Request(t) => Some(t),
            Running::Unattributed => None,
        };
        self.switch(outer, now_ns)
    }

    /// The CPU the current run may use before a request goes over its
    /// limit: the running request's own remaining CPU; for unattributed
    /// work, the smallest remaining CPU among the requests in flight, or the
    /// whole limit with none in flight (orphaned work cannot spin forever).
    pub fn budget(&self) -> Duration {
        let left = |c: &Charge| self.limit_ns.saturating_sub(c.total);
        Duration::from_nanos(match self.running {
            Running::Request(t) => self.charged.get(&t).map(left).unwrap_or(self.limit_ns),
            Running::Unattributed => self
                .charged
                .values()
                .map(left)
                .min()
                .unwrap_or(self.limit_ns),
        })
    }

    /// Charge the run from `since_ns` to `now_ns`. Unattributed CPU is split
    /// evenly among the requests in flight, rounded up, so the sum of the
    /// charges never falls below the CPU used while any request was in flight.
    fn flush(&mut self, now_ns: u64) {
        let used = now_ns.saturating_sub(self.since_ns);
        self.since_ns = now_ns;
        if used == 0 {
            return;
        }
        match self.running {
            Running::Request(t) => {
                if let Some(c) = self.charged.get_mut(&t) {
                    c.total += used;
                    c.own += used;
                }
            }
            Running::Unattributed => {
                let n = self.charged.len() as u64;
                if n > 0 {
                    let share = used.div_ceil(n);
                    for c in self.charged.values_mut() {
                        c.total += share;
                    }
                }
            }
        }
    }
}

/// What the calling thread used so far, for the CPU trace (#342): page
/// faults, context switches, and user and system CPU. Linux only
/// (`getrusage(RUSAGE_THREAD)`); `None` elsewhere.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ThreadUsage {
    pub minflt: u64,
    pub majflt: u64,
    /// Voluntary context switches (the thread waited).
    pub nvcsw: u64,
    /// Involuntary context switches (the scheduler took the CPU away).
    pub nivcsw: u64,
    pub user_ns: u64,
    pub system_ns: u64,
}

impl ThreadUsage {
    pub fn now() -> Option<ThreadUsage> {
        #[cfg(any(target_os = "linux", target_os = "android"))]
        {
            // SAFETY: an all-zero `rusage` is a valid value (plain integers).
            let mut u: libc::rusage = unsafe { std::mem::zeroed() };
            // SAFETY: `u` is a valid out-pointer; RUSAGE_THREAD reads only the
            // calling thread's counters.
            if unsafe { libc::getrusage(libc::RUSAGE_THREAD, &mut u) } != 0 {
                return None;
            }
            let ns = |t: libc::timeval| t.tv_sec as u64 * 1_000_000_000 + t.tv_usec as u64 * 1_000;
            Some(ThreadUsage {
                minflt: u.ru_minflt as u64,
                majflt: u.ru_majflt as u64,
                nvcsw: u.ru_nvcsw as u64,
                nivcsw: u.ru_nivcsw as u64,
                user_ns: ns(u.ru_utime),
                system_ns: ns(u.ru_stime),
            })
        }
        #[cfg(not(any(target_os = "linux", target_os = "android")))]
        {
            None
        }
    }

    /// The usage between `earlier` and `self`.
    pub fn since(&self, earlier: &ThreadUsage) -> ThreadUsage {
        ThreadUsage {
            minflt: self.minflt.saturating_sub(earlier.minflt),
            majflt: self.majflt.saturating_sub(earlier.majflt),
            nvcsw: self.nvcsw.saturating_sub(earlier.nvcsw),
            nivcsw: self.nivcsw.saturating_sub(earlier.nivcsw),
            user_ns: self.user_ns.saturating_sub(earlier.user_ns),
            system_ns: self.system_ns.saturating_sub(earlier.system_ns),
        }
    }
}

/// CPU of V8's garbage collections on the calling thread (#342 trace):
/// [`gc_started`] and [`gc_ended`] are called from the isolate's GC prologue
/// and epilogue; [`gc_total`] reads the sum.
pub mod gc {
    use std::cell::Cell;

    thread_local! {
        static START_NS: Cell<u64> = const { Cell::new(0) };
        static TOTAL_NS: Cell<u64> = const { Cell::new(0) };
        static COUNT: Cell<u64> = const { Cell::new(0) };
    }

    fn thread_cpu_ns() -> u64 {
        let mut ts = libc::timespec {
            tv_sec: 0,
            tv_nsec: 0,
        };
        // SAFETY: `ts` is a valid out-pointer; CLOCK_THREAD_CPUTIME_ID reads
        // the calling thread's CPU clock.
        let rc = unsafe { libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, &mut ts) };
        if rc != 0 {
            return 0;
        }
        ts.tv_sec as u64 * 1_000_000_000 + ts.tv_nsec as u64
    }

    pub fn gc_started() {
        START_NS.with(|s| s.set(thread_cpu_ns()));
    }

    pub fn gc_ended() {
        let used = thread_cpu_ns().saturating_sub(START_NS.with(Cell::get));
        TOTAL_NS.with(|t| t.set(t.get().saturating_add(used)));
        COUNT.with(|c| c.set(c.get() + 1));
    }

    /// (CPU ns, collections) of the GCs on this thread so far.
    pub fn gc_total() -> (u64, u64) {
        (TOTAL_NS.with(Cell::get), COUNT.with(Cell::get))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    fn spin(d: Duration) {
        let t = Instant::now();
        let mut x = 0u64;
        while t.elapsed() < d {
            x = x.wrapping_add(std::hint::black_box(1));
        }
        std::hint::black_box(x);
    }

    const MS: u64 = 1_000_000;

    /// One request in flight: every run, attributed or not, is its own
    /// (never under-count, #155).
    #[test]
    fn ledger_charges_everything_to_a_lone_request() {
        let mut l = CpuLedger::new(Duration::from_millis(50));
        l.begin(0);
        l.admit(1, 0);
        assert!(l.switch(Some(1), 2 * MS));
        assert!(l.switch(None, 5 * MS));
        l.end(6 * MS);
        assert_eq!(l.release(1, 6 * MS), 6 * MS);
    }

    /// The B12 finding: 16 requests in flight, each runs 1 ms of its own
    /// JavaScript per slice. The old model charged each one 16 ms per
    /// slice; the ledger charges each its own 1 ms plus its share of the
    /// glue.
    #[test]
    fn ledger_charges_concurrent_requests_their_own_runs() {
        let mut l = CpuLedger::new(Duration::from_millis(50));
        let mut now = 0;
        for t in 0..16 {
            l.admit(t, now);
        }
        for _slice in 0..10 {
            l.begin(now);
            for t in 0..16 {
                now += 10_000; // 10 µs of glue
                l.enter(Some(t), now);
                now += MS;
                l.leave(now);
            }
            l.end(now);
        }
        for t in 0..16 {
            let c = l.release(t, now);
            assert!((10 * MS..11 * MS).contains(&c), "token {t}: {c} ns");
        }
    }

    /// CPU used in a slice before a request joined is not charged to it.
    #[test]
    fn ledger_does_not_charge_a_request_for_the_slice_before_it_joined() {
        let mut l = CpuLedger::new(Duration::from_millis(50));
        l.begin(0);
        l.admit(1, 0);
        l.admit(2, 20 * MS);
        l.end(21 * MS);
        assert_eq!(l.release(2, 21 * MS), MS / 2);
        assert_eq!(l.release(1, 21 * MS), 20 * MS + MS / 2);
    }

    /// The watchdog budget follows the running context.
    #[test]
    fn ledger_budget_is_the_running_requests_remaining_cpu() {
        let mut l = CpuLedger::new(Duration::from_millis(50));
        l.begin(0);
        assert_eq!(l.budget(), Duration::from_millis(50));
        l.admit(1, 0);
        l.admit(2, 0);
        l.switch(Some(1), 0);
        l.switch(Some(2), 30 * MS);
        assert_eq!(l.budget(), Duration::from_millis(50));
        l.switch(None, 40 * MS);
        // Unattributed: the smallest remaining (request 1: 20 ms).
        assert_eq!(l.budget(), Duration::from_millis(20));
        l.switch(Some(1), 40 * MS);
        assert_eq!(l.budget(), Duration::from_millis(20));
        // A token that is not in flight is unattributed.
        assert!(l.switch(Some(9), 41 * MS));
        assert_eq!(l.running(), Running::Unattributed);
        assert_eq!(l.charged(1), 31 * MS);
    }

    /// Unattributed CPU is split, rounded up, so the charges add up to at
    /// least the CPU used.
    #[test]
    fn ledger_splits_unattributed_cpu() {
        let mut l = CpuLedger::new(Duration::from_millis(50));
        l.begin(0);
        for t in 0..3 {
            l.admit(t, 0);
        }
        l.end(10);
        let total: u64 = (0..3).map(|t| l.release(t, 10)).sum();
        assert_eq!(total, 12);
    }

    /// A request's charge is everything it used; `own` is the part in its
    /// own async context (#342 trace).
    #[test]
    fn ledger_charge_keeps_own_runs_apart_from_shared_ones() {
        let mut l = CpuLedger::new(Duration::from_millis(50));
        l.begin(0);
        l.admit(1, 0);
        l.switch(Some(1), 0);
        l.switch(None, 30 * MS);
        assert_eq!(l.budget(), Duration::from_millis(20));
        let c = l.release_charge(1, 32 * MS);
        assert_eq!((c.total, c.own), (32 * MS, 30 * MS));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn thread_usage_counts_this_threads_faults_and_cpu() {
        let a = ThreadUsage::now().unwrap();
        let mut v = vec![0u8; 8 << 20];
        for i in (0..v.len()).step_by(4096) {
            v[i] = 1;
        }
        std::hint::black_box(&v);
        spin(Duration::from_millis(20));
        let d = ThreadUsage::now().unwrap().since(&a);
        assert!(d.minflt >= 1_000, "{d:?}");
        assert!(d.user_ns + d.system_ns >= 15 * MS, "{d:?}");
    }

    /// The watchdog's estimate against a clock that publishes in steps
    /// (macOS `thread_info` read from another thread): between publishes it
    /// follows wall time from the last publish, at a publish it snaps to
    /// the published value, and a new run resets it. On Linux it is the
    /// plain delta.
    #[test]
    fn run_estimate_follows_a_stepping_clock() {
        let mut e = RunEstimate::new();
        // Run starts at cpu 100, wall 1000 (ns, arbitrary). The clock still
        // shows a value from before the run: nothing published yet.
        assert_eq!(
            e.used(100, 1000, 90, 1000 + 2 * MS),
            if cfg!(target_os = "macos") { 2 * MS } else { 0 }
        );
        // First publish, 1 ms of CPU late: 5 ms of CPU at wall +6 ms.
        assert_eq!(e.used(100, 1000, 100 + 5 * MS, 1000 + 6 * MS), 5 * MS);
        // Frozen for 3 ms: the estimate follows wall, the raw delta does not.
        let frozen = e.used(100, 1000, 100 + 5 * MS, 1000 + 9 * MS);
        assert_eq!(
            frozen,
            if cfg!(target_os = "macos") {
                8 * MS
            } else {
                5 * MS
            }
        );
        // Next publish shows 0.5 ms of preemption in the meantime.
        assert_eq!(
            e.used(100, 1000, 100 + 8 * MS + MS / 2, 1000 + 10 * MS),
            8 * MS + MS / 2
        );
        // A new run (a context switch rebased at cpu 200, wall 5000) resets.
        assert_eq!(
            e.used(200, 5000, 150, 5000 + MS),
            if cfg!(target_os = "macos") { MS } else { 0 }
        );
    }

    /// The seqlock never hands the watchdog a torn triple. Only the
    /// (start, budget) pair comes from the caller (as `(i, i)`); the
    /// watch reads its own wall clock inside `rebase`, so wall_start is
    /// not asserted here.
    #[test]
    fn rebase_is_seen_whole() {
        // No watchdog thread: the test samples the triple itself.
        let watch = Arc::new(CpuWatch {
            clock: ThreadCpuClock::current().unwrap(),
            wall_origin: Instant::now(),
            slice_start_ns: AtomicU64::new(IDLE),
            wall_start_ns: AtomicU64::new(IDLE),
            budget_ns: AtomicU64::new(u64::MAX),
            seq: AtomicU64::new(0),
            fired: AtomicBool::new(false),
            fired_at_ns: AtomicU64::new(IDLE),
            stop: AtomicBool::new(false),
        });
        let seen = Arc::new(AtomicU64::new(0));
        let reader = {
            let (watch, seen) = (watch.clone(), seen.clone());
            thread::spawn(move || {
                while seen.load(Ordering::SeqCst) < 10_000 {
                    if let Some((start, _wall, budget)) = watch.sample() {
                        assert!(start == budget || start == IDLE, "torn pair");
                        seen.fetch_add(1, Ordering::SeqCst);
                    }
                    thread::yield_now();
                }
            })
        };
        // Rewrite the triple until the reader has sampled it 10,000 times.
        let t = std::time::Instant::now();
        let mut i = 1u64;
        while !reader.is_finished() && t.elapsed() < Duration::from_secs(10) {
            watch.rebase(i, Duration::from_nanos(i));
            i += 1;
        }
        reader.join().unwrap();
        assert!(seen.load(Ordering::SeqCst) >= 10_000);
    }

    #[test]
    fn thread_clock_counts_cpu_not_sleep() {
        let c = ThreadCpuClock::current().unwrap();
        let a = c.now().unwrap();
        thread::sleep(Duration::from_millis(30));
        let b = c.now().unwrap();
        assert!(b - a < Duration::from_millis(10), "{:?}", b - a);
        spin(Duration::from_millis(30));
        let d = c.now().unwrap();
        assert!(d - b >= Duration::from_millis(20), "{:?}", d - b);
    }

    /// The watchdog reads the isolate thread's clock from its own thread,
    /// and the clock stops answering once that thread has exited (no reused
    /// clock id or Mach port reads another thread's CPU). Runs on Linux and
    /// on the macOS CI job (#139; docs/24-threat-model.md B, "CPU, memory,
    /// wall-clock exhaustion").
    #[test]
    fn thread_clock_reads_another_thread_until_it_exits() {
        let (tx, rx) = std::sync::mpsc::channel();
        let (go_tx, go_rx) = std::sync::mpsc::channel::<()>();
        let t = thread::spawn(move || {
            tx.send(ThreadCpuClock::current().unwrap()).unwrap();
            spin(Duration::from_millis(40));
            go_rx.recv().unwrap();
        });
        let c = rx.recv().unwrap();
        let mine = ThreadCpuClock::current().unwrap();
        let before = mine.now().unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while c.now().unwrap() < Duration::from_millis(30) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(1));
        }
        assert!(
            c.now().unwrap() >= Duration::from_millis(30),
            "{:?}",
            c.now()
        );
        // The other thread's spin is not charged to this one.
        assert!(mine.now().unwrap() - before < Duration::from_millis(20));
        go_tx.send(()).unwrap();
        t.join().unwrap();
        // Linux releases the exited thread's task shortly after the join
        // returns (glibc wakes the joiner at CLONE_CHILD_CLEARTID); until
        // then its clock may still answer.
        let deadline = Instant::now() + Duration::from_secs(5);
        while c.now().is_some() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(1));
        }
        assert_eq!(c.now(), None);
    }

    /// The watchdog fires once a slice uses more than its budget, and not
    /// for a slice that stays within it.
    #[test]
    fn watchdog_fires_after_budget() {
        let fired = Arc::new(AtomicBool::new(false));
        let f = fired.clone();
        let w = Watchdog::start(Box::new(move || f.store(true, Ordering::SeqCst))).unwrap();
        let s = w.begin_slice(Duration::from_millis(50));
        spin(Duration::from_millis(10));
        w.end_slice(s);
        thread::sleep(Duration::from_millis(5));
        assert!(!fired.load(Ordering::SeqCst));
        let s = w.begin_slice(Duration::from_millis(20));
        let t = Instant::now();
        while !fired.load(Ordering::SeqCst) && t.elapsed() < Duration::from_secs(2) {
            spin(Duration::from_micros(100));
        }
        let used = w.end_slice(s);
        assert!(fired.load(Ordering::SeqCst));
        assert!(
            used >= Duration::from_millis(20) && used < Duration::from_millis(40),
            "{used:?}"
        );
    }
}
