# B4 — Cold start — 2026-10-27
Hardware: dev-laptop (Intel(R) Core(TM) i7-6700 CPU @ 3.40GHz, 8 vCPU, 15 GB RAM, Linux 7.0.0-38-generic), git c3b527c, rustc 1.99.1, bun 1.4.4, node 24.21.0, deno n/a
Scenario: hello function, 200 cold samples per run, worker evicted after every request (--policy oneshot), client-side time to response headers, median run of 3
Result: p50_ms 32.31 ms, p99_ms 38.66 ms, run1_p50_ms 32.28, run1_p99_ms 40.03, run2_p50_ms 32.31, run2_p99_ms 38.66, run3_p50_ms 32.33, run3_p99_ms 39.71
Target: p50 ≤ 20 ms, p99 ≤ 100 ms (fail: p99 > 100 ms) → FAIL
Notes: profile dev-laptop, runs 3; not node-small: relative comparison only, never pass/fail; p50_ms 32.31 ms misses the target 20 ms; run 1: p50 32.28 ms, p99 40.03 ms, retired workers +200 for 200 requests, active 0 (eviction verified); run 2: p50 32.31 ms, p99 38.66 ms, retired workers +200 for 200 requests, active 0 (eviction verified); run 3: p50 32.33 ms, p99 39.71 ms, retired workers +200 for 200 requests, active 0 (eviction verified)
Raw: bench/results/raw/2026-10-27-B4.json

Verdict on this profile: **PROVISIONAL FAIL on the p50 target** (32 ms against ≤ 20 ms); p99 39 ms is well inside the ≤ 100 ms limit and the kill criterion (p99 > 100 ms) is not hit. Pass/fail is only final on `node-small`.

## What was measured

- Runtime: pinned image `v1.77.8` (`EDGE_RUNTIME_MODE=docker`), started with `--policy oneshot`, which terminates the user worker after it has served one request. Every sample is therefore: request arrives at the main service → `EdgeRuntime.userWorkers.create()` → Deno loads `examples/hello/_spike/index.ts` and `functions/api/hello.ts` from the staged directory → handler runs → response headers reach the client.
- Eviction verified per run: `retiredUserWorkersCount` advanced by exactly 200 for 200 requests and `activeUserWorkersCount` was 0 afterwards (notes above). No process restart was needed, so no startup time had to be subtracted.
- Clock: `performance.now()` in Bun around `fetch()` until the response headers, through the loopback port and Docker's port mapping. The same path measures 0.66 ms for a warm worker (B5), so roughly 0.7 ms of the 32 ms is transport, not cold start.
- Per run: p50 32.28 / 32.31 / 32.33 ms, p99 40.03 / 38.66 / 39.71 ms. The spread between runs is under 1%.

## Reading it

- This is **without** a snapshot or an eszip bundle: the module graph is read and transpiled from TypeScript source on every boot. B4's scenario text in `docs/14-benchmarks.md` is "snapshot + eszip load + first request"; both are F1 work (`crates/renox-runtime`, D19) and both reduce exactly the part measured here. The number to beat is 32 ms, not 20 ms, and the gap is 12 ms.
- Comparison with the baseline (`2026-10-27-BASE-HELLO-bun-node-hono.md`): a fresh Bun process answers in p50 18 ms, Node in 134 ms. The isolate without snapshot sits between them and costs a tenth of the memory of a Bun process (B1).
- Not on `node-small`; measured on an 8-vCPU desktop-class CPU.
