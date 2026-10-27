# B12 — Noisy neighbor — 2026-10-27
Hardware: dev-laptop (Intel(R) Xeon(R) Processor @ 2.10GHz, 4 vCPU, 16 GB RAM, Linux 6.18.44-fc-v165), git 9167700, rustc 1.99.1, bun 1.4.4, node 22.22.0, deno n/a
Scenario: tenant B examples/shop GET /api/products (100 rows) with 16 keep-alive connections, 10 s warm-up, 60 s alone then 60 s while tenant A's examples/evil /api/loop and /api/alloc get 50 req/s; median of 3 runs; A's termination from its meter records (free tier, CPU limit 50 ms)
Result: b_p99_change_pct 0.35 %, a_termination_error_ms 13.24 ms, a_termination_error_median_ms 1.219, a_terminations 2242, a_collateral 6760, b_p99_alone_ms 21.85, b_p99_with_a_ms 21.93, b_p50_alone_ms 11.59, b_p50_with_a_ms 11.29, b_not_ok 16
Target: B's p99 changes ≤ 10%; A terminated at its CPU limit ± 5 ms (fail: B's p99 changes > 25%) → FAIL
Notes: profile dev-laptop, runs 3; not node-small: relative comparison only, never pass/fail; a_termination_error_ms 13.245 ms misses the target 5 ms; run 1: B alone p50 11.438 / p99 21.231 ms (1381 req/s); with A p50 11.074 / p99 21.384 ms (1418 req/s); p99 change 0.7 %; A 3001 requests {"503":3001}; run 2: B alone p50 11.594 / p99 21.854 ms (1355 req/s); with A p50 11.293 / p99 21.931 ms (1388 req/s); p99 change 0.4 %; A 3000 requests {"503":3000}; run 3: B alone p50 11.794 / p99 22.134 ms (1335 req/s); with A p50 11.235 / p99 21.752 ms (1399 req/s); p99 change -1.7 %; A 3001 requests {"503":3001}; A meter records: loop 4502 (cpu_limit 4502), alloc 4500 (oom 0, cpu_limit 4500); A cpu_limit records: 9002, of which 2242 ran into the limit themselves (cpu_ms 50.342-93.605 ms) and 6760 were collateral (in flight on the terminated isolate); A loop cpu_ms at termination: min 0.011 median 0.154 max 93.605; B requests that did not end ok: 16
Raw: bench/results/raw/2026-10-27-B12-h2.json

Verdict: **PROVISIONAL FAIL, findings recorded**. Tenant B's p99 is unaffected by A (+0.35 %, target ≤ 10 %). A's termination error p99 is 13.2 ms against the 5 ms target, maximum 93.6 ms (#35: 10.8 ms p99, 131 ms maximum). **New in this batch: 16 of B's own requests did not end ok** (#35: 0). See below. Measured on the same 4 vCPU / 16 GB cloud container, not `node-small`.

## Findings (#146)

- **The termination tail is not a GC pause.** A diagnostic run with `--trace-gc` (not committed) recorded 356 GCs on A's large heaps: p50 1.1 ms, p99 11.6 ms, maximum 17 ms (an incremental mark finalisation at 64 MB). That cannot explain terminations 40–80 ms past the limit. The remaining suspects:
  - the CPU watchdog thread's wake-up latency while all 4 vCPUs are saturated (the Bun load generator, B's 16 connections, and A's 50 req/s run on the same machine);
  - long-running builtins (`new Array(1e6).fill()`) that do not check V8's interrupt flag.

  This container cannot tell them apart. The next step is B12 on `node-small` with the load generator on another machine, plus watchdog-latency counters.
- **The ± 5 ms bound is not met here.** I suggest documenting the bound in `docs/contracts/ops.md` section 10 through a contract issue (this batch may not edit `docs/contracts/**`). Proposed wording: "termination lands within one interrupt check of the limit: ± 5 ms for JavaScript loops; for a single builtin call or a GC in progress, after it returns; under host CPU saturation, also after the watchdog thread is scheduled".
- **B requests not ok (16, all at one moment, in run 2's B-alone phase while A was idle).** B's isolate charged 85 ms of CPU to two in-flight `GET /api/products` requests. Those two ended `RENOX_CPU_LIMIT`, the isolate was recycled, and the other 14 in-flight requests ended 500. The same event happened in 3 of 4 B12 sets with this batch, and in 0 of 4 sets with `examples/shop` built the pre-#143 way (one self-contained bundle per module). The new bootstrap alone gave 0 of 2.
  - Ruled out: allocator trims (none ran, since no cell was evicted) and GC (B's isolate's largest pause was 15 ms).
  - Not explained after two attempts. Reported on #143 and #146 for a decision before merge.
