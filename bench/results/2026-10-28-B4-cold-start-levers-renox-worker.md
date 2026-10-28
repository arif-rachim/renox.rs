# B4 / B1 — Cold-start levers (#157) — 2026-10-28
Hardware: dev-laptop (Intel(R) Xeon(R) Processor @ 2.30GHz, 4 vCPU, 16 GB RAM, Linux 6.18.44-fc-v180), renox-worker release builds of `main` (f38fdc1) and of 37b1c68 plus the uncommitted #157 changes, rustc 1.99.1, bun 1.4.4, node 22.22.0
Scenario: B4 as in `bench/scenarios/B4/worker.ts` (199 fresh tenants on `examples/hello`, sequential first requests, 3 runs) and B1 `shop` at N = 100 (`B1_APPS=shop B1_SIZES=100`, 3 runs), each on both binaries on the same container, interleaved (main, #157, main or #157, main, #157); plus `crates/renox-runtime/tests/cold_start.rs` (release, in-process) on the `examples/shop` artifact `renox build` writes (`e7020d53…`), 30 isolates per variant
Result: B4 p50_ms 14.28 / 13.98 ms with #157 against 15.87 / 16.62 ms on main; B4 p99_ms 36.65 / 38.06 against 37.77 / 34.08; B1 shop rss_delta_mb 10.68 / 10.67 MB with #157 against 10.65 MB on main; re-created shop isolate: module evaluation p50 10.3–10.7 ms with the code cache against 16.8–18.9 ms without
Target: B4 p50 ≤ 20 ms (met on this host by both binaries, as since #155; the 22.3 ms of #145 was another host state); B1 ≤ 10 MB (missed by both: 10.65 / 10.67 MB)
Notes: profile dev-laptop, not node-small: relative comparison only, never pass/fail (`docs/14-benchmarks.md`). The `node-small` re-run of B1 and B4 belongs to #158 (batch O3; the bench hosts do not exist yet). This host measured main at 15.9–16.6 ms today against 21.3 ms on 2026-10-28 morning (#154 run): compare only rows of this file with each other.
Raw: bench/results/raw/2026-10-28-B4-157-main-1.json, -main-2.json, -1.json, -2.json; bench/results/raw/2026-10-28-B1-157-main.json, -1.json, -2.json; bench/results/raw/2026-10-28-B4-157.hw.json, bench/results/raw/2026-10-28-B1-157.hw.json

## Verdict per lever

| Lever | Verdict | Evidence |
| --- | --- | --- |
| **Open the tenant DB in parallel with isolate creation** | **Adopted.** B4 p50 −1.6 to −2.6 ms (−10 to −16 %) | `crates/renox-cell/src/manager.rs` opens the file on its DB thread (`DbHandle::open_in_background`) before the artifact is verified, and runs migrations alongside `create_isolate`. B4 runs: main 15.87, 16.62 ms; #157 14.28, 13.98 ms. B1 unchanged |
| **V8 code cache** | **Adopted for re-created isolates.** Module evaluation of a re-created `shop` isolate −40 %, creation p50 −6 to −10 ms; no effect on a deployment's first isolate (B4, B1 unchanged) | `crates/renox-runtime/src/loader.rs` `CodeCache`: per tenant and deployment, keyed by a hash of the full source. The first version stored the cache of every first isolate: B1 `shop` rose by 0.2–0.34 MB per tenant (10.82 / 10.77 / 10.99 MB against 10.6 / 10.65 MB), the size of `shop`'s cache (271 KB). The final version stores from a deployment's second isolate on, so pool members, the spare, recycles and re-creation after an idle eviction benefit, and single-isolate tenants pay nothing |
| **eszip instead of shared-chunk `esm-dir`** | **Not adopted.** No measurable difference | In-process, same modules: V8 heap 6.48–6.50 MB for both; module evaluation and RSS per isolate follow the order of the series, not the format (table below). The CLI keeps writing `esm-dir`; `artifact.md` "Open" 2 stays open |
| **Evaluate route modules on first use** | **Not done in #157: needs a contract change** | `docs/contracts/ops.md` section 11 steps 4–5 import every `code.entry` module at isolate creation and fail the deployment on a missing or non-function export (fail closed). Lazy evaluation changes both; a `type:task` issue may not edit a contract (`docs/25-execution.md`, rule 7). Size of the prize: `shop` costs 10.65 MB per isolate against 7.4 MB for `hello` (B1, #143); its routes that are not `GET /api/products` hold most of the difference (the Stripe SDK in `checkout`, evaluated at creation) |

## In-process: format × code cache (`tests/cold_start.rs`, release)

30 isolates of one deployment per row, created after one warm-up isolate (with the cache on, the warm-up isolate is the deployment's first and stores nothing, the first measured one stores, the other 29 load from the cache). Two orders, because the first series also pays process-wide first-use pages (its RSS column is not comparable).

| Order | Variant | `create_isolate` p50 / p99 ms | module eval p50 ms | V8 heap MB | RSS per isolate MB |
| --- | --- | --- | --- | --- | --- |
| esm-dir first | esm-dir, cache off | 29.03 / 59.27 | 18.90 | 6.49 | (10.25, first series) |
| | esm-dir, cache on | 18.77 / 27.48 | 10.72 | 6.47 | 2.19 |
| | eszip, cache off | 26.90 / 38.07 | 17.49 | 6.48 | 2.32 |
| | eszip, cache on | 19.21 / 35.66 | 10.63 | 6.48 | 1.89 |
| eszip first | eszip, cache off | 28.04 / 56.17 | 17.69 | 6.49 | (10.98, first series) |
| | eszip, cache on | 18.50 / 28.02 | 10.33 | 6.50 | 2.35 |
| | esm-dir, cache off | 24.62 / 38.12 | 16.78 | 6.48 | 1.91 |
| | esm-dir, cache on | 18.72 / 40.29 | 10.67 | 6.48 | 1.44 |

`shop`'s code cache is 271 KB per deployment. The in-process RSS column counts isolates kept alive in one process and is not B1's per-tenant figure.

## B4 and B1 runs

| Binary | B4 p50 ms | B4 p99 ms | B4 worker wall p50 ms | B1 shop N=100 MB |
| --- | --- | --- | --- | --- |
| main (f38fdc1), run 1 | 15.87 | 37.77 | 15.56 | 10.65 |
| main, run 2 | 16.62 | 34.08 | 16.28 | — |
| #157, run 1 (code cache stored on first isolates) | 14.28 | 36.65 | 13.98 | 10.99 / 10.82 / 10.77 |
| #157, final | 13.98 | 38.06 | 13.66 | 10.68 / 10.67 |

B4's tenants each create one isolate of `hello`, so the code cache never applies there; its gain is the DB lever alone.

## Open

- B1 `shop` ≤ 10 MB needs lazy route modules (contract change to `ops.md` section 11; see the issue) or a smaller `checkout` dependency.
- `node-small` re-run: #158.
