# Getting started

From an empty folder to an app at `https://<app>.renoxium.app` in about ten minutes: install the CLI, create an app, run it locally, sign in, deploy. Each step shows what you should see. Every command is the real one from the [CLI reference](../cli/README.md).

## Prerequisites

- **Linux or macOS** (x64 or arm64). **Windows:** use WSL 2 with Ubuntu (`wsl --install -d Ubuntu` in PowerShell, then run every command below inside the Ubuntu terminal).
- **[Bun](https://bun.sh) 1.4 or newer** for `bun install` and `renox test`: `curl -fsSL https://bun.sh/install | bash`, then open a new terminal. `bun --version` prints `1.4.x` or newer.
- `curl`, and a browser for the sign-in.

## Install

One line installs `renox`, and the `renox-worker` it runs your app on locally, into `~/.renox/bin`. It installs a file only when its SHA-256 matches the release:

```sh
curl -fsSL https://github.com/arif-rachim/renox.rs/releases/download/cli-v0.1.2/install.sh | sh
```

If the installer says `~/.renox/bin` is not on your `PATH`, add it (and add the same line to `~/.bashrc` or `~/.zshrc`):

```sh
export PATH="$HOME/.renox/bin:$PATH"
```

Check it:

```sh
renox --version
```

```
renox 0.1.2 (renox-worker 0.3.0)
```

There is no npm package for the CLI: `npx renox` and `bunx renox` do not work. The SDK your app imports is the npm package `@renoxium/sdk`. Verifying the signatures and upgrading are in [Developer experience](12-developer-experience.md#installing-the-cli).

## Your first app

```sh
renox new my-app --template hello
```

```
Created my-app/. Next:

  cd my-app
  bun install        # the @renoxium/sdk types and test helpers
  renox dev          # http://localhost:8787, reloads on save
  renox login        # once: approve the sign-in in the dashboard
  renox deploy       # prints the live URL

Docs: https://renoxium.com/docs
```

`hello` writes a function (`functions/api/hello.ts`), a home page (`pages/index.html` and its layout), a test (`tests/hello.test.ts`), `renox.toml`, `package.json`, `tsconfig.json`, a `README.md` and the files for coding agents (`AGENTS.md`, `CLAUDE.md`, `.mcp.json`). `--template blank` writes one health route and nothing else.

```sh
cd my-app
bun install
```

```
+ bun-types@1.4.4
+ typescript@7.0.2
+ @renoxium/sdk@0.1.2

6 packages installed
```

`typescript` is what `renox check` type checks your code with.

Run it:

```sh
renox dev
```

```
renox dev: http://localhost:8787  (artifact 982e73345217, 2 routes)
  GET     /api/hello
  PAGE    /
```

Open `http://localhost:8787`: the page says "my-app is running". `http://localhost:8787/api/hello` answers `{"ok":true}`. Edit `pages/index.html` or the function and save: the browser reloads. Stop it with Ctrl-C.

Folders are routes: `functions/api/hello.ts` answers `/api/hello`, `pages/products/[id].html` is the page at `/products/:id` with its loader in `pages/products/[id].ts`. The model is in [App model](07-app-model.md).

## Check and test

```sh
renox check
```

```
renox check: ok
```

```sh
renox test
```

```
 2 pass
 0 fail
```

`renox check` validates the configuration, the routes and templates, lints SQL and scans for secrets. `renox test` runs `tests/*.test.ts` on the same local worker as `renox dev`, with a fresh database for each test file.

## Sign in

Create an account at `https://dashboard.renoxium.com/signup` (email, a password of at least 12 characters, a workspace id) and open the link in the email: the dashboard signs you in. Then, in the app folder:

```sh
renox login
```

```
Open https://dashboard.renoxium.com/device?code=BCDF-GHJK
and check that it shows the code BCDF-GHJK, then approve.
Waiting for approval…
Signed in to my-workspace. Token saved to /home/you/.config/renox/credentials.json
```

The link opens the dashboard's device page with the code filled in: check that the code matches, keep or narrow the scopes, and press Approve. The token is kept in `~/.config/renox/credentials.json` (readable only by you) for 90 days. In CI, set `RENOX_TOKEN` to a token from the dashboard's Tokens page instead.

## Deploy

```sh
renox deploy
```

```
Bundling… 2 routes, 1 modules, 2 templates               0.2s
  Created app my-app
  Uploading 0.0 MB → api.renoxium.com                      0.0s
  Validating… ✓ manifest ✓ routes ✓ templates ✓ permissions ✓ bundle (validated)
  Activating… ✓ migrations ✓ cell ✓ probe                  0.1s
  Live: https://my-app.renoxium.app  (10db4d689fa2)        total 0.6s
```

`renox deploy` first type checks the app (as `renox check` does) and stops on a type error. The next deploy also prints `Rollback: renox deploy --rollback <previous hash>`.

The first deploy creates the app under the name in `renox.toml`; the app names are global, so pick another name in `renox.toml` if it is taken. Every deploy is kept: `renox deploy --rollback` switches back to the previous one without a build or an upload. Then:

| Command | What it does |
| --- | --- |
| `renox logs --follow` | The app's log lines as they happen |
| `printf %s "$VALUE" \| renox secrets set NAME` | A secret, read from stdin and never from an argument |
| `renox add auth` | Installs a module (and the official modules it needs) after showing its permissions ([Modules](10-modules.md)) |
| `renox db export` | A snapshot of the app's SQLite database ([Data](06-data.md)) |
| `renox <command> --help` | The options of any command |

## What next

- [App model](07-app-model.md): pages, loaders and actions, functions, webhooks, jobs, the `ctx` surface.
- [Templates](08-template-engine.md): HTML-first templates with `r-*` attributes.
- [Modules](10-modules.md): sign-in, organisations, billing and admin as installed modules.
- [Limits](contracts/ops.md#10-limits-per-tier-and-behaviour-on-limit): what the platform enforces per request and per app.
- [AI agents and MCP](20-ai-agents-mcp.md): `renox mcp` for coding agents.

To work on the platform itself from a clone of the repository instead: `git clone https://github.com/arif-rachim/renox.rs && cd renox.rs && bun install && bun cli/scripts/fetch-worker.ts`, then run the CLI as `bun cli/src/main.ts`.
