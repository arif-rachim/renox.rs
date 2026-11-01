# CHAOS erasure — Erasure with the owning node down — 2026-11-01
Hardware: node-small (AMD EPYC Processor (with IBPB), kernel 6.8.0-147-generic), renox-worker 46fdfce, bun 1.4.4
Command: `CARGO_PROFILE_RELEASE_DEBUG=0 cargo build --release --locked -j 3 -p renox-cell --bin renox-worker` (RUSTY_V8_ARCHIVE from `ops/v8-archive.sh fetch`), then `sudo env PATH=$PATH RENOX_WORKER_PATH=$PWD/target/release/renox-worker RENOX_CHAOS_S3_ENDPOINT=http://127.0.0.1:9000 RENOX_CHAOS_S3_ACCESS_KEY_ID=… RENOX_CHAOS_S3_SECRET_ACCESS_KEY=… RENOX_CHAOS_S3_DOWN="kill -STOP <pid>" RENOX_CHAOS_S3_UP="kill -CONT <pid>" bench/chaos/run.sh all`, as root (loop mounts, tmpfs data directories), S3 from `rclone serve s3` v1.75.2 (MinIO no longer publishes binaries and its pinned images could not be pulled); every scenario of `all` but `storage-down` passed, and this file is from that run
Scenario: two controlled renox-workers, file replica, control/api with a 2 s erasure retry; the owner deletes the tenant while its node is killed, then the node restarts
Failure modes: "Tenant erasure cannot finish (owning node down, object store unreachable)" (docs/23-failure-modes.md)
Result: done in 10.3 s, replica purged, bystander 97×200
Target: the erasure finishes once the node is reachable again, with the replica purged and no impact on other tenants → PASS
Alerts: none
Checks:
- [x] the owner's request is accepted: DELETE answered 202
- [x] the erasure waits for the node: state erasing 5 s after the request with the node down
- [x] it finishes once the node is back: done 10.3 s after the request
- [x] the replica generations are purged: replica_purged_at 1793493789709, no replica directory left
- [x] the hostname is no longer served: GET on node-chaos-2 answered 404
- [x] no cross-tenant impact: bystander t-chaos-keep on node-chaos-1: 97×200
Notes: Both nodes run on one host (loopback). Production retries a failed step hourly and finishes within 24 hours while the node and the store answer.
Raw: bench/results/raw/2026-11-01-CHAOS-erasure.json
