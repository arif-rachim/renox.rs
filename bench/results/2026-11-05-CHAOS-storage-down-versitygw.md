# CHAOS storage-down — Object storage unreachable — 2026-11-05
Hardware: dev-container (Intel(R) Xeon(R) Processor @ 2.10GHz, kernel 6.18.44-fc-v236), renox-worker 21f0d16 plus this batch (release build, local tree), bun 1.4.4
Scenario: control/api keeps artifacts in S3 (versitygw in CI); the node restarts with one tenant's artifact removed from its cache, another tenant is warmed from the cache, the storage is paused, then resumed
Failure modes: "Object storage unreachable" (docs/23-failure-modes.md)
Result: cached tenant serves: t-chaos-a: 200; uncached cold start refused: t-chaos-d: 503 {"error":{"code":"RENOX_UNAVAILABLE","request_id":"01M6P2WKAHH0NCTETC238FK42G","message":"The servic; the worker reports it: object_storage on /healthz; cold start after recovery: 200
Target: cached tenant 200 throughout; uncached cold start 503 RENOX_UNAVAILABLE while down, 200 after; /healthz reports object_storage → PASS
Alerts: RenoxObjectStorageUnreachable (reads renox_worker_degraded{component="object_storage"} (pending #295); the reason is on /healthz)
Checks:
- [x] cached tenant serves: t-chaos-a: 200
- [x] uncached cold start refused: t-chaos-d: 503 {"error":{"code":"RENOX_UNAVAILABLE","request_id":"01M6P2WKAHH0NCTETC238FK42G","message":"The servic
- [x] the worker reports it: object_storage on /healthz
- [x] cold start after recovery: 200
Notes: none
Raw: not kept (a local run; the weekly CI run uploads its own `chaos-results` artifact)

## Why this run (#389)

The weekly chaos run 41435552318 stopped before any scenario: `docker compose` could not pull `minio/minio` and `minio/mc` ("pull access denied, repository does not exist"; reproduced on 2026-11-05). MinIO no longer publishes images. `control/docker-compose.yml` now runs versitygw v1.0.16 from `ghcr.io`, pinned by the digest of its multi-arch index (`sha256:605de57c…2eb797`), with its POSIX backend: the `renox-artifacts` bucket is a directory made before the server starts. `chaos.yml` starts the `s3` service and pauses `renox-control-s3-1`.

## The control API's object store against it

`S3ObjectStore` (`control/api/src/storage/object-store.ts`) with the compose file's development credentials:

| Check | Region `auto` (the API's default) | Region `us-east-1` |
| --- | --- | --- |
| `putIfAbsent` | `created`, then `exists` | refused (signature region) |
| `get`, missing key | the bytes; `null` | — |
| presigned GET | 200 | — |
| `delete`, then `exists` | `false` | — |
| wrong secret | refused | — |
| anonymous GET and PUT on the bucket | 403 | 403 |

versitygw checks the signing region (`VGW_REGION=auto`). The renox-cell tests that use an S3 store (`RENOX_TEST_S3`) need `RENOX_TEST_S3_REGION=auto` with it.

## Every scenario, same stack

`bench/chaos/run.sh all` as root on the dev container (4 vCPU), `docker pause`/`unpause` of the versitygw container for storage-down, the pinned Litestream (`ops/scripts/fetch-litestream.sh`):

| Scenario | Verdict | Time |
| --- | --- | --- |
| node-kill | PASS | 48 s |
| storage-down | PASS | 15 s |
| control-plane-down | PASS | 39 s |
| disk-full | PASS | 25 s |
| corrupt-file | PASS | 14 s |
| replica-lag | PASS | 23 s |
| pubsub-drop | PASS | 20 s |
| erasure | PASS | 17 s |

Open: the next scheduled weekly run in CI is the confirmation on a GitHub runner.
