//! Returning freed memory to the OS after evictions (#144).
//!
//! Each cell runs an isolate thread, a watchdog thread, and a DB thread, so
//! glibc malloc spreads the cell's allocations over per-thread arenas. When
//! the cell is evicted the memory is freed but stays in those arenas: B2
//! measured 3 GB retained after 1,000 hello cells were evicted. A
//! `malloc_trim(0)` once the evictions settle gives it back (0.6 MB per
//! evicted tenant left, `bench/results/2026-10-27-B2-*-h2*`). jemalloc as
//! the global allocator was measured too and kept more without tuning.

/// Release free memory of every malloc arena to the OS. A no-op where the
/// C library is not glibc. Blocking (it walks every arena): call it from a
/// blocking thread.
pub fn trim() {
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    // SAFETY: `malloc_trim` takes a plain integer, touches only the
    // allocator's own state under its locks, and is safe to call from any
    // thread at any time (glibc malloc(3)).
    unsafe {
        libc::malloc_trim(0);
    }
}
