# CHAOS node-kill — Node killed — 2026-11-01
Hardware: node-small (AMD EPYC Processor (with IBPB), kernel 6.8.0-147-generic), renox-worker 46fdfce, bun 1.4.4
Command: `CARGO_PROFILE_RELEASE_DEBUG=0 cargo build --release --locked -j 3 -p renox-cell --bin renox-worker` (RUSTY_V8_ARCHIVE from `ops/v8-archive.sh fetch`), then `sudo env PATH=$PATH RENOX_WORKER_PATH=$PWD/target/release/renox-worker RENOX_CHAOS_S3_ENDPOINT=http://127.0.0.1:9000 RENOX_CHAOS_S3_ACCESS_KEY_ID=… RENOX_CHAOS_S3_SECRET_ACCESS_KEY=… RENOX_CHAOS_S3_DOWN="kill -STOP <pid>" RENOX_CHAOS_S3_UP="kill -CONT <pid>" bench/chaos/run.sh all`, as root (loop mounts, tmpfs data directories), S3 from `rclone serve s3` v1.75.2 (MinIO no longer publishes binaries and its pinned images could not be pulled); every scenario of `all` but `storage-down` passed, and this file is from that run
Scenario: two controlled renox-workers, control/api sweeping every 5 s (unhealthy after 30 s), file replica; the owner of a tenant killed with SIGKILL after 10 s of writes (B18)
Failure modes: "Node dies" (docs/23-failure-modes.md)
Result: RTO 31.0 s, RPO 0.36 s, 101 rows lost, bystander 387×200
Target: RTO ≤ 60 s, RPO ≤ 10 s (B18), no error for a tenant on the surviving node → PASS
Alerts: RenoxNodeUnhealthy (condition true after 30.7 s)
Checks:
- [x] RTO ≤ 60 s: 31.0 s from SIGKILL to the first 200 on node-chaos-1
- [x] the surviving node stays healthy: renox_cp_node_healthy 1, heartbeat age 3.4 s
- [x] RPO ≤ 10 s: 0.36 s (101 of 2952 acknowledged rows not restored)
- [x] no cross-tenant impact: bystander t-chaos-b on node-chaos-1: 387×200
- [x] detected by the control plane: renox_cp_node_healthy = 0 after 30.7 s
Notes: Both nodes run on one host (loopback); the two-host B18 run is O3 (#158).
Raw: bench/results/raw/2026-11-01-CHAOS-node-kill.json
