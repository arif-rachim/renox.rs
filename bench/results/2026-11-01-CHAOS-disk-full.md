# CHAOS disk-full — Disk full on a node — 2026-11-01
Hardware: node-small (AMD EPYC Processor (with IBPB), kernel 6.8.0-147-generic), renox-worker 46fdfce, bun 1.4.4
Command: `CARGO_PROFILE_RELEASE_DEBUG=0 cargo build --release --locked -j 3 -p renox-cell --bin renox-worker` (RUSTY_V8_ARCHIVE from `ops/v8-archive.sh fetch`), then `sudo env PATH=$PATH RENOX_WORKER_PATH=$PWD/target/release/renox-worker RENOX_CHAOS_S3_ENDPOINT=http://127.0.0.1:9000 RENOX_CHAOS_S3_ACCESS_KEY_ID=… RENOX_CHAOS_S3_SECRET_ACCESS_KEY=… RENOX_CHAOS_S3_DOWN="kill -STOP <pid>" RENOX_CHAOS_S3_UP="kill -CONT <pid>" bench/chaos/run.sh all`, as root (loop mounts, tmpfs data directories), S3 from `rclone serve s3` v1.75.2 (MinIO no longer publishes binaries and its pinned images could not be pulled); every scenario of `all` but `storage-down` passed, and this file is from that run
Scenario: each node's data directory on a 128 MiB loop-mounted ext4; the victim's filled to 92 %, then 96 %, then emptied (crate::disk polls every 5 s)
Failure modes: "Disk full on node" (docs/23-failure-modes.md)
Result: 92 %: no new cell: cold t-chaos-d: 503 (92.0 % used); 92 %: warm tenant reads and writes: POST 200, GET 200; 96 %: writes refused: POST 503 (96.0 % used); 96 %: reads go on: GET 200; the other node is unaffected: t-chaos-b on node-chaos-1: POST 200; freed: everything again: POST 200, cold GET 200; warm reads at every level: GET once a second on t-chaos-a: 12×200
Target: 92 %: a cold tenant 503 RENOX_UNAVAILABLE, warm reads and writes 200; 96 %: writes 503 RENOX_UNAVAILABLE, reads 200; other node unaffected; all 200 after freeing → PASS
Alerts: RenoxDiskWatermarkStop (reads renox_worker_disk_level (pending #295); the level is on /healthz)
Checks:
- [x] 92 %: no new cell: cold t-chaos-d: 503 (92.0 % used)
- [x] 92 %: warm tenant reads and writes: POST 200, GET 200
- [x] 96 %: writes refused: POST 503 (96.0 % used)
- [x] 96 %: reads go on: GET 200
- [x] the other node is unaffected: t-chaos-b on node-chaos-1: POST 200
- [x] freed: everything again: POST 200, cold GET 200
- [x] warm reads at every level: GET once a second on t-chaos-a: 12×200
Notes: none
Raw: bench/results/raw/2026-11-01-CHAOS-disk-full.json
