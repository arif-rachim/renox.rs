# Changelog

Releases of the developer toolkit: the `renox` CLI (GitHub Release `cli-v<version>`), the SDK `@renoxium/sdk` (npm, same version) and the `renox-worker` the CLI pins (GitHub Release `worker-v<version>`). The platform itself (control plane, production workers) deploys from `main` and is not versioned here.

## 0.1.4 (unreleased)

- `@renoxium/cli` and `create-renox` on npm (D30, #440).
- An app with only `.html` pages and `public/` files builds, runs under `renox dev` and `renox test`, and deploys; its artifact has an empty `code.entry` and the worker starts no isolate for it (artifact 1.6, #495).
- `renox add email` also delivers org invitations: email fills `org.send_mail` with the `org_invite` mail in EN/AR, in the organisation's locale, when `org` is installed (#475).
- `@renoxium/sdk` is licensed under Apache-2.0 from this version (`LICENSE`, ADR D29, #469); 0.1.0 to 0.1.3 were published under MIT and stay so.

## 0.1.3 (2026-11-05)

What the first hour on a Mac found (#462; the pinned `renox-worker` stays 0.3.0).

**Install**

```sh
curl -fsSL https://github.com/arif-rachim/renox.rs/releases/download/cli-v0.1.3/install.sh | sh
```

**CLI**

- `renox test` works on macOS. The harness wrote the worker's `artifacts_dir` relative to its state directory under `$TMPDIR`, which on macOS is a symlink under `/var`; the worker resolved it into `/private/Users/...` and was refused at start-up. Every path in the generated worker configuration is now absolute.
- A worker that exits during `renox test` start-up now names its last error line and the configuration file in the hint, instead of only the exit code.
- `renox dev` no longer prints the worker's `disk usage unreadable` warning every 5 seconds on macOS, where the disk probe is unsupported.
- CI runs the first-hour smoke test on macOS as well as Linux; the script no longer needs `realpath`, which macOS before 13 does not have.

## 0.1.2 (2026-11-05)

The first hour of a new developer, from sign-up to a live deploy (batch ONBOARD-1: #443, #444, #445, #446, #447, #448, #449, #450). The pinned `renox-worker` stays 0.3.0; the worker change of #444 ships with the next `worker-v*` release and the CLI pin that follows it.

**Install**

```sh
curl -fsSL https://github.com/arif-rachim/renox.rs/releases/download/cli-v0.1.2/install.sh | sh
```

**CLI**

- `renox test` works in the installed binary: it runs the real `bun` (exit 3 with the install hint when it is missing) instead of spawning itself without end, and refuses to run inside another `renox test` (#448).
- `renox add auth` works in the installed binary: the official modules are embedded and extracted to `~/.cache/renox/modules/<digest>/`, checked against their digest. Adding an official module offers the official modules it needs in the same prompt (`auth` brings `i18n`) (#448).
- `renox check` type checks the TypeScript with the app's own `typescript` (findings of rule `types` with file, line and column; one warning when `typescript` or `tsconfig.json` is missing; `--types-only`, `--no-types`). `renox deploy` refuses an app with type errors (exit 2) unless `--skip-types`. `run_check` over `renox mcp` returns the type findings (#443).
- `renox new` prints every step to a live app and the docs URL, writes a `README.md`, and `--template hello` adds a home page with its layout and a test; the app gets `typescript` and `bun-types` as devDependencies and a `typecheck` script (#449, #443).
- `renox dev` no longer prints the production node's warnings (`fetch_blocked_addresses`, `platform_key_file`, the disk watermark); other worker lines are one short line (`RENOX_DEV_RAW=1` for the JSON). It stops its worker on SIGTERM too. A handler that returns something other than a Response is named with a hint, with a worker that has #444 (#449, #444).
- `renox <command> --help` for every command, "did you mean" for an unknown command, unknown flags named, grouped `renox --help` (#449).
- `renox login` prints a link to the dashboard's `/device` page with the code filled in, and stops at once when the request is denied there (#446).

**Dashboard and site** (deployed from `main`, listed here for the developer's view)

- Sign in with email and password, the second factor (authenticator code, recovery code, passkey) and its set-up, and "forgot password"; the verification link signs you in (#445). The `/device` page approves `renox login`; a Tokens page creates, lists and revokes tokens (#446).
- The real install line instead of `bunx renox`, only the templates the CLI has, "Docs" in the navigation (#447). Broken links fixed, with a link checker (#449).

**Release**

- A CI job and a release step run the compiled CLI from outside the repository through the first hour (`cli/scripts/smoke.sh`) (#448).

## 0.1.1 (2026-11-04)

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
