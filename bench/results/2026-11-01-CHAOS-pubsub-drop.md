# CHAOS pubsub-drop — Realtime client links dropped — 2026-11-01
Hardware: node-small (AMD EPYC Processor (with IBPB), kernel 6.8.0-147-generic), renox-worker 46fdfce, bun 1.4.4
Command: `CARGO_PROFILE_RELEASE_DEBUG=0 cargo build --release --locked -j 3 -p renox-cell --bin renox-worker` (RUSTY_V8_ARCHIVE from `ops/v8-archive.sh fetch`), then `sudo env PATH=$PATH RENOX_WORKER_PATH=$PWD/target/release/renox-worker RENOX_CHAOS_S3_ENDPOINT=http://127.0.0.1:9000 RENOX_CHAOS_S3_ACCESS_KEY_ID=… RENOX_CHAOS_S3_SECRET_ACCESS_KEY=… RENOX_CHAOS_S3_DOWN="kill -STOP <pid>" RENOX_CHAOS_S3_UP="kill -CONT <pid>" bench/chaos/run.sh all`, as root (loop mounts, tmpfs data directories), S3 from `rclone serve s3` v1.75.2 (MinIO no longer publishes binaries and its pinned images could not be pulled); every scenario of `all` but `storage-down` passed, and this file is from that run
Scenario: 20 SSE and 20 WebSocket clients on one topic through a TCP proxy, 50 messages per second published by a function; every client link cut for 1 s (inside the 100-event replay buffer), then for 4 s (past it), the node and its hub running throughout
Failure modes: "WebSocket message flood / oversized frame" (docs/23-failure-modes.md)
Result: 745 messages published (745×200); SSE missed 0–0 of 50 inside the buffer and 105–109 of 200 past it; every client reconnected 2–2 times; meter 371.9 s vs 368.7 s measured
Target: one reconnect per drop; SSE contiguous inside the replay buffer; past it, the buffer's events only and no error; no RENOX_REALTIME_LIMIT; meter seconds = connection seconds (±5 %) → PASS
Alerts: none
Checks:
- [x] the publisher sees nothing: publishes: 745×200
- [x] each cut drops every client link: proxied connections closed: 40 and 40 (40 clients)
- [x] each client reconnects exactly once per cut: reconnects per client: min 2, max 2 (2 cuts)
- [x] SSE inside the replay buffer: nothing missed: 50 events published during the 1 s cut; missing across the reconnect per client 0–0; every connection's stream without hole or repeat: true
- [x] SSE past the buffer: the newest 100 replayed, the older ones gone: 200 events during the 4 s cut; missing across the reconnect per client 105–109 (expected 100, plus what was published before the client was back)
- [x] WebSocket: no replay, a clean stream after each reconnect: missing across the reconnects per client 53–54 of 50 and 208–209 of 200 published during the cuts; every connection's stream without hole or repeat: true
- [x] no RENOX_REALTIME_LIMIT: 0 (client refusals plus `busy` records)
- [x] the meter records sum to the connection seconds: 120 records (60 WS, 60 SSE) for 120 connections; realtime_conn_seconds 371.9 s, client-measured 368.7 s (0.9 %)
Notes: The replay buffer is 100 events or 60 s, whichever is shorter (ops.md section 18): at 50 messages per second it holds 2 s, so the long cut is past it although it is well under 60 s. Past the buffer no event names the gap (#281 implements none; the contract says the client re-reads its state); the SSE `id:` jumps. The clients close while messages are still published: on a quiet topic the node sees an SSE client leave only at its next 15 s keep-alive (ops.md section 18), so that connection is metered until then. The cut is of the client links only; a worker restart takes the hub and its buffer with it (ids restart at 1), which no scenario here asserts.
Raw: bench/results/raw/2026-11-01-CHAOS-pubsub-drop.json
