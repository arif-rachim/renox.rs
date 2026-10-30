# CHAOS pubsub-drop — Realtime client links dropped — 2026-10-30
Hardware: node-small (AMD EPYC Processor (with IBPB), kernel 6.8.0-147-generic), renox-worker c949aac, bun 1.4.4
Command: `cargo build --release --locked -j 3 -p renox-cell --bin renox-worker` (RUSTY_V8_ARCHIVE from `ops/v8-archive.sh fetch`, litestream from `ops/scripts/fetch-litestream.sh`), then `BENCH_PROFILE=node-small RENOX_WORKER_PATH=$PWD/target/release/renox-worker sudo -E env "PATH=$PATH" bench/chaos/run.sh pubsub-drop --out bench/results`; the same scenario passed in three earlier runs and in `run.sh all` (storage-down skipped: no MinIO image could be pulled)
Scenario: 20 SSE and 20 WebSocket clients on one topic through a TCP proxy, 50 messages per second published by a function; every client link cut for 1 s (inside the 100-event replay buffer), then for 4 s (past it), the node and its hub running throughout
Failure modes: "WebSocket message flood / oversized frame" (docs/23-failure-modes.md)
Result: 745 messages published (745×200); SSE missed 0–0 of 50 inside the buffer and 107–108 of 200 past it; every client reconnected 2–2 times; meter 368.7 s vs 366.3 s measured
Target: one reconnect per drop; SSE contiguous inside the replay buffer; past it, the buffer's events only and no error; no RENOX_REALTIME_LIMIT; meter seconds = connection seconds (±5 %) → PASS
Alerts: none
Checks:
- [x] the publisher sees nothing: publishes: 745×200
- [x] each cut drops every client link: proxied connections closed: 40 and 40 (40 clients)
- [x] each client reconnects exactly once per cut: reconnects per client: min 2, max 2 (2 cuts)
- [x] SSE inside the replay buffer: nothing missed: 50 events published during the 1 s cut; missing across the reconnect per client 0–0; every connection's stream without hole or repeat: true
- [x] SSE past the buffer: the newest 100 replayed, the older ones gone: 200 events during the 4 s cut; missing across the reconnect per client 107–108 (expected 100, plus what was published before the client was back)
- [x] WebSocket: no replay, a clean stream after each reconnect: missing across the reconnects per client 54–55 of 50 and 207–208 of 200 published during the cuts; every connection's stream without hole or repeat: true
- [x] no RENOX_REALTIME_LIMIT: 0 (client refusals plus `busy` records)
- [x] the meter records sum to the connection seconds: 120 records (60 WS, 60 SSE) for 120 connections; realtime_conn_seconds 368.7 s, client-measured 366.3 s (0.7 %)
Notes: The replay buffer is 100 events or 60 s, whichever is shorter (ops.md section 18): at 50 messages per second it holds 2 s, so the long cut is past it although it is well under 60 s. Past the buffer no event names the gap (#281 implements none; the contract says the client re-reads its state); the SSE `id:` jumps. The clients close while messages are still published: on a quiet topic the node sees an SSE client leave only at its next 15 s keep-alive (ops.md section 18), so that connection is metered until then. The cut is of the client links only; a worker restart takes the hub and its buffer with it (ids restart at 1), which no scenario here asserts.
Raw: bench/results/raw/2026-10-30-CHAOS-pubsub-drop.json
