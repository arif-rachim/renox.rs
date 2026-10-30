# CHAOS storage-down — Object storage unreachable — 2026-10-29
Hardware: dev-laptop (Intel(R) Xeon(R) Processor @ 2.10GHz, kernel 6.18.44-fc-v185), renox-worker 66b0040, bun 1.4.4
Scenario: control/api keeps artifacts in S3 (MinIO); the storage is paused while one tenant is warm and another's artifact is removed from its node's cache, then resumed
Failure modes: "Object storage unreachable" (docs/23-failure-modes.md)
Result: skipped: RENOX_CHAOS_S3_ENDPOINT, RENOX_CHAOS_S3_DOWN and RENOX_CHAOS_S3_UP are not set (CI's chaos workflow sets them with MinIO)
Target: cached tenant 200 throughout; uncached cold start 503 RENOX_UNAVAILABLE while down, 200 after; /healthz reports object_storage → SKIPPED
Alerts: RenoxObjectStorageUnreachable (reads renox_worker_degraded{component="object_storage"} (pending #295); the reason is on /healthz)
Checks:
Notes: none
Raw: bench/results/raw/2026-10-29-CHAOS-storage-down.json
