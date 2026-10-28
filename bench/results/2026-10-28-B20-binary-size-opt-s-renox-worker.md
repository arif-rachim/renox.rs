# B20 — Build/binary: renox-worker release size, built for size (#154) — 2026-10-28
Hardware: dev-laptop (Intel(R) Xeon(R) Processor @ 2.10GHz, 4 vCPU, 16 GB RAM, Linux 6.18.44-fc-v180), git 1513eed plus the #154 release-worker.yml change, rustc 1.99.1, deno_runtime 0.268.0, v8 150.4.0, target x86_64-unknown-linux-gnu
Scenario: size of the packaged `renox-worker` built the way `.github/workflows/release-worker.yml` now builds it: the workspace `[profile.release]` (thin LTO, codegen-units 1, strip) with `CARGO_PROFILE_RELEASE_OPT_LEVEL=s` and `CARGO_PROFILE_RELEASE_LTO=fat` set for both build steps (the packaged-sources writer and the binary). Baseline: the same commit and steps without the two variables
Result: binary_mb 94.65 (99,249,248 bytes) packaged, built for size; 122.77 (128,736,352 bytes) packaged, workspace profile; 88.48 (92,777,568 bytes) built for size without `packaged`; gzip -9 of the packaged binary built for size 36.1 (37,810,563 bytes)
Target: ≤ 100 MB → PASS
Notes: MB = 2^20 bytes, as the workflow's size check computes it; one build each, sizes are deterministic for a given commit and toolchain; follows [the packaged run](2026-10-28-B20-binary-size-packaged-renox-worker.md) (121.6 MB at 6f6d878, FAIL); the CI half of B20 (CI ≤ 15 min warm) is unchanged, the size settings apply to the release workflow only (local build time of the two-step packaged build: 16.6 min built for size, 17.2 min with the workspace profile)

Verdict: **PASS, 5.3 MB under the limit.** The packaged binary drops from 122.8 to 94.7 MB. About 25 MB of `.text` is V8's prebuilt C++ library, which no Rust profile setting changes; the cut comes from the Rust code (`.text` of the unpackaged builds 81.3 → 57.7 MB).

## What was changed, and what was not

- **Changed:** `opt-level = "s"` and fat LTO, through `CARGO_PROFILE_RELEASE_*` in the release workflow's build job. The root `Cargo.toml` is outside #154's files, so the workspace profile is unchanged: `cargo build --release` for development, CI, and the benchmark harness (`bench/lib/worker.sh build`) still uses opt-level 3 and thin LTO. Only the published asset is built for size.
- **Not changed: `panic = "abort"`.** It would shrink the unwind tables (`.eh_frame` and `.gcc_except_table`, about 8 MB), but a panic on one isolate thread would then end the worker process with every tenant on it. That is a failure-mode change, not a packaging one.
- **Tried and dropped:** `opt-level = "s"` for everything except the request path (renox crates, `deno_core`, `serde_v8`, `v8`, `tokio`, `hyper`, `hyper-util`, `h2`, `http`, `bytes`, `axum`, `rusqlite`, `libsqlite3-sys`, `minijinja`, `serde_json` at opt-level 3) came out at 98.5 MB stripped. That leaves 1.5 MB of headroom, which the next F2 crate would use up.
- **Not done (runtime design change, a separate issue):** leaving unused Deno extensions out (`deno_webgpu`/`naga`/`wgpu`, `deno_canvas`, `deno_ffi`/`cranelift`, ...), listed in the previous result file.

## Effect on the benchmarks (same machine and commit, measured back to back, binaries alternating)

B4, cold start (`bench/run.sh B4 --runs 3`, 199 fresh tenants per run, `RENOX_WORKER_PATH` set to each packaged binary):

| Binary | round | p50 ms | p99 ms | worker wall p50 ms | warm p50 ms | failed |
| --- | --- | --- | --- | --- | --- | --- |
| workspace profile | 1 | 23.93 | 46.12 | 23.43 | 1.178 | 0 |
| built for size | 1 | 23.29 | 48.13 | 22.68 | 1.21 | 0 |
| workspace profile | 2 | 23.65 | 54.93 | 23.19 | 1.174 | 0 |
| built for size | 2 | 23.86 | 65.62 | 23.36 | 1.134 | 0 |

**B4 not worse:** p50 is within the round-to-round spread (23.29 and 23.86 against 23.93 and 23.65 ms). The p99 values come from 199 samples per run and move by 10 to 20 ms between rounds of the same binary. Both binaries miss the 20 ms p50 target, as in [the packaged run](2026-10-28-B4-cold-start-packaged-renox-worker.md) (21.37 ms, an earlier session on this container). Provisional until the `node-small` re-run (#158).

B5, hello latency under the B11 closed-loop load plus 1,000 sequential requests (`bench/run.sh B5 --runs 3`):

| Binary | round | req/s | p50 ms | p99 ms | sequential p50 ms | sequential p99 ms | worker RSS MB |
| --- | --- | --- | --- | --- | --- | --- | --- |
| workspace profile | 1 | 20,902 | 2.802 | 7.814 | 0.333 | 1.913 | 105.6 |
| built for size | 1 | 20,269 | 2.921 | 7.629 | 0.271 | 0.888 | 96.6 |
| workspace profile | 2 | 21,137 | 2.783 | 7.625 | 0.335 | 1.493 | 99.4 |
| built for size | 2 | 19,487 | 2.998 | 8.143 | 0.287 | 1.301 | 99.6 |

**The price is throughput under load: about 5% fewer requests per second** (19,487 to 20,269 against 20,902 to 21,137), and concurrent p50 is 4 to 8% higher. Sequential latency is lower with the size build. This is the trade the release asset makes to meet B20, and the B5 number to re-check on `node-small` (#158). If B5 or B11 has to win it back, the options are the extension cut above or a higher size limit through an ADR.

Raw: bench/results/raw/2026-10-28-B4-default-{1,2}.json, bench/results/raw/2026-10-28-B4-opt-s-{1,2}.json, bench/results/raw/2026-10-28-B5-default-{1,2}.json, bench/results/raw/2026-10-28-B5-opt-s-{1,2}.json

## Clean machine (built for size)

- With `~/.cargo` and the checkout hidden (mount namespace, the same check as #154's first run), the packaged binary built for size answered `GET /api/hello` on `hello.test` with `{"ok":true}`.
- `cli/scripts/fetch-worker.ts 0.1.0` downloaded `renox-worker-0.1.0-x86_64-unknown-linux-gnu` from a local copy of the release layout and verified its checksum; `cli/tests/dev.e2e.test.ts` passed on it.
- The `ubuntu:24.04` container step could not run locally because Docker Hub answered 429. The release workflow runs it on the pull request.
