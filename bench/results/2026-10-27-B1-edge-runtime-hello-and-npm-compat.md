# B1 — Memory per warm isolate — 2026-10-27
Hardware: dev-laptop (Intel(R) Core(TM) i7-6700 CPU @ 3.40GHz, 8 vCPU, 15 GB RAM, Linux 7.0.0-38-generic), git c3b527c, rustc 1.99.1, bun 1.4.4, node 24.21.0, deno n/a
Scenario: RSS delta per pinned user worker, apps hello+npm-compat, N = 1/10/50/100, settle 10 s, 10 samples at 1 s, median of 3 runs; judged: hello at N = 100
Result: hello_n1_rss_delta_mb 13.97, hello_n1_pss_delta_mb 13.97, hello_n1_baseline_rss_mb 74.11, hello_n1_total_rss_mb 88.61, hello_n1_heap_total_mb 9.16, hello_n1_create_p50_ms 83.61, hello_n10_rss_delta_mb 10.8, hello_n10_pss_delta_mb 10.78, hello_n10_baseline_rss_mb 74.12, hello_n10_total_rss_mb 182.3, hello_n10_heap_total_mb 9.16, hello_n10_create_p50_ms 27.21, hello_n50_rss_delta_mb 9.97, hello_n50_pss_delta_mb 9.95, hello_n50_baseline_rss_mb 74.07, hello_n50_total_rss_mb 572.1, hello_n50_heap_total_mb 9.16, hello_n50_create_p50_ms 27.08, hello_n100_rss_delta_mb 9.77, hello_n100_pss_delta_mb 9.76, hello_n100_baseline_rss_mb 73.91, hello_n100_total_rss_mb 1051, hello_n100_heap_total_mb 9.16, hello_n100_create_p50_ms 27.8, npm_compat_n1_rss_delta_mb 94.53, npm_compat_n1_pss_delta_mb 94.49, npm_compat_n1_baseline_rss_mb 74.05, npm_compat_n1_total_rss_mb 168.6, npm_compat_n1_heap_total_mb 23.68, npm_compat_n1_create_p50_ms 605.8, npm_compat_n10_rss_delta_mb 78.37, npm_compat_n10_pss_delta_mb 78.35, npm_compat_n10_baseline_rss_mb 74.05, npm_compat_n10_total_rss_mb 857.8, npm_compat_n10_heap_total_mb 23.78, npm_compat_n10_create_p50_ms 498.4, npm_compat_n50_rss_delta_mb 74.25, npm_compat_n50_pss_delta_mb 74.25, npm_compat_n50_baseline_rss_mb 73.8, npm_compat_n50_total_rss_mb 3786, npm_compat_n50_heap_total_mb 23.81, npm_compat_n50_create_p50_ms 493.8, rss_delta_mb 9.77 MB
Target: ≤ 10 MB RSS delta (fail: > 20 MB) → PASS
Notes: profile dev-laptop, runs 3; not node-small: relative comparison only, never pass/fail; npm-compat N=100 run 1 skipped: MemAvailable 8444 MB < 10494 MB needed; npm-compat N=100 run 2 skipped: MemAvailable 8444 MB < 10494 MB needed; npm-compat N=100 run 3 skipped: MemAvailable 8444 MB < 10494 MB needed; hello: per-worker delta drift across runs at N=100: 9.77 → 9.77 MB (0%)
Raw: bench/results/raw/2026-10-27-B1.json

Verdict on this profile: **PROVISIONAL PASS for `hello`** (9.77 MB per worker at N = 100, inside the ≤ 10 MB target), **PROVISIONAL FAIL for `npm-compat`** (74–94 MB per worker, far above the 20 MB fail threshold). Pass/fail is only final on `node-small`. The judged metric `rss_delta_mb` is `hello` at N = 100, because B1's scenario is "example app loaded, idle" and `hello` is the only dependency-free app in F0; the kill criterion in `docs/15-roadmap.md` must be read against both rows.

## Per app and N (RSS delta per pinned worker, median of 3 runs, 10 s settle, 10 samples)

| App | N | RSS delta / worker | PSS delta / worker | V8 `totalHeapSize` / worker | Create p50 | Runtime total |
| --- | --- | --- | --- | --- | --- | --- |
| hello | 1 | 13.97 MB | 13.97 MB | 9.16 MB | 83.6 ms | 88.6 MB |
| hello | 10 | 10.80 MB | 10.78 MB | 9.16 MB | 27.2 ms | 182.3 MB |
| hello | 50 | 9.97 MB | 9.95 MB | 9.16 MB | 27.1 ms | 572.1 MB |
| hello | 100 | **9.77 MB** | 9.76 MB | 9.16 MB | 27.8 ms | 1,051 MB |
| npm-compat | 1 | 94.53 MB | 94.49 MB | 23.68 MB | 606 ms | 168.6 MB |
| npm-compat | 10 | 78.37 MB | 78.35 MB | 23.78 MB | 498 ms | 857.8 MB |
| npm-compat | 50 | **74.25 MB** | 74.25 MB | 23.81 MB | 494 ms | 3,786 MB |
| npm-compat | 100 | skipped | | | | needs ~10.5 GB, 8.4 GB available |

- Baseline (main service only, no user worker): 73.7–75.1 MB RSS in every start.
- RSS and PSS agree to within 0.02 MB: nothing is shared between workers; each isolate owns its pages.
- Leak check: the per-worker delta at the largest N is identical across the three fresh processes (hello N = 100: 9.77 → 9.77 MB, 0% drift). Within a process, no growth was observed during the 10 s sampling window.
- `hello` converges from 14 MB (N = 1, which includes one-off costs of the first worker) to 9.8 MB; the marginal worker is ~9.7 MB, of which 9.2 MB is V8 heap reservation (`totalHeapSize`; `usedHeapSize` is 7.8 MB).

## Reading it

- A dependency-free app meets B1 **without** a snapshot or eszip, which are the F1 mechanisms meant to lower exactly this number (D19). Against the baseline (`2026-10-27-BASE-HELLO-bun-node-hono.md`: 23 MB per Bun process, 79 MB per Node process) the isolate is 2.4× denser than Bun today.
- An app that imports the full B17 package set (stripe, checkout-sdk-node, arctic, @oslojs, resend, nodemailer, zod, date-fns, plus the hand-written helpers) costs ~74 MB per worker: 24 MB of V8 heap and ~50 MB outside the heap (compiled module code, Deno's module graph and npm resolution state for 41 packages). That is 3.7× the kill threshold. Nothing in F0 mitigates it; the candidates are eszip bundling with V8 code cache (F1), a shared module cache across workers of the same deployment, and the `shared` module-context mode in `docs/10-modules.md`. **The F0 gate (#14) must decide whether B1 is judged on `hello` or on a realistic app, and F1 must re-measure B1 with the `shop` skeleton (#34) in eszip form before the F1 gate.**
- The per-worker RSS is almost exactly the V8 heap for `hello`, so the heap limit (`memoryLimitMb`) is the lever for density of small apps; for apps with dependencies the lever is module loading, not the heap.
- Measured through the pinned Docker image (`EDGE_RUNTIME_MODE=docker`), apps staged outside the monorepo (see `bench/edge-runtime/NOTES.md`, "The root package.json trap": served from inside the repository, a `hello` worker costs ~56 MB instead). Not on `node-small`.
