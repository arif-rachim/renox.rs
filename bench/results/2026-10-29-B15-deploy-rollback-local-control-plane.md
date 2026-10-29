# B15 — Deploy and rollback, examples/shop, local control plane (#60) — 2026-10-29
Hardware: dev-laptop (Intel(R) Xeon(R) Processor @ 2.80GHz, 4 vCPU, 16 GB RAM, Linux 6.18.44-fc-v185), git 7fafd60, rustc 1.99.1, bun 1.4.4, node 22.22.0, deno n/a
Scenario: `renox deploy --json` (the CLI as a process) of a fresh copy of `examples/shop` with one extra version route, so every run is a new hash: cold `renox build`, a new upload, a new cell. Local control plane: `control/api` on PGlite with the in-memory artifact store, plus one controlled `renox-worker` (debug build), all on the same machine. deploy = process start → first 200 of the new version from the worker. rollback = `renox deploy --rollback` start → first 200 of the previous version. 5 runs.
Result: deploy p50 0.361 s, p99 0.414 s; rollback p50 0.136 s, p99 0.154 s (n = 5 each)
Target: ≤ 30 s end-to-end; rollback ≤ 5 s (fail: > 60 s) → PASS
Notes: profile dev-laptop, not node-small: relative comparison only, never pass/fail. The local stack is not the compose stack (no Docker daemon in this container): Postgres is PGlite in the API process and artifacts stay in memory, so the upload skips an S3 put. `bench/scenarios/B15/run.sh` (RENOX_WORKER_PATH required; RENOX_TEST_PG switches the API to a real Postgres)
Raw: bench/results/raw/2026-10-29-B15.json

Verdict: **B15 met on the dev laptop by two orders of magnitude.** A deploy of the shop app is live in about 0.36 s and a rollback in about 0.14 s, against 30 s and 5 s.

## Stage breakdown (p50 of 5 runs, ms)

| Stage | p50 | What it contains |
| --- | --- | --- |
| build | 106 | `renox build`: route discovery, one `Bun.build` of the shop's modules, template transpile by `renox-worker transpile`, migrations, `public/`, manifest, content hash, secret scan; plus the gzip tar |
| upload | 23 | `POST /v1/apps/shop/deployments`: extraction with T1–T8, V1–V16 and H1–H2, store |
| sourcemaps | 39 | `PUT …/sourcemaps` (#128): tar and gzip of the `.map` files, extraction, store |
| activate | 106 | `POST /v1/apps/shop/activate`: `prepare` on the node's stream, artifact fetch, migrations, new cell (module evaluation), probe, `prepare_result`, the route switch |
| CLI process total | 352 | The four stages above, plus Bun start and module load of the CLI and `GET /v1/apps/shop` before and after (together 352 − 274 = 78 ms, not timed separately) |
| route | 9 | CLI exit → first 200 of the new version: whatever is left of the route delta's delivery to the node, then the first request on the prepared cell |

Rollback (136 ms p50) is almost all CLI process start: the `POST /v1/apps/shop/rollback` pointer switch took 38 ms of the CLI's own `total_ms` in one run of `cli/tests/deploy.e2e.test.ts`, and the previous cell is still warm.

## Follow-up issues

None filed. No stage is near its share of the 30 s and 5 s budgets. The biggest items are `renox build` and activation, about 0.1 s each, on a debug worker. Before the F3 gate the numbers that still need measuring are:

- the compose stack (Postgres and MinIO): the S3 put of the artifact and the node's artifact fetch;
- a bigger app;
- the CLI against a remote control plane over TLS.

This scenario runs all three setups unchanged once `RENOX_TEST_PG` and an S3 endpoint are configured, so they are measurements to take, not stages to fix.
