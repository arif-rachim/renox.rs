# B17 — npm compatibility — 2026-10-27
Hardware: dev-laptop (Intel(R) Core(TM) i7-6700 CPU @ 3.40GHz, 8 vCPU, 15 GB RAM, Linux 7.0.0-38-generic), git c3b527c, rustc 1.99.1, bun 1.4.4, node 24.21.0, deno n/a
Scenario: examples/npm-compat GET /api/check inside a fresh Edge Runtime user worker per run (3 runs); cold_request_ms = first request including every package import
Result: failed_packages 0 packages, packages 13, cold_request_ms 644, warm_request_ms 13.43, stripe_ms 6.9, checkout_sdk_node_ms 1.55, telr_ms 1.71, paytabs_ms 2.92, tabby_ms 1.04, arctic_ms 1.19, _oslojs_crypto_oslojs_encoding_ms 0.15, whatsapp_cloud_api_ms 0.39, resend_ms 0.49, nodemailer_ms 16.76, zod_ms 3.1, date_fns_ms 0.77, intl_ms 17.19
Target: All run in the isolate with declared network allowlist (fail: Any core package fails) → PASS
Notes: profile dev-laptop, runs 3; not node-small: relative comparison only, never pass/fail; all packages ran inside the isolate
Raw: bench/results/raw/2026-10-27-B17.json

Verdict on this profile: **PROVISIONAL PASS**. Every package in the B17 list ran inside a Supabase Edge Runtime user worker; pass/fail is only final on `node-small`.

## Per package (inside the isolate, median of 3 fresh workers)

| Package | Version | In the isolate | ms (median of runs) | Error |
| --- | --- | --- | --- | --- |
| stripe | 23.0.1 | ok | 6.9 |  |
| checkout-sdk-node | 5.7.0 | ok | 1.55 |  |
| telr | hand-written | ok | 1.71 |  |
| paytabs | hand-written | ok | 2.92 |  |
| tabby | hand-written | ok | 1.04 |  |
| arctic | 3.7.0 | ok | 1.19 |  |
| @oslojs/crypto+@oslojs/encoding | 1.0.1+1.1.0 | ok | 0.15 |  |
| whatsapp-cloud-api | hand-written | ok | 0.39 |  |
| resend | 6.34.1 | ok | 0.49 |  |
| nodemailer | 10.2.1 | ok | 16.76 |  |
| zod | 4.6.7 | ok | 3.1 |  |
| date-fns | 4.4.0 | ok | 0.77 |  |
| intl | built-in | ok | 17.19 |  |
# B17 — npm compatibility — 2026-10-27
Hardware: dev-laptop (Intel(R) Core(TM) i7-6700 CPU @ 3.40GHz, 8 vCPU, 15 GB RAM, Linux 7.0.0-38-generic), git c3b527c, rustc 1.99.1, bun 1.4.4, node 24.21.0, deno n/a
Scenario: examples/npm-compat GET /api/check inside a fresh Edge Runtime user worker per run (3 runs); cold_request_ms = first request including every package import
Result: failed_packages 0 packages, packages 13, cold_request_ms 644, warm_request_ms 13.43, stripe_ms 6.9, checkout_sdk_node_ms 1.55, telr_ms 1.71, paytabs_ms 2.92, tabby_ms 1.04, arctic_ms 1.19, _oslojs_crypto_oslojs_encoding_ms 0.15, whatsapp_cloud_api_ms 0.39, resend_ms 0.49, nodemailer_ms 16.76, zod_ms 3.1, date_fns_ms 0.77, intl_ms 17.19
Target: All run in the isolate with declared network allowlist (fail: Any core package fails) → PASS
Notes: profile dev-laptop, runs 3; not node-small: relative comparison only, never pass/fail; all packages ran inside the isolate
Raw: bench/results/raw/2026-10-27-B17.json

`ms` is the time of the check itself (one real call per package, no network), not the import. The import cost is in the first request to a fresh worker: **`cold_request_ms` 644 ms** (590–662 across runs), against 13 ms for the same request on the warm worker. That 630 ms is the module graph of nine npm packages plus the hand-written helpers being loaded and compiled by Deno, and it is the number to keep in mind for apps that import payment and email SDKs (see B1 for the memory side of the same cost, and B4 for the hello function without dependencies).

## How it ran

- `bench/run.sh B17 --runs 3`, `EDGE_RUNTIME_MODE=docker`: pinned image `public.ecr.aws/supabase/edge-runtime:v1.77.8`, main service `bench/edge-runtime/main`, app staged by `run.sh` into a directory without the monorepo's `package.json` above it, `node_modules` installed there with `bun install` (Deno resolves bare specifiers from it). No `npm:` specifiers, no `DENO_DIR` tuning needed.
- Limits on the worker: `memoryLimitMb` 128, `cpuTimeSoftLimitMs` 1000, `cpuTimeHardLimitMs` 2000, `workerTimeoutMs` 300000, `envVars: []`.
- No network allowlist is enforced yet (the permissions option exists, F1 wires it); every check is offline by construction, so "declared network allowlist" is satisfied vacuously here and must be re-run under F1's `fetch` policy.
- Follow-up issues: none, no package failed.
