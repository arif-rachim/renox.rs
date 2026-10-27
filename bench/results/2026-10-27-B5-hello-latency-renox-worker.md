# B5 — Hello function latency — 2026-10-27
Hardware: dev-laptop (Intel(R) Xeon(R) Processor @ 2.10GHz, 4 vCPU, 16 GB RAM, Linux 6.18.44-fc-v165), git 0e3c906, rustc 1.99.1, bun 1.4.4, node 22.22.0, deno n/a
Scenario: examples/hello GET /api/hello on renox-worker (release), 64 keep-alive connections, 30 s warm-up + 60 s per run, median of 3 runs (bun load generator on the same machine); plus 1,000 sequential requests on one connection
Result: p50_ms 2.999 ms, p99_ms 8.225 ms, req_per_s 19508, sequential_p50_ms 0.284, sequential_p99_ms 1.274, worker_rss_mb 135.4, run1_req_per_s 12909, run1_p99_ms 28.4, run2_req_per_s 19508, run2_p99_ms 8.225, run3_req_per_s 20474, run3_p99_ms 7.626
Target: p50 ≤ 0.3 ms, p99 ≤ 2 ms (fail: p99 > 5 ms) → FAIL
Notes: profile dev-laptop, runs 3; not node-small: relative comparison only, never pass/fail; p50_ms 2.999 ms misses the target 0.3 ms; p99_ms 8.225 ms crosses the fail threshold 5 ms; run 1: 12909 req/s, p50 3.563 ms, p99 28.398 ms, 650 errors (bun); run 2: 19508 req/s, p50 2.999 ms, p99 8.225 ms, 0 errors (bun); run 3: 20474 req/s, p50 2.914 ms, p99 7.626 ms, 0 errors (bun)
Raw: bench/results/raw/2026-10-27-B5-f1.json

Verdict: **PROVISIONAL**: under 64 connections p50 3.0 ms / p99 8.2 ms (FAIL against the in-node targets, as expected for queueing on one isolate thread, see B11); **sequential on one keep-alive connection p50 0.284 ms / p99 1.274 ms, inside the B5 targets (p50 ≤ 0.3 ms, p99 ≤ 2 ms) even with HTTP and the gateway in the path**. The B5 target is defined warm and in-node, so the sequential number is the one to compare; it is an upper bound on in-node. Measured on a 4 vCPU / 16 GB cloud container, not `node-small`.

## F1 findings

- The full request path (gateway: rate limit, host lookup, header filtering, body limit; cell: admission, meter record; runtime: route match, dispatch into the isolate, `Response` serialisation) costs under 0.3 ms at p50 for `hello`.
- Run 1 (12.9k req/s, p99 28 ms) was slower than runs 2 and 3 (19.5k / 20.5k): the first run starts on a fresh process with the B11 run's page cache state; the median run is reported.
- F0 measured 0.659 ms p50 over HTTP on the Edge Runtime spike (different hardware); the F1 worker is about 2× faster sequentially.
