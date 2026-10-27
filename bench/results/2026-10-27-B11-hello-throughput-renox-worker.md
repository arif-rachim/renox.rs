# B11 — Throughput — 2026-10-27
Hardware: dev-laptop (Intel(R) Xeon(R) Processor @ 2.10GHz, 4 vCPU, 16 GB RAM, Linux 6.18.44-fc-v165), git 6b254d7, rustc 1.99.1, bun 1.4.4, node 22.22.0, deno n/a
Scenario: examples/hello GET /api/hello on renox-worker (release), 64 keep-alive connections, 30 s warm-up + 60 s per run, median of 3 runs (bun load generator on the same machine)
Result: req_per_s 18897 req/s, p50_ms 3.115, p99_ms 8.381, worker_rss_mb 118.7, run1_req_per_s 19433, run1_p99_ms 7.737, run2_req_per_s 18871, run2_p99_ms 8.917, run3_req_per_s 18897, run3_p99_ms 8.381
Target: ≥ 40k req/s (fail: < 15k req/s) → FAIL
Notes: profile dev-laptop, runs 3; not node-small: relative comparison only, never pass/fail; req_per_s 18897 req/s misses the target 40000 req/s; run 1: 19433 req/s, p50 3.07 ms, p99 7.737 ms, 0 errors (bun); run 2: 18871 req/s, p50 3.078 ms, p99 8.917 ms, 0 errors (bun); run 3: 18897 req/s, p50 3.115 ms, p99 8.381 ms, 0 errors (bun)
Raw: bench/results/raw/2026-10-27-B11-f1.json

Verdict: **PROVISIONAL FAIL** (18.9k req/s against 40k; inside the 15k fail threshold). Measured on a 4 vCPU / 16 GB cloud container with the load generator on the same machine, not `node-small`.

## F1 findings

- **One isolate per deployment is one core.** Every request of the `hello` deployment runs on the isolate's single thread (`crates/renox-runtime` README, "Thread model"); 64 connections queue on it. The gateway's Tokio threads and the load generator share the remaining cores.
- **The load generator is in-process Bun on the same 4 vCPU**, because `oha` is not installed in this environment (a binary download was not permitted). It used about one core itself, so the worker had at most three. The number is a lower bound; re-run with `oha` from a separate machine per the methodology.
- p50 3.1 ms / p99 8.4 ms at 64 connections is queueing on the one isolate thread, not handler time (B5's sequential p50 is 0.28 ms).
- Levers: more than one isolate per hot deployment (the contract's concurrency model allows it; the runtime would need a pool of isolate threads per `IsolateHandle`), and measuring on `node-small` with an external generator. Follow-up issue opened.
