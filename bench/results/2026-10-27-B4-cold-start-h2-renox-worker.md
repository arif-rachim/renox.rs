# B4 — Cold start — 2026-10-27
Hardware: dev-laptop (Intel(R) Xeon(R) Processor @ 2.10GHz, 4 vCPU, 16 GB RAM, Linux 6.18.44-fc-v165), git 53aed0e plus the uncommitted #145 changes of batch H2 (lazy readers, artifact cache, extension modules in the snapshot), rustc 1.99.1, bun 1.4.4, node 22.22.0, deno n/a
Scenario: renox-worker (release): first request of 199 fresh tenants on examples/hello (esm-dir), sequential, client-side time to the full response; median of 3 runs
Result: p50_ms 22.32 ms, p99_ms 45.37 ms, worker_wall_p50_ms 21.86, worker_wall_p99_ms 44.5, warm_p50_ms 1.179, failed_cold_starts 0
Target: p50 ≤ 20 ms, p99 ≤ 100 ms (fail: p99 > 100 ms) → FAIL
Notes: profile dev-laptop, runs 3; not node-small: relative comparison only, never pass/fail; p50_ms 22.325 ms misses the target 20 ms; run 1: cold p50 24.28 / p99 39.315 ms (worker wall p50 23.794 / p99 38.512 ms), warm p50 1.28 ms; run 2: cold p50 22.325 / p99 45.37 ms (worker wall p50 21.861 / p99 44.5 ms), warm p50 1.179 ms; run 3: cold p50 21.07 / p99 36.057 ms (worker wall p50 20.45 / p99 35.533 ms), warm p50 1.18 ms; failed cold starts (all runs): {}
Raw: bench/results/raw/2026-10-27-B4-h2.json

Verdict: **PROVISIONAL FAIL, findings recorded**. Cold start p50 is 22.3 ms against the 20 ms target, down from 31.5 ms in [the #35 run](2026-10-27-B4-cold-start-renox-worker.md); p99 is 45.4 ms (was 55.6). 0 of 600 cold starts failed. Measured on the same 4 vCPU / 16 GB cloud container, not `node-small`.

## Findings (#145)

- **Where the 31.5 ms went.** `renox-worker` now logs the phases of each cell creation (`"cell ready"`: `artifact_ms`, `db_ms`, `migrate_ms`, `isolate_ms`, `module_ms`). An instrumented run before the fix below gave these p50 values: cell creation 17 ms (artifact lookup 0, tenant database open 4, migrations 0, isolate 11, tenant module evaluation 0). The other ≈ 13 ms were the fresh isolate's first dispatch.
- **The fix that moved B4.** That first dispatch loaded Deno's lazily loaded extension modules (`23_request.js`, `23_response.js`, `06_streams.js`, `00_url.js`) inside the request. The bootstrap now loads them at its top level, which runs while the platform snapshot is built, so they are part of the snapshot and no isolate loads them again. Proved by `tests/dispatch.rs::request_and_response_modules_are_in_the_snapshot`.
- **Second hash skipped.** The runtime keeps the verified artifact per directory (`Runtime::load_artifact`), so a deployment is hashed once per process instead of once per cell. For `hello` the cost was under 1 ms, so this barely shows here. It matters for large artifacts.
- **Reader connections lazy.** `TenantDb::open` opens the writer only, and readers are opened by the first read. `db_ms` stayed around 4–5 ms: most of it is creating a new file (WAL switch, platform schema), and every B4 tenant is new.
- **Remaining 22 ms:** isolate creation from the snapshot ≈ 12 ms, tenant file creation ≈ 5 ms, and request plus HTTP ≈ 5 ms. Next levers, not done in this batch:
  - Open the database in parallel with isolate creation. This needs a `DbHandle` that opens its file on its own thread and guarantees that migrations run before tenant module code; that changes the API between renox-runtime and renox-cell.
  - Pre-create isolates. The isolate takes tenant state (secrets, `DbHandle`, limits) at bootstrap, so a spare must be generic and bound later. That is a runtime design change.
