# B11 — Throughput — 2026-10-27
Hardware: dev-laptop (Intel(R) Xeon(R) Processor @ 2.10GHz, 4 vCPU, 16 GB RAM, Linux 6.18.44-fc-v165), git 53aed0e plus the uncommitted #145 changes of batch H2 (lazy readers, artifact cache, extension modules in the snapshot), rustc 1.99.1, bun 1.4.4, node 22.22.0, deno n/a
Scenario: examples/hello GET /api/hello on renox-worker (release), 64 keep-alive connections, 30 s warm-up + 60 s per run, median of 3 runs (bun load generator on the same machine)
Result: req_per_s 21094 req/s, p50_ms 2.79, p99_ms 7.662, worker_rss_mb 124.2, run1_req_per_s 21425, run1_p99_ms 7.033, run2_req_per_s 19471, run2_p99_ms 10.72, run3_req_per_s 21094, run3_p99_ms 7.662
Target: ≥ 40k req/s (fail: < 15k req/s) → FAIL
Notes: profile dev-laptop, runs 3; not node-small: relative comparison only, never pass/fail; req_per_s 21094 req/s misses the target 40000 req/s; run 1: 21425 req/s, p50 2.771 ms, p99 7.033 ms, 0 errors (bun); run 2: 19471 req/s, p50 2.841 ms, p99 10.725 ms, 50 errors (bun); run 3: 21094 req/s, p50 2.79 ms, p99 7.662 ms, 0 errors (bun)
Raw: bench/results/raw/2026-10-27-B11-h2.json

Verdict: **PROVISIONAL FAIL, findings recorded**. 21.1k req/s against the 40k target (was 18.9k in [the #35 run](2026-10-27-B11-hello-throughput-renox-worker.md)). The load generator is still Bun on the same 4 vCPU machine (`oha` is not available in this container and there is no second machine), so client and worker share the CPUs. Not `node-small`. Run 2 had 50 client-side errors from the Bun generator under load; runs 1 and 3 had none.

## Findings (#145)

- One deployment still runs on one isolate thread. The difference from #35 is within run-to-run spread (19.5k–21.4k here, 18.9k–19.4k before), so this batch did not change throughput in a measurable way.
- **Not done: N isolates per `IsolateHandle`.** The handle owns one current isolate thread, and recycling, termination, the CPU watchdog, the create-failure cache, and the per-deployment concurrency limit all assume that. Running several needs a pool inside the handle, with dispatch, recycle, and `terminate()` across members. Those are the limit and termination paths that prove `docs/24-threat-model.md` rows, so the change is left for its own issue, with tests for each limit per member.
- **Not done: pre-created isolates for hot deployments.** Same reason as in the B4 finding: tenant state is bound at bootstrap.
- To judge the 40k target, B11 must be re-run with `oha` from a separate machine against `node-small`.
