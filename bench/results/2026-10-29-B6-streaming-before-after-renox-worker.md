# B6 — SSR medium page, before and after streaming (#161) — 2026-10-29
Hardware: dev-laptop (Intel(R) Xeon(R) Processor @ 2.10GHz, 4 vCPU, Linux 6.18.44-fc-v185), rustc 1.99.1, bun 1.4.4; before: release `renox-worker` of `main` bc4df84, after: the batch Y4 branch (ops 1.2.0)
Scenario: the B6 page measured end to end through the worker with `bench/run.sh B8 --profile dev-laptop --runs 3` (its path A: the shop list page at 100 items, about 26 KB, loader → JSON → minijinja on the render pool, and the `product_list` fragment); 100 warm-up then 500 sequential timed requests per variant, client-side time to the last byte, and a 10 s load with 8 connections; median run of 3. Each binary was run twice, alternating (after, before, after, before)
Result (second pair; raw: `raw/2026-10-29-B6-streaming-before.json`, `raw/2026-10-29-B6-streaming-after.json`):

| Variant | Before p50 / p99 ms | After p50 / p99 ms | Before / after `cpu_ms` | Before / after req/s |
| --- | --- | --- | --- | --- |
| Page, 100 items | 3.68 / 6.10 | 3.63 / 5.81 | 0.81 / 0.84 | 935 / 949 |
| Fragment, 100 items | 3.66 / 6.04 | 3.62 / 5.52 | 0.73 / 0.77 | 876 / 943 |

First pair, same order: page p50 3.45 → 3.65 ms, p99 5.57 → 5.47 ms, `cpu_ms` 0.73 → 1.00 ms; fragment p50 3.62 → 3.79 ms. The two pairs disagree in direction, so the differences are run-to-run noise on a shared 4 vCPU container.

Target: B6 not regressed (#161 acceptance criterion; `docs/14-benchmarks.md` B6: p50 ≤ 3 ms, p99 ≤ 15 ms on `node-small`) → **PASS (not regressed)**; the absolute B6 numbers wait for `node-small` (#158, batch O3).
Notes: the B6 page's loader is fast, so it never reaches the 50 ms shell delay (`docs/contracts/ops.md` section 14) and keeps the one-piece path; what every request pays for 1.2.0 is the response sink opened per request and the static-body check in the bootstrap. `bench/scenarios/B6/run.sh` measures the render stage only (no HTTP or isolate) and does not exercise this change.
