//! CPU limit per request (`docs/contracts/ops.md` section 10): the isolate
//! thread's CPU clock plus a watchdog thread that terminates JavaScript when
//! the running slice would take a request over its limit.
//!
//! Accounting: the isolate thread runs JavaScript only inside its loop's
//! poll ("a slice"). At slice start it records its thread CPU time and the
//! smallest remaining budget among the requests in flight, and arms the
//! watchdog. At slice end every request that was in flight during the slice
//! is charged the slice's CPU time. With one request in flight this is
//! exact. With several, each is charged every slice it was in flight for,
//! which over-counts (never under-counts) a request's `cpu_ms`; see the
//! README, "Limits".

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::thread::{self, JoinHandle};
use std::time::Duration;

/// How often the watchdog samples the running slice.
pub const WATCHDOG_INTERVAL: Duration = Duration::from_millis(1);

const IDLE: u64 = u64::MAX;

/// The CPU clock of one thread (`CLOCK_THREAD_CPUTIME_ID` of that thread),
/// readable from any thread.
#[derive(Debug, Clone, Copy)]
pub struct ThreadCpuClock {
    clock: libc::clockid_t,
}

impl ThreadCpuClock {
    /// The clock of the calling thread.
    pub fn current() -> std::io::Result<ThreadCpuClock> {
        let mut clock: libc::clockid_t = 0;
        // SAFETY: `pthread_self()` is always a valid handle for the calling
        // thread, and `clock` is a valid out-pointer for the duration of the
        // call. The function only writes a clock id; it has no other effect.
        let rc = unsafe { libc::pthread_getcpuclockid(libc::pthread_self(), &mut clock) };
        if rc != 0 {
            return Err(std::io::Error::from_raw_os_error(rc));
        }
        Ok(ThreadCpuClock { clock })
    }

    /// CPU time consumed by the thread so far. Returns `None` once the
    /// thread has exited (the kernel then reports `EINVAL`).
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

/// State shared by the isolate thread and its watchdog.
pub struct CpuWatch {
    clock: ThreadCpuClock,
    /// Thread CPU time (ns) when the current slice started, or `IDLE`.
    slice_start_ns: AtomicU64,
    /// CPU (ns) the current slice may use before the watchdog fires.
    budget_ns: AtomicU64,
    fired: AtomicBool,
    stop: AtomicBool,
}

impl CpuWatch {
    pub fn clock(&self) -> ThreadCpuClock {
        self.clock
    }

    /// Thread CPU time now, in nanoseconds.
    pub fn now_ns(&self) -> u64 {
        self.clock.now().map(|d| d.as_nanos() as u64).unwrap_or(0)
    }

    /// Did the watchdog terminate execution?
    pub fn fired(&self) -> bool {
        self.fired.load(Ordering::SeqCst)
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
            slice_start_ns: AtomicU64::new(IDLE),
            budget_ns: AtomicU64::new(u64::MAX),
            fired: AtomicBool::new(false),
            stop: AtomicBool::new(false),
        });
        let w = watch.clone();
        let thread = thread::Builder::new()
            .name("renox-cpu-watchdog".into())
            .spawn(move || {
                while !w.stop.load(Ordering::SeqCst) {
                    let start = w.slice_start_ns.load(Ordering::SeqCst);
                    if start == IDLE {
                        // Nothing is running: sleep until a slice is armed.
                        thread::park();
                        continue;
                    }
                    let budget = w.budget_ns.load(Ordering::SeqCst);
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
        self.set_budget(budget);
        self.watch.slice_start_ns.store(start, Ordering::SeqCst);
        if let Some(t) = &self.thread {
            t.thread().unpark();
        }
        start
    }

    /// Change the budget of the running slice (a request joined it).
    pub fn set_budget(&self, budget: Duration) {
        self.watch.budget_ns.store(
            budget.as_nanos().min(u128::from(u64::MAX - 1)) as u64,
            Ordering::SeqCst,
        );
    }

    /// End the slice; returns the CPU it used.
    pub fn end_slice(&self, start: u64) -> Duration {
        self.watch.slice_start_ns.store(IDLE, Ordering::SeqCst);
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
