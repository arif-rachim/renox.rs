# B14 per-connection memory in the worker: profile and fix (#522, task 2)

| | |
| --- | --- |
| Date | 2026-11-09 |
| Host | **dev container** (not `node-small`, owner decision of 2026-11-07 on #522): 4 vCPU Intel Xeon @ 2.10 GHz, 15 GB RAM, Linux 6.18.44 |
| Build | release `renox-worker` (`cargo build --release -p renox-cell --bin renox-worker`, `CARGO_PROFILE_RELEASE_DEBUG=0`; symbols kept for the profile) |
| Scenario | `bench/run.sh B14 --runs 3`: `examples/chat`, 10,000 idle WebSocket connections of one signed-in user to one room, held 10 s, load generator on the same host |
| Profile | `heaptrack` 1.5 on the worker with 1,000 and 3,000 connections, the worker killed during the hold (its leak report is then the heap live at that moment); `/proc/<pid>/smaps` by region type; `malloc_info` through `gdb` |
| Target | `docs/14-benchmarks.md` B14: ≤ 50 MB for 10,000 idle connections, red line 150 MB |

Not the gate's verdict: the dev container is a relative comparison only (`bench/README.md`). The `node-small` run is #522 task 3.

## Result

| Worker | RSS delta, 3 runs | Median | Per connection | Tokio tasks per connection |
| --- | --- | --- | --- | --- |
| `main` b866c13 | 237.5, 243.3, 241.8 MB | **241.8 MB** | 24.8 KB | 3 |
| this change | 118.9, 114.0, 117.4 MB | **117.4 MB** | 12.0 KB | 1 |

Under the red line (150 MB), not yet the 50 MB target. 10,000 of 10,000 sockets opened in every run. `heap_delta_mb` (the isolate heap a page request sees, the smallest peak of five requests) is 3.55 to 4.52 MB before and 5.19 to 6.57 MB after; it moves with when V8 last collected, and nothing in this change runs in the isolate or changes what the handlers get. Task 3 checks it on `node-small`. Raw: `bench/results/raw/2026-11-09-B14-dev-container-base*.json` and `...-fix*.json`.

`cargo test -p renox-realtime --release --test scale`: 10,000 connections in 38.1 MB of RSS (3,996 bytes each; 46.8 MB before), and the new `per_connection_heap_budget`: **1,896 heap bytes** per idle connection on the crate's side, budget 2,048.

## What one idle connection held (`main`, heaptrack, 3,000 connections)

About 24 KB of live heap per connection, almost all of it outside the hub:

| What | Per connection | Why it stayed |
| --- | --- | --- |
| hyper's read buffer of the connection | 8 KB | hyper parses the URI and the header values as slices of that buffer; the cell kept the request's `Parts` (URI, headers) for the connection's life, and the pending upgrade kept `Sec-WebSocket-Protocol`, so the whole buffer stayed |
| the cell's connection task | 2.8 KB | its future held every handler run (`open`, `message`, `close`) inline |
| the `ws::serve` task and the delivered-message relay task | 2.0 KB | two more tasks per connection |
| three tokio `mpsc` channels (hub queue, relay queue, inbound) | about 2 KB | each allocates its first block of 32 slots at creation |

The rest were smaller allocations of the handshake (hyper's header map, axum's extensions, the gateway's boxed socket), and freed memory glibc kept between the connections' long-lived allocations (about 23 MB free in the arenas at 10,000, `malloc_info`). Under heaptrack the isolate runs slower, so some `open` runs were still queued when the worker was killed; the rows above are the ones that stay after the runs end.

## The fix

- `crates/renox-cell/src/realtime/mod.rs`: one task per connection. The transport (`ws::serve`) and the handler loop are polled together (`tokio::join!`, a panic in the transport still ends as 1011 `transport`); each handler run is boxed only while it runs. No relay task: the hub's queue counts what the transport took (`Conn::delivered`). The handshake's URI and headers are copied into owned values (`owned_head`) and the pending upgrade is dropped once the socket is taken, so hyper's read buffer is freed after the handshake. A connection no longer keeps the CSP nonce. After a burst of 256 connections and 2 s without a new one, the cell runs the allocator trim the evictions already use (`crate::alloc::trim`): about 20 MB back at 10,000.
- `crates/renox-realtime/src/queue.rs` (new): the per-connection queue, a `VecDeque` and wakers behind one mutex. Nothing allocated until the first item, the smallest buffer at most once drained, `recv` and `send` futures of a reference and the item. It replaces `mpsc` for the hub's outbound queue and the WebSocket inbound queue (`ws::inbox`; `ws::serve` takes any `ws::InboundSink`, so an `mpsc::Sender` still works).
- `crates/renox-realtime/src/ws.rs`, `hub.rs`: the reader-to-writer control state and the close signal keep a waker instead of a `tokio::sync::Notify`; `ws::serve` keeps the four limit scalars instead of the whole `Limits`, and writes each step's frames at one await point. Its future went from 1,320 to 896 bytes.

## What is left (12 KB per connection at 10,000)

`smaps` of the fixed worker, 10,000 connections, after the trim:

| Region | Growth | Per connection |
| --- | --- | --- |
| V8 heap pages (256 KB regions of the isolate) | +37 MB | 3.7 KB |
| malloc arenas | about +70 MB | 7 KB |
| file-backed | +5 MB | 0.5 KB |

- **The isolate's committed heap.** Each connection runs the isolate twice (connect and `open`); their garbage makes V8 commit about 37 MB of heap pages that it does not give back within the 10 s hold, while the heap in use after a collection grows by a few MB only (`heap_delta_mb`). The cell has no way to ask the isolate for a memory-reducing collection; that is `renox-runtime` work, outside this task's files. In a longer hold (first version of the fix) the RSS fell by 17 MB about 20 s after the last connection opened, which looks like V8 giving pages back late.
- **Live heap of the worker path**, heaptrack with 1,000 connections: the connection task's future 2.0 KB (`ws::serve` 0.9 KB of it, the connection's context, the join), tokio's socket registration 256 bytes, the gateway's boxed socket with its idle timer about 320 bytes, the hub's maps, queues, close signal and control state about 600 bytes, the owned headers. About 4 to 5 KB.
- **Fragmentation** that the trim does not return, about 2 to 3 KB per connection.

The 50 MB target needs the isolate part: #680, the follow-up of #522.

## Reproduce

```
CARGO_PROFILE_RELEASE_DEBUG=0 cargo build --release --locked -p renox-cell --bin renox-worker
RENOX_WORKER_PATH=$PWD/target/release/renox-worker bench/run.sh B14 --runs 3
cargo test -p renox-realtime --release --test scale -- --nocapture
```
