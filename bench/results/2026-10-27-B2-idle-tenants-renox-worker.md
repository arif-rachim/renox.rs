# B2 — Memory per idle tenant — 2026-10-27
Hardware: dev-laptop (Intel(R) Xeon(R) Processor @ 2.10GHz, 4 vCPU, 16 GB RAM, Linux 6.18.44-fc-v165), git d79bc84, rustc 1.99.1, bun 1.4.4, node 22.22.0, deno n/a
Scenario: 1000 tenants registered on renox-worker (release), each warmed with one request, then idle past idle_timeout 30 s: RSS per idle tenant
Result: registered_tenants 999, idle_mb 3.012 MB, baseline_rss_mb 59.2, idle_rss_mb 3071, peak_rss_mb 7339
Target: ≈ 0 MB (bookkeeping only) (fail: > 1 MB) → FAIL
Notes: profile dev-laptop, runs 3; not node-small: relative comparison only, never pass/fail; idle_mb 3.0119 MB crosses the fail threshold 1 MB; warmed 1000 tenants in 15.5 s (1 failed), peak RSS 7338.7 MB, 3020 threads; baseline RSS 59.2 MB (9 threads, 11 files); after eviction 3071.1 MB (9 threads, 11 files)
Raw: bench/results/raw/2026-10-27-B2-f1.json

Verdict: **PROVISIONAL FAIL** (3.0 MB per idle tenant against ≈ 0, fail > 1 MB). Measured on a 4 vCPU / 16 GB cloud container, not `node-small`.

## F1 findings

- **Eviction works; the memory is not returned to the OS.** After `idle_timeout` every cell is gone: the worker is back at its baseline of 9 threads and 11 open files (from 3,020 threads at the peak). The isolates, their threads, and the tenant files are released. RSS stays at 3.07 GB (baseline 59 MB): the freed memory stays in the allocator. With one isolate thread and one watchdog thread per cell and one DB thread per tenant, glibc malloc creates per-thread arenas, and pages freed in an arena are not given back unless the arena's top is free.
- So `idle_mb` here measures allocator retention, not per-tenant bookkeeping (the manager keeps one empty map slot per tenant that had a database: a few hundred bytes).
- Levers: `malloc_trim(0)` after an eviction burst, capping arenas (`M_ARENA_MAX` / `MALLOC_ARENA_MAX=2`), or a different global allocator for the worker (jemalloc/mimalloc with decay). V8's own pages are unmapped when an isolate is disposed; the retained memory is in the Rust and C heaps (Tokio runtimes, rusqlite caches, Deno's extension state per isolate). Follow-up issue opened.
- Peak while all 1,000 tenants were warm: 7.3 GB (≈ 7.3 MB per warm hello isolate, consistent with B1), reached because warming took 15.5 s with a 30 s idle timeout.
- 1 of the 1,000 first requests failed during the warm-up, and in the B3 run 5 of 1,000; a dedicated re-run of the same warm-up had 0 failures, and B4 (sequential cold starts) had 0 in 600. Intermittent, under 8 concurrent cold starts; the response code was not captured by this scenario. Follow-up issue opened to capture and fix it.
