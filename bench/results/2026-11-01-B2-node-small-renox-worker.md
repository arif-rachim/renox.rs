# B2 — Memory per idle tenant on `node-small` — 2026-11-01

Hardware: node-small (AMD EPYC Processor (with IBPB), 4 vCPU, 8 GB RAM (7,941 MB), SSD (QEMU virtual disk), Ubuntu 24.04.5, Linux 6.8.0-147-generic; a KVM VPS), git 46fdfce (`main`), renox-worker release (`deno_runtime` 0.268.0, prebuilt `rusty_v8` 150.4.0), rustc 1.99.1, bun 1.4.4
Scenario: **500** `hello` tenants registered on renox-worker (release), each warmed with one request (8 at a time), then idle past `idle_timeout` 30 s; idle RSS sampled 35 s after the last eviction (after the allocator trims, #144): RSS per idle tenant. One run (`density.ts` takes `BENCH_RUNS`, default 1, not `--runs`).

| | Value |
| --- | --- |
| Registered and warmed | 500 (498 answered 200; 2 failed with `RENOX_CPU_LIMIT`) |
| Baseline RSS | 61.4 MB (10 threads, 11 files) |
| Peak RSS, 500 warm | 3,291 MB (1,522 threads) |
| Right after the last eviction | 2,963.6 MB |
| 35 s later (idle) | 114.6 MB (10 threads, 11 files) |
| **Per idle tenant** | **0.107 MB** |

Target: ≈ 0 MB (bookkeeping only) (fail: > 1 MB) → **PASS** (0.107 MB; 0.059 MB with 1,000 tenants on the dev container, [2026-10-27](2026-10-27-B2-idle-tenants-trim-renox-worker.md)).

## Method and raw command lines

```
export RUSTY_V8_ARCHIVE=$(ops/v8-archive.sh fetch x86_64-unknown-linux-gnu ~/bench-tools/rusty_v8)   # verified against ops/v8-checksums.txt
CARGO_PROFILE_RELEASE_DEBUG=0 cargo build --release --locked -j 3 -p renox-cell --bin renox-worker  # 33.5 min
RENOX_WORKER_PATH=$PWD/target/release/renox-worker bench/run.sh B2 --profile node-small --runs 3                       # attempt 1: 1,000 tenants, stopped (below)
DENSITY_TENANTS=500 RENOX_WORKER_PATH=$PWD/target/release/renox-worker bench/run.sh B2 --profile node-small --runs 3   # this result
```

Both ran detached under a guard that logged MemAvailable and disk every 5 s and stopped the run below 1 GB available or above 80 % disk; nothing else ran on the host. In the 500-tenant run the lowest MemAvailable was 3,790 MB, disk 59 %. No load generator: one request per tenant, 8 in flight, from the same host; the judged number is the idle RSS after every request has ended.

Raw: `bench/results/raw/2026-11-01-B2.json` (and `.hw.json`).

## Findings

- **1,000 warm `hello` tenants do not fit `node-small`.** Attempt 1 (the scenario's default, 1,000 tenants) was stopped by the guard during the warm-up at 516 MB MemAvailable, 36 s after it started; no tenant had gone idle yet, so it measured nothing for B2. On the dev container the same warm-up peaked at 7,197 MB RSS. 500 warm tenants peak at 3,291 MB here (6.5 MB each above the baseline, with 3 threads each). B3's F1 row extrapolates "997 warm" to `node-small` from 7.13 MB per warm tenant; this run does not measure B3 (B3 keeps 300 tenants warm with a 1 req/s trickle from the same host, which needs the load generator, #158), but the default B2 warm-up shows that "1,000 registered, all warm at once" is not an operating point for an 8 GB node.
- **Two cold first requests answered `RENOX_CPU_LIMIT`** (2 of 500, on a quiet host): the class of #342, whose fix (batch O4, `batch/o4-host-f2`) is not on `main` yet.
- The idle cost per tenant (0.107 MB) is above the dev container's 0.059 MB but inside the target's spirit: 1,000 idle tenants cost 107 MB.
