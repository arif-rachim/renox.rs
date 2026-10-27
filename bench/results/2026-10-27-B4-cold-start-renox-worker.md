# B4 — Cold start — 2026-10-27
Hardware: dev-laptop (Intel(R) Xeon(R) Processor @ 2.10GHz, 4 vCPU, 16 GB RAM, Linux 6.18.44-fc-v165), git d13fd0f, rustc 1.99.1, bun 1.4.4, node 22.22.0, deno n/a
Scenario: renox-worker (release): first request of 199 fresh tenants on examples/hello (esm-dir), sequential, client-side time to the full response; median of 3 runs
Result: p50_ms 31.52 ms, p99_ms 55.64 ms, worker_wall_p50_ms 30.86, worker_wall_p99_ms 54.99, warm_p50_ms 1.244, failed_cold_starts 0
Target: p50 ≤ 20 ms, p99 ≤ 100 ms (fail: p99 > 100 ms) → FAIL
Notes: profile dev-laptop, runs 3; not node-small: relative comparison only, never pass/fail; p50_ms 31.52 ms misses the target 20 ms; run 1: cold p50 31.52 / p99 55.642 ms (worker wall p50 30.864 / p99 54.992 ms), warm p50 1.244 ms; run 2: cold p50 30.544 / p99 53.239 ms (worker wall p50 29.876 / p99 51.652 ms), warm p50 1.225 ms; run 3: cold p50 34.865 / p99 103.022 ms (worker wall p50 34.066 / p99 102.289 ms), warm p50 1.309 ms; failed cold starts (all runs): {}
Raw: bench/results/raw/2026-10-27-B4-f1.json

Verdict: **PROVISIONAL FAIL on p50** (31.5 ms against 20 ms), p99 inside the 100 ms limit in the median run (one run's p99 was 103 ms). Measured on a 4 vCPU / 16 GB cloud container, not `node-small`.

## F1 findings

- This is the cold start of a whole **cell**, not of an isolate: the tenant's SQLite file is opened (writer + 2 readers, pragmas, platform table), the artifact is verified (canonical hash, manifest schema), migrations are checked, `secrets.json` is read, then the isolate is created from the snapshot and the request dispatched. The worker's own wall time (meter `wall_ms`, p50 30.9 ms) is within 1 ms of the client's, so HTTP is not where the time goes.
- `renox-runtime` alone creates a hello isolate in 12.6 ms p50 (`crates/renox-runtime` README, "Measurements"), so roughly 18 ms of the 31 ms is cell work around it: artifact verification hashes every file twice (once in `LocalArtifactStore`, once in `load_artifact`), and `TenantDb::open` runs its pragmas and platform-table DDL on three connections.
- Levers, in order of expected gain: cache the `ArtifactStore` verification across tenants on the same hash (it is, but `load_artifact` re-hashes per isolate); open reader connections lazily; pre-create isolates for hot deployments (#29 follow-up). Follow-up issue opened.
- No cold start failed (`failed_cold_starts 0`). An earlier attempt saw one 503 on a cold first request that did not reproduce; the scenario now records such failures instead of aborting.
- F0 baseline to beat was p50 32.3 ms / p99 38.7 ms on the Edge Runtime (isolate only); the F1 cell is at p50 31.5 ms including the database.
