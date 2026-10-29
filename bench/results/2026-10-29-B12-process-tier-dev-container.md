# B12 with the noisy tenant in its own process (#254)

| | |
| --- | --- |
| Date | 2026-10-29 |
| Host | dev container, 4 vCPU, Ubuntu 24.04.5, kernel 6.18.44, cgroup v1 hierarchy (no writable cgroup v2 tree) |
| Scenario | `docs/14-benchmarks.md` B12: tenant A runs an infinite loop and an unbounded allocation while tenant B serves B6; here A is placed in a child process (`[process] own_tenants`), B stays in the shared process |
| Target | B's p99 changes ≤ 10 %; A terminated at its CPU limit ± 5 ms |
| Status | **Not measured** |

## Why not

- `bench/scenarios/B12/run.sh` drives the load with `oha`, which is not installed on the dev container (`bench/scenarios/README.md`: load generators are installed by hand).
- This host has no writable cgroup v2 tree, so the child would run without its `cpu.max` and `memory.max`: the run would measure the process split alone, not the tier.

## What is proven instead

`crates/renox-cell/tests/supervisor.rs` (passes on this host): the noisy tenant's child is a separate process; killing it with `SIGKILL` leaves the shared tenant serving, and the child is restarted within the backoff. The cgroup and fork-bomb part of the same file runs where a writable cgroup v2 tree exists.

## Owed

The run on `node-small` with the systemd units of `ops/` (cgroup v2, `Delegate=yes`) is listed for O3 (#158): `bench/run.sh B12 --profile node-small` with `[process] enabled = true` and A in `own_tenants`, against the F1 B12 numbers (`docs/14-benchmarks.md`, "F1 results").
