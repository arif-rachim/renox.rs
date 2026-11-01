# CHAOS storage-down (stopped, with #359) — Object storage unreachable — 2026-11-01
Hardware: node-small (AMD EPYC Processor (with IBPB), kernel 6.8.0-147-generic), renox-worker 99b1600 plus the #359 change of this branch (release build), bun 1.4.4
Command: the same build, `RENOX_CHAOS_S3_DOWN` stopping the rclone S3 server (connections refused) and `RENOX_CHAOS_S3_UP` starting it again, `bench/chaos/run.sh storage-down`
Scenario: control/api keeps artifacts in S3 (MinIO); the node restarts with one tenant's artifact removed from its cache, another tenant is warmed from the cache, the storage is paused, then resumed
Failure modes: "Object storage unreachable" (docs/23-failure-modes.md)
Result: cached tenant serves: t-chaos-a: 200; uncached cold start refused: t-chaos-d: 503 {"error":{"code":"RENOX_UNAVAILABLE","request_id":"01M6AJVNDT0HFH26W6ZCA9Y0XE","message":"The servic; the worker reports it: object_storage on /healthz; cold start after recovery: 200
Target: cached tenant 200 throughout; uncached cold start 503 RENOX_UNAVAILABLE while down, 200 after; /healthz reports object_storage → PASS
Alerts: RenoxObjectStorageUnreachable (reads renox_worker_degraded{component="object_storage"} (pending #295); the reason is on /healthz)
Checks:
- [x] cached tenant serves: t-chaos-a: 200
- [x] uncached cold start refused: t-chaos-d: 503 {"error":{"code":"RENOX_UNAVAILABLE","request_id":"01M6AJVNDT0HFH26W6ZCA9Y0XE","message":"The servic
- [x] the worker reports it: object_storage on /healthz
- [x] cold start after recovery: 200
Notes: none
Raw: bench/results/raw/2026-11-01-CHAOS-storage-down-stopped-359.json
