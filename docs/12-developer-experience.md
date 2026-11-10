# 12 — Developer experience

A tenant needs one CLI and an editor. Dev mode runs the same data plane as production locally, with SQLite, so laptop and server behave the same.

| Command | Purpose |
| --- | --- |
| `renox new <name>` | Project from a template: `hello` (a function, a home page and a test) or `blank` (one health route); prints the next steps |
| `renox dev` | Local server: hot reload, error overlay, type generation, local dashboard |
| `renox add <module>` | Add a module, update `renox.lock`, show requested permissions |
| `renox migrate` | Run migrations for all modules in dependency order |
| `renox check` | Type check the TypeScript with the app's own `typescript` (see "Type safety"), validate templates and policies, detect route conflicts and broken module contracts, lint unsafe SQL, scan for secrets (`--secrets`: only the secret scan) |
| `renox test` | Run TS tests in the production runtime, including policy test cases and per-role template snapshots |
| `renox deploy` | Bundle, upload, validate, activate; `--rollback <hash>` |
| `renox logs --follow` | Tenant logs |
| `renox apps list` / `rm <name>` / `restore <name>` | The tenant's apps. `rm` stops serving an app at once (type its name again, or `--yes`); `restore` brings it back within 7 days, then it is purged with its deployments, secrets and its own database (a database shared with the tenant's other apps is never touched; deploy-api.md 0.7 section 3). `list --deleted` shows what can still be restored |
| `renox apps rename <old> <new>` | Give an app a new name: it keeps its deployments, data, secrets, custom domains, logs and meters and is served at `<new>.<platform domain>` at once; `<old>.<platform domain>` stops being served (its users sign in again on the new hostname) and the old name stays this tenant's for 90 days. In the app's folder it offers to set `[app] name` in `renox.toml` (`--yes` sets it). A `renox deploy` with the old name in `renox.toml` stops with `renamed to <new>; update renox.toml` instead of creating a new app. The database id of an app with its own database stays `<tenant_id>.<old>` (deploy-api.md 0.7 section 3) |
| `renox authz explain` | Explain a policy decision |
| `renox db export` / `import` / `restore` | Download the production database; import a file into a staging app; restore a point in time into a new app. The local database of `renox dev` is `.renox/data/dev/app.db`, a plain SQLite file any SQLite client opens |
| `renox <command> --help` | The usage of any command; an unknown command or flag is named, with a suggestion |

### `renox test`

`renox test [pattern] [--seed <file.sql>] [-u]` builds the app, adds a test-only service route to a copy of the artifact, and runs `bun test` with `@renoxium/sdk/test` preloaded (#238). Each test file that calls `app()` gets the same prebuilt worker as `renox dev` (rule 5) on a fresh temporary tenant file: migrations applied, then `seeds/*.sql` and the `--seed` files. The helpers:

- `request`, `page`, `action`, each with its own cookie jar per user (`as(user)`), so session and CSRF work as in a browser;
- `service(module).<name>(...)`, through the broker like app code;
- a read-only `db` for assertions; it waits up to five seconds on the worker's write lock (`pragma busy_timeout = 5000`), and a test that opens `dbFile` with its own `bun:sqlite` connection should run the same pragma, or it fails with `SQLITE_BUSY` while the worker writes;
- `job(name, { module?, timeoutMs? })`, which runs a scheduled job now as a tick of its schedule (the rows `renox jobs run` writes; the test worker looks for them every 50 ms) and resolves after the run committed, or rejects with the job's error text (#593). The scheduler runs as in production, so a test should not wait for a schedule: call `job`;
- `tool(name, input, { as?, scope?, confirm? })`, which calls an App MCP tool on `/mcp` as the agent of `as` (default the calling user, signed in): it takes an agent token through the `auth` module's OAuth flow once per user and scope, then `tools/call`. A `confirm` tool answers `{ ok, preview, confirmation }`; with `confirm: true` the confirmation is sent back and the final `{ ok, result }` returned; a refusal is `{ ok: false, error: { code, message } }` (`RENOX_FORBIDDEN`, `RENOX_TOOL_SCOPE`, `RENOX_TOOL_INPUT`; `RENOX_TOOL_ERROR` for a result with `isError`). Without the `auth` module it throws (#593);
- `snapshot(html, { role })`, with request ids, nonces and CSRF tokens stripped;
- `installModule(name, source)` and `.upgrade(source)`, which return what `renox check` and the migration plan report;
- `policyCases()`, which reads `policies/tests/*.json` (`{ principal, action, resource, expected }`) as pending tests until Cedar is wired (F5).

Exit code 0 when every test passed, 2 when one failed.

### Installing the CLI

On Linux or macOS (x64 or arm64):

```sh
curl -fsSL https://github.com/arif-rachim/renox.rs/releases/download/cli-v0.1.11/install.sh | sh
export PATH="$HOME/.renox/bin:$PATH"    # the installer prints this line when ~/.renox/bin is not on PATH yet
renox --version                          # renox 0.1.11 (renox-worker 0.7.0)
renox new demo --template hello && cd demo && bun install && renox dev
```

`bun install` in the new app pulls the SDK `@renoxium/sdk` from npm at the CLI's version; it needs Bun 1.4 or later (the `renox` binary itself does not need Bun).

**With Bun.** The CLI is also one npm package, `@renoxium/cli`: a single bundled JavaScript file that runs on Bun (D30), at the version of the `cli-v*` tag.

```sh
bun add -g @renoxium/cli          # then: renox --version
bunx @renoxium/cli new myapp      # without installing
bun create renox myapp            # the create-renox package: renox new myapp
npm install -g @renoxium/cli      # needs Bun 1.4 or later on PATH
```

The package carries no worker. `renox dev`, `renox test` and `renox migrate` (and `renox build` of an app with a `pages/` or `policies/` folder) download the pinned `renox-worker` on first use into `~/.renox/bin`, the folder `install.sh` uses, and print one line saying so; a worker found earlier (`RENOX_WORKER_PATH`, beside a compiled `renox`, `cli/bin/`) is used as it is. What is checked: npm provenance covers the package (it was built by `release-cli.yml` from the tag), the sha256 pinned in the CLI covers the worker (downloaded or cached, a file that does not match is refused with `RENOX_CLI_WORKER_UNVERIFIED` and never run), and `install.sh` checks the sha256 of each file and the sigstore signature when `cosign` is installed. The standalone binaries and `install.sh` are unchanged.

**Bun is not installed for you.** `@renoxium/cli` has no dependencies. `"engines": { "bun": ">=1.4.0" }` is advice that npm does not act on, so `npm install -g @renoxium/cli` succeeds without Bun. Afterwards `renox` fails: its file starts with `#!/usr/bin/env bun`. On Windows the message comes from `cmd.exe` and does not name renox: `'"bun"' is not recognized as an internal or external command`. Install Bun first and check `bun --version` (1.4 or later). The standalone `renox` from `install.sh` or `install.ps1` has Bun built in, but the app itself still needs Bun for `bun install` and `renox test`.

**Install Bun and the CLI with the same tool.** How Bun was installed decides how the CLI can be installed:

| Bun was installed with | Install the CLI with | Why |
| --- | --- | --- |
| The official installer: `curl -fsSL https://bun.sh/install \| bash`, or on Windows `powershell -c "irm bun.sh/install.ps1 \| iex"` | `bun add -g @renoxium/cli` | The installer puts `bun` in `~/.bun/bin` and adds that folder to `PATH`; `bun add -g` puts `renox` there too. |
| npm: `npm install -g bun` | `npm install -g @renoxium/cli` | npm puts `renox` beside its own `bun`, which is on `PATH`. |

Avoid `bun add -g @renoxium/cli` with a Bun that npm installed. It installs without an error, then `renox` does not run, for two reasons:
- **`~/.bun/bin` is not on `PATH`.** `bun add -g` writes `renox` into `~/.bun/bin` (`%USERPROFILE%\.bun\bin` on Windows), and only the official installer adds that folder to `PATH`. The shell answers that `renox` is not found.
- **On Windows the launcher finds no `bun.exe`.** The `renox.exe` launcher that `bun add -g` writes looks for a real `bun.exe` on `PATH`. npm's Bun puts only a `bun.cmd` shim there; its `bun.exe` stays inside `node_modules\bun\bin`. The launcher answers `error: bun is not installed in %PATH%`.

To see which Bun you have, run `where.exe bun` (Windows) or `which -a bun`. A path under the Node.js folder (for example `C:\nvm4w\nodejs\bun.cmd`, or `$(npm prefix -g)/bin/bun`) is npm's Bun; `~/.bun/bin/bun` is the official one. With two Bun installations on `PATH`, keep one:
- npm's Bun: `npm uninstall -g bun`.
- The official Bun: delete `~/.bun` (`%USERPROFILE%\.bun`) and remove `~/.bun/bin` from `PATH`.
- Then install it again with the tool you chose. The official installer is the one `bun add -g` expects.

**In an app**, run `bun install` once after `renox new`. Without it, `renox test` stops with "@renoxium/sdk is not installed" (CLI 0.1.7 or later; before, bun's `Cannot find module '@renoxium/sdk/test'`). Run the tests with `renox test`, not `bun test`: `renox test` starts the test worker and sets `RENOX_TEST_HARNESS`, and `bun test` alone stops with `@renoxium/sdk/test: run the tests with renox test`.

**Upgrading.** The way you installed is the way you upgrade. Rerun `install.sh` or `install.ps1` from `releases/latest/download/`: they take the newest `cli-v*` release and replace `renox` and its pinned worker in place, or the release that `RENOX_VERSION` names. With Bun, run `bun add -g @renoxium/cli@latest`. The CLI has no self-update command. When both an installer copy and a Bun copy are present, the first on `PATH` runs (`which -a renox`, `Get-Command renox -All`). An app's `@renoxium/sdk` is upgraded in the app: `bun add @renoxium/sdk@latest`.

**The install line names a release that exists.** Every install line in the repository (this section, `docs/getting-started.md`, `cli/README.md`, the dashboard's `control/dashboard/lib/install.ts`, `www/public/llms-full.txt`) names a `cli-v*` release that is on GitHub Releases. The version in `cli/package.json` and the install lines move together (`control/dashboard/tests/copy.test.ts` checks the dashboard's against it), in the release commit that is then tagged the same day; a change for the next version is listed under it in `CHANGELOG.md` as "(unreleased)" and moves no install line. A newcomer's first command must never answer 404. Before a docs PR merges, the check is a grep for `cli-v` against the list of releases.

#### Windows

In PowerShell (x64):

```powershell
irm https://github.com/arif-rachim/renox.rs/releases/latest/download/install.ps1 | iex
```

The CLI runs natively on Windows (x64), and WSL 2 is optional. `renox-worker.exe` is published in `worker-v*` releases (from `worker-v0.4.0`) for development only: it runs isolates, without the production supervisor and sandbox. `install.ps1` installs it beside `renox.exe` after a SHA-256 check, and the CLI checks it against its pinned SHA-256 before running it (#532); from a checkout, `bun cli/scripts/fetch-worker.ts` puts it in `cli/bin/win32-x64/`. `dev`, `test`, `migrate` and apps with `.html` pages or policies work natively; there is no pdf variant for Windows. `renox dev` reloads routes on Windows without `SIGHUP`: the worker watches the routes file (#530). A CLI older than 0.1.6 pins no Windows worker: there these commands stop with `RENOX_CLI_WORKER_UNAVAILABLE` unless `RENOX_WORKER_PATH` names a `renox-worker.exe`. CI builds `examples/hello` and `examples/npm-compat` on Windows and on Linux and compares the artifact hashes, and runs `renox dev` and `renox test` of `examples/hello` with the pinned worker (`.github/workflows/ci.yml`, jobs `windows` and `windows-hash-parity`). Use `install.ps1` on Windows: `install.sh` stops with a pointer to it when it runs under Git Bash, MSYS2 or Cygwin. WSL 2 remains an option, and is a Linux machine:

1. In PowerShell as administrator: `wsl --install -d Ubuntu`, then restart Windows.
2. Open Ubuntu from the Start menu and create the Linux user it asks for.
3. In that Ubuntu terminal: `sudo apt-get update && sudo apt-get install -y curl unzip`, then `curl -fsSL https://bun.sh/install | bash` for Bun, and open a new terminal.
4. Run the install line above, inside Ubuntu. Keep your apps in the Linux file system (`~/apps/...`), not under `/mnt/c/...`: file watching for `renox dev` and file access are much slower across the Windows drive.

`renox dev` listens on `localhost:8787` inside WSL; WSL 2 forwards localhost to Windows, so `http://localhost:8787` opens in a Windows browser.

**Upgrading.** Run the install line again: it replaces `renox` and `renox-worker` in `~/.renox/bin` in place (`RENOX_VERSION=<version>` picks a version; without it, the newest `cli-v*` release). `renox --version` prints the CLI version and the worker it pins. That worker is the one `renox dev`, `renox test` and the template transpile of `renox build` run on your machine; production runs its own worker version, managed by the platform, so a CLI release does not change what runs your deployed app. `renox deploy` uploads an artifact that the production worker validates on its own (`docs/contracts/artifact.md`).

The CLI is released as standalone binaries (`bun build --compile`, so no Bun is needed) for Linux and macOS on x64 and arm64. A `cli-v<version>` tag runs `.github/workflows/release-cli.yml`, which publishes `renox-<version>-<os>-<arch>` with a `.sha256` for each binary, `install.sh`, and `worker-version.txt`. That file holds the `renox-worker` version the CLI is tested against: `WORKER_VERSION` in `cli/scripts/fetch-worker.ts`, whose release must exist before the CLI release. `curl -fsSL https://github.com/arif-rachim/renox.rs/releases/download/cli-v<version>/install.sh | sh` (source: `cli/scripts/install.sh`) installs into `~/.renox/bin`. It installs `renox` and the pinned `renox-worker` for the platform, and installs a file only when its SHA-256 matches. Override with `RENOX_VERSION`, `RENOX_INSTALL_DIR` and `RENOX_RELEASE_BASE`, or skip the worker with `RENOX_NO_WORKER=1`. `renox new`, `renox check`, and `renox build` of an app without `templates/` run without the worker; `renox dev` and the template transpile of `renox build` find the installed worker beside `renox`.

Releases are signed (#129; `docs/24-threat-model.md` F, "Tampered release"). Every `cli-v*` and `worker-v*` release also carries `SHA256SUMS`, a sigstore bundle `<asset>.sigstore.json` per file (cosign keyless signature from the release workflow's OIDC identity, logged in Rekor), and SLSA v1 build provenance (`renox-<version>.provenance.sigstore.json`, `renox-worker-<version>.provenance.sigstore.json`). The release workflow verifies all of them with cosign in a fresh container before it publishes. With `cosign` installed, `install.sh` also checks each file's signature and installs nothing that fails; `RENOX_REQUIRE_SIGNATURE=1` refuses to install without a verified signature. To verify a download by hand:

```sh
v=0.1.3; a=renox-$v-linux-x64
sha256sum -c --ignore-missing SHA256SUMS
cosign verify-blob --bundle $a.sigstore.json \
  --certificate-identity-regexp '^https://github\.com/arif-rachim/renox\.rs/\.github/workflows/release-cli\.yml@refs/tags/cli-v' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com $a
cosign verify-blob-attestation --bundle renox-$v.provenance.sigstore.json --new-bundle-format --type slsaprovenance1 \
  --certificate-identity-regexp '^https://github\.com/arif-rachim/renox\.rs/\.github/workflows/release-cli\.yml@refs/tags/cli-v' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com $a
```

**The SDK** (`sdk/`, package `@renoxium/sdk`, #376; npm refuses the unscoped `renox`, D28) is published to npm from the same `cli-v<version>` tag by `.github/workflows/release-sdk.yml`, at the CLI's version: `renox new` writes `"@renoxium/sdk": "^<cli version>"`, so `bun add @renoxium/sdk` (or `npm install @renoxium/sdk`) in a new app installs the SDK that CLI was released with. The package holds compiled JavaScript and declarations (`dist/`, built by `tsc -p sdk/tsconfig.build.json`); `@renoxium/sdk`, `@renoxium/sdk/kysely`, `@renoxium/sdk/drizzle`, `@renoxium/sdk/fakes` and `@renoxium/sdk/test` are its entry points. It is published with npm provenance (`npm publish --provenance`, the OIDC identity of the release workflow, logged in Sigstore): `npm view @renoxium/sdk --json | jq .dist.attestations` shows it, and `npm audit signatures` checks it in an app. The workflow refuses a tag whose version differs from `sdk/package.json` or `cli/package.json`, and a pull request that changes `sdk/` or the workflow runs the build, the packed-package test (`sdk/tests/pack.test.ts`) and `npm publish --dry-run --provenance` without publishing. A version npm already has is never published again: a tag's run skips the upload with a notice (0.1.0 was published by hand, #431), and the dry run checks a throwaway prerelease `<version>-dryrun.<run id>` instead.

For a worker use `release-worker\.yml@refs/tags/worker-v` and the worker release's files. The CLI checks the worker before it runs it: the downloaded or installed worker must have the sha256 of the pinned release for its platform, baked into the CLI (`PINNED_WORKER` in `cli/src/worker/verify.ts`, checked against the worker release when the CLI is released); `renox dev --worker <path>` also accepts a binary whose `<path>.sigstore.json` and the release's provenance bundle beside it verify with cosign as above. Anything else stops with `RENOX_CLI_WORKER_UNVERIFIED` (exit code 3) and the expected and actual sha256. `RENOX_WORKER_PATH` is the unverified override for a worker built from source.

**Which worker has `ctx.pdf`** (#381). The PDF engine behind `ctx.pdf` (typst, 26 MiB) does not fit in the default release build under the 128 MiB that cosign verifies (B20, `docs/14-benchmarks.md`), so each `worker-v*` release from 0.4.0 on carries two builds per platform:

| Worker | `ctx.pdf.render` | How you get it |
| --- | --- | --- |
| Default release build, `renox-worker-<version>-<target>` | fails with `RENOX_INTERNAL`, `details.reason: "pdf_unavailable"`; everything else works | `install.sh`, `bun cli/scripts/fetch-worker.ts` |
| PDF variant, `renox-worker-<version>-<target>-pdf.gz` | renders | `RENOX_WORKER_VARIANT=pdf` with `install.sh` (it verifies the `.gz`, unpacks it and installs it as `renox-worker`), `bun cli/scripts/fetch-worker.ts --pdf`, or by hand (below) |
| Built from a checkout, `cargo build --release -p renox-cell --bin renox-worker` (the `pdf` feature is on by default) | renders | `RENOX_WORKER_PATH=target/release/renox-worker` (not verified) |

The variant is published gzip-compressed: the `.gz` is what `SHA256SUMS`, its signature and the provenance cover, and the `.gz` is small enough for cosign. `SHA256SUMS.unpacked`, signed as well, lists the sha256 of each binary after `gunzip`, and the CLI pins those hashes beside the default ones (`PINNED_WORKER.pdf`), so it runs either build and refuses anything else with `RENOX_CLI_WORKER_UNVERIFIED`. `fetch-worker.ts --pdf` checks the `.gz` against its `.sha256`, unpacks it and installs it as `renox-worker`; run it without `--pdf` to go back. `RENOX_WORKER_VARIANT=pdf sh install.sh` does the same for an installed `renox` (any other value but `default` is refused); run it without the variable to go back. With an installed `renox` and no checkout, verify and unpack the variant by hand, then point `renox dev` at it:

```sh
v=0.7.0; a=renox-worker-$v-x86_64-unknown-linux-gnu-pdf
id='^https://github\.com/arif-rachim/renox\.rs/\.github/workflows/release-worker\.yml@refs/tags/worker-v'
cosign verify-blob --bundle $a.gz.sigstore.json --certificate-identity-regexp "$id" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com $a.gz
gunzip -c $a.gz > renox-worker-pdf && chmod +x renox-worker-pdf
renox dev --worker ./renox-worker-pdf
```

`renox dev --worker` accepts it by its pinned hash: the CLI pins `worker-v0.4.0`, the first release with the PDF variant, for the four Linux and macOS targets (there is no PDF variant for Windows). `bun cli/scripts/fetch-worker.ts --pdf` and `RENOX_WORKER_VARIANT=pdf` in `install.sh` do the same steps. Production nodes run the variant their operator installs; apps that call `ctx.pdf` (the `tax_gcc` invoices, `reports`) need the PDF variant there too.

## Build with an AI agent

The platform is built to be driven by a coding agent as well as by a person (`docs/20-ai-agents-mcp.md`; #377). What an agent gets, and the rules it works under:

**In every new app.** `renox new` writes three files next to `renox.toml` (`cli/templates/`): `AGENTS.md` (the app model in short: folders are routes; the commands; the rules agents break most: parameterised SQL, no module-level state, `fetch` hosts and secret names declared in `renox.toml`, `guard` exports for authorization; where the docs for models are), `CLAUDE.md` ("Read `AGENTS.md` first"), and `.mcp.json`, which registers the local MCP server:

```json
{ "mcpServers": { "renox": { "command": "renox", "args": ["mcp", "--project", "."] } } }
```

Claude Code reads `.mcp.json` as is. Cursor reads the same object from `.cursor/mcp.json`; Codex and other clients that take a stdio MCP server take the same command. `renox mcp` (`cli/README.md`, "`renox mcp`") serves `dev_status`, `dev_errors` (what the error overlay shows), `run_check`, `run_tests`, `search_docs`, `authz_explain`, `list_policies`, `list_tools`, `list_agent_tokens` and `revoke_agent_token`, and the resources `docs://`, `types://renox/ctx.d.ts`, `config://effective`, `routes://` and `policies://`. Every tool is one fixed operation on the project folder: model input never becomes a shell command or a path, and `.env` values are redacted from every result. The documentation for models is at <https://renoxium.com/llms.txt> (the index) and <https://renoxium.com/llms-full.txt> (the developer documents in one file), generated from this repository (`www/scripts/llms.ts`).

**The remote platform MCP** (`mcp.renoxium.com`, `control/api/src/mcp/README.md`) is for agents that are not on the developer's machine: `list_apps`, `get_app`, `create_app`, `list_deployments`, `get_deployment`, `activate`, `rollback`, `get_logs`, `list_secrets` (names only, never a value), `get_usage`. It is behind OAuth 2.1 with PKCE; a token is a tenant token named `mcp: <client>` that lives one hour, holds at most the signed-in user's role, and carries the scopes `apps:read`, `apps:write`, `deploy`, `logs:read`, `secrets:read` (each optionally narrowed to one app; `secrets:write` and `tokens:write` are never granted to an agent). The default grant is `apps:read logs:read secrets:read deploy`. Mutating tools (`create_app`, `activate`, `rollback`) do nothing on the first call: they return a plan and a confirmation token bound to the exact arguments, and run on the second call with it, once. Log lines come back marked `untrusted: true`. The dashboard and `renox tokens list` show and revoke these tokens like any other.

**App MCP.** An app is itself an MCP server at `/mcp`: every `functions/tools/*.ts` and every tool a module declares is listed, authenticated by the `auth` module's OAuth server, authorized by the tool's Cedar `action` exactly like a button in the UI, rate-limited and metered to the tenant; a tool with `confirm: true` returns a preview first (`docs/20`, section 2).

**In-app agents.** Tenant code calls models with `ctx.ai.chat(...)` (`ops.md`, `op_ai_chat`): the provider host must be in `[permissions] network`, the key in a declared secret, or the request goes through the platform's AI gateway; tokens count toward the tenant's limits, and local tools run in the same isolate under the same authorization (`docs/20`, section 3).

**What an agent may and may not do** (`docs/20`, section 5): results that come from the database, logs or user content are data, labelled `untrusted: true`, never instructions; destructive operations (`rollback`, `activate`, `revoke_agent_token`, `db_execute`) need the confirmation step, and the local server shows the confirmation to the person in the terminal; a module's permission diff (`renox add`) is shown, never auto-approved; secrets are never serialized through MCP (names and versions only) and are redacted from logs and errors; every call is audited with the actor `agent`, the client and, when reported, the model; tokens are short-lived and listed in the dashboard, where a tenant revokes them.

## Dev loop

1. A file watcher detects a change.
2. Only the changed file is processed: TS transpiled (swc), templates transpiled to minijinja and recompiled.
3. The isolate is discarded and recreated from the snapshot (D19). SQLite connections stay open.
4. The browser is refreshed via SSE; if only a template changed, only the fragment is swapped.

Target from save to browser update: under 300 ms for a single file. Discarding the isolate costs tens of milliseconds and removes the memory-leak risk of hot-swapping contexts.

## Type safety

`renox dev` generates `.renox/types/`: `LoaderContext`, `params` per route (from file names), each module's services, event payloads, policy action names, and fragment names. `renox dev` does not type check, so reloads stay fast; the editor does it there.

**`renox check` type checks** (#443). It runs the app's own TypeScript compiler, `node_modules/typescript` (looked up from the app upwards, as Node resolves it), as `tsc --noEmit -p tsconfig.json` with a fixed argv and no shell, and reports each error as a finding of `rule: "types"` with its file, line, column and TS code (`functions/api/hello.ts:3:41  error  types  TS2322: …`); files under `node_modules/` are left out. `renox new` adds `typescript` (pinned to the version this repository uses, TypeScript 7) and `bun-types` as devDependencies and a `typecheck` script (`renox check --types-only`), so `bun install` is all an app needs.

- Without `typescript` installed: one warning, `types not checked: add typescript (bun add -d typescript)`, and the check passes.
- Without `tsconfig.json`: one warning, `types not checked: no tsconfig.json (renox new writes one; copy it from the template)`. No configuration is guessed, and the check passes.
- `--types-only` runs only the type check; `--no-types` skips it; `--json` carries the findings like the others.
- `renox deploy` runs the same check before it builds anything: a type error stops it with exit code 2 and nothing is uploaded; `--skip-types` deploys anyway, with a warning. `run_check` over `renox mcp` returns the type findings, so a coding agent sees them.

The type check of `examples/shop` takes about 0.6 s with TypeScript 7 (636 ms measured on 2026-11-04 in a 4-vCPU container; `cli/tests/check-types.test.ts` fails above 5 s).

## Debugging

- TS → JS source maps ship in the bundle and are mapped by the Deno runtime, so stack traces point at the original TS lines.
- Errors from Rust ops (query, fetch, render) are wrapped as JS errors with context (table name, host, template name and line).
- In dev, elements hidden by `r-can` are shown as placeholders with the name of the deciding policy.
- `renox dev --inspect` exposes the V8 inspector for breakpoints in VS Code.

## Client-side errors

Server errors alone are not enough: an exception in an Alpine component or an island, an htmx fragment that returned an error or found no swap target, or a script blocked by the CSP would otherwise leave a page that "does nothing". The platform captures these from the browser (`docs/contracts/client-events.md`, #125):

- Every response carries `x-renox-request-id` (the gateway sets it on every response, its own 400, 431, 429, and 503 included). Pages also carry it in `<meta name="renox-request-id">`, with `<meta name="renox-deployment">` and, on error pages, `<meta name="renox-error-code">`; fragments carry it in the header only (contract section 1). A browser error is reported with the id of the page or fragment on screen, so the overlay shows the server log and the browser error of the same request on one screen.
- The platform script `/__renox/client.js` (`sdk/client/`, about 2.5 KB gzipped, CI fails above 4 KB) is the first thing in every page's `<head>`, with the request's CSP nonce. It captures `window` errors (message, file, line, column, stack frames), unhandled rejections, `htmx:responseError` (status and the `RENOX_*` code from the JSON body or the error page's meta tag, with the failed request's own id), `htmx:sendError`, `htmx:timeout`, `htmx:targetError`, `htmx:swapError`, and `securitypolicyviolation`. Identical events within 10 s are sent once, at most 50 per page load, in batches of up to 20 to `/__renox/events` with `sendBeacon` (fetch `keepalive` as fallback), at the latest one second after the first event or when the page is hidden. `<meta name="renox-events-sample" content="0.1">` keeps one page load in ten. Realtime events (`renox.realtime.connect()`) come with F5 (#70).
- **`renox:error` hook.** Every captured event is also dispatched on `document` as a `renox:error` DOM event whose `detail` is the event as sent, so the app can show its own toast: `document.addEventListener("renox:error", (e) => toast(e.detail.kind))`. `renox.client.setExtra({ plan: "pro" })` adds up to 16 tenant fields (1 KB) to later events.
- The gateway validates and rate-limits the events per IP and per tenant before writing them to the tenant log sink with `source=client`; the endpoint never touches the isolate and always answers 204. The endpoint, batch format, and limits (32 KB body, 20 events, 60 requests per minute per IP, 1,000 events per minute per tenant then sampled, a daily cap) are in `docs/contracts/client-events.md` sections 2, 3, and 7. CSP reports from the browser itself (`report-uri`, `report-to renox-csp`) go to the same endpoint.
- **In dev** (`renox dev`): the proxy marks every page with `<meta name="renox-dev">`, which also turns on `console.error` capture, and handles the batches itself, so nothing is dropped or sampled. Each event is printed in the terminal next to the server lines, for example `[browser] js.error pages/products/[id].html:42:7 TypeError: cart is undefined (01JBQ3Z7MA…)` (an inline script's errors name the page's template; the line is the line in the served HTML), and an event with a `RENOX_*` code gets the catalogue's hint. The overlay's "Browser" tab lists the events with source, line, column, stack, and request id; "Server log for <id>" shows the server side of that request (code, limit, cpu_ms, heap) in the same panel. The MCP `dev_errors` tool returns them as `browserErrors` (`kind`, `message`, `request_id`, `url`, `code`, `detail`). The events are kept in `.renox/logs/browser.ndjson`.
- In production the dashboard groups events by fingerprint per deployment, flags regressions, and symbolicates frames against sourcemaps that `renox deploy` uploads privately (never served) (#128).
- Privacy: no cookies, form values, or storage are read; URLs other than the page's lose their query and fragment; stack frames keep file, line, column, and function only (`docs/contracts/client-events.md` section 8). `[client] events = false` in `renox.toml` is to disable the script and the endpoint once the manifest carries it (contract Open 1; the worker already reads `client.events`).

## Deploy without downtime

1. `renox deploy` produces an artifact with a content hash.
2. The control plane validates it and runs migrations (forward-only, so the old deployment keeps working during the switch).
3. The new isolate is prepared alongside the old one.
4. The route pointer is switched atomically; in-flight requests finish on the old version.
5. Rollback is a pointer switch to the previous hash.

## Concurrency and the blast radius

A quiet deployment runs in one isolate. When requests start waiting on a busy isolate, the worker grows a pool of isolates for that deployment (up to 2 on the free tier, up to one per core and at most 8 on paid tiers), keeps one spare ready, and sends each request to the least-loaded isolate (#156). A request that hits the CPU or heap limit ends its own isolate and every request in flight on that isolate, which get the same 503 code; requests on the other isolates of the pool carry on, and the spare takes the dead isolate's place. Module-level state (in-memory caches, counters) lives per isolate, so two requests of one deployment can see different copies: keep shared state in `ctx.db`. The concurrency limit (50 free, 500 paid) counts the requests of the whole pool.

## Build and compile strategy (for platform developers)

Two different people compile things, and the experience must differ.

| Who | Writes | Compiles | Expected feedback loop |
| --- | --- | --- | --- |
| Tenant developer | TypeScript, HTML, SQL | Nothing. TS is transpiled (types stripped) in milliseconds; templates are re-transpiled in milliseconds | Save → browser in ≤ 300 ms; `renox test` runs hundreds of TS tests in seconds inside the prebuilt runtime |
| Platform developer (us) | Rust data plane, plus TypeScript control plane, CLI, SDK, modules | Rust only for the data plane; everything else is Bun with no build step | `cargo check` in seconds for a leaf crate; full release build only in CI when Rust changes |

Tenants never touch Rust. The pain of Rust compile times is confined to the data plane, and the rules below keep it small.

### Rules

1. **Never compile V8.** Use prebuilt `rusty_v8` binaries (the default of the `v8` crate). V8 from source is 30–60 minutes and is never part of our build. Pin the version.
2. **Small crates, strict boundaries.** `renox-data`, `renox-template`, `renox-authz`, `renox-realtime`, `renox-meter`, `renox-gateway` are leaf crates that do not depend on the runtime or on each other. Editing the template engine recompiles only that crate. Integration happens only in `renox-cell`.
3. **Fast linking and incremental builds.** `mold` (Linux) or `lld` as the linker; `cargo watch -x check` during iteration; `opt-level = 1` for dependencies in the dev profile; `debug = 1` to cut debuginfo size.
4. **Tests without V8 wherever possible.** The template engine is tested as string in → string out; the authorizer and migrations against a real SQLite file; Cedar policies against policy files; the gateway with in-memory requests. Only `renox-runtime` and `renox-cell` link V8, and their tests run less often (CI and on demand).
5. **Dev-mode runtime is prebuilt.** `renox dev` ships the compiled worker, so the tenant feedback loop never includes a Rust build. The same prebuilt worker is used for `renox test`.
6. **CI caches everything.** `sccache` + cached `target/`; the release build of `renox-worker` runs only when `crates/` changes. Docs, TypeScript, and module changes never trigger a Rust build. Target: CI ≤ 15 minutes with a warm cache (B20).
   **CI minutes (#189).** Every check sits in one of three jobs: `lint` (path filter, pinned actions, `cargo-deny`, `bun audit`, and the docs checks when docs change) runs on every push and PR, `rust` and `ts` only when their paths change, so a docs-only PR bills one job. On a pull request `rust` tests only the crates that changed and the workspace packages that depend on them (`make rust-test CRATES=...`); a change outside `crates/` (lockfile, toolchain, `ops/`, the workflow) tests the whole workspace, and so does every push to `main`. A push run on `main` is per commit and is never cancelled or replaced while it queues (#619), so every merge keeps its own status and its `renox-worker-ci-packaged` artifact; the cost, two merges in quick succession run twice, is accepted because the runners are not metered (below). `release-worker.yml` runs on `worker-v*` tags, by hand, and once on `main` after a merge that touches the packaging, never on a pull request. Quota decision, taken by the owner on 2026-10-28 when 1,800 of the plan's 2,000 monthly minutes were used: option (c), the repository is public, so standard GitHub-hosted runners are not metered. Rejected: (a) a paid spending limit for overage (USD 0.008 a Linux minute), kept as the fallback if the repository ever goes private again; (b) a self-hosted runner for `rust` on the owner's build machine, which on a public repository would run code from fork pull requests on that machine. The job folding stays because it shortens the PR feedback loop and the concurrency queue.
7. **Most of the platform is not Rust.** Control plane, CLI, SDK, and all official modules are TypeScript on Bun. Expected split of code we write: roughly 30–40% Rust (data plane glue over Supabase Edge Runtime), 60–70% TypeScript.
8. **`unsafe` and FFI stay in two places.** V8 and SQLite wrappers only, documented and reviewed. This keeps compile-heavy, hard-to-test code isolated.

### Expected numbers (targets, measured under B20)

| Build | Cold | Warm (one leaf crate changed) |
| --- | --- | --- |
| `cargo check` workspace | ≤ 3 min | ≤ 5 s |
| `cargo build` debug (with V8 prebuilt) | ≤ 6 min | ≤ 20 s |
| `cargo test` leaf crates (no V8) | ≤ 1 min | ≤ 10 s |
| `cargo build --release renox-worker` (CI) | ≤ 15 min with cache | — |

If these targets are missed, the fix is more crate splitting or moving logic out of the V8-linked crates, not accepting slower loops.

## Observability

OpenTelemetry tracing per request: spans for the loader, each service call, query, render, and outbound fetch. Metrics per tenant and per route: latency, error rate, CPU ms, heap, egress. Structured logs always include `tenant_id`, `request_id`, and module name. Tenants see their own traces and metrics in the dashboard.
