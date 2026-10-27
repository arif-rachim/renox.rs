# B3 — Density — 2026-10-27
Hardware: dev-laptop (Intel(R) Xeon(R) Processor @ 2.10GHz, 4 vCPU, 16 GB RAM, Linux 6.18.44-fc-v165), git 9167700, rustc 1.99.1, bun 1.4.4, node 22.22.0, deno n/a
Scenario: 1000 tenants registered and warmed once, evicted after 30 s; then 300 kept warm with 1 req/s each for 60 s; warm capacity extrapolated to node-small (8 GB, 1 GB headroom)
Result: registered_tenants 1000 tenants, failed_cold_first_requests 0, idle_mb 0.0428, baseline_rss_mb 54.9, idle_rss_mb 97.7, peak_rss_mb 6029, warm_tenants 997 tenants, measured_warm_tenants 300, warm_rss_mb 2193, mb_per_warm_tenant 7.127, warm_threads 961, warm_open_files 2775, trickle_ok_pct 99.99
Target: ≥ 1,000 registered, ≥ 300 warm (fail: < 100 warm) → PASS
Notes: profile dev-laptop, runs 3; not node-small: relative comparison only, never pass/fail; warmed 1000 tenants in 10 s (0 failed: {}), peak RSS 6029.1 MB, 3023 threads; baseline RSS 54.9 MB (9 threads, 11 files); right after the last eviction 5397.9 MB; 35 s later 97.7 MB (9 threads, 11 files); 300 warm tenants at 1 req/s for 60 s: 18107/18108 ok, steady RSS 2193.1 MB (7.13 MB per warm tenant), threads 961, open files 2775
Raw: bench/results/raw/2026-10-27-B3-h2-146.json

Verdict: **PROVISIONAL PASS**. `registered_tenants` is 1,000 of 1,000 (0 failed cold first requests at 8 concurrent cold starts), and `warm_tenants` is 997 extrapolated to `node-small` (target ≥ 300). Measured on the same 4 vCPU / 16 GB cloud container as #35, not `node-small`.

## Findings (#146)

- **Cause of the failed cold first requests.** B2/B3 now record failing first requests by error code. Before the fix, every failure was `RENOX_CPU_LIMIT`: 1 of 1,000 in each of three B2/B3 runs during #144. The first request of a fresh isolate loaded Deno's lazy extension modules (`Request`, `Response`, streams, `URL`) inside its 50 ms CPU budget, and under 8 concurrent cold starts on 4 vCPUs that sometimes went over.
- **Fix (commit for #145):** those modules are evaluated into the platform snapshot, so no request loads them. `tests/dispatch.rs::request_and_response_modules_are_in_the_snapshot` checks this and runs ten fresh isolates' first requests within a 10 ms budget.
- **After the fix:** this B3 run and two B2 runs (`raw/2026-10-27-B2-h2-146.json`, `-146b.json`) had **0 failed cold first requests in 3,000**. Peak RSS during the warm-up fell from 7.2 to 6.0 GB, and the cost per warm tenant fell from 8.95 to 7.13 MB, because the modules are now shared snapshot data instead of being compiled again in every isolate.
- Trickle: 18,107 of 18,108 requests answered 200; the one exception is not explained by this run.
