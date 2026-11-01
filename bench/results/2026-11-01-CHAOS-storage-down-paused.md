# CHAOS storage-down (storage paused) — Object storage unreachable — 2026-11-01
Hardware: node-small (AMD EPYC Processor (with IBPB), kernel 6.8.0-147-generic), renox-worker 46fdfce, bun 1.4.4
Command: as for `run.sh all`, with the scenario fix of this branch, `RENOX_CHAOS_S3_DOWN="kill -STOP <pid>"` and `RENOX_CHAOS_S3_UP="kill -CONT <pid>"` (the S3 server paused), `bench/chaos/run.sh storage-down`
Scenario: control/api keeps artifacts in S3 (MinIO); the node restarts with one tenant's artifact removed from its cache, another tenant is warmed from the cache, the storage is paused, then resumed
Failure modes: "Object storage unreachable" (docs/23-failure-modes.md)
Result: cached tenant serves: t-chaos-a: 200; uncached cold start refused: t-chaos-d: 0 TimeoutError: The operation timed out.; the worker reports it: no object_storage reason within 30 s; cold start after recovery: 200
Target: cached tenant 200 throughout; uncached cold start 503 RENOX_UNAVAILABLE while down, 200 after; /healthz reports object_storage → FAIL
Alerts: RenoxObjectStorageUnreachable (reads renox_worker_degraded{component="object_storage"} (pending #295); the reason is on /healthz)
Checks:
- [x] cached tenant serves: t-chaos-a: 200
- [ ] uncached cold start refused: t-chaos-d: 0 TimeoutError: The operation timed out.
- [ ] the worker reports it: no object_storage reason within 30 s
- [x] cold start after recovery: 200
Notes: the storage was paused (`kill -STOP` of the S3 server: connections are accepted and never answered, like `docker pause` in the weekly workflow); logs were kept and then removed.
Raw: bench/results/raw/2026-11-01-CHAOS-storage-down-paused.json
