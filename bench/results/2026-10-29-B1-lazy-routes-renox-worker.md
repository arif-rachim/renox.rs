# B1 — Memory per warm isolate, lazy route modules — 2026-10-29

Hardware: dev-laptop (Intel(R) Xeon(R) Processor @ 2.10GHz, 4 vCPU, 16 GB RAM, Linux 6.18.44-fc-v185), git dddd743, rustc 1.99.1, bun 1.4.4, node 22.22.0
Scenario: renox-worker (release), N tenants per app, each with one warm isolate after one request (`shop`: `GET /api/products`; `hello`: `GET /api/hello`); shop, hello at N = 1, 10, 100; esm-dir artifacts from the CLI; median of 3 runs; judged: shop at N = 100. Two builds of the same commit: the default (route modules `eager: false`, ops 1.4.0, #265) and `RENOX_BUILD_EAGER=1` (every entry eager, the 1.3.0 behaviour).

| | shop N = 1 | shop N = 10 | shop N = 100 | V8 heap (shop) | hello N = 100 |
| --- | --- | --- | --- | --- | --- |
| Lazy route modules (default) | 23.26 MB | 8.50 MB | **7.33 MB** | 4.25 MB | 6.32 MB |
| Every entry eager (baseline) | 29.05 MB | 13.66 MB | 11.57 MB | 6.96 MB | 6.32 MB |

RSS delta per isolate (PSS is the same). Raw: `bench/results/raw/2026-10-29-B1-lazy-routes.json`, `bench/results/raw/2026-10-29-B1-lazy-routes-eager-baseline.json` (and their `.hw.json`).

Target: ≤ 10 MB RSS delta (fail: > 20 MB) → **PASS** on the dev container (7.33 MB); the eager baseline misses it (11.57 MB).

Verdict: lazy route modules bring `shop` under the 10 MB target on this container: 7.33 MB per warm isolate at N = 100, 4.2 MB less than the same commit with every entry eager. The `node-small` run is O3's (#158); this file is a relative comparison on the 4 vCPU / 16 GB cloud container, not the gate measurement.

## Findings (#265)

- **What is no longer evaluated at creation.** The warm request is `GET /api/products`. With lazy routes the isolate evaluates that route's module only, plus the eager ones: the installed modules' `services` and `hooks` (auth, org, i18n). The Stripe SDK (`functions/api/checkout`, 584 KB) and the page modules are not evaluated until a request needs them. The V8 heap of a `shop` isolate falls from 6.96 MB to 4.25 MB, close to `hello` (4.05 MB).
- **The shop is bigger than in the 2026-10-27 run.** It now installs i18n, auth and org (F4), so its eager baseline (11.57 MB) is above the 11.09 MB of [the #143 run](2026-10-27-B1-shop-shared-chunks-renox-worker.md). The lazy build is below both.
- **The cost moves to the first request of a route.** Its module is evaluated inside that request (ops 1.4.0 section 7). The V8 code cache (#157) applies to lazy modules too (`crates/renox-runtime/tests/lazy_routes.rs`, `the_code_cache_serves_lazy_modules`), so the isolates of a deployment after the second one compile them from the cache.
- **`hello` is unchanged** (6.32 MB): its one route module is the one the warm request evaluates.
