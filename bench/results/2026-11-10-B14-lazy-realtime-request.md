# B14 — The realtime ctx builds its `Request` and `URL` only when read (#680, task 3) — 2026-11-10

| | |
| --- | --- |
| Host | dev container: Intel(R) Xeon(R) Processor @ 2.10GHz, 4 vCPU, 16 GB RAM, Linux 6.18.44-fc-v338 |
| Build | release `renox-worker`, `CARGO_PROFILE_RELEASE_DEBUG=0`, the binary of task 2 (task 3 changes only `bootstrap.js`, which that binary reads from the checkout at isolate creation; see the measurement note in `2026-11-10-B14-hub-heartbeat.md`) |
| Before | #680 task 2 (`c8533d2`, `bench/results/2026-11-10-B14-hub-heartbeat.md`) |
| After | task 3 (`crates/renox-runtime/src/js/bootstrap.js`) |
| Scenario | `bench/run.sh B14 --runs 3` (10 s hold) and one run with `B14_HOLD_S=30`; B1 `shop` N = 100 |

## The change

`dispatchRealtime` built a `Request` and a `URL` for every `open`, `message` and `close` run, and `examples/chat`'s handlers read neither. Now `ctx.req`, `ctx.url` and `ctx.headers` of a realtime run are getters. The first read builds the object, and later reads in the same run return it. `ctxOf` copies the property descriptors of the request's base fields instead of spreading their values, so the getters stay getters on each module's frozen ctx. For a page or function request, whose fields are plain values, nothing changes.

Test: `crates/renox-runtime/tests/realtime_ctx.rs`. On a frozen ctx, `req` is an accessor. Reading `ctx.req`, `ctx.url` and `ctx.headers` gives the same objects every time, with the upgrade request's method, path and headers. `crates/renox-cell/tests/realtime.rs` (11 tests) passes unchanged.

## Result

| Worker | RSS delta, 3 runs (10 s hold) | Median | 30 s hold, RSS at 10 s / at 30 s |
| --- | --- | --- | --- |
| task 2 | 83.2, 83.0, 85.5 MB | **83.2 MB** | 83.3 / 83.3 MB |
| task 3 | 82.1, 81.4, 78.2 MB | **81.4 MB** | 80.6 / **80.6 MB** |
| **change** | | **−1.8 MB** | |

Task 1 already returns the garbage of the runs once the burst is over. What this saves is the garbage V8 holds while the connections open, part of which stays committed after the reduction, and the CPU of building two objects per run.

B1 (`shop`, N = 100): 9.89, 9.90, 9.91 MB, **9.90 MB**, V8 heap 3.94 MB. Unchanged, since B1 makes no realtime runs.

Raw: `bench/results/raw/2026-11-10-B14-680-task3*.json`, `bench/results/raw/2026-11-10-B1-680-task3.json`.

## #680 as a whole

| Step | B14 median (10 s hold) | B14 at 30 s | B1 `shop` N = 100 |
| --- | --- | --- | --- |
| before (#640, #642 on this branch) | 117.8 MB | 100.8 MB | 9.88 MB |
| task 1: memory-reducing collection when idle after a burst | 85.7 MB | 85.9 MB | 9.88 MB |
| task 2: one heartbeat ticker per hub, the `ws` control state shared | 83.2 MB | 83.3 MB | 9.89 MB |
| task 3: lazy `Request` and `URL` in realtime runs | **81.4 MB** | **80.6 MB** | 9.90 MB |

The total is −36.4 MB at 10 s (−31 %), down to 8.1 KB per connection. The RSS no longer falls during the hold, so the 10 s and 30 s readings agree.

**Remaining gap to the refinement's 75 MB: 6.4 MB** (0.64 KB per connection). To the B14 target of 50 MB: 31.4 MB. From #680's breakdown, what is left is mostly the malloc side of the worker path: about 4 to 5 KB of live heap per connection (the connection task's future, tokio's socket registration, the gateway's boxed socket with its idle timer, the hub's maps and queue, the owned handshake headers), plus 2 to 3 KB of fragmentation.

Candidates, not done here:
- the gateway's per-connection idle timer after an upgrade (`renox-gateway`);
- folding the outbound queue into the connection's shared state (needs a `queue` API change, about 32 bytes);
- the size of the connection task's future (`crates/renox-cell/src/realtime/mod.rs`).
