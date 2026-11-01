# CHAOS replica-lag — Replica lagging — 2026-11-01
Hardware: node-small (AMD EPYC Processor (with IBPB), kernel 6.8.0-147-generic), renox-worker 46fdfce, bun 1.4.4
Command: `CARGO_PROFILE_RELEASE_DEBUG=0 cargo build --release --locked -j 3 -p renox-cell --bin renox-worker` (RUSTY_V8_ARCHIVE from `ops/v8-archive.sh fetch`), then `sudo env PATH=$PATH RENOX_WORKER_PATH=$PWD/target/release/renox-worker RENOX_CHAOS_S3_ENDPOINT=http://127.0.0.1:9000 RENOX_CHAOS_S3_ACCESS_KEY_ID=… RENOX_CHAOS_S3_SECRET_ACCESS_KEY=… RENOX_CHAOS_S3_DOWN="kill -STOP <pid>" RENOX_CHAOS_S3_UP="kill -CONT <pid>" bench/chaos/run.sh all`, as root (loop mounts, tmpfs data directories), S3 from `rclone serve s3` v1.75.2 (MinIO no longer publishes binaries and its pinned images could not be pulled); every scenario of `all` but `storage-down` passed, and this file is from that run
Scenario: the tenant's Litestream sidecar stopped with SIGSTOP for 15 s during 10 writes per second, then SIGCONT
Failure modes: "Replica lagging / Litestream behind" (docs/23-failure-modes.md)
Result: max lag 16.6 s (metric 16.6), recovered 0.1 s after SIGCONT, writes 143×200
Target: no tenant error; lag reported above 10 s while frozen; under 5 s again within 60 s → PASS
Alerts: RenoxReplicationLag (condition true (16.6 s))
Checks:
- [x] the tenant sees nothing: writes during and after the freeze: 143×200
- [x] the lag passes the FO6 threshold: getBackups lag_seconds up to 16.6 s
- [x] the control plane's metric shows it: renox_cp_replication_lag_max_seconds up to 16.6 (RenoxReplicationLag fires above 10)
- [x] the lag recovers: under 5 s 0.1 s after SIGCONT
Notes: The control plane's lag metric is the nodes' last report, refreshed here by getBackups; the worker's own gauge comes with #295.
Raw: bench/results/raw/2026-11-01-CHAOS-replica-lag.json
