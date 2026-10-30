# Replica spike: plain file, Litestream 1 s, LiteFS, libSQL embedded replica (#256)

> Superseded by [the 2026-10-30 run on `node-small`](2026-10-30-replica-spike.md), which measured all four candidates.

| | |
| --- | --- |
| Date | 2026-10-29 |
| Host | dev container, 4 vCPU, Ubuntu 24.04.5, kernel 6.18.44; `/dev/fuse` present |
| Scripts | `bench/spike/replica/run.sh`, `writer.ts` (Bun, `bun:sqlite`) |
| Status | **Incomplete: one of four candidates measured** |

## Measured

Plain file, WAL, `synchronous = normal`, one insert of ≈ 230 bytes per transaction, 10 s per run:

| Run | Writes | Writes/s | p50 | p99 |
| --- | --- | --- | --- | --- |
| 1 | 871,435 | 87,144 | 0.008 ms | 0.045 ms |
| 2 | 940,887 | 94,089 | 0.009 ms | 0.048 ms |
| 3 | 1,012,335 | 101,234 | 0.008 ms | 0.039 ms |
| 4 (`run.sh plain`) | 882,931 | 88,293 | 0.008 ms | 0.046 ms |

Median 91,191 writes/s. This is the ceiling a replicated candidate is compared with (B19: ≤ 10 % loss).

## Not measured, and why

| Candidate | Why not here | What it needs |
| --- | --- | --- |
| Litestream, `sync-interval: 1s` | Running a downloaded binary was refused by this session's permission policy, so `litestream` could not run (the pinned tarball was fetched and verified, `ops/litestream.lock`) | `litestream` on `PATH`; then `run.sh litestream --kills 10` |
| LiteFS, static leader | Same policy; LiteFS also needs FUSE with `CAP_SYS_ADMIN`, a lease (Consul) for promotion, and its own HTTP port per node | `litefs`, a privileged host; promotion needs Consul |
| libSQL embedded replica | `sqld` not installed (same policy); the embedded replica needs `@libsql/client` or the `libsql` crate, which `renox-data` (rusqlite) does not use | `sqld`, a writer on `@libsql/client` |

## Integration shape (from the projects' documentation, not measured)

| | Litestream 1 s | LiteFS | libSQL embedded replica |
| --- | --- | --- | --- |
| Change in `renox-data` | None (it reads the WAL; #255 ships it) | None for reads; writes only on the lease holder, through the FUSE mount | The file is opened through `libsql`, not `rusqlite`; writes go to `sqld` |
| Change in the cell | None | The cell must run where the lease is, or forward writes | A `sqld` primary per tenant, or per node with namespaces |
| RPO | Up to the sync interval plus replica lag (seconds) | Asynchronous by default (LTX shipped after commit); not zero | Writes acknowledged by the primary; the replica syncs on demand |
| Daemons, ports | One sidecar per active file, no port | One FUSE daemon per node, an HTTP port, Consul | `sqld` (HTTP + gRPC ports) |
| B18 fit (RTO ≤ 60 s, RPO ≤ 10 s) | Fits by budget (deploy-api.md FO1–FO6) | Fits if the lease moves within the budget | Fits if a replica is promoted, which `sqld` does not do by itself |

## Verdict

No verdict on the candidates: three of four were not measured. The owner's decision waits for the runs above on a host where the binaries can run (the dev container with the permission, or `node-small` and the load host of #158).

## ADR

D5 stands as written. No ADR is proposed from this spike yet; the proposal follows the measured runs.
