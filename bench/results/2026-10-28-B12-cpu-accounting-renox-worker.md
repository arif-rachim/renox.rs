# B12 — Noisy neighbor, CPU accounting under concurrency (#155) — 2026-10-28
Hardware: dev-laptop (Intel(R) Xeon(R) Processor @ 2.80GHz, 4 vCPU, 16 GB RAM, Linux 6.18.44-fc-v180), renox-worker git e1fb730, rustc 1.99.1, bun 1.4.4, node 22.22.0
Scenario: as B12 H2 (tenant B `examples/shop` with shared chunks, GET /api/products, 16 keep-alive connections, 10 s warm-up, 60 s alone then 60 s while tenant A's `examples/evil` /api/loop and /api/alloc get 50 req/s), 4 sets of 3 runs each
Result: B requests not ok 0 / 0 / 0 / 0 (H2: 16, in 3 of 4 sets); b_p99_change_pct −0.36 / −0.8 / 2.21 / 1.16 %; a_termination_error_ms (p99) 5.41 / 8.85 / 6.11 / 5.95; a_termination_error_median_ms 1.03 / 1.03 / 1.00 / 1.00; b_p50_alone_ms 17.88 / 17.14 / 17.04 / 16.58; b_p99_alone_ms 32.7 / 31.83 / 31.9 / 30.84
Target: 0 spurious recycles of B in 4 sets (#155) → met; B's p99 changes ≤ 10 % → met; A terminated at its CPU limit ± 5 ms → missed (p99 5.4–8.8 ms, better than H2's 13.2 ms)
Notes: profile dev-laptop, not node-small: relative comparison only, never pass/fail (`docs/14-benchmarks.md`). Collateral records of A (6,758–6,765 per set) are unchanged: one isolate per deployment until #156.
Raw: bench/results/raw/2026-10-28-B12-155-set1.json … -set4.json, bench/results/raw/2026-10-28-B12-155.hw.json

## Root cause

The isolate thread runs JavaScript only inside its loop's poll, one "slice" per poll. Until this change, at the end of every slice **every request still in flight was charged the whole slice's CPU** (runtime README, "CPU accounting", F1 wording). On a busy isolate a request is in flight during the slices that run the other requests' work too, so its `cpu_ms` grows with its wall time, not with its own work. Under B12, tenant B's 16 connections keep B's single `shop` isolate near saturation (about 900–1,400 req/s at 0.7–1 ms of CPU each), so each request was charged roughly its whole latency: p50 about 11 ms, p99 about 22 ms. A latency spike to 50 ms or more, with the isolate busy all the time, then charged more than the 50 ms free-tier limit to the requests waiting through it. The watchdog terminated the isolate and every request on it ended (2 × 503 `RENOX_CPU_LIMIT`, 14 × 500 in H2). The shared-chunk `shop` build has a slightly higher CPU cost per request than the pre-#143 bundles, which moves the isolate closer to saturation. That explains why the event showed up with that build and not without it. GC and allocator trims had been ruled out in #146.

A second, smaller over-count had the same cause. A slice's watchdog budget was the smallest remaining budget of the requests in flight, measured against the CPU of the whole slice. One poll that resolved many requests' ops could therefore exceed the limit without any single request doing so.

Reproduced with `crates/renox-runtime/tests/cpu_accounting.rs` against the F1 accounting (debug build, the same machine): 16 concurrent requests that each do about 1 ms of their own JavaScript in four rounds separated by timers were charged 12.2–15.8 ms each, 221 ms in total for about 29 ms of work (8.6× the solo cost for the worst request). With about 7× more work per request, all 16 crossed the 50 ms limit and the isolate was recycled.

## Fix

`crates/renox-runtime/src/limits/cpu.rs` (`CpuLedger`) and `src/isolate.rs`:

- **Attribution per async context.** Before calling the handler, the isolate sets V8's continuation-preserved embedder data to an object holding the request's token. It uses a key that the bootstrap's `AsyncVariable` spread (`{ ...previous, [id]: entry }`) carries along. V8 restores that value for every promise reaction the request creates (`await` continuations, `then` callbacks, ops, and deno's timers). Context-level `before`/`after` promise hooks report each switch, and the ledger charges the thread CPU of each run to the request it belongs to.
- **Unattributed CPU** (platform glue between reactions) is split evenly among the requests in flight, rounded up. With one request in flight everything is its own, as before, so a single request is never under-counted.
- **Watchdog budget follows the running context.** For a request's own run, the budget is that request's remaining CPU. For unattributed work, it is the smallest remaining CPU among the requests in flight, or the whole limit when none is in flight (orphaned timers). A seqlock keeps the watchdog's (start, budget) pair consistent when it is re-armed at a switch.

The first version used the isolate-level `SetPromiseHook`, which also calls into the embedder on every promise `init` and `resolve`. The final version uses context hooks with only `before` and `after` set. In short B12 runs on the same machine (1 × 30 s, two rounds each), B's p50 alone was 16.1 / 15.0 ms for `main` (1513eed), 14.8 / 16.7 ms with the isolate hook, and 16.4 / 15.7 ms with context hooks. That is no measurable difference. The host was slower than on 2026-10-27, where `main` measured 11.6 ms. One full set with the isolate hook gave 0 requests not ok (`raw/2026-10-28-B12-155-isolate-hook.json`).

## Tests

- `cpu_accounting.rs::concurrent_light_requests_are_charged_their_own_cpu`: 16 concurrent light requests on one isolate. Each is charged at most 2× its solo cost (measured 0.94–1.07×), at least 0.8× its own JavaScript work, and none is ended. Typical run: solo 1.6 ms, own work 0.95 ms, charged 0.92–1.85 ms.
- `cpu_accounting.rs::infinite_loop_among_concurrent_requests_is_terminated_at_its_own_limit`: an infinite loop that starts while 15 requests are in flight is terminated at 50.6–51.2 ms of its own CPU.
- `limits/cpu.rs` unit tests: ledger (lone request, 16 concurrent requests, budget per context, split rounding) and the seqlock.
- `tests/limits.rs` unchanged and green.

## Open

- B12 on `node-small` with the load generator on another machine (#158) is still the judge. These numbers are relative.
- The runtime README's "CPU accounting" paragraph still describes the F1 model. It is outside #155's files; see the PR.
