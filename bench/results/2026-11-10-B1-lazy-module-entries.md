# B1 — Lazy module `services` and `hooks` entries (#640, ADR D32) — 2026-11-10

| | |
| --- | --- |
| Host | dev-laptop profile, session container: Intel(R) Xeon(R) Processor @ 2.10GHz, 4 vCPU, 16 GB RAM, Linux 6.18.44-fc-v338 |
| Build | release `renox-worker`, `CARGO_PROFILE_RELEASE_DEBUG=0`; rustc 1.99.1, bun 1.4.4 |
| Before | `main` at `11af504` (worker and CLI of that commit) |
| After | this branch at `1a839dd` (worker and CLI of that commit): `renox build` writes the module entries `eager: false` with their recorded hook and event names, and the runtime evaluates them on first use |
| Scenario | `B1_APPS=shop B1_SIZES=100 BENCH_RUNS=3 BENCH_WORKER_EXTRA_TOML=$'[tiers.free]\ncpu_ms = 1000\n' bench/run.sh B1 --profile dev-laptop`, both on the same host one after the other |
| Target | `docs/14-benchmarks.md` B1: ≤ 10 MB RSS per warm isolate |

**Provisional (D31).** This is a session container, not `node-small`. Both runs are on the same host, so the comparison holds. The absolute numbers do not: `main` measures 10.74 MB here, against the 11.96 MB that #457 measured on another container.

## Result

| Worker and CLI | `shop_n100_rss_delta_mb`, 3 runs | Median | `shop_n100_v8_heap_mb` |
| --- | --- | --- | --- |
| `main` 11af504 | 10.73, 10.74, 10.74 | **10.74 MB** | 4.53 MB |
| lazy module entries 1a839dd | 9.89, 9.88, 9.87 | **9.88 MB** | 3.93 MB |
| **change** | | **−0.86 MB (−8 %)** | **−0.60 MB** |

`shop` at N = 100 is under the 10 MB target on this host. Raw: `bench/results/raw/2026-11-10-B1-lazy-module-entries-main.json` (before) and `bench/results/raw/2026-11-10-B1-lazy-module-entries.json` (after; `.hw.json` is the host).

## Why less than #457's ≈ 4 MB

B1's warm request is an anonymous `GET /api/products`. On it, the principal lookup (`ops.md` section 17) calls `auth.principal`, so `auth`'s `services` entry is still evaluated in every isolate. It is the largest bundled module of the shop: 216 KB of the 0.9 MB under `code/modules/`. For an anonymous visitor `auth.principal` returns before running the `auth.principal` hook, so `org` and `twofa`, its fillers, stay unevaluated. Every other module (`i18n`, `org`, `twofa`, `audit`, `notifications`, `email`, `billing`, `tax_gcc`, `storage`, `reports`, `admin`, and `auth`'s `hooks` entry) is no longer evaluated in an isolate that serves only this request.

#457's estimate, "≈ 4.2 MB of modules per `shop` isolate", is the whole difference of `shop` over `hello`. It includes what lazy evaluation cannot remove: the module registry, `harden`'s frozen module info and secrets, the service proxies, the templates and route tables of 12 modules, the module code's share of the code cache, and `auth`. The measured −0.86 MB is what evaluation of the other modules cost.

## Check of the artifact

`renox build` of `examples/shop` at 1a839dd writes `"eager": false` on every `modules/<name>/services` and `modules/<name>/hooks` entry. The `hooks` entries record `hooks` and `on` (for example `modules/org/hooks`: `hooks: ["auth.agent_orgs", "auth.principal"], on: []`). No module of the shop sets `[module] eager = true`.

## Reproduce

```sh
CARGO_PROFILE_RELEASE_DEBUG=0 cargo build --release --locked -p renox-cell --bin renox-worker
RENOX_BUILD_LAZY_MODULES=1 RENOX_WORKER_PATH=$PWD/target/release/renox-worker B1_APPS=shop B1_SIZES=100 BENCH_RUNS=3 \
  BENCH_WORKER_EXTRA_TOML=$'[tiers.free]\ncpu_ms = 1000\n' bench/run.sh B1 --profile dev-laptop
```

`RENOX_BUILD_LAZY_MODULES=1`: since f136974, `renox build` writes lazy module entries only when the pinned worker is 0.8.0 or later. Until that pin, this variable makes the CLI build the artifacts these runs measured. The runs above predate the gate and built them lazy.

Run it once at `main` and once at the branch. The CLI of the same checkout builds the artifact, so each run measures its own `renox build`.
