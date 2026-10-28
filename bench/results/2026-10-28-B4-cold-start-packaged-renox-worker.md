# B4 — Cold start, packaged renox-worker (#154) — 2026-10-28
Hardware: dev-laptop (Intel(R) Xeon(R) Processor @ 2.10GHz, 4 vCPU, 16 GB RAM, Linux 6.18.44-fc-v180), git 6f6d878 plus the uncommitted #154 changes (packaged feature), rustc 1.99.1, bun 1.4.4, node 22.22.0, deno n/a
Scenario: renox-worker (release, `--features renox-runtime/packaged`): first request of 199 fresh tenants on examples/hello (esm-dir), sequential, client-side time to the full response; median of 3 runs. Same machine, same commit, unpackaged release binary as the baseline
Result: p50_ms 21.37 ms, p99_ms 36.63 ms, worker_wall_p50_ms 20.9, worker_wall_p99_ms 36.14, warm_p50_ms 1.096, failed_cold_starts 0
Target: p50 ≤ 20 ms, p99 ≤ 100 ms (fail: p99 > 100 ms) → FAIL
Notes: profile dev-laptop, runs 3; not node-small: relative comparison only, never pass/fail; p50_ms 21.367 ms misses the target 20 ms; run 1: cold p50 21.367 / p99 36.631 ms (worker wall p50 20.898 / p99 36.138 ms), warm p50 1.096 ms; run 2: cold p50 21.687 / p99 42.341 ms (worker wall p50 21.224 / p99 41.738 ms), warm p50 1.145 ms; run 3: cold p50 20.276 / p99 33.144 ms (worker wall p50 19.722 / p99 32.532 ms), warm p50 1.05 ms; failed cold starts (all runs): {}
Raw: bench/results/raw/2026-10-28-B4-packaged.json (packaged), bench/results/raw/2026-10-28-B4-unpackaged.json (baseline)

Verdict: **B4 not worse.** The packaged binary's cold start is the same as the unpackaged one built from the same commit and measured right after it on the same container (p50 21.37 vs 21.28 ms, p99 36.63 vs 45.37 ms; run-to-run spread is about 1 ms at p50). Both miss the 20 ms p50 target as in [the H2 run](2026-10-27-B4-cold-start-h2-renox-worker.md) (22.32 ms). Provisional until the `node-small` re-run (#158).

| Binary | p50 ms | p99 ms | worker wall p50 ms | warm p50 ms | failed |
| --- | --- | --- | --- | --- | --- |
| packaged | 21.37 | 36.63 | 20.9 | 1.096 | 0 |
| unpackaged (baseline) | 21.28 | 45.37 | 20.75 | 1.088 | 0 |

Baseline notes: profile dev-laptop, runs 3; not node-small: relative comparison only, never pass/fail; p50_ms 21.284 ms misses the target 20 ms; run 1: cold p50 21.539 / p99 34.795 ms (worker wall p50 21.048 / p99 34.202 ms), warm p50 1.146 ms; run 2: cold p50 21.284 / p99 45.37 ms (worker wall p50 20.751 / p99 44.921 ms), warm p50 1.088 ms; run 3: cold p50 20.834 / p99 43.492 ms (worker wall p50 20.375 / p99 43.089 ms), warm p50 1.127 ms; failed cold starts (all runs): {}

## Process start

A packaged isolate starts from the same snapshot bytes, so cold start per tenant is not expected to change. What changes is process start: the unpackaged worker builds the platform snapshot from the Deno sources on start, the packaged one embeds it. Time from `exec` to the first `GET /api/hello` response (`hello.test`, fresh data directory), 3 runs each:

| Binary | run 1 | run 2 | run 3 |
| --- | --- | --- | --- |
| packaged | 51 ms | 48 ms | 39 ms |
| unpackaged | 485 ms | 513 ms | 540 ms |
