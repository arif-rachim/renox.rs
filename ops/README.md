# ops

Operational files that the build and CI trust. Owned by code owners (`.github/CODEOWNERS`); every change is reviewed.

| File | What it is |
| --- | --- |
| `v8-checksums.txt` | sha256 of every prebuilt `rusty_v8` archive the build may link |
| `v8-archive.sh` | Downloads the archive for the locked `v8` version, verifies it against `v8-checksums.txt`, prints its path |
| `v8-archive.test.ts` | Tests of the above (`bun test ops`), including one changed byte failing the build |

## Verified prebuilt V8

The `v8` crate's build script downloads a static library archive (`librusty_v8<features>_release_<target>.a.gz`) from GitHub and checks nothing, so a tampered archive would end up in every `renox-worker` build (`docs/24-threat-model.md` section F, "Tampered prebuilt rusty_v8 binary"). CI does the download itself instead:

```
archive=$(ops/v8-archive.sh fetch x86_64-unknown-linux-gnu "$RUNNER_TEMP/rusty_v8")
export RUSTY_V8_ARCHIVE=$archive   # the build script copies this file, no download
cargo build ...
```

`fetch` reads the single `v8` version from `Cargo.lock` (two versions are an error), looks up the one archive for that version and target in `v8-checksums.txt`, downloads it, and fails with `checksum mismatch` before cargo runs if the sha256 differs. A version or target without an entry also fails, so a `v8` bump cannot reach CI unverified.

`RENOX_V8_MIRROR` points `fetch` at a mirror with the upstream layout (`<base>/v<version>/<archive>`), for example our object storage once it exists; the default is `https://github.com/denoland/rusty_v8/releases/download`. It is deliberately not `RUSTY_V8_MIRROR`, which the `v8` build script reads to download further files unverified.

Local builds still let the build script download the archive; set `RUSTY_V8_ARCHIVE` from `fetch` the same way to verify it locally.

### Adding a `v8` version or a target

1. Find the archive name: `librusty_v8` + the enabled feature suffixes in this order (`_ptrcomp`, `_sandbox`, `_simdutf`; see `cargo tree -e features -i v8`) + `_release_<target>.a.gz`. Today it is `librusty_v8_simdutf_release_<target>.a.gz`.
2. Download it from `https://github.com/denoland/rusty_v8/releases/download/v<version>/<archive>` twice, from two different networks or machines, and check both give the same `sha256sum`. Upstream publishes no checksum file, so this first download is trusted; record where it came from in the PR.
3. Add the line `<sha256>  v<version>/<archive>` to `v8-checksums.txt` and remove the lines of versions no longer in `Cargo.lock`.
4. Bump the `v8` (and the Deno crates) in the same PR; Dependabot leaves them alone (`.github/dependabot.yml`).

Current entry: `v150.4.0/librusty_v8_simdutf_release_x86_64-unknown-linux-gnu.a.gz`, downloaded twice from the upstream release on 2026-10-27 with the same sha256, both times from the same build container (one network); a second-network check is still owed.
