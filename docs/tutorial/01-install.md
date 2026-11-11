# Chapter 1: Install the CLI and create the app

**What you build:** the starting point of the board, an app with one page, one API route and one test, running on your machine.

## Install the CLI

One line installs `renox`, and the `renox-worker` it runs your app on, into `~/.renox/bin`. Each file is installed only if its SHA-256 matches the release:

```sh
curl -fsSL https://github.com/arif-rachim/renox.rs/releases/download/cli-v0.1.13/install.sh | sh
export PATH="$HOME/.renox/bin:$PATH"   # also add this line to ~/.bashrc or ~/.zshrc
renox --version
```

```
renox 0.1.13 (renox-worker 0.8.0)
```

On Windows (x64), in PowerShell: `irm https://github.com/arif-rachim/renox.rs/releases/latest/download/install.ps1 | iex`.

If you already use Bun, you can install the CLI from npm instead. It downloads the worker the first time `renox dev` or `renox test` needs it:

```sh
bun add -g @renoxium/cli
```

Keep the `-g`: without it the CLI goes into the current project only. The SDK your app imports is a separate npm package, `@renoxium/sdk`.

### Upgrade later

When a new version is out, run the same command again, with the tool you installed with:

```sh
curl -fsSL https://github.com/arif-rachim/renox.rs/releases/latest/download/install.sh | sh   # installer
bun add -g @renoxium/cli@latest                                                                # Bun
```

On Windows, run the PowerShell line above again. Then `renox --version` shows the new version. Pinning a version, upgrading the SDK and two copies on `PATH`: [Getting started](../getting-started.md#upgrade).

## Create the app

```sh
renox new my-board --template tutorial
cd my-board
bun install
```

`--template tutorial` writes this chapter's checkpoint. You can also copy it from the repository:

```sh
git clone --depth 1 https://github.com/arif-rachim/renox.rs && cp -r renox.rs/examples/tutorial/step-01 my-board
```

Either way you get:

| Path | What it is |
| --- | --- |
| `renox.toml` | The app's name, time zone and permissions |
| `functions/api/health.ts` | An API route: `GET /api/health` |
| `pages/index.html`, `pages/_layouts/main.html` | The home page and the layout around it |
| `tests/app.test.ts` | A test that `renox test` runs on the real worker |
| `package.json`, `tsconfig.json` | The SDK, TypeScript and the Bun types; `renox check` type checks with them |
| `AGENTS.md`, `CLAUDE.md`, `.mcp.json` | For coding agents (see the end of this chapter) |

## The files

`renox.toml` names the app and says what it may reach. An empty `network` list means `fetch` cannot reach any host. Every name in `secrets` must be declared before `ctx.secrets` can read it:

`renox.toml`:
```toml
[app]
name = "board"
timezone = "Asia/Dubai"

[permissions]
# Outbound hosts for fetch, e.g. ["api.stripe.com"]; empty = no network.
network = []
# Secret names the app reads from ctx.secrets.
secrets = []
```

Every file under `functions/` is a route: its path is the URL, and each exported HTTP method handles that method. A handler gets `ctx` (the request, the app's database, `fetch`, secrets, the log) and returns a `Response`:

`functions/api/health.ts`:
```ts
// GET /api/health answers {"ok":true}: a route for uptime checks.
//
// Every file under functions/ is a route: its path is the URL, and each
// exported HTTP method (GET, POST, ...) handles that method.
import type { Handler } from "@renoxium/sdk";

export const GET: Handler = () => Response.json({ ok: true });
```

The board will be mostly pages, but an app made only of `.html` pages builds too (artifact 1.6). We keep the health route because chapter 10 points an uptime check at it.

A page is an `.html` file under `pages/`; `pages/index.html` is `/`. `<r-layout use="main">` wraps it in `pages/_layouts/main.html`, and the layout's `<slot />` is where the page goes:

`pages/index.html`:
```html
<r-layout use="main">
  <h1>Team board</h1>
  <p>Your app is running. This page is <code>pages/index.html</code>: change it and save.</p>
  <p>The API answers at <a href="/api/health"><code>/api/health</code></a>.</p>
</r-layout>
```

`pages/_layouts/main.html`:
```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title><slot name="title">Team board</slot></title>
</head>
<body>
  <main>
    <slot />
  </main>
</body>
</html>
```

## Run it

```sh
renox dev
```

```
renox dev: http://localhost:8787  (artifact 1296b55f326f, 2 routes)
  GET     /api/health
  PAGE    /
```

Open http://localhost:8787. [What you should see: the home page of the new app](screenshots/01-running.png).

## Test it

`renox test` builds the app, starts the same worker as `renox dev` with a fresh database for each test file, and runs `tests/*.test.ts` with Bun:

`tests/app.test.ts`:
```ts
// `renox test` runs this file on the local worker, with a fresh database.
import { describe, expect, test } from "bun:test";
import { app } from "@renoxium/sdk/test";

const t = await app();

describe("the app", () => {
  test("the home page renders", async () => {
    const res = await t.page("/");
    expect(res.status).toBe(200);
    expect(res.html).toContain("Team board");
  });

  test('GET /api/health answers {"ok":true}', async () => {
    const res = await t.request("GET", "/api/health");
    expect(res.json()).toEqual({ ok: true });
  });
});
```

```sh
renox test
```

```
 2 pass
 0 fail
```

The first lines of the test file make it run only under `renox test`. Your app does not need them. They are there because the Renoxium repository runs its own `bun test` over every file it holds, these checkpoints included (#479 removes them).

## If it does not work

| You see | Why, and what to do |
| --- | --- |
| `renox: command not found` | `~/.renox/bin` is not on your `PATH`: run the `export` line above, then open a new terminal |
| `renox --version` shows the old version after an upgrade | Two copies are installed (the installer's and Bun's); the first on `PATH` wins. `which -a renox` lists them: keep one |
| `port 8787 is in use` | Another `renox dev` is running. Stop it, or run `renox dev --port 8788` |
| `renox test` exits with code 3, "`bun` is not on PATH" | Install Bun 1.4 or newer and open a new terminal |
| `RENOX_CLI_WORKER_UNVERIFIED` | The worker binary does not match the release checksums. Run the installer again; do not copy a worker from elsewhere |
| `unknown template "tutorial"` | Your CLI is 0.1.2: copy `step-01` as shown above |

## Building with an AI agent

`.mcp.json` registers `renox mcp --project .` with Claude Code and Cursor. In the app folder, ask your agent: "Read AGENTS.md, then run the app's checks and tests with the renox MCP tools." It uses `run_check` and `run_tests`, and `dev_status` once `renox dev` runs. The tools and the rules agents follow: [AI agents and MCP](../20-ai-agents-mcp.md).

**Checkpoint:** [`examples/tutorial/step-01`](../../examples/tutorial/step-01/). Next: [the dev loop](02-dev-loop.md).
