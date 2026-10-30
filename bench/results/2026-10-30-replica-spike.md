# Replica spike: plain file, Litestream 1 s, LiteFS, libSQL embedded replica (#256) — 2026-10-30

| | |
| --- | --- |
| Date | 2026-10-30 |
| Host | `node-small`: 4 vCPU AMD EPYC (KVM VPS), 8 GB, SSD (QEMU virtual disk), Ubuntu 24.04.5, Linux 6.8.0-147-generic; `/dev/fuse` present |
| Topology | One host, two processes standing in for two nodes (loopback), as the issue's scope says; the replica of Litestream is a `file` replica (no object storage, no network) |
| Git | `batch/o3-host-f2` (the scripts as committed with this file) |
| Tools | Bun 1.4.4 (`bun:sqlite`); Litestream v0.3.13 (`ops/scripts/fetch-litestream.sh`, verified against `ops/litestream.lock`); LiteFS v0.5.14 (GitHub release `litefs-v0.5.14-linux-amd64.tar.gz`, sha256 `231190010850c57ab43e278a0b521e50a9fc63a7c571d683dd7febd4ab2cdf30`; the release publishes no checksum, so this is the hash of the file used); `sqld` 0.24.32 (`libsql-server-v0.24.32`, `libsql-server-x86_64-unknown-linux-gnu.tar.xz`, sha256 `71720fc8648c19efef416efebd47145ef59b62e198770533530a858e1336879f`, matched the release's `.sha256`); `@libsql/client` 0.15.15 (`bench/spike/replica/libsql/`) |
| Status | **Four candidates measured; verdict and ADR proposal below** |

Supersedes the incomplete [2026-10-29 run](2026-10-29-replica-spike.md) (plain file only, on the dev container).

## Commands

```
bench/spike/replica/run.sh --seconds 10 --kills 10 --out <dir>                    # series 1: kill runs as fast as each candidate writes
bench/spike/replica/run.sh --seconds 10 --kills 10 --kill-rate 200 --out <dir>    # series 2: kill runs at 200 writes/s offered
```

Both ran detached from the terminal session under a guard that logged memory and disk every 5 s (lowest MemAvailable 6,926 MB, disk at most 18 % used); nothing else ran on the host. Raw: `bench/results/raw/2026-10-30-replica-spike-maxrate.json` (series 1), `bench/results/raw/2026-10-30-replica-spike-200.json` (series 2).

Method per candidate: a 10 s throughput run with the writer unlimited; then 10 kill runs, each a fresh primary and replica, the writer for a random 3–7 s, then `SIGKILL` of the writer and the primary's daemon together ("the node dies"). RPO = rows the writer had acknowledged (its fsync'd ack file) minus the newest row on host 2. RTO = time from the kill until host 2 serves a read, and until it acknowledges a write (promotion included).

## Throughput (B19: ≤ 10 % loss, fail > 25 %)

| Candidate | Writes/s | p50 | p99 | Loss against the plain file |
| --- | --- | --- | --- | --- |
| Plain file (WAL, `synchronous = normal`) | 26,406 / 26,630 | 0.03 ms | 0.12 / 0.13 ms | — |
| Litestream, `sync-interval: 1s` | 22,822 / 26,444 | 0.03 ms | 0.14 / 0.13 ms | 13.6 % / 0.7 % |
| LiteFS, static lease | 47.4 / 50.3 | 17–18 ms | 51–60 ms | **99.8 %** |
| libSQL: writes to `sqld` over HTTP | 208.5 / 202.1 | 4.1 ms | 15–18 ms | **99.2 %** |

Two values: series 1 / series 2 (the throughput run is unlimited in both). This host's plain-file ceiling is 26.5k writes/s, against 91k on the dev container on 2026-10-29.

## RPO and RTO at 200 writes/s offered (series 2, 10 kills each)

| Candidate | Rows lost per kill (median / max) | As time at 200 writes/s | Read on host 2 (median / max) | Write on host 2 (median / max) |
| --- | --- | --- | --- | --- |
| Litestream 1 s | 9 / 191 | 45 ms / 0.96 s | 177 / 206 ms (restore) | 177 / 206 ms (the restored file) |
| LiteFS | 0 / 0 | 0 | 94 / 265 ms | 296 / 937 ms (replica restarted as the candidate) |
| libSQL embedded replica | 428 / 703 | 2.1 s / 3.5 s | 39 / 109 ms | 190 / 1,325 ms (new `sqld` from the replica, `VACUUM INTO`) |

Per kill: Litestream lost `8, 2, 15, 1, 4, 4, 15, 191, 14, 10`; LiteFS `0` ten times (but acknowledged only 119–335 rows per run: it writes ≈ 50/s, not the 200 offered); libSQL `314, 486, 703, 470, 425, 193, 394, 430, 391, 520`.

## Series 1: kill runs at each candidate's own maximum

- **Litestream: not a valid RPO number.** In this series the kill runs started the writer on a new file at the moment the sidecar started; the kill (3–7 s) landed before Litestream had shipped anything, so every run restored 0 rows (raw file, `rows_lost` = all acknowledged rows). The script now creates the file and waits for the first snapshot before the load (series 2). The same series showed what saturation does: traced by hand at ≈ 22k writes/s, the primary's WAL grew to 756 MB and Litestream's shadow WAL to 1.3 GB in 12 s (Litestream holds a read lock that keeps SQLite from checkpointing), while the replica held 45 MB. At that rate the RPO is not bounded by the 1 s interval.
- **LiteFS**: 0 rows lost in 10 kills (acknowledged 132–249 rows per run); write on host 2 after 264–393 ms.
- **libSQL**: lost 387–698 rows per kill (median 477) at ≈ 208 writes/s; write on host 2 after 158–267 ms.

## Memory and disk per tenant

| Candidate | Daemon | RSS, one tenant, idle after 400 writes | Disk overhead |
| --- | --- | --- | --- |
| Litestream | One sidecar **per active tenant file** | 28.0 MB | Shadow WAL beside the file (`.app.db-litestream`); under saturation larger than the WAL itself (1.3 GB above) |
| LiteFS | One FUSE daemon per node | 15.3 MB | LTX files in the data directory (512 KB for 400 rows) |
| `sqld` | One daemon per node (namespaces for tenants) | 27.8 MB | `wallog` beside the file (3.7 MB for 400 rows) |

The embedded replica on host 2 is the `@libsql/client` process here (a cell would hold it in-process through the `libsql` crate).

## Integration shape (measured where the table says so)

| | Litestream 1 s | LiteFS | libSQL embedded replica |
| --- | --- | --- | --- |
| Change in `renox-data` | None: it reads the WAL (#255 ships it) | None for reads; every write goes through the FUSE mount on the lease holder | The file is opened through `libsql`, not `rusqlite`; every write is a network round trip to `sqld` (measured: 4 ms p50 on loopback) |
| Change in the cell | None | The cell must run where the lease is, or forward writes | A `sqld` primary per node with a namespace per tenant |
| RPO measured | ≤ 1 s at 200 writes/s; unbounded under saturation | 0 at ≤ 50 writes/s (all it can write) | 2–3.5 s at 200 writes/s and growing: the replica synced ≈ 130 rows/s even when `sync()` was called again at once while it brought frames |
| Promotion | `litestream restore` (here 0.18 s from a local file; from object storage it adds the download) | Needs a lease that moves (Consul); here a restart of the replica as the candidate | Not provided by `sqld`; here a new `sqld` seeded from the replica file |
| Daemons, ports | Sidecar per active file, no port | FUSE (`fusermount3`, `/dev/fuse`), one HTTP port per node, Consul for a moving lease | `sqld`: HTTP and gRPC ports |

## Verdict

| Candidate | B18 (RTO ≤ 60 s, RPO ≤ 10 s) | B19 (≤ 10 % throughput loss) | Paid tier "RPO near zero" (`docs/06-data.md`) |
| --- | --- | --- | --- |
| Litestream 1 s | **PASS** at 200 writes/s (RPO ≤ 0.96 s, RTO 0.2 s) | **PASS** (0.7 % and 13.6 % in two runs; the median of two is inside 10 %, one run is over) | No: up to 1 s, and unbounded under saturation |
| LiteFS | PASS on RPO (0) and RTO (< 1 s) | **FAIL** (99.8 % loss: ≈ 50 writes/s) | Yes, but only at ≈ 50 writes/s per node |
| libSQL embedded replica | PASS on RPO at this load (≤ 3.5 s) but the lag grows with sustained writes above ≈ 130/s | **FAIL** (99.2 % loss: every write is a round trip) | No: seconds behind |

Neither LiteFS nor libSQL embedded replicas, as measured here, gives the paid tier what `docs/06-data.md` promises (a synchronous replica with near-zero RPO) at a write rate a paid tenant can use. LiteFS is the only one with RPO 0, at a throughput 500 times below a plain file on this host. Litestream at 1 s is the only candidate inside B18 and B19.

Limits of this verdict: one host on loopback (a real second node adds network latency to LiteFS and libSQL writes and to Litestream's restore from object storage); LiteFS and `sqld` in their default configurations; the libSQL replica rate measured with `@libsql/client` 0.15.15, not the `libsql` crate.

## Proposed ADR paragraph (for the owner; `docs/13-decisions.md` is not edited)

> **D24 (proposed number) — Replica for the paid tier: Litestream, not a synchronous replica.** Status: proposed. The paid tier keeps per-tenant SQLite replicated by Litestream (as the base tier, D5), with a shorter sync interval than the base tier if B19 allows it, and failover by restore on a second node (deploy-api FO1–FO6). Its promise changes from "synchronous replica, RPO near zero" to "RPO ≤ 1 s under normal load, RTO ≤ 60 s". Reason: the #256 spike (`bench/results/2026-10-30-replica-spike.md`) measured LiteFS at RPO 0 but ≈ 50 writes/s (99.8 % below a plain file) and libSQL embedded replicas at 2–3.5 s of lag and 99 % throughput loss, while Litestream at 1 s lost ≤ 1 s of writes at 200 writes/s with < 15 % throughput loss. Revisit if a tenant needs RPO 0 and accepts LiteFS's write rate, measured again across two hosts (#158's load host). Consequence: `docs/06-data.md` (the paid-tier rows) and `docs/01-business.md` (the Pro row, "Synchronous replica") change with the ADR, and B19 is re-measured at the paid tier's interval.

`docs/06-data.md`'s "Replica tier" line is not edited by this spike; the owner decides (#76).
