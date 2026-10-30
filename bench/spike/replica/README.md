# Spike: the synchronous replica for the paid tier (#256)

`docs/06-data.md` promises the paid tier "a synchronous replica (libSQL / LiteFS) on a second node" with near-zero RPO. This spike measures the candidates against a plain file, so the owner can decide by ADR (D5 names the storage; this directory never edits `docs/13-decisions.md`).

| File | What it does |
| --- | --- |
| `writer.ts` | The load: one insert of ≈ 230 bytes per transaction into one SQLite file (WAL, `synchronous = normal`), as fast as the file allows; prints writes/s, p50, p99 and the last acknowledged id; `--ack-file` keeps the last ack on disk for RPO |
| `run.sh` | Runs `plain`, `litestream` (1 s sync, restore on "host 2"), `litefs` (static lease, FUSE), `libsql` (`sqld` primary, embedded replica) with two processes on one host; `--kills N` runs of SIGKILL for RPO and RTO; a candidate whose tools are missing is skipped with the reason |
| `libsql/writer.ts`, `libsql/replica.ts` | The same load sent to `sqld` over HTTP with `@libsql/client`, and the embedded replica on "host 2" that calls `sync()` until it is caught up, then every 100 ms. Their own `package.json` (not a workspace member: `renox-data` does not use libSQL); `bun install` there first |

Promotion. Litestream: `litestream restore` on host 2 (reads and writes once restored). LiteFS: a static lease has no election, so the kill runs restart the replica as the candidate, the step a Consul lease would automate; RTO includes that restart. libSQL: the replica file serves reads; a new `sqld` seeded from it (`VACUUM INTO`, which folds in the WAL) takes writes. RTO is measured from the kill to the first read and to the first acknowledged write on host 2.

Tools: `litestream` from `ops/scripts/fetch-litestream.sh`; `litefs` and `sqld` from their GitHub releases (the versions and sha256 are in the result file); `fusermount3` for LiteFS.

```
bench/spike/replica/run.sh --seconds 10 --kills 10 --out /tmp/replica-spike
```

Results: `bench/results/2026-10-29-replica-spike.md`.
