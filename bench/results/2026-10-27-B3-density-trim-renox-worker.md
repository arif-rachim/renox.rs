# B3 — Density — 2026-10-27
Hardware: dev-laptop (Intel(R) Xeon(R) Processor @ 2.10GHz, 4 vCPU, 16 GB RAM, Linux 6.18.44-fc-v165), git 4562556 plus the uncommitted #144 and #145 changes of batch H2, rustc 1.99.1, bun 1.4.4, node 22.22.0, deno n/a
Scenario: 1000 tenants registered and warmed once, evicted after 30 s; then 300 kept warm with 1 req/s each for 60 s; warm capacity extrapolated to node-small (8 GB, 1 GB headroom)
Result: registered_tenants 999 tenants, failed_cold_first_requests 1, idle_mb 0.0576, baseline_rss_mb 55.2, idle_rss_mb 112.8, peak_rss_mb 7195, warm_tenants 795 tenants, measured_warm_tenants 300, warm_rss_mb 2739, mb_per_warm_tenant 8.946, warm_threads 948, warm_open_files 2775, trickle_ok_pct 100
Target: ≥ 1,000 registered, ≥ 300 warm (fail: < 100 warm) → FAIL
Notes: profile dev-laptop, runs 3; not node-small: relative comparison only, never pass/fail; registered_tenants 999 tenants misses the target 1000 tenants; warmed 1000 tenants in 11.8 s (1 failed: {"RENOX_CPU_LIMIT":1}), peak RSS 7194.8 MB, 3020 threads; baseline RSS 55.2 MB (9 threads, 11 files); right after the last eviction 6269.4 MB; 35 s later 112.8 MB (9 threads, 11 files); 300 warm tenants at 1 req/s for 60 s: 18100/18100 ok, steady RSS 2738.8 MB (8.95 MB per warm tenant), threads 948, open files 2775
Raw: bench/results/raw/2026-10-27-B3-h2.json

Verdict: **PROVISIONAL**. `warm_tenants` is 795 extrapolated to `node-small` (target ≥ 300), up from 561 in [the #35 run](2026-10-27-B3-density-renox-worker.md). `registered_tenants` 999 of 1,000 is a FAIL by 1: one cold first request was answered `RENOX_CPU_LIMIT` (#146). Measured on the same 4 vCPU / 16 GB cloud container, not `node-small`.

## Findings (#144, re-measured)

- The cost per warm tenant fell from 12.67 MB to 8.95 MB. Two changes from this batch contribute. First, the allocator trims after the warm-up's 1,000 evictions (#144): steady RSS is measured against the pre-warm-up baseline, so memory that the warm-up left in the allocator counted against the warm tenants before. Second, reader connections are opened lazily (#145): open files at 300 warm tenants went from 3,975 to 2,775.
- 300 tenants at 1 req/s each for 60 s: 18,100 / 18,100 answered 200.
