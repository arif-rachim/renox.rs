# B14 — One heartbeat ticker per hub, one shared state per connection (#680, task 2) — 2026-11-10

| | |
| --- | --- |
| Host | dev container: Intel(R) Xeon(R) Processor @ 2.10GHz, 4 vCPU, 16 GB RAM, Linux 6.18.44-fc-v338 |
| Build | release `renox-worker`, `CARGO_PROFILE_RELEASE_DEBUG=0` |
| Before | #680 task 1 (`b9f71b8`, `bench/results/2026-11-10-B14-idle-memory-reduction.md`) |
| After | task 2 (`crates/renox-realtime/src/hub.rs`, `ws.rs`) |
| Scenario | `bench/run.sh B14 --runs 3` (10 s hold) and one run with `B14_HOLD_S=30`; B1 `shop` N = 100 |

Not the gate's verdict: the dev container is for relative comparison only.

## The change

- **No timer per connection.** `ws::serve` held a `tokio::time::Sleep` (112 bytes, in the connection's task) for the next ping or pong deadline. Now it writes the deadline into the connection's shared state (`Conn::set_beat`) and waits on `Conn::beat()`. One ticker task per hub wakes every `HEARTBEAT_TICK` (1 s), walks the hub's connections and wakes only those whose deadline has passed. It holds the hub weakly, starts with the first waiting connection and stops when the hub has none. A ping or a heartbeat close can be up to 1 s late. That is within the contract (ping every 30 s, pong within 10 s, else 1001), and `heartbeat_timeout_closes` passes unchanged.
- **One shared state for the close signal, the heartbeat and the reader/writer control state.** `CloseSignal` (hub) now also holds the `ws` reader-to-writer `Ctrl`, which was its own `Arc` per connection.
- **Not merged: the outbound queue.** `queue::Shared<T>` is the generic per-connection queue that `ws::inbox` also uses. Folding the close signal into it would need a queue that carries a payload of the hub's, for about 32 bytes, a malloc header and the `Arc` counts. Left as is.

## Result

| Worker | RSS delta, 3 runs (10 s hold) | Median | 30 s hold, RSS at 10 s / at 30 s |
| --- | --- | --- | --- |
| task 1 | 86.4, 85.0, 85.7 MB | **85.7 MB** | 85.9 / 85.9 MB |
| task 2 | 83.0, 80.2, 79.7 MB | **80.2 MB** | 80.0 / **80.0 MB** |
| **change** | | **−5.5 MB** | |

The crate-side count of `cargo test --release -p renox-realtime --test scale per_connection_heap_budget` went from **1,896** to **1,841** heap bytes per idle connection, budget 2,048. The RSS gain is larger than those 55 bytes × 10,000. The counting allocator sees only the crate's own allocations, and this was not profiled further. The likely rest: tokio's timer driver no longer holds an entry for each connection, and 10,000 fewer small long-lived allocations mean less fragmentation in the malloc arenas.

B1 (`shop`, N = 100): 9.89, 9.90, 9.90 MB, **9.90 MB**, V8 heap 3.95 MB. Unchanged, since B1 opens no realtime connections.

Gap to the refinement's 75 MB: **5.2 MB**.

Raw: `bench/results/raw/2026-11-10-B14-680-task2*.json`, `bench/results/raw/2026-11-10-B1-680-task2.json`.

## Reproduce

```sh
CARGO_PROFILE_RELEASE_DEBUG=0 cargo build --release --locked -p renox-cell --bin renox-worker
ulimit -n 20000
RENOX_WORKER_PATH=$PWD/target/release/renox-worker bench/run.sh B14 --runs 3
B14_HOLD_S=30 RENOX_WORKER_PATH=$PWD/target/release/renox-worker bench/run.sh B14 --runs 1
cargo test --release -p renox-realtime --test scale -- --nocapture
```
