# B20 — Build/binary: renox-worker release size (#154) — 2026-10-28
Hardware: dev-laptop (Intel(R) Xeon(R) Processor @ 2.10GHz, 4 vCPU, 16 GB RAM, Linux 6.18.44-fc-v180), git 6f6d878 plus the uncommitted #154 changes, rustc 1.99.1, deno_runtime 0.268.0, v8 150.4.0, target x86_64-unknown-linux-gnu, workspace `[profile.release]` (thin LTO, codegen-units 1, strip)
Scenario: size of `target/release/renox-worker` built the way `.github/workflows/release-worker.yml` builds it (packaged: snapshot and residual lazy sources embedded), and the same binary without `packaged` as the baseline
Result: binary_mb 121.6 (127,462,496 bytes) packaged; 116.5 (122,141,792 bytes) unpackaged; gzip -9 of the packaged binary 46.0 (48,255,912 bytes)
Target: ≤ 100 MB → FAIL
Notes: MB = 2^20 bytes, as the workflow's size check computes it; one build each, sizes are deterministic for a given commit and toolchain; the CI half of B20 (CI ≤ 15 min warm) is unchanged and recorded in [the G2 run](2026-10-27-B20-ci-time-sccache.md)

Verdict: **FAIL, and it is not caused by packaging.** The binary is over the limit even without the packaged feature: 116.5 MB. Packaging adds 5.1 MB, that is the embedded data (snapshot 2.5 MB, transpiled residual lazy sources 3.7 MB) minus about 1.2 MB of snapshot-building code that is no longer linked. The release workflow's size check therefore fails the build job, after the smoke tests have run, and no `worker-v*` release can be published until the size is fixed.

## Where to cut (not done here: outside #154's files)

- **Release profile** (root `Cargo.toml`): `opt-level = "s"` and `panic = "abort"` are the usual first steps. Both change the performance or failure behaviour of every crate, so B4/B5/B11 have to be re-measured with them.
- **Deno extensions linked but not exposed to tenants:** `deno_canvas` (pulls `image`), `deno_webgpu` (pulls `wgpu`/`naga`), `deno_cache`, `deno_cron`, `deno_kv`, and others. A request handler needs none of them; whether tenant code can reach each one is decided per global in renox-runtime's README, "Hidden globals". Leaving them out of the extension set needs `deno_runtime` to tolerate missing extensions, or stubs with the same op names. That is a runtime design change.
- **Compressed asset:** gzip brings the download to 46 MB. B20 is defined on the binary, though, so a compressed asset alone does not pass it.
