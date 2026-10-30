# bench/chaos

The fault-injection harness of `docs/23-failure-modes.md` section 6 (#104): each scenario starts a fresh two-node stack, breaks one thing, and asserts what the failure-modes table says the tenant sees and the platform does, including that other tenants see nothing. Each run writes a result file in the benchmark format (`docs/14-benchmarks.md`, "Recording results").

```sh
bench/chaos/run.sh <scenario|all> [--out <dir>]     # default --out bench/results
sudo -E env "PATH=$PATH" bench/chaos/run.sh all     # disk-full needs root; as root every node also gets its own tmpfs
```

Needs Bun, `litestream` on `PATH` (`ops/scripts/fetch-litestream.sh`), and a `renox-worker` (`RENOX_WORKER_PATH`, default `target/release/renox-worker`, built when missing). Exit 1 when a scenario fails; a skipped scenario does not fail the run and its result file says why.

## The stack (`lib/stack.ts`)

control/api (PGlite in a directory, so it survives a restart; S3 for artifacts when `RENOX_CHAOS_S3_*` is set) and two controlled renox-workers on loopback, each with a node listener, a health listener and replication to a `file` replica shared by both (standing in for object storage). Tenants are created through the API with one app each (`POST /api/hits` writes a row, `GET` reads the count and the newest row). Running as root, each node's data directory is a 512 MiB tmpfs, so the disk watermarks (`crate::disk`, #103) read that node's disk and not a shared host disk. The stack's directory is removed after a pass and kept, named in the result, after a failure.

A scenario can ask for two more things: `realtimeUserConnections` (`[realtime] user_connections`, since every client of the stack is anonymous on 127.0.0.1) and `recordMeters`, which puts a pass-through proxy in front of the API's node listener and keeps every meter record the nodes post (`Stack.meterRecords`); the control plane folds records into usage hours, so a per-record field such as `realtime_conn_seconds` cannot be read back from it. A tenant can deploy another app than `hits` (`AppSpec`, `stack.tenant(id, spec)`).

This is the same shape as B18 (`bench/scenarios/B18/`), with both nodes on one host. A run with the nodes on two hosts is the O3 B18 run (#158).

## Scenarios

| Scenario | Breaks | Asserts | `docs/23` row | Alert (`ops/observability`) |
| --- | --- | --- | --- | --- |
| `node-kill` | SIGKILL of the node owning a tenant after 10 s of writes (B18) | RTO ≤ 60 s, RPO ≤ 10 s, the surviving node stays healthy, a tenant on it never sees an error | Node dies | `RenoxNodeUnhealthy` (condition observed) |
| `storage-down` | The S3 artifact store paused (`RENOX_CHAOS_S3_DOWN` / `_UP`) | A cached tenant serves; an uncached cold start is 503 `RENOX_UNAVAILABLE`, then 200 after; `/healthz` reports `object_storage` | Object storage unreachable | `RenoxObjectStorageUnreachable` (pending #295) |
| `control-plane-down` | control/api stopped for 15 s, then restarted on the same database | Warm tenants read and write throughout; `/healthz` degraded; the metrics endpoint gone; afterwards heartbeats accepted and no failover | Control plane unreachable from the worker | `RenoxControlPlaneDown` (condition observed) |
| `disk-full` | The victim node's data directory (a loop-mounted ext4) filled to 92 %, 96 %, then emptied | 92 %: a cold tenant 503, warm reads and writes 200; 96 %: writes 503, reads 200; the other node unaffected; all 200 after | Disk full on node | `RenoxDiskWatermarkStop` (pending #295) |
| `corrupt-file` | An idle tenant's `app.db` overwritten (WAL and SHM removed) | 503 `RENOX_DB_UNAVAILABLE`, automatic restore with every replicated row, `app.db.corrupt-*` kept, a neighbour unaffected | SQLite file corrupted, WAL unreadable | `RenoxTenantFileRestoring` (pending #295) |
| `replica-lag` | The tenant's Litestream sidecar frozen with SIGSTOP for 15 s, then SIGCONT | No tenant error; lag above 10 s reported by the node and by `renox_cp_replication_lag_max_seconds`; back under 5 s | Replica lagging / Litestream behind | `RenoxReplicationLag` (condition observed) |
| `erasure` | The owner deletes a tenant while its owning node is killed; the node restarts 5 s later (#308) | The erasure waits (`erasing`), then finishes once the node is back, `replica_purged_at` set and the replica directory gone, the hostname no longer served, a tenant on the other node never sees an error | Tenant erasure cannot finish | — (the step's own retry; `failed` after 24 h writes an operator alert row) |
| `pubsub-drop` | 20 SSE and 20 WebSocket clients on one topic of a realtime app, 50 messages per second published by a function; every client link cut through a TCP proxy (`lib/realtime.ts`) for 1 s, then for 4 s, the node and its hub running (#312) | Each client reconnects exactly once per cut; SSE with `Last-Event-ID` misses 0 of the ≈ 50 events of the 1 s cut (inside the replay buffer: 100 events or 60 s, whichever is shorter, so 2 s at this rate) and, past the buffer, ≈ 100 of the ≈ 200 of the 4 s cut plus what was published before it was back (the newest 100 replayed, no event names the gap); WebSocket has no replay and misses what was published while it was away; no `RENOX_REALTIME_LIMIT`; one meter record per connection, `realtime_conn_seconds` within 5 % of the clients' own measure; the publisher sees no error | WebSocket message flood / oversized frame (the realtime row) | — |

`storage-down` needs:

| Variable | Example (CI) |
| --- | --- |
| `RENOX_CHAOS_S3_ENDPOINT` | `http://127.0.0.1:9000` (MinIO from `control/docker-compose.yml`) |
| `RENOX_CHAOS_S3_ACCESS_KEY_ID`, `RENOX_CHAOS_S3_SECRET_ACCESS_KEY` | the compose file's development values |
| `RENOX_CHAOS_S3_DOWN`, `RENOX_CHAOS_S3_UP` | `docker pause renox-control-minio-1`, `docker unpause renox-control-minio-1` |

## Weekly run

`.github/workflows/chaos.yml` runs every scenario on Mondays (and on demand), uploads the result files as an artifact, and opens an issue labelled `chaos` when a scenario fails (or comments on the open one). To check the failure path, run the workflow on a branch where one scenario's assertion is inverted: it must end red and open the issue.
