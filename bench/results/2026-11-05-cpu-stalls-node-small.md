# Host vCPU stalls counted as tenant CPU on `node-small` (#342, #523) — 2026-11-05

Hardware: node-small (AMD EPYC Processor (with IBPB), 4 vCPU, 8 GB RAM, SSD (QEMU virtual disk), Ubuntu 24.04.5, Linux 6.8.0-147-generic), a KVM VPS on a shared-vCPU plan. On 2026-11-04 the provider live-migrated the VM to another host node to fix an unrelated packet-loss problem. The guest is unchanged.

Worker: the installed release `renox-worker` 0.3.0 (`worker-v0.3.0`, c5d33da). Its CPU accounting is identical to `main` 21f0d16: `git diff worker-v0.3.0 21f0d16 -- crates/renox-runtime/src crates/renox-cell/src` changes only a `cpu.rs` unit test and the message of a handler that returns a non-Response.

## Summary

`node-small` counts the time the host takes a vCPU away as CPU of the thread that was running. The guest has no steal accounting, so the thread CPU clock, which the watchdog and the meter read, cannot tell a stalled vCPU from a tenant that spins. Since the migration of 2026-11-04 the stalls are about 3.5× longer in total than on the old host node, and up to 156 ms long. A cold `shop` request that does about 6.7 ms of work was charged 55.0 ms and answered 503 `RENOX_CPU_LIMIT` on the first B1 attempt. Two fixes inside the worker were tried and neither removes the overcharge (O4's first-request allowance; #378's warm-up of the request path). No fix inside the guest can tell the stall apart without under-counting tenant code. This is a known gap under ADR D31, and #342 is closed as not planned.

## 1. Host facts

| Fact | Value |
| --- | --- |
| Kernel | Linux 6.8.0-147-generic; `CONFIG_PARAVIRT_TIME_ACCOUNTING` is not set |
| Steal | 0 in `/proc/stat` and in `vmstat` (`st` column), idle and under load |
| `kvm-stealtime` | not in the boot log (`dmesg` shows `kvm-clock` only) |
| PMU | present (`Performance Events: AMD PMU driver`); `kernel.perf_event_paranoid` = 4 |

## 2. Stalls, old host node against new host node

`hiccup.c` (O4's tool: one thread per vCPU spinning on `clock_gettime`, every gap in the loop that the thread's own CPU clock also counted) on an idle guest (load < 0.1, no other work), 60 s per run. The O4 numbers are from 2026-10-31 (branch `batch/o4-host-f2`, never pushed; its `hiccup.c` and `gaps.c` are copied into this file's raw file).

| | O4 (old host) | now (new host) |
|---|---|---|
| 1 spinner: stall time counted on the thread clock, per minute | 3.5 s | **12.2 s** |
| 1 spinner: gaps ≥ 20 ms on the thread clock, per minute | 5 | **62** |
| 1 spinner: largest gap | 47.8 ms | **82.3 ms** |
| 4 spinners: gaps ≥ 20 ms on the thread clock, per vCPU per minute | 8–11 | **102–116** |
| 4 spinners: largest gap | 66 ms | **100–156 ms** |

## 3. The B1 attempt of 2026-11-05

`BENCH_KEEP=1 RENOX_WORKER_PATH=/opt/renox/bin/renox-worker bench/run.sh B1 --profile node-small --runs 3` stopped on its first attempt, at the second cold request:

| Tenant | Request | Route | `cpu_ms` | `wall_ms` | Status |
| --- | --- | --- | --- | --- | --- |
| `t_shop_0` | `01M6P2BRGN7SK62WP3ZFDDQ7N8` | `GET /api/products` | 6.75 | 458.5 | 200 |
| `t_shop_1` | `01M6P2BRZD0P6AJKNNBH9QT6AK` | `GET /api/products` | **55.0** | 492.0 | 503 `RENOX_CPU_LIMIT` |

The two requests are the same work on two fresh tenants of the same deployment: about 6.7 ms. The tenant log line of the second reads `request CPU limit reached; isolate recycled`, `phase: request`, `cpu_ms: 55.0`, `limit_ms: 50`.

## 4. Why there is no fix inside the guest

- The thread clock advances the same way when the vCPU is stalled and when the tenant spins, whether it is read from the isolate thread or from the watchdog.
- The stalls are mostly per vCPU (O4: 30 % of the gaps ≥ 5 ms overlap a gap on another vCPU), so the watchdog on another vCPU does not see the isolate's.
- An allowance large enough to cover today's stalls would have to exceed 150 ms, which lets tenant code run three times the free tier's 50 ms limit. That under-counts tenant code, which #342's goal forbids.
- The guest PMU's cycles do not run while the vCPU is stalled; O4 used them to prove the root cause. A cycles-based charge needs `CAP_PERFMON` for the worker or a lower `perf_event_paranoid` (an `ops/` change), a conversion from cycles to milliseconds on a CPU that changes frequency, and an ADR on what `cpu_ms` measures.

## 5. Options for later

1. A dedicated-vCPU host, or a host that publishes steal time to a guest kernel built with `CONFIG_PARAVIRT_TIME_ACCOUNTING`, so the thread clock stops counting it.
2. A cycles-based charge from the guest PMU with `CAP_PERFMON`; needs an ADR first.
3. B1 (and B12) measured on another host, with this file as the `node-small` caveat.

## Status

Known gap under D31 (`docs/13-decisions.md`): benchmarks on `node-small` are provisional, and gaps are recorded. #342 is closed as not planned. Recorded in `docs/23-failure-modes.md` (section 1, "Host vCPU stalls counted as tenant CPU") and on the B1 and B12 rows of `docs/14-benchmarks.md`.

## Raw command lines

```
gcc -O2 -pthread -o hiccup hiccup.c && ./hiccup 60 1 && ./hiccup 60 4     # source in bench/results/raw/2026-11-05-cpu-stalls-node-small.json, key "sources"
BENCH_KEEP=1 RENOX_WORKER_PATH=/opt/renox/bin/renox-worker bench/run.sh B1 --profile node-small --runs 3
# then the meter records in /tmp/renox-bench-*/meters/2026-11-05.ndjson
```

Raw: `bench/results/raw/2026-11-05-cpu-stalls-node-small.json` (the `hiccup` output lines of both runs, the two meter records of the B1 attempt, and the sources of `hiccup.c` and `gaps.c`).
