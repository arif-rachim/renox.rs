# B14 on the crate: 10,000 idle realtime connections (#278)

| | |
| --- | --- |
| Date | 2026-10-29 |
| Host | **dev container** (not `node-small`): 4 vCPU Intel Xeon @ 2.80 GHz, 15 GB RAM, Linux 6.18.44 |
| Build | release (`--release`) and debug test builds; tokio multi-thread runtime, 2 workers |
| Scenario | `crates/renox-realtime/tests/scale.rs`: one tenant `Hub` (paid limits), 10,000 WebSocket connections accepted and each served by `ws::serve` over an in-memory duplex stream (4 KB), each subscribed to `room:lobby`, an inbound channel of 16 per connection as the cell would hold; RSS (`/proc/self/statm`) before and 500 ms after; then one `publish` to all |
| Target | `docs/14-benchmarks.md` B14: 10,000 idle connections ≤ 50 MB |

## Result

| Build | RSS before | RSS after | Delta | Per connection |
| --- | --- | --- | --- | --- |
| release | 3 MB | 50 MB | **46.8 MB** | 4,909 bytes |
| debug (two runs) | 3 MB | 50 MB | 46.9 / 47.0 MB | 4,918 / 4,932 bytes |

Target met. One `publish` queued the message for all 10,000 connections.

The delta includes the test's own client ends of the duplex streams and the inbound channels the cell would hold. A first version with a second task per connection (a spawned reader) and an unboxed message type in the queue measured 79 MB (8.3 KB per connection). The tokio `mpsc` block of 32 slots per channel, and the second task, were most of the difference.

## Reading

This measures the crate, not a worker. The end-to-end B14 (gateway upgrade, cell, isolate heap unchanged, `node-small`) is #282 and O3 (#158). Command: `cargo test -p renox-realtime --release --test scale -- --nocapture`.
