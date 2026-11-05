# AGENTS.md — this app runs on Renoxium

Read this first; `CLAUDE.md` points here, and other coding agents read this file directly. It is written by `renox new` and belongs to the app: edit it as the app grows.

## What this is

A Renox app: TypeScript functions and HTML pages that Renoxium runs in a V8 isolate with the app's own SQLite file, under CPU, memory, wall-clock and network limits the platform enforces. The SDK is the npm package `@renoxium/sdk`; the command-line tool is `renox`. Documentation for models: <https://renoxium.com/llms.txt> (index) and <https://renoxium.com/llms-full.txt> (the full text); for people: <https://renoxium.com/docs>.

## Layout: folders are routes

- `functions/<path>.ts` → `/<path>`: export `GET`, `POST`, `PUT`, `PATCH`, `DELETE` as `Handler` (`functions/api/health.ts` → `GET /api/health`; `[id].ts` → `:id`; `[...slug].ts` → `*slug`).
- `pages/<path>.html` with an optional `pages/<path>.ts` (`load`, `actions`) → a server-rendered page; `pages/_layouts/`, `partials/` for `<x-name>` components; htmx fragments.
- `migrations/NNN_name.sql` (forward-only, numbered from 001), `policies/*.cedar` (authorization), `jobs/*.ts` (scheduled and queued work), `functions/tools/*.ts` (MCP tools of the app), `public/` (static files, served at the root).
- `renox.toml`: the app name, `[permissions] network` (the only hosts `fetch` may reach) and `secrets` (the secret names the app reads), limits.
- `tests/*.test.ts`: `bun test` files, run by `renox test` on the real worker with `@renoxium/sdk/test` and `@renoxium/sdk/fakes`.

## Commands

- `renox dev` builds, starts the local worker on <http://localhost:8787> and rebuilds on every change.
- `renox check` type checks the TypeScript (the app's own `typescript`, `rule: "types"` findings with file, line and column), validates `renox.toml`, routes, templates, policies and modules, lints SQL and scans for secrets. Run it before every commit; `renox deploy` runs the same type check and refuses an app with type errors. Exit code 2 means errors.
- `renox test` runs `policies/tests/*.json` and `tests/*.test.ts` against the worker.
- `renox deploy` builds, uploads, validates and activates; `renox deploy --rollback` goes back.
- `renox add <module>` installs an official module (`auth`, `org`, `billing`, `storage`, ...) after showing the permissions it asks for.

## Rules agents break most

1. **SQL takes parameters.** `db.query("select ... where id = ?", [id])`, never a string built from input. Module tables are `<module>__*` and belong to the module; name the app's own tables with the app's prefix (`shop__products`).
2. **No module-level mutable state.** A request may run in a fresh isolate; keep state in the database, caches in `ctx.storage` or the database, never in a top-level variable.
3. **Declare `fetch` hosts and secrets in `renox.toml`.** `fetch` to a host that is not in `[permissions] network` is refused; a secret is `ctx.secrets.NAME` and must be listed under `secrets`; never put a key in the code, a test or a fixture.
4. **Guard what needs a user.** Export `guard` (`defineGuard`) from a function or page that needs authorization, keep the decision in `policies/`, use `db.scoped()` for per-user data; `renox authz explain` tells why a request is allowed or denied.
5. **Validate input** with `validate(input, Schema)` (zod or valibot) and return `Response` objects; throw the `renox` error classes for known failures.
6. **Respect the limits.** CPU, memory, wall clock and egress are enforced by the platform; work that cannot finish in one request goes to `jobs/`.

## Tools for agents

- `.mcp.json` (next to this file) registers `renox mcp --project .`, the local MCP server: tools `dev_status`, `dev_errors`, `run_check`, `run_tests`, `search_docs`, `authz_explain`, `list_policies`, `list_tools`; resources `docs://`, `config://effective`, `routes://`. Claude Code reads `.mcp.json` as is; Cursor reads the same object from `.cursor/mcp.json`.
- The remote platform MCP (deployments, logs, secrets names) is `mcp.renoxium.com`, behind OAuth 2.1 with per-tool scopes; destructive tools return a plan and need a confirmation.
