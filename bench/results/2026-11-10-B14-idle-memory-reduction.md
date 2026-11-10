# B14 — The isolate gives its heap back when it goes idle after a burst (#680, task 1) — 2026-11-10

| | |
| --- | --- |
| Host | dev container: Intel(R) Xeon(R) Processor @ 2.10GHz, 4 vCPU, 16 GB RAM, Linux 6.18.44-fc-v338 |
| Build | release `renox-worker`, `CARGO_PROFILE_RELEASE_DEBUG=0` |
| Before | this branch after #640 and #642 (`30e61d4`, the same worker code as `1a839dd`) |
| After | task 1 of #680 (`crates/renox-runtime/src/isolate.rs`, `serve`) |
| Scenario | `bench/run.sh B14 --runs 3` (`examples/chat`, 10,000 idle WebSocket connections of one user to one room, held 10 s), and one run with `B14_HOLD_S=30` |
| Target | `docs/14-benchmarks.md` B14: ≤ 50 MB, red line 150 MB; #680's refinement: ≤ 75 MB on the dev container |

Not the gate's verdict: the dev container is for relative comparison only (`bench/README.md`). The `node-small` run is #522 task 3.

## The change

When an isolate has run at least 256 invocations since its last memory-reducing collection, and then has nothing in flight for 1 s, it calls V8's `LowMemoryNotification`. That is a full collection that also releases the heap pages V8 no longer needs. It runs on the isolate thread outside any request, so no invocation is charged for it. A new command cancels the idle timer, and the count starts again after the collection.

B14 needs this because each connection runs the isolate twice (`connect` and `open`). The garbage of 20,000 runs made V8 commit about 37 MB of heap pages that it did not give back within the 10 s hold (#680, item 1). It gave back about 18 MB roughly 20 s later, which the 30 s run below shows.

Each pool member now publishes its heap at its idle points (`used`, `committed`, number of reductions) through `IsolateHandle::heap_stats()`, which the test reads.

## Result

| Worker | RSS delta, 3 runs (10 s hold) | Median | 30 s hold, RSS at 10 s / at 30 s | `heap_delta_mb` (median) |
| --- | --- | --- | --- | --- |
| before (#640, #642) | 113.8, 117.8, 120.9 MB | **117.8 MB** | 119.3 / **100.8 MB** | 4.28 MB |
| task 1 | 86.4, 85.0, 85.7 MB | **85.7 MB** | 85.9 / **85.9 MB** | −0.48 MB |
| **change** | | **−32.1 MB (−27 %)** | | |

At 10,000 connections that is 8.6 KB per connection, against 11.8 KB before. The RSS no longer moves during the hold: the 30 s run reads 192.2 MB from second 4 to second 30. Before, RSS dropped from 221.8 to 203.2 MB at about second 19. `heap_delta_mb` (the isolate heap a page request sees after the connections) is now below the heap before the connections, because the reduction also compacted the warm-up garbage.

B1 (`shop`, N = 100, same host) with task 1: 9.88, 9.88, 9.88 MB, **9.88 MB**, V8 heap 3.93 MB, unchanged. Each B1 isolate serves one request, far below the 256-run threshold, so no collection runs there.

The 75 MB of the refinement is not reached: 10.7 MB remain. Tasks 2 and 3 follow.

Raw: `bench/results/raw/2026-11-10-B14-680-base*.json` (before; `-hold30` is the 30 s run), `bench/results/raw/2026-11-10-B14-680-task1*.json`, `bench/results/raw/2026-11-10-B1-680-task1.json`.

## Test

`crates/renox-runtime/tests/idle_memory.rs`:
- `an_idle_isolate_gives_heap_back_after_a_burst_of_realtime_runs`: 1,000 `connect` and `open` runs of a `ws` route, then idle. One reduction ran, and the committed heap is within 2 MB of the heap in use. The debug build printed `after the burst: used 4599 KB, committed 15104 KB; after the idle collection: used 3412 KB, committed 4096 KB`.
- `a_few_requests_run_no_memory_reducing_collection`: 10 requests and 1.5 s idle run no reduction.

## Reproduce

```sh
CARGO_PROFILE_RELEASE_DEBUG=0 cargo build --release --locked -p renox-cell --bin renox-worker
ulimit -n 20000
RENOX_WORKER_PATH=$PWD/target/release/renox-worker bench/run.sh B14 --runs 3
B14_HOLD_S=30 RENOX_WORKER_PATH=$PWD/target/release/renox-worker bench/run.sh B14 --runs 1
cargo test -p renox-runtime --test idle_memory -- --nocapture
```
