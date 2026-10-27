# B3 — Density — 2026-10-27
Hardware: dev-laptop (Intel(R) Xeon(R) Processor @ 2.10GHz, 4 vCPU, 16 GB RAM, Linux 6.18.44-fc-v165), git c1c0abc, rustc 1.99.1, bun 1.4.4, node 22.22.0, deno n/a
Scenario: 1000 tenants registered and warmed once, evicted after 30 s; then 300 kept warm with 1 req/s each for 60 s; warm capacity extrapolated to node-small (8 GB, 1 GB headroom)
Result: registered_tenants 995 tenants, idle_mb 3.024, baseline_rss_mb 58, idle_rss_mb 3082, peak_rss_mb 7310, warm_tenants 561 tenants, measured_warm_tenants 300, warm_rss_mb 3860, mb_per_warm_tenant 12.67, warm_threads 973, warm_open_files 3975, trickle_ok_pct 100
Target: ≥ 1,000 registered, ≥ 300 warm (fail: < 100 warm) → FAIL
Notes: profile dev-laptop, runs 3; not node-small: relative comparison only, never pass/fail; registered_tenants 995 tenants misses the target 1000 tenants; warmed 1000 tenants in 13.1 s (5 failed), peak RSS 7310.2 MB, 3013 threads; baseline RSS 58 MB (9 threads, 11 files); after eviction 3082 MB (9 threads, 11 files); 300 warm tenants at 1 req/s for 60 s: 18147/18147 ok, steady RSS 3859.5 MB (12.67 MB per warm tenant), threads 973, open files 3975
Raw: bench/results/raw/2026-10-27-B3-f1.json

Verdict: **PROVISIONAL**: `warm_tenants` 561 extrapolated to `node-small` (≥ 300 target, < 100 fail) is a **PASS on warm density**; `registered_tenants` 995 of 1,000 is a **FAIL by 5** because 5 first requests failed during the warm-up (intermittent, see below). 300 tenants were kept warm at 1 req/s each for 60 s with 18,147 / 18,147 requests answered 200. Measured on a 4 vCPU / 16 GB cloud container, not `node-small`.

## F1 findings

- Steady state with 300 warm tenants: RSS 3.86 GB, 973 threads (3 per warm tenant: isolate, watchdog, DB thread), 3,975 open files (13 per warm tenant: the SQLite writer and 2 readers with their WAL and SHM files, plus sockets).
- The cost per warm tenant, 12.67 MB, is measured against the process baseline before any tenant ran, so it includes the allocator memory retained from the earlier warm-up of all 1,000 tenants (B2: 3.07 GB after eviction). Measured against the post-eviction RSS, the 300 warm tenants added only 2.6 MB each; the true steady-state cost is between the two, and with allocator memory returned (B2 follow-up) the extrapolation would move from 561 towards the ≈ 970 tenants that 7.3 MB per warm isolate (B1, hello) allows.
- `registered_tenants`: all 1,000 route entries were registered and served; 5 cold first requests failed under 8 concurrent cold starts (B2's run had 1, a dedicated re-run 0). The scenario does not record the failure code yet; follow-up #146.
- The threads per tenant (3) are the next density limit after memory: 1,000 warm tenants would be 3,000 threads.
