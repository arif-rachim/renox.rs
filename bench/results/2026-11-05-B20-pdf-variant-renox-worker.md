# B20 — Build/binary: the renox-worker release with a `pdf` variant shipped gzip-compressed (#381) — 2026-11-05
Hardware: dev container (4 vCPU, 15 GB RAM, Linux 6.18.44-fc-v236), git e6459f5 (`main`) plus the #381 changes, rustc 1.99.1, deno_runtime 0.268.0, v8 150.4.0 (the archive of `ops/v8-checksums.txt`), target x86_64-unknown-linux-gnu
Scenario: the `pdf` variant built exactly as `.github/workflows/release-worker.yml` now builds it (`CARGO_PROFILE_RELEASE_OPT_LEVEL=s`, `CARGO_PROFILE_RELEASE_LTO=fat`, the packaged sources written by `write_packaged_sources`, then `--no-default-features --features media,avif,pdf,renox-runtime/packaged`), packaged as the workflow does (`gzip -9 -n`); the default variant is the released `worker-v0.3.0` binary for the same target (the same composition without `pdf`), downloaded with `cli/scripts/fetch-worker.ts`
Result: pdf variant: binary 133.52 MiB (140,008,544 bytes), published asset `-pdf.gz` 52.25 MiB (54,792,548 bytes, 39.1 %); default variant: 107.35 MiB (112,565,344 bytes), published uncompressed (it would gzip to 41.36 MiB, 43,373,427 bytes); `gzip -9` 19.9 s, `gunzip` 1.1 s
Target: ≤ 120 MB per signed asset (the cosign ceiling is 128 MiB) → PASS for both assets of this target: 107.4 (default) and 52.3 (pdf, compressed)
Notes: MB = 2^20 bytes, as the workflow's size check and cosign compute it. Only x86_64 Linux was built here; the other targets are measured by the size check of the next `worker-v*` run, which writes both numbers of the pdf variant to the run summary. Estimates for them, from the #372 sizes with every feature (125.9 aarch64 Linux, 123.9 x86_64 macOS, 118.0 aarch64 macOS) and this target's ratio: 47 to 50 MiB compressed, far under 120. The build took 17.7 min for the snapshot step and 24.8 min for the binary on 4 vCPU without a cache. Follows [the #372 bloat analysis](2026-11-01-B20-binary-size-bloat-renox-worker.md)

Verdict: **`ctx.pdf` fits a cosign-verified release as a second, compressed asset.** The 128 MiB ceiling applies to the file cosign verifies (`verify-blob`, `verify-blob-attestation`), and that file is now the `.gz`: 52 MiB for the 134 MiB binary, so the typst engine needs no cuts and no new engine to ship. The default build stays as it is (the asset `install.sh` and `fetch-worker.ts` download, 107.4 MiB, and its `pdf_unavailable` behaviour), so nothing changes for a developer who does not ask for the variant. The feature-neutral cuts of #381 (a compressed embedded payload, the snapshot writer as its own feature, the narrower typst crates) are not needed for the ceiling; they would still help the 100 MB goal of the uncompressed default build.

## What ships per target (from worker-v0.4.0 on)

| Asset | Contents | Size, x86_64 Linux | Signed and in `SHA256SUMS` |
| --- | --- | --- | --- |
| `renox-worker-<v>-<target>` | default build, no `pdf` | 107.35 MiB | yes |
| `renox-worker-<v>-<target>-pdf.gz` | `pdf` variant, `gzip -9 -n` | 52.25 MiB | yes |
| `SHA256SUMS.unpacked` | sha256 of each `-pdf` binary after `gunzip` | — | signed (`.sigstore.json`) |

## Checks run on this build

- `fetch-worker.ts --pdf` against the release layout served locally: it checks the `.gz` against its `.sha256`, unpacks it, and installs a file byte-identical to the built binary (`cmp`).
- `RENOX_WORKER_PDF=1 bun test cli/tests/dev-pdf.e2e.test.ts` on that worker: `renox dev` serves the bilingual invoice of `crates/renox-runtime/tests/pdf.rs` (English, Arabic right-to-left, a table) as `application/pdf`, 36,448 bytes, `%PDF-` header.
- `RENOX_WORKER_PDF=0` on the released `worker-v0.3.0` binary: the same app gets `RENOX_INTERNAL`, `details.reason: "pdf_unavailable"`, and `/api/hello` still answers.
- `bun test cli/tests/dev.e2e.test.ts` and the whole CLI suite on the pdf variant (`RENOX_WORKER_PATH`): green.

Not run here: cosign on the `.gz` (signing needs the workflow's OIDC identity; the release job signs and verifies it in a fresh container), and the three other targets.
