# @renox/artifact-validate

One implementation of the artifact rules, shared by the CLI (`renox check`, `renox build`) and the control plane's upload validation (`control/api`):

| Rules | Source | Code |
| --- | --- | --- |
| V1–V22 (the artifact tree; V17–V22 are the modules of artifact 1.1, #227) | [`docs/contracts/artifact.md`](../../docs/contracts/artifact.md) section 6 | `src/artifact.ts`, `src/schema.ts`, `src/paths.ts` |
| T1–T8 (the upload tarball) | [`docs/contracts/deploy-api.md`](../../docs/contracts/deploy-api.md) section 4 | `src/tar.ts` |
| H1 forbidden files, H2 secrets (bundle hygiene, #115) | `docs/05-tenant-lifecycle.md` "Bundle hygiene"; `docs/24-threat-model.md` sections B and C | `src/hygiene.ts`, `src/secrets.ts` |

The F1 gate (#37) folded the tar rules of #95 and the bundle rules of #115 into this package instead of separate `tar-safe` and `bundle-rules` packages, so the API and the CLI import one implementation. The H rules are not part of `checkArtifactFiles`: `renox build` filters and scans before the artifact exists (`cli/src/lib/build.ts`, `cli/src/lib/secrets.ts`), and the control plane applies them to uploads (`control/api/src/deployments/validate-bundle.ts`). `docs/contracts/deploy-api.md` section 4 says these rules report under their own rule ids in a minor version of the contract; `H1` and `H2` are those ids until a contract issue records them.

## Safe extraction (T1–T8)

`extractTar(stream, { gzip, limits })` reads a tar or gzip tar **as a stream** and applies every cap while it reads. It stops at the first violation, cancels the input, and throws `TarRejected` with `{ rule, path?, reason }`; over the input cap it throws `InputTooLarge` (the API answers 413). It never writes to disk. What it holds is bounded by T2, and a bomb is never read to its end.

| Rule | Cap (`UPLOAD_LIMITS`) | Checked |
| --- | --- | --- |
| Input | 100 MiB as sent | per chunk, before decompression |
| T1 | regular files and directories only: no symbolic or hard links, devices, FIFOs, sparse files | at each header |
| T2 | 100 MiB of file bytes in total | at each header, from the declared size, **before** the entry's bytes are read |
| T3 | 10,000 entries | at each header |
| T4 | `artifact.md` section 1 paths: no absolute path, no `..`, at most 32 segments and 512 bytes, NFC | at each header |
| T5 | 20 MiB per file | at each header, before the entry's bytes are read |
| T6 | gzip ratio 50:1 | continuously, once 1 MiB has been decompressed |
| T7 | a path twice, or as both file and directory | at each header |
| T8 | 30 s wall clock | on every read |

Sourcemap uploads use the same reader with 50 MiB for the input and T2 (`control/api/src/deployments/extract.ts`).

## For the worker's artifact loader (#55, #162)

The worker loads artifacts from object storage in Rust, so it cannot import this package. It must apply the **same caps, in the same order, at the same points** (each header is checked before its bytes are read; the ratio is checked while decompressing, not after), and stop at the first violation without writing more than the T2 cap to its artifacts directory. A rejected artifact is not cached, and the activation fails with `RENOX_ACTIVATION_FAILED`.

The control plane already refuses these uploads, so a violation in the worker means the object store holds something the API never accepted; log it as an operator alert.

To test the loader against the same inputs:

```sh
bun packages/artifact-validate/src/bombs.ts <dir>     # writes T1-symlink.tar, T3-many-entries.tar, ...
```

Each file is named `<rule>-<name>.tar` and must be rejected with that rule. The large bombs (high-ratio gzip, oversized entry, total size) are lazy streams in `src/bombs.ts` and are not written as files. Generate them in the Rust tests the same way: a 2 GiB gzip of zeros in 16 MiB files (T6), one 64 MiB entry (T5), and eight 18 MiB random files (T2).

## Tests

`bun test` in this directory. `tests/tar.test.ts` covers each T rule; `tests/hygiene.test.ts` the H rules, with a false-positive corpus; `tests/bombs.test.ts` runs the generated bombs and checks how far into each one the reader got. `control/api/tests/extract.test.ts` sends the same bombs through the upload endpoint.
