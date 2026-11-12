# B1 — `shop` on the pinned worker 0.8.0, lazy module entries by default (#743) — 2026-11-12

| | |
| --- | --- |
| Host | dev-laptop profile, session container: Intel(R) Xeon(R) Processor @ 2.30GHz, 4 vCPU, 16 GB RAM, Linux 6.18.44-fc-v378 |
| Build | no build: the sha-verified release `renox-worker` 0.8.0 (the version `cli/src/worker/verify.ts` pins); bun 1.4.4, node 22.23.4 |
| CLI | the CLI of this checkout at `fd4b148` (`cli-v0.1.13` pins worker 0.8.0) |
| Scenario | `RENOX_WORKER_PATH=<worker 0.8.0> B1_APPS=shop B1_SIZES=100 BENCH_RUNS=3 BENCH_WORKER_EXTRA_TOML=$'[tiers.free]\ncpu_ms = 1000\n' bench/run.sh B1 --profile dev-laptop`, `RENOX_BUILD_LAZY_MODULES` unset |
| Target | `docs/14-benchmarks.md` B1: ≤ 10 MB RSS per warm isolate |

**Provisional (D31).** This is a session container, not `node-small`, and not the container of the 2026-11-10 runs (kernel 6.18.44-fc-v338 there, v378 here; CPU 2.10 GHz there, 2.30 GHz here). The absolute numbers are indicative; compare the V8 heap more than the RSS.

## Result

| Run | `shop_n100_rss_delta_mb`, 3 runs | Median | `shop_n100_pss_delta_mb` | `shop_n100_v8_heap_mb` |
| --- | --- | --- | --- | --- |
| pinned worker 0.8.0, lazy by default (this file) | 10.11, 10.09, 10.10 | **10.10 MB** | 9.99 MB | 3.94 MB |
| lazy module entries, 2026-11-10 (`1a839dd`, other container) | 9.89, 9.88, 9.87 | 9.88 MB | 9.88 MB | 3.93 MB |

The V8 heap is the same (3.94 against 3.93 MB), so the lazy entries are in effect with no environment variable. The RSS is 0.22 MB above the 2026-11-10 run and just over the 10 MB target (PSS 9.99 MB is under it). The runs are in different session containers and the worker is a different build (0.8.0 against the 0.7.1 lineage of that branch), so this gap is not attributed to either; on `node-small` the number stays to be measured. Raw: `bench/results/raw/2026-11-12-B1-pinned-worker-0.8.0.json` (`.hw.json` is the host).

## Check of the artifact

`renox build` of `examples/shop` with this CLI, worker 0.8.0 and `RENOX_BUILD_LAZY_MODULES` unset writes `"eager": false` on all 66 `modules/<name>/services` and `modules/<name>/hooks` entries and on the app's `hooks` entry (none is eager). For example `modules/org/hooks`: `{"exports":["hooks","on"],"eager":false,"hooks":["auth.agent_orgs","auth.principal"],"on":[]}`. The CLI test `cli/tests/check.test.ts`, "examples/shop passes; its artifact records entries with lazy route modules", asserts the same for `modules/auth/services`.

## Reproduce

```sh
RENOX_WORKER_PATH=<renox-worker 0.8.0> B1_APPS=shop B1_SIZES=100 BENCH_RUNS=3 \
  BENCH_WORKER_EXTRA_TOML=$'[tiers.free]\ncpu_ms = 1000\n' bench/run.sh B1 --profile dev-laptop
```

No `RENOX_BUILD_LAZY_MODULES`: since f136974 `renox build` writes lazy module entries only when the pinned worker is at least `LAZY_MODULES_WORKER` (`cli/src/lib/hook-keys.ts`, 0.8.0), and the CLI that pins 0.8.0 (`cli-v0.1.13`) builds them lazy by default.
