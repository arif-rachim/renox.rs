# B5 — Hello function latency — 2026-10-27
Hardware: dev-laptop (Intel(R) Core(TM) i7-6700 CPU @ 3.40GHz, 8 vCPU, 15 GB RAM, Linux 7.0.0-38-generic), git c3b527c, rustc 1.99.1, bun 1.4.4, node 24.21.0, deno n/a
Scenario: hello function, one pinned warm worker, 1000 sequential requests per run after 100 warm-up requests, client-side time to headers over HTTP (informational: the target is in-node), median run of 3
Result: p50_ms 0.659 ms, p99_ms 1.233 ms, run1_p50_ms 0.677, run1_p99_ms 1.279, run2_p50_ms 0.659, run2_p99_ms 1.233, run3_p50_ms 0.648, run3_p99_ms 1.251
Target: p50 ≤ 0.3 ms, p99 ≤ 2 ms (fail: p99 > 5 ms) → FAIL
Notes: profile dev-laptop, runs 3; not node-small: relative comparison only, never pass/fail; p50_ms 0.659 ms misses the target 0.3 ms; informational, measured over HTTP not in-node; run 1: p50 0.677 ms, p99 1.279 ms; run 2: p50 0.659 ms, p99 1.233 ms; run 3: p50 0.648 ms, p99 1.251 ms
Raw: bench/results/raw/2026-10-27-B5.json

Verdict: **informational**, as issue #7 asks. The B5 target (p50 ≤ 0.3 ms) is defined in-node without HTTP; this run goes through the loopback port, Docker's port mapping, the main service's `worker.fetch()` hop, and Bun's `fetch`, so it is an upper bound on the in-node number, not a pass/fail.

## What was measured

- One pinned warm `hello` worker per run (`--policy per_worker`), 100 untimed warm-up requests, then 1,000 sequential timed requests; client-side time to response headers.
- Per run: p50 0.677 / 0.659 / 0.648 ms, p99 1.279 / 1.233 / 1.251 ms.
- The baseline file measured Bun + Hono at p50 0.98 ms and Node + Hono at 2.61 ms with `oha -c 64` (64 concurrent connections, throughput mode), so the two numbers are not directly comparable; the in-node B5 and the over-HTTP B11 come in F1 on the real worker (#35).
