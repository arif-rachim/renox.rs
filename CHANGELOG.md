# Changelog

Releases of the developer toolkit: the `renox` CLI (GitHub Release `cli-v<version>`), the SDK `@renoxium/sdk` (npm, same version) and the `renox-worker` the CLI pins (GitHub Release `worker-v<version>`). The platform itself (control plane, production workers) deploys from `main` and is not versioned here.

## 0.1.1 (unreleased)

No change in behaviour; the CLI, the SDK and the pinned `renox-worker` 0.3.0 are those of 0.1.0. What changes is how the SDK is published:

- `@renoxium/sdk` 0.1.1 is the first version published by `.github/workflows/release-sdk.yml` through npm trusted publishing (the workflow's OIDC identity, no long-lived token), with npm provenance: `npm view @renoxium/sdk@0.1.1 --json | jq .dist.attestations`, or the Provenance badge on npmjs.com.
- The install line moves to `cli-v0.1.1`:

```sh
curl -fsSL https://github.com/arif-rachim/renox.rs/releases/download/cli-v0.1.1/install.sh | sh
```

## 0.1.0 (2026-11-03)

The first public release of the CLI and the SDK (#431).

**Install** (Linux and macOS, x64 and arm64):

```sh
curl -fsSL https://github.com/arif-rachim/renox.rs/releases/download/cli-v0.1.0/install.sh | sh
```

The installer checks every file's SHA-256, and its sigstore signature when `cosign` is installed (`RENOX_REQUIRE_SIGNATURE=1` makes the signature mandatory). Verify by hand and the WSL 2 steps: `docs/12-developer-experience.md`, "Installing the CLI".

**What is in it**

- `renox` 0.1.0: four signed binaries (`bun build --compile`, no Bun needed to run them) with SLSA provenance. Commands: `new`, `build`, `dev`, `check`, `test`, `migrate`, `add`, `remove`, `approve`, `publish`, `jobs`, `authz explain`, `mcp`, `login`, `tokens`, `deploy` (with `--rollback`), `logs`, `secrets`, `db`. `renox --version` prints the CLI version and the pinned worker.
- Pins `renox-worker` 0.3.0 for all four targets (`x86_64` and `aarch64` Linux, `x86_64` and `aarch64` macOS), signed, the version production runs. `install.sh` installs it beside `renox`; the CLI refuses a worker without the pinned sha256 (closes #219).
- `@renoxium/sdk` 0.1.0 on npm: types and helpers for tenant code, with `@renoxium/sdk/kysely`, `/drizzle`, `/fakes` and `/test`. MIT licensed. `renox new` depends on it at the CLI's version. The SDK is scoped because npm refuses the unscoped name `renox` (D28).
- `renox login` defaults to `https://api.renoxium.com`; `renox deploy` puts the app live on `https://<app>.renoxium.app`.

**Known limits**

- No native Windows build: `renox-worker` runs on Linux and macOS only. Use WSL 2; `install.sh` prints the steps when it runs under Git Bash, MSYS2 or Cygwin.
- CLI 0.x: commands, flags and the `renox.toml` keys can still change between minor versions; breaking changes are listed here.
- `@renoxium/sdk` 0.1.0 was published by hand, so it carries no npm provenance; later versions are published by `.github/workflows/release-sdk.yml` with provenance.
- Not yet: Homebrew, Scoop, `npx` as an installer.
