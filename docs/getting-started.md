# Getting started

From an empty folder to an app at `https://<app>.renoxium.app`: install the CLI, create an app, run it locally, sign in, deploy. Every command below is the real one from the [CLI reference](../cli/README.md).

## Install

The CLI is not on npm yet, and there is no packaged `renox` binary yet. What works today is the CLI from the repository, run with [Bun](https://bun.sh) 1.4 or later:

```sh
git clone https://github.com/arif-rachim/renox.rs
cd renox.rs
bun install
bun cli/scripts/fetch-worker.ts        # the signed renox-worker release for your platform
alias renox="bun $PWD/cli/src/main.ts"
```

`fetch-worker.ts` downloads the `renox-worker` release the CLI is tested against (it refuses a download whose SHA-256 does not match) into `cli/bin/<platform>-<arch>/`, where `renox dev` finds it. To get one binary instead of the alias, `bun run --cwd cli compile` writes `cli/dist/renox`.

When the first CLI release is published, the install becomes one line (`curl -fsSL https://github.com/arif-rachim/renox.rs/releases/download/cli-v<version>/install.sh | sh`) and `bun add @renoxium/sdk` installs the SDK at the same version; the details are in [Developer experience](12-developer-experience.md#installing-the-cli).

## Your first app

```sh
renox new my-shop --template hello
cd my-shop
renox dev
```

`renox new` writes `renox.toml`, `package.json`, `tsconfig.json`, the agent files (`AGENTS.md`, `CLAUDE.md`, `.mcp.json`) and the template's files. `hello` is one function; `blank` has a health route and nothing else. `renox dev` builds the app, starts the worker on it and serves it at `http://localhost:8787`, rebuilding on every change.

Folders are routes: `functions/api/hello.ts` answers `/api/hello`, `pages/products/[id].html` is the page at `/products/:id` with its loader in `pages/products/[id].ts`. The model is in [App model](07-app-model.md); `renox check` validates the project and `renox test` runs its tests.

## Sign in

Create an account at `https://dashboard.renoxium.com/signup` and verify the address from the email. Then, in the app folder:

```sh
renox login
```

`renox login` prints a code and polls until it is approved; the token it receives is kept in `~/.config/renox/credentials.json` (mode 0600). The approval page of the dashboard is not published yet, so until it is, the code cannot be approved from a browser; the CLI commands below are ready for the day it is. In CI, set `RENOX_TOKEN` instead.

## Deploy

```sh
renox deploy
```

```
Bundling… 1 routes, 0 modules, 0 templates
Uploading 0.1 MB → api.renoxium.com
Validating… ✓ manifest ✓ routes ✓ templates ✓ permissions ✓ bundle (validated)
Activating… ✓ migrations ✓ cell ✓ probe
Live: https://my-shop.renoxium.app   (<hash>)
Rollback: renox deploy --rollback <previous hash>
```

The first deploy creates the app under the name in `renox.toml`. Every deploy is kept: `renox deploy --rollback` switches back to the previous one without a build or an upload. Then:

| Command | What it does |
| --- | --- |
| `renox logs --follow` | The app's log lines as they happen |
| `printf %s "$VALUE" \| renox secrets set NAME` | A secret, read from stdin and never from an argument |
| `renox add auth` | Installs a module after showing its permissions ([Modules](10-modules.md)) |
| `renox db export` | A snapshot of the app's SQLite database ([Data](06-data.md)) |

## What next

- [App model](07-app-model.md): pages, loaders and actions, functions, webhooks, jobs, the `ctx` surface.
- [Templates](08-template-engine.md): HTML-first templates with `r-*` attributes.
- [Modules](10-modules.md): sign-in, organisations, billing and admin as installed modules.
- [Limits](contracts/ops.md#10-limits-per-tier-and-behaviour-on-limit): what the platform enforces per request and per app.
- [AI agents and MCP](20-ai-agents-mcp.md): `renox mcp` for coding agents.
