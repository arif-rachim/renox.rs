# B2 — Memory per idle tenant — 2026-10-27
Hardware: dev-laptop (Intel(R) Xeon(R) Processor @ 2.10GHz, 4 vCPU, 16 GB RAM, Linux 6.18.44-fc-v165), git 4562556 plus the uncommitted #144 and #145 changes of batch H2, rustc 1.99.1, bun 1.4.4, node 22.22.0, deno n/a
Scenario: 1000 tenants registered on renox-worker (release), each warmed with one request, then idle past idle_timeout 30 s: RSS per idle tenant
Result: registered_tenants 999, failed_cold_first_requests 1, idle_mb 0.0589 MB, baseline_rss_mb 55.6, idle_rss_mb 114.5, peak_rss_mb 7197
Target: ≈ 0 MB (bookkeeping only) (fail: > 1 MB) → PASS
Notes: profile dev-laptop, runs 3; not node-small: relative comparison only, never pass/fail; warmed 1000 tenants in 12.6 s (1 failed: {"RENOX_CPU_LIMIT":1}), peak RSS 7197 MB, 3019 threads; baseline RSS 55.6 MB (9 threads, 11 files); right after the last eviction 6271.2 MB; 35 s later 114.5 MB (9 threads, 11 files)
Raw: bench/results/raw/2026-10-27-B2-h2.json

Verdict: **PROVISIONAL PASS** (0.059 MB per idle tenant against ≈ 0, fail > 1 MB), down from 3.0 MB in [the #35 run](2026-10-27-B2-idle-tenants-renox-worker.md). Measured on the same 4 vCPU / 16 GB cloud container, not `node-small`.

## Findings (#144)

- **What changed.** `renox-worker` calls glibc `malloc_trim(0)` after evictions (`crates/renox-cell/src/alloc.rs`, `CellManager::schedule_trim`): once no cell was evicted for 2 s, then again 10 s and 30 s after that. An evicted cell's memory is freed in stages (isolate disposal, the exit of its isolate, watchdog, and DB threads, Tokio's blocking-pool threads after their 10 s keep-alive), and only memory already free can be trimmed. That is why a single trim was not enough.
- **Scenario change.** B2 now samples the idle RSS `DENSITY_SETTLE_S` (35 s) after the last eviction, not 3 s after it, so that it measures the steady idle state after the trims. The note shows both points: 6.27 GB right after the last eviction, 114.5 MB 35 s later. The #35 run sampled 3 s after eviction, but without a trim glibc does not return this memory on its own: an ad-hoc run of the same build without a trim still held 4.7 GB several seconds later.
- **Options measured** (1,000 hello tenants warmed, then evicted; RSS per evicted tenant; ad-hoc runs on the same container):

  | Option | Per tenant after eviction |
  | --- | --- |
  | Nothing (baseline build) | 3.28 MB (B2, +3 s) |
  | `MALLOC_ARENA_MAX=2` | 2.42 MB (B2, +3 s) |
  | jemalloc as the global allocator, replacing `malloc` for C code too, defaults | 3.9–4.1 MB, peak RSS 8.3 GB (+1.1 GB) |
  | jemalloc with `dirty_decay_ms:1000,muzzy_decay_ms:0`, background threads | 0.65 MB |
  | one `malloc_trim(0)` (gdb, after eviction) | 0.62 MB |
  | one automatic trim 2 s after the last eviction | 1.56 MB (B2, +3 s) |
  | **trims at +2 s, +12 s, +32 s (kept)** | **0.059 MB** (B2, +35 s) |

- The kept option adds no C dependency. Its one `unsafe` line (the FFI call) is documented in `alloc.rs`, and it is a no-op outside glibc. A trim walks every arena, so it runs on a blocking thread; each trim took well under a second here.
- Failed cold first requests during the 8-concurrent warm-up are now recorded by code: 1, `RENOX_CPU_LIMIT` (#146).
