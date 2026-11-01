# CHAOS control-plane-down — Control plane down — 2026-11-01
Hardware: node-small (AMD EPYC Processor (with IBPB), kernel 6.8.0-147-generic), renox-worker 46fdfce, bun 1.4.4
Command: `CARGO_PROFILE_RELEASE_DEBUG=0 cargo build --release --locked -j 3 -p renox-cell --bin renox-worker` (RUSTY_V8_ARCHIVE from `ops/v8-archive.sh fetch`), then `sudo env PATH=$PATH RENOX_WORKER_PATH=$PWD/target/release/renox-worker RENOX_CHAOS_S3_ENDPOINT=http://127.0.0.1:9000 RENOX_CHAOS_S3_ACCESS_KEY_ID=… RENOX_CHAOS_S3_SECRET_ACCESS_KEY=… RENOX_CHAOS_S3_DOWN="kill -STOP <pid>" RENOX_CHAOS_S3_UP="kill -CONT <pid>" bench/chaos/run.sh all`, as root (loop mounts, tmpfs data directories), S3 from `rclone serve s3` v1.75.2 (MinIO no longer publishes binaries and its pinned images could not be pulled); every scenario of `all` but `storage-down` passed, and this file is from that run
Scenario: control/api (PGlite in a directory) stopped for 15 s while a warm tenant takes reads and another writes, then started again on the same database
Failure modes: "Control plane unreachable from the worker" (docs/23-failure-modes.md)
Result: reads 73×200, writes 73×200; degraded after 0.0 s; recovered 2.3 s after the restart
Target: no error for warm tenants during the outage; /healthz degraded; nodes healthy again after the restart without a failover → PASS
Alerts: RenoxControlPlaneDown (metrics endpoint down during the outage)
Checks:
- [x] warm tenants keep serving: reads on node-chaos-2: 73×200; writes on node-chaos-1: 73×200
- [x] the worker reports the outage: control_plane degraded after 0.0 s
- [x] the control plane's metrics stop answering: GET /v1/ops/metrics: no answer (RenoxControlPlaneDown)
- [x] recovery after restart: both nodes healthy and heartbeating, /healthz ok, 2.3 s after the restart
- [x] heartbeats accepted after the restart: heartbeat age 15 s later: node-chaos-1 2.4 s, node-chaos-2 2.4 s (interval 10 s)
- [x] no failover from a short outage: after the restart t-chaos-a answers 200 on node-chaos-2; route entry on node-chaos-2
Notes: Artifacts live in the API's memory in this stack (no S3), so a cold start of an uncached deployment during or after the outage is not exercised here; storage-down covers it with S3. An outage longer than the 30 s threshold makes the first sweep after the restart see stale heartbeats and start failovers; that case is the node-kill scenario's.
Raw: bench/results/raw/2026-11-01-CHAOS-control-plane-down.json
