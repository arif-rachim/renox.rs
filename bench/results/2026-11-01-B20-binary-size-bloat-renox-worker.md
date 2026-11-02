# B20 — Build/binary: where the renox-worker release size went, and the `media`, `avif` and `pdf` features (#372) — 2026-11-01
Hardware: dev container (4 vCPU, 15 GB RAM, Linux 6.18.44-fc-v185), git 10e802e (`main` after #378) plus the #372 changes, rustc 1.99.1, deno_runtime 0.268.0, v8 150.4.0 (the archive of `ops/v8-checksums.txt`), target x86_64-unknown-linux-gnu
Scenario: the packaged `renox-worker` built exactly as `.github/workflows/release-worker.yml` builds it (`CARGO_PROFILE_RELEASE_OPT_LEVEL=s`, `CARGO_PROFILE_RELEASE_LTO=fat`, `--features renox-runtime/packaged`, the workspace `[profile.release]`: codegen-units 1, strip), once with every feature and once without each of the new Cargo features; `cargo bloat --release --crates` on the same build with symbols kept (`CARGO_PROFILE_RELEASE_STRIP=none`, then `strip`), `readelf -S` for the sections
Result: binary_mb 133.69 (140,184,672 bytes) with every feature, the release composition, two steps with `strip = true` as the workflow (133.68, 140,172,384, when built with symbols for `cargo bloat` and stripped afterwards); 107.39 (112,606,304) without `pdf`; 132.53 (138,964,064) without `avif`; the release-worker run 41321600807 of the same source measured 133.72 (140,213,344) for this target
Target: ≤ 120 MB (the cosign ceiling is 128, see below; 100 MB until 2026-11-01, 160 MB from the morning of 2026-11-01) → FAIL with every feature (133.7), PASS for the release composition without `pdf` (107.4)
Notes: MB = 2^20 bytes, as the workflow's size check and cosign compute it; sizes are deterministic for a given commit and toolchain (the local build and the CI build of the same source differ by 41 KB of build-id and strip details); the `cargo bloat` figures are per crate after fat LTO, so inlined code is credited to the caller and 5.4 MiB is `[Unknown]`; follows [the 2026-10-28 size build](2026-10-28-B20-binary-size-opt-s-renox-worker.md) (94.7 MB, PASS at 100) and the F7 release-worker runs 41231474082 and 41321600807 (133.7 / 125.9 / 123.9 / 118.0 MB on the four targets)

Verdict: **the F7 growth is the PDF engine, not the image pipeline.** From 94.7 to 133.7 MB (+39.0 MiB), `typst` and its fixed dependency tree are 26.3 MiB, the AVIF encoder 1.15 MiB, and the other F7 code (storage, webhooks, AI, jobs, the module broker, the App MCP, realtime feeds, the sandbox) about 11.6 MiB. With every feature the binary stays over the 128 MiB cosign ceiling. **Decision (owner, 2026-11-02): the release is built without `pdf`** (`--no-default-features --features media,avif` on both build steps of `release-worker.yml`, `MAX_BINARY_MB` 120): 107.4 MB on this target, every target under 120 by the shares of run 41321600807. On the released worker, and so under `renox dev`, `ctx.pdf.render` answers `RENOX_INTERNAL` with `reason: pdf_unavailable` until a worker variant with the engine or a smaller engine exists (the follow-up issue).

## Why 128 and not 100

`cosign verify-blob-attestation` refuses an artefact over 128 MiB (134,217,728 bytes, `COSIGN_MAX_ATTACHMENT_SIZE`, CVE-2024-29902): the `worker-v0.2.0` tag run 41321600807 built all four targets and failed in "Verify in a fresh container" on the x86_64 Linux binary (140,213,344 bytes); nothing was published. Users verify with cosign too (`install.sh`, `docs/12`), so raising the cap is not the fix. `MAX_BINARY_MB` is 128 from this change, so the build job fails before the release job does; the B20 target is 128 MB with the same reason. 100 MB does not hold with `pdf` in the binary: even without the image pipeline and AVIF the typst tree alone puts the x86_64 Linux build at about 132 MB, and nothing in the three cuts below reaches 100 while the PDF engine stays.

## Sections of the stripped binary (bytes)

| Section | every feature | without `pdf` | PDF share |
| --- | --- | --- | --- |
| `.text` | 83,037,920 | 70,049,424 | 12.4 MiB |
| `.rodata` | 35,063,240 | 25,123,464 | 9.5 MiB (fonts 1.8 MB, typst's ICU, syntax-highlighting and bibliography data) |
| `.eh_frame` + `.eh_frame_hdr` | 10,157,912 | 8,593,364 | 1.5 MiB |
| `.rela.dyn` | 5,412,144 | 3,995,520 | 1.35 MiB |
| `.data.rel.ro` | 3,613,912 | 2,553,976 | 1.0 MiB |
| `.gcc_except_table` | 2,461,424 | 1,993,924 | 0.45 MiB |
| `.data` + `.bss` | 584,756 | — | — |
| **file** | **140,172,384** | **112,606,304** | **26.3 MiB** |

Unwind tables (`.eh_frame`, `.eh_frame_hdr`, `.gcc_except_table`) are 12.0 MiB; `panic = "abort"` would drop most of them but is out of scope (a failure-mode change, the 2026-10-28 file).

## Top 20 crates by `.text` (every feature; `cargo bloat --release --crates`, fat LTO)

| `.text` | Crate | Note |
| --- | --- | --- |
| 22.7 MiB | `v8` | the prebuilt library; no Rust setting changes it |
| 5.4 MiB | `[Unknown]` | inlined and C code without a crate (libsqlite3, aws-lc, brotli, …) |
| 3.1 MiB | `typst_library` | `pdf` |
| 2.5 MiB | `std` | |
| 1.9 MiB | `renox_cell` | |
| 1.7 MiB | `cedar_policy_core` | |
| 1.6 MiB | `aws_lc_sys` | through `deno_node_crypto` |
| 1.5 MiB | `sqlparser` | the `db.scoped` rewriter |
| 1.4 MiB | `renox_runtime` | |
| 1.4 MiB | `wgpu_core` | `deno_webgpu`, a fixed part of `deno_runtime` |
| 1.4 MiB | `deno_node` | |
| 1.0 MiB | `cranelift_codegen` | `deno_ffi`, fixed |
| 968 KiB | `deno_node_crypto` | |
| 927 KiB | `citationberg` | `pdf` (typst bibliographies) |
| 910 KiB | `naga` | `deno_webgpu` |
| 870 KiB | `hayagriva` | `pdf` (typst bibliographies) |
| 863 KiB | `jsonschema` | the artifact validator of the cell |
| 855 KiB | `deno_runtime` | |
| 831 KiB | `deno_core` | |
| 800 KiB | `deno_crypto` | |

Grouped (`.text` only): the typst tree 11.1 MiB over 95 crates (`typst_*`, `krilla`, `hayro*` PDF reader, `hayagriva` and `citationberg`, `syntect` and `two_face`, `usvg` and `resvg`, `tiny_skia`, `wasmi` plugins, `rustybuzz`, `skrifa`, `subsetter`, `icu_*`, `html5ever`); the Deno extensions 9.7 MiB plus `deno_webgpu` with `wgpu`/`naga` 3.3 MiB and `deno_ffi` with `cranelift` 1.25 MiB; `swc`/`deno_ast` 2.4 MiB; the AVIF path (`ravif`, `rav1e`, `v_frame`, `av1_grain`, …) 0.8 MiB; `image` with its JPEG, PNG and WebP codecs 0.4 MiB; the renox crates 4.5 MiB.

Deltas against the 2026-10-28 build (94.65 MB, 57.7 MB of `.text` unpackaged; that file recorded no per-crate table): the file grew by 39.0 MiB and `.text` by about 21 MiB. Of the growth, `pdf` is 26.3 MiB (67 %), `avif` 1.15 MiB (3 %), everything else of F7 about 11.6 MiB (30 %).

## The three cuts, in the order #372 asks for them

1. **Features of large dependencies that the code does not use: nothing to cut.** `typst` 0.15 and `typst-library` have no Cargo features: plugins (`wasmi`), syntax highlighting (`syntect`, `two-face`), bibliographies (`hayagriva`, `citationberg`), SVG and PDF image readers (`usvg`, `hayro`) come with the crate. `image` in the cell is already `default-features = false` with `jpeg`, `png`, `webp` (and `avif`); `ravif` and `rav1e` are already pulled without their defaults (no assembly, no binaries). `deno_runtime` 0.268 exposes no feature for its extensions (`deno_webgpu`, `deno_ffi`, `deno_node`, `deno_kv`, … are unconditional); leaving them out is the runtime-design change the 2026-10-28 file lists, not a feature flag. Dropping the `typst` facade crate for `typst-eval` + `typst-realize` + `typst-layout` directly would avoid `typst-html` and `typst-svg` with the `hayro` PDF reader (about 2 MiB of `.text`) at the price of a copy of `typst::compile`'s relayout loop; not done.
2. **A smaller AVIF path: not worth a tenant-visible change.** There is no other pure-Rust AVIF encoder; AVIF off (WebP kept) saves 1.15 MiB (133.68 → 132.53 MB), which does not reach any target, and `f=auto` would stop answering AVIF to browsers that ask for it (`ops.md` section 21). AVIF stays on; `avif` exists as a feature so the share is measurable and a lean worker can leave it out.
3. **`media`, `avif` and `pdf` as Cargo features, on by default.** `renox-runtime` has `pdf` (typst, typst-pdf, typst-layout, html5ever, markup5ever_rcdom optional); `renox-cell` has `media` (`image`), `avif` (`image/avif`) and `pdf` (`renox-runtime/pdf`), `default = ["media", "avif", "pdf"]`. The op set of the snapshot is unchanged, so a lean build uses the same packaged sources. What a lean worker answers (`errors.md` codes that exist): `op_render_pdf` → `RENOX_INTERNAL`, `details.reason` `pdf_unavailable`; `/_img` → 503 `RENOX_UNAVAILABLE`, `Retry-After: 5` (after the same lookup and signature checks; `/_files` serves as before); `ctx.storage.put` records no width or height; without `avif`, `f=auto` picks WebP and `f=avif` is 400 `RENOX_VALIDATION`. Tests: `tests/images.rs` (`without_avif_auto_serves_webp_and_f_avif_is_refused`, `without_media_files_serve_and_img_is_unavailable`, each behind its `cfg`), `tests/storage.rs` (dimensions), `tests/pdf.rs` (needs `pdf`).

Sizes by composition, this target:

| Composition | Flags of the `cargo build` step (the snapshot step is unchanged: the op set is the same, so the packaged sources of the full build were reused) | Bytes | MB |
| --- | --- | --- | --- |
| every feature (the release today) | `--features renox-runtime/packaged` | 140,172,384 | 133.68 |
| without `avif` | `--no-default-features --features media,pdf,renox-runtime/packaged` | 138,964,064 | 132.53 |
| without `pdf` | `--no-default-features --features media,avif,renox-runtime/packaged` | 112,606,304 | 107.39 |

The other three targets were 5.8 to 11.7 % smaller than x86_64 Linux in run 41321600807; the same shares put a release without `pdf` at about 101 MB (aarch64 Linux), 100 MB (x86_64 macOS) and 95 MB (aarch64 macOS). The release workflow measures them when this change merges.

## The options, and the one taken

- **Ship the lean release** (taken, 2026-11-02; `--no-default-features --features media,avif` on the two build steps of `release-worker.yml`): 107 MB here, every target under 120, `ctx.pdf` answers `pdf_unavailable` until the PDF engine is smaller or a worker variant with it exists. The `tax_gcc` invoices (#331) and `reports` (#333) call `ctx.pdf`.
- **Keep `pdf` and cut elsewhere, outside this issue's files** (not taken: about 128 together, no headroom): compress the embedded packaged payload (7.2 MB of snapshot and lazy sources, about 5 MB saved at a one-time decompression per process; `build.rs`, `runtime.rs`), build the packaged binary without `deno_runtime`'s `transpile` feature once the snapshot writer is its own feature (`swc`, about 2 MiB), the `typst` facade replaced by its parts (about 2 MiB), `panic = "abort"` (12 MiB, rejected on 2026-10-28). Together they reach about 128 on this target with everything in, not 120.
- **A PDF engine without the typst tree** (an ADR: `docs/13`), the only way back to 100 MB with PDF in the binary; with a worker variant that carries the engine, the content of the follow-up issue.

Raw: `cargo bloat` output in this file; the binaries are reproducible from the flags above.
