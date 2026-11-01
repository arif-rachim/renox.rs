# CHAOS storage-down — Object storage unreachable — 2026-11-01
Hardware: node-small (AMD EPYC Processor (with IBPB), kernel 6.8.0-147-generic), renox-worker 46fdfce, bun 1.4.4
Command: as for `run.sh all` (same build, root, rclone v1.75.2 `serve s3` on 127.0.0.1:9000), with the scenario fix of this branch (the node restarts before the outage, so the cold tenant has no live cell), `RENOX_CHAOS_S3_DOWN=s3-down.sh` (stops the S3 server: connections are refused) and `RENOX_CHAOS_S3_UP=s3-up.sh` (starts it again), `BENCH_PROFILE=node-small bench/chaos/run.sh storage-down`
Scenario: control/api keeps artifacts in S3 (MinIO); the node restarts with one tenant's artifact removed from its cache, another tenant is warmed from the cache, the storage is paused, then resumed
Failure modes: "Object storage unreachable" (docs/23-failure-modes.md)
Result: cached tenant serves: t-chaos-a: 200; uncached cold start refused: t-chaos-d: 503 {"error":{"code":"RENOX_UNAVAILABLE","request_id":"01M6A9M94FN9NNAYRK3BF4YKP3","message":"The servic; the worker reports it: object_storage on /healthz; cold start after recovery: 200
Target: cached tenant 200 throughout; uncached cold start 503 RENOX_UNAVAILABLE while down, 200 after; /healthz reports object_storage → PASS
Alerts: RenoxObjectStorageUnreachable (reads renox_worker_degraded{component="object_storage"} (pending #295); the reason is on /healthz)
Checks:
- [x] cached tenant serves: t-chaos-a: 200
- [x] uncached cold start refused: t-chaos-d: 503 {"error":{"code":"RENOX_UNAVAILABLE","request_id":"01M6A9M94FN9NNAYRK3BF4YKP3","message":"The servic
- [x] the worker reports it: object_storage on /healthz
- [x] cold start after recovery: 200
Notes: the first run of this scenario in `run.sh all` (before the fix) answered 200 to the cold tenant: activation had prepared its cell, so removing the cached artifact did not make it cold; that run measured nothing about object storage and is not kept.
Raw: bench/results/raw/2026-11-01-CHAOS-storage-down.json
