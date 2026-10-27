# B20 — Build/binary — 2026-10-27
Hardware: GitHub-hosted runner ubuntu-24.04 (4 vCPU, 16 GB RAM), CI workflow `ci.yml`, git 2f528f5 (cold) and de367c1 (warm), deno_runtime 0.268.0, v8 150.4.0, rustc 1.99.1
Scenario: wall time of the CI run and of its `rust` job (`make rust-check` = fmt + clippy, `make rust-test` = all workspace tests, V8-linked renox-runtime included), read through `bench/run.sh B20` (GitHub REST API); renox-worker release asset size
Result: ci_min 9.7 min, rust_job_min 9.6 (warm, run 40527963397); cold: ci_min 29.8, rust_job_min 29.7 (run 40522848622); binary_mb not measured
Target: ≤ 100 MB; CI ≤ 15 min with cache → ci_min PASS; binary_mb NOT MEASURED (no renox-worker binary yet)
Notes: measured on the branch of PR "Batch G2" (issues #36, #109), push runs; `bench/run.sh B20 --runs 1` judged the run FAIL only because binary_mb is absent from the summary
Raw: bench/results/raw/2026-10-27-B20.json

Verdict: **CI time PASS, binary size open.** A warm run takes 9.7 minutes against the 15-minute target, so the `rust` job is not split (issue #36: "measure, and only split if B20 fails"). The binary-size half needs a `renox-worker` binary, which arrives with `crates/renox-cell` (#28); the first `worker-v*` release records it.

## What was measured

| Run | Commit | Cache state | `rust-check` | `rust-test` | `rust` job | Run wall time | sccache hit rate |
| --- | --- | --- | --- | --- | --- | --- | --- |
| [40522848622](https://github.com/arif-rachim/renox.rs/actions/runs/40522848622) | 2f528f5 | cold: no sccache entries, no `rust-cache` entry for this key | 11.8 min | 16.2 min | 29.7 min | 29.8 min | 0.4 % |
| [40527963397](https://github.com/arif-rachim/renox.rs/actions/runs/40527963397) | de367c1 | warm sccache; `rust-cache` missed (its key includes the new `RUSTY_V8_ARCHIVE` variable) | 5.5 min | 1.8 min | 9.6 min | 9.7 min | 96.2 % (Rust 98.8 %) |

- The warm number comes from sccache alone; with a `rust-cache` hit as well, `target/` is restored and most crates are not even recompiled, so later runs should be at or below it. Fixed costs in every run: freeing runner disk (1.0 min), saving the `rust-cache` entry (1.06 GB, 0.9 min).
- 240 of 2,563 compiler calls are not cacheable by sccache (binaries, proc-macros, build scripts with several inputs); they and linking the V8 test binaries are what remains in the warm run.
- The cold run had 83 sccache write errors (GitHub cache rate limiting on first fill); the warm run 4.

## Docs-only and TypeScript-only changes

The `changes` job gates the `rust` job on `crates/**`, `bench/spike/**`, `Cargo.*`, `rust-toolchain.toml`, `.cargo/**` and `ops/**`. The commit adding this result file touches only `bench/results/`; its CI run is linked in the PR as the check that `rust` is skipped.
