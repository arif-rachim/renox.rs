# Spike: the synchronous replica for the paid tier (#256)

`docs/06-data.md` promises the paid tier "a synchronous replica (libSQL / LiteFS) on a second node" with near-zero RPO. This spike measures the candidates against a plain file, so the owner can decide by ADR (D5 names the storage; this directory never edits `docs/13-decisions.md`).

| File | What it does |
| --- | --- |
| `writer.ts` | The load: one insert of ≈ 230 bytes per transaction into one SQLite file (WAL, `synchronous = normal`), as fast as the file allows; prints writes/s, p50, p99 and the last acknowledged id; `--ack-file` keeps the last ack on disk for RPO |
| `run.sh` | Runs `plain`, `litestream` (1 s sync, restore on "host 2"), `litefs` (static leader, FUSE), `libsql` (`sqld`) with two processes on one host; `--kills N` runs of SIGKILL for RPO and RTO; a candidate whose tools are missing is skipped with the reason |

```
bench/spike/replica/run.sh --seconds 10 --kills 10 --out /tmp/replica-spike
```

Results: `bench/results/2026-10-29-replica-spike.md`.
