# Tutorial: build a team board

In about an hour you go from an empty folder to a multi-user app on `https://<app>.renoxium.app`. You build a small **team task board**: people sign up, create a team, invite each other, add and tick off tasks, and everyone on the team sees changes live. Only admins and owners remove tasks.

The app has no auth code of its own and no client framework. It uses pages and templates, one SQLite database, a few actions, two official modules, one Cedar policy file and a live feed. Each chapter adds one of these.

## Before you start

- Linux or macOS (Windows: WSL 2 with Ubuntu), [Bun](https://bun.sh) 1.4 or newer, `curl`, and a browser.
- TypeScript and HTML at the level of a form and a `fetch`. You do not need to know htmx, Cedar or SQLite: each is explained when it first appears.

## The chapters

| # | Chapter | What the board can do afterwards |
| --- | --- | --- |
| 1 | [Install the CLI and create the app](01-install.md) | It runs locally: one page, one API route, one test |
| 2 | [The dev loop](02-dev-loop.md) | It has a stylesheet, and you have seen the error overlay |
| 3 | [Pages and templates](03-pages.md) | `/board` lists tasks through a layout, a partial and translated strings |
| 4 | [Data](04-data.md) | The tasks live in SQLite, created by a migration |
| 5 | [Functions and forms](05-actions.md) | You add, tick off and remove tasks; htmx swaps only the list |
| 6 | [Sign-in and teams with modules](06-teams.md) | People sign up, create teams and invite each other; each team has its own tasks |
| 7 | [Authorization](07-authorization.md) | A Cedar policy keeps every team's tasks to its members |
| 8 | [Realtime](08-realtime.md) | Every member sees changes without reloading |
| 9 | [Tests](09-tests.md) | A test flow for each role, with snapshots of what each one sees |
| 10 | [Deploy and a custom domain](10-deploy.md) | It is live, with logs, usage and your own domain |

## The checkpoints

Every chapter ends at a checkpoint: a complete app in [`examples/tutorial/`](../../examples/tutorial/) (`step-01` … `step-10`). If your copy stops working, compare it with the checkpoint, or continue from there:

```sh
git clone --depth 1 https://github.com/arif-rachim/renox.rs
cp -r renox.rs/examples/tutorial/step-05 my-board
```

Each step contains the whole previous step plus that chapter's changes. The code blocks in the chapters are copied from the checkpoint files, and the repository's CI fails when one drifts (`cli/tests/tutorial.test.ts`). The same CI builds every checkpoint, runs `renox check` on it and passes its `renox test`.

## Building with an AI agent

Every app `renox new` writes includes `AGENTS.md` (the app model, the commands and the rules) and `.mcp.json`, which registers `renox mcp --project .` with Claude Code, Cursor and other agents. Each chapter ends with a short note on doing that chapter's step with an agent. How agents work with Renoxium: [AI agents and MCP](../20-ai-agents-mcp.md).
