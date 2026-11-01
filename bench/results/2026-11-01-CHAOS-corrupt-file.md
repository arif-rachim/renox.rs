# CHAOS corrupt-file — Tenant file corrupted — 2026-11-01
Hardware: node-small (AMD EPYC Processor (with IBPB), kernel 6.8.0-147-generic), renox-worker 46fdfce, bun 1.4.4
Command: `CARGO_PROFILE_RELEASE_DEBUG=0 cargo build --release --locked -j 3 -p renox-cell --bin renox-worker` (RUSTY_V8_ARCHIVE from `ops/v8-archive.sh fetch`), then `sudo env PATH=$PATH RENOX_WORKER_PATH=$PWD/target/release/renox-worker RENOX_CHAOS_S3_ENDPOINT=http://127.0.0.1:9000 RENOX_CHAOS_S3_ACCESS_KEY_ID=… RENOX_CHAOS_S3_SECRET_ACCESS_KEY=… RENOX_CHAOS_S3_DOWN="kill -STOP <pid>" RENOX_CHAOS_S3_UP="kill -CONT <pid>" bench/chaos/run.sh all`, as root (loop mounts, tmpfs data directories), S3 from `rclone serve s3` v1.75.2 (MinIO no longer publishes binaries and its pinned images could not be pulled); every scenario of `all` but `storage-down` passed, and this file is from that run
Scenario: 5 rows written and replicated, the cell evicted (idle 2 s) and its sidecar stopped, then the tenant's app.db overwritten with 8 KiB of 0xAB (WAL and SHM removed)
Failure modes: "SQLite file corrupted, WAL unreadable" (docs/23-failure-modes.md)
Result: first answer 503, restored in 0.2 s with 5 of 5 rows, 1 quarantine file(s)
Target: 503 RENOX_DB_UNAVAILABLE, automatic restore, 200 with every replicated row, quarantine kept, neighbours unaffected → PASS
Alerts: RenoxTenantFileRestoring (reads renox_worker_db_unavailable (pending #295))
Checks:
- [x] 503 RENOX_DB_UNAVAILABLE first: 503 {"error":{"code":"RENOX_DB_UNAVAILABLE","request_id":"01M6A8WMFX0BDGWH0A5F5Y0VDH","message":"The service is temporarily 
- [x] restored automatically with its rows: 200 with n = 5 after 0.2 s
- [x] the damaged file is kept: app.db.corrupt-1793493717504
- [x] no impact on a neighbour: t-chaos-d on the same node: 1×200
Notes: none
Raw: bench/results/raw/2026-11-01-CHAOS-corrupt-file.json
