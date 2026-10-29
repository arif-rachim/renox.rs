# B19 Litestream overhead on the dev container (#255)

| | |
| --- | --- |
| Date | 2026-10-29 |
| Host | dev container, 4 vCPU, Ubuntu 24.04.5, kernel 6.18.44 |
| Scenario | `bench/scenarios/B19/run.sh`: a write-heavy tenant (one insert of ≈ 230 bytes per request), 16 closed-loop clients, 30 s per mode after a 3 s warm-up, replication off then on (`file` replica, 1 s sync), median of 3 runs |
| Target | ≤ 10 % throughput loss (fail > 25 %), `docs/14-benchmarks.md` B19 |
| Status | **Not measured** |

## Why not

`litestream` could not be run in this session: running a downloaded binary was refused by the session's permission policy, so neither the scenario nor `crates/renox-cell/tests/replication.rs` could exercise a sidecar here. The pinned tarball itself was fetched and its SHA-256 verified (`ops/scripts/fetch-litestream.sh`).

## Where it runs

- CI's rust job puts the pinned Litestream on `PATH` (#252), so `tests/replication.rs` runs there.
- The scenario needs only Bun, a `renox-worker` and `litestream`: `bench/run.sh B19` on any host that has them, and on `node-small` for the number that counts (O3, #158).
