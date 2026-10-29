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

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::thread::{self, JoinHandle};
use std::time::Duration;

/// How often the watchdog samples the running slice.
pub const WATCHDOG_INTERVAL: Duration = Duration::from_millis(1);

const IDLE: u64 = u64::MAX;

/// The CPU clock of one thread, readable from any thread. Linux:
/// `CLOCK_THREAD_CPUTIME_ID` of that thread (`pthread_getcpuclockid`).
/// macOS (#139): the thread's Mach port and `thread_info(THREAD_BASIC_INFO)`,
/// `user_time + system_time`, at microsecond resolution. Not released: on
/// the macOS CI runner the CPU limit landed 3-11 ms late (wall ≈ CPU), which
/// points at this clock lagging for a running thread.
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
    /// Thread CPU time (ns) when the current slice started, or `IDLE`.
    slice_start_ns: AtomicU64,
    /// CPU (ns) the current run may use before the watchdog fires.
    budget_ns: AtomicU64,
    /// Seqlock over (`slice_start_ns`, `budget_ns`): odd while the isolate
    /// thread rewrites the pair, so the watchdog never pairs a new start
    /// with an old budget.
    seq: AtomicU64,
    fired: AtomicBool,
    stop: AtomicBool,
}

impl CpuWatch {
    pub fn clock(&self) -> ThreadCpuClock {
        self.clock.clone()
    }

    /// Thread CPU time now, in nanoseconds.
    pub fn now_ns(&self) -> u64 {
        self.clock.now().map(|d| d.as_nanos() as u64).unwrap_or(0)
    }

    /// Did the watchdog terminate execution?
    pub fn fired(&self) -> bool {
        self.fired.load(Ordering::SeqCst)
    }

    /// Restart the measured run at `start_ns` (thread CPU) with `budget`:
    /// the running context changed. Only the isolate thread calls it.
    pub fn rebase(&self, start_ns: u64, budget: Duration) {
        self.seq.fetch_add(1, Ordering::SeqCst);
        self.budget_ns.store(clamp_ns(budget), Ordering::SeqCst);
        self.slice_start_ns.store(start_ns, Ordering::SeqCst);
        self.seq.fetch_add(1, Ordering::SeqCst);
    }

    /// A consistent (start, budget) pair, or `None` while it is rewritten.
    fn sample(&self) -> Option<(u64, u64)> {
        let g = self.seq.load(Ordering::SeqCst);
        if g % 2 == 1 {
            return None;
        }
        let start = self.slice_start_ns.load(Ordering::SeqCst);
        let budget = self.budget_ns.load(Ordering::SeqCst);
        (self.seq.load(Ordering::SeqCst) == g).then_some((start, budget))
    }
}

fn clamp_ns(d: Duration) -> u64 {
    d.as_nanos().min(u128::from(u64::MAX - 1)) as u64
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
            slice_start_ns: AtomicU64::new(IDLE),
            budget_ns: AtomicU64::new(u64::MAX),
            seq: AtomicU64::new(0),
            fired: AtomicBool::new(false),
            stop: AtomicBool::new(false),
        });
        let w = watch.clone();
        let thread = thread::Builder::new()
            .name("renox-cpu-watchdog".into())
            .spawn(move || {
                while !w.stop.load(Ordering::SeqCst) {
                    let Some((start, budget)) = w.sample() else {
                        thread::yield_now();
                        continue;
                    };
                    if start == IDLE {
                        // Nothing is running: sleep until a slice is armed.
                        thread::park();
                        continue;
                    }
                    if let Some(now) = w.clock.now() {
                        let used = (now.as_nanos() as u64).saturating_sub(start);
                        if used > budget && !w.fired.swap(true, Ordering::SeqCst) {
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

    /// End the slice; returns the CPU used since `start`.
    pub fn end_slice(&self, start: u64) -> Duration {
        self.watch.rebase(IDLE, Duration::MAX);
        Duration::from_nanos(self.watch.now_ns().saturating_sub(start))
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

/// Per-request CPU of one isolate thread (#155). The isolate thread feeds it
/// the thread CPU clock at every context switch; the ledger charges the run
/// that just ended and says what budget the next run gets.
#[derive(Debug)]
pub struct CpuLedger {
    limit_ns: u64,
    /// CPU charged so far, per request in flight (token → ns).
    charged: HashMap<u32, u64>,
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
        self.charged.insert(token, 0);
    }

    /// The request ended: charge the current run, forget the request, and
    /// return its total CPU (ns).
    pub fn release(&mut self, token: u32, now_ns: u64) -> u64 {
        self.flush(now_ns);
        if self.running == Running::Request(token) {
            self.running = Running::Unattributed;
        }
        if self.outer == Running::Request(token) {
            self.outer = Running::Unattributed;
        }
        self.charged.remove(&token).unwrap_or(0)
    }

    /// CPU charged to a request in flight so far (ns).
    pub fn charged(&self, token: u32) -> u64 {
        self.charged.get(&token).copied().unwrap_or(0)
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
        let left = |t: &u32| self.limit_ns.saturating_sub(self.charged(*t));
        Duration::from_nanos(match self.running {
            Running::Request(t) => left(&t),
            Running::Unattributed => self.charged.keys().map(left).min().unwrap_or(self.limit_ns),
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
                    *c += used;
                }
            }
            Running::Unattributed => {
                let n = self.charged.len() as u64;
                if n > 0 {
                    let share = used.div_ceil(n);
                    for c in self.charged.values_mut() {
                        *c += share;
                    }
                }
            }
        }
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

    /// The seqlock never hands the watchdog a torn (start, budget) pair.
    #[test]
    fn rebase_is_seen_whole() {
        // No watchdog thread: the test samples the pair itself.
        let watch = Arc::new(CpuWatch {
            clock: ThreadCpuClock::current().unwrap(),
            slice_start_ns: AtomicU64::new(IDLE),
            budget_ns: AtomicU64::new(u64::MAX),
            seq: AtomicU64::new(0),
            fired: AtomicBool::new(false),
            stop: AtomicBool::new(false),
        });
        let seen = Arc::new(AtomicU64::new(0));
        let reader = {
            let (watch, seen) = (watch.clone(), seen.clone());
            thread::spawn(move || {
                while seen.load(Ordering::SeqCst) < 10_000 {
                    if let Some((start, budget)) = watch.sample() {
                        assert!(start == budget || start == IDLE, "torn pair");
                        seen.fetch_add(1, Ordering::SeqCst);
                    }
                    thread::yield_now();
                }
            })
        };
        // Rewrite the pair until the reader has sampled it 10,000 times.
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
