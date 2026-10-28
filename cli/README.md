# renox CLI (v0, F2)

One CLI for the tenant dev loop (`docs/12-developer-experience.md`, P11): `new`, `build`, `dev`, `check`, and `mcp` (P21). Bun, no runtime dependencies (the TOML parser, transpiler, bundler, and file watcher are Bun's own; the JSON Schema checks use `src/lib/schema.ts` against `docs/contracts/schemas`).

```
bun cli/src/main.ts <command>        # from the repository
bun run --cwd cli compile            # single binary: cli/dist/renox
bun test --cwd cli                   # tests; the dev end-to-end test needs RENOX_WORKER_PATH
```

## Exit codes

| Code | Meaning | Examples |
| --- | --- | --- |
| `0` | ok | `renox check` with warnings only; `renox`, `renox help` |
| `1` | user error | unknown command or flag, bad `--port`, an invalid app name or a non-empty folder for `renox new`, no `renox.toml` (not in an app folder) |
| `2` | validation error | invalid TOML, an unknown key, a bad time zone or value in `renox.toml`; a bad route file name, two files for one route, paths that differ only in case; a TypeScript syntax or bundling error; any `renox check` error |
| `3` | environment error | no `renox-worker` binary (`RENOX_WORKER_PATH` unset and none downloaded, or pointing to nothing); the worker exits during startup or keeps exiting under `renox dev`; the port is in use |
| `130` | interrupted | Ctrl-C (SIGINT); `renox dev` stops the worker first |

Every error is one message: `renox <command>: <file>:<line>:<col>: <what is wrong>`, then `hint: <what to do>` when there is something to do (`src/errors.ts`). `renox check` prints each problem as `<file>:<line>  error  <message>`. A TypeScript syntax error carries the transpiler's line and column, relative to the app folder. A `renox.toml` problem carries the line of the key; for a TOML syntax error, the line where parsing first fails. An unknown key comes with the closest valid key ("did you mean"). The messages are snapshotted in `tests/negative/__snapshots__/`.

## Commands

| Command | What it does |
| --- | --- |
| `renox new <name> [--template blank\|hello]` | Creates `<name>/` with `renox.toml`, `package.json` (depends on `renox`), `tsconfig.json`, `.gitignore`, and the template's files (`cli/templates/<template>/`; `hello` mirrors `examples/hello`, `blank` has `GET /api/health`). Refuses a non-empty folder |
| `renox build [--out <dir>]` | Builds the artifact (`docs/contracts/artifact.md`) into `.renox/artifact/<hash>/` (or `<dir>/<hash>/`). Prints the hash |
| `renox dev [--port 8787]` | Builds, starts the prebuilt `renox-worker` on the app, serves it on `http://localhost:<port>`, rebuilds on every change and switches the worker to the new artifact |
| `renox check` | Validates `renox.toml`, route conflicts, and the manifest (by building in memory), and lints the sources. Exit code 2 on any error |
| `renox mcp [--project <dir>]` | Local MCP server on stdio for coding agents: the docs, the project's config and routes, and the `check`/`dev` status as tools (below) |

### `renox build`

1. `renox.toml` is read and validated: `[app] name, timezone`, `[permissions] network, secrets`, `[limits] cpu_ms, wall_ms, memory_mb, concurrency` (unknown keys are errors).
2. Routes are discovered from `functions/` (`docs/07-app-model.md`, "Routing rules"): the file path without extension is the URL, `index` is its folder, `[id]` is `:id`, `[...slug]` is `*slug` (last segment only). Files and folders starting with `_`, `.d.ts`, and `*.test.*` files are not routes; a module that exports no method (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`, `HEAD`) is not a route. Two routes with the same method and shape conflict (V8): `/a/:id` and `/a/:slug` conflict, `/a/new` and `/a/:id` do not (static wins).
3. All function modules are bundled in one `Bun.build` (`target: "browser"`, ESM, code splitting): types stripped, local and npm imports vendored into the artifact, `node:` imports kept (the runtime allows its compute-only `node:` modules). Code imported by more than one module (zod, a project `lib/`) is emitted once under `code/chunks/chunk-<hash>.js`, so an isolate evaluates each dependency once (#143). Nothing is resolved at runtime (`code.format = "esm-dir"`). Source maps are not in the artifact (they would be loaded into every isolate as module text): they are written to `<out>/../sourcemaps/<hash>/` (`.renox/sourcemaps/<hash>/` by default), for `renox deploy` to upload privately (#128). Source paths are relative to the project (the build runs with the project as working directory), so the same project always builds to the same hash and no machine path enters the artifact.
4. `migrations/NNN_name.sql` → `migrations/app/` with `checksums.json` (numbered from 001 without gaps). `public/**` → `public/` with `manifest.json` (sha256, size, content type by extension).
5. `manifest.json`, validated against `manifest.schema.json`. `code/` over 20 MiB fails (V5).
6. The content hash (`src/lib/hash.ts`, the twin of `crates/renox-cell/src/artifact.rs`, both tested against `docs/contracts/examples/hash-vectors.json`) names the directory. An existing directory with that name is reused.

Limitations found so far (B17 will add to this list): the bundle targets a browser-like environment, so a package that needs Node APIs beyond the runtime's `node:` allowlist builds but fails at isolate creation; dynamic `import()` of a computed specifier cannot be vendored; one module's dependencies are duplicated in every module that imports them (no shared chunks in `esm-dir`).

### `renox dev`

```
.renox/
  artifact/<hash>/        built artifacts
  data/dev/app.db         the tenant file (tenant id `dev`)
  data/dev/secrets.json   from .env (KEY=value lines), mode 0600, never printed
  routes.json             <app>.localhost -> dev -> <current hash>
  worker.toml             generated worker config
  meters/, logs/          meter batches; tenant log lines (also printed to the terminal)
  dev.json                pid, URL, artifact, last build result (read by `renox mcp`); removed on stop
```

- The worker binary is `RENOX_WORKER_PATH` if set, else `cli/bin/<platform>-<arch>/renox-worker`, which `bun cli/scripts/fetch-worker.ts [<version>]` downloads from the GitHub release `worker-v<version>` (default: the pinned `WORKER_VERSION`; asset `renox-worker-<version>-<target triple>` and its `.sha256`, the names `.github/workflows/release-worker.yml` publishes; the download is refused on a checksum mismatch). Locally: `cargo build -p renox-cell --bin renox-worker` and `RENOX_WORKER_PATH=target/debug/renox-worker`.
- The route table requires a dotted hostname (`route-table.schema.json`), so the app is routed as `<app>.localhost` and the worker listens on a free loopback port. `renox dev` listens on `localhost:<port>` and forwards every request to the worker with that `Host`.
- On a change to an app input (sources, `migrations/`, `public/`, `renox.toml`; not `tests/`, `.renox/`, `node_modules/`), debounced by 30 ms (a burst of saves is one rebuild and one route switch; builds run one at a time): a changed module under `functions/` is rebuilt alone (per-module cache keyed by the source's hash); a change anywhere else rebuilds every module. When the hash changes, `routes.json` is rewritten and the worker gets `SIGHUP`: new requests create a fresh isolate for the new hash (D19), the old cell drains and is evicted. The terminal prints `rebuilt in N ms`. The error overlay is F2.
- A failed build prints `build failed: <file>:<line>:<col>: <message>` and changes nothing: the worker keeps serving the last good artifact. `routes.json` is replaced atomically (write, then rename) and only after a build succeeded, so the worker never reads a half-written table.
- A worker that exits is restarted with `renox dev: renox-worker exited (…); restarting`; requests in between get 502. More than 5 exits within 30 s end `renox dev` with exit code 3. So does a worker that exits during startup, or a missing binary (with the download instruction).

**Dev loop timing (first B16 data point, informational).** `examples/hello` copied by `renox new devtest --template hello`, 4 vCPU cloud container, debug build of `renox-worker`: rebuild 5 ms; edit of `functions/api/hello.ts` to the first response with the new body 69 ms (watcher latency, 30 ms debounce, build, SIGHUP, route reload, fresh isolate). Target 300 ms is F2's (`docs/14-benchmarks.md`, B16); F1's acceptance is 1 s.

### `renox check`

| Rule | Severity |
| --- | --- |
| `renox.toml` schema, route discovery, route conflicts (V8), manifest schema, migration names, bundle size | error |
| `sql-interpolation`: the first argument of `db.query` / `db.queryOne` / `db.execute` (also `tx.` and `ctx.db.`) is a template literal with `${}`, uses `+`, or calls `.concat(` | error |
| `fetch-undeclared-host`: `fetch("https://…")` / `ctx.fetch(...)` with a literal URL whose host is not in `[permissions] network` | warning |
| `global-state`: inside a function body, a write to `globalThis` (`globalThis.x = …`, `globalThis["x"] = …`, compound assignments, `++`/`--`, `Object.assign(globalThis, …)`, `Object.defineProperty(globalThis, …)`) or an assignment to a module-level `let`/`var` binding that no parameter or local declaration shadows. Module state is shared by every request of the deployment (`docs/07-app-model.md`, "State rules"); `// renox-allow-global` on the line or the line above marks an intentional cache | error |

The lint is a small tokenizer (comments, strings, and template literals with nested `${}` are understood), not a type checker: SQL passed through a variable is not followed. `global-state` adds brace scopes on that tokenizer, not a parser: it does not see writes into a shared object (`cache.set(k, v)`, `counts[k] = 1` on a module-level `const`), writes through a cast (`(globalThis as any).x = 1`), or writes inside a `${}` of a template literal. Tests are not linted.

### `renox mcp`

The local platform MCP server (`docs/20-ai-agents-mcp.md`, sections 1 and 6). JSON-RPC 2.0 over stdio, one message per line; protocol versions `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05` (the client's if it is one of them, else the newest). It serves the project in the current folder, or `--project <dir>`. stdout carries only protocol messages; the server logs to stderr.

| Tool | Input | Returns |
| --- | --- | --- |
| `dev_status` | none | `running`, and while `renox dev` runs: `url`, `port`, `pid`, current `artifact`, `routes`, `lastBuild` (`ok`, `at`, `ms`, problem count), `workerRestarts` |
| `dev_errors` | none | The last build's `problems` and the latest 20 `error` lines of the tenant log (`.renox/logs/tenant.ndjson`) |
| `run_check` | none | `renox check` as data: `ok`, `errors`, `warnings`, `problems` |
| `run_tests` | `filter?` | `bun test` in the project (120 s timeout): `ok`, `exitCode`, `timedOut`, `pass`, `fail`, `skip`, the last 32 KiB of `output` |
| `search_docs` | `query`, `limit?` (1–50, default 10) | Lines of the docs that contain every query word: `uri`, `title`, `section`, `line`, `snippet` |

A problem has the CLI's shape: `code`, `message`, and `file`, `line`, `column`, `hint` when known. Every result is both `structuredContent` and the same JSON as text. A bad input (an unknown argument, a `filter` outside the allowlist) is a tool result with `isError: true` and `error.code: "invalid_input"`.

| Resource | Content |
| --- | --- |
| `docs://<path>` | Every `docs/*.md` and `docs/contracts/*.md` (`docs://00-overview.md`, `docs://contracts/ops.md`), Markdown |
| `types://renox/ctx.d.ts` | The contract's `ctx` types (`docs/contracts/ctx.d.ts`), which the `renox` SDK re-exports |
| `config://effective` | The resolved `renox.toml`, or `{ ok: false, problems }` |
| `routes://` | The routes `renox build` would emit, in matching order, and route conflicts |

No prompts, no subscriptions. The docs are embedded at build time by a Bun macro (`src/mcp/embed.ts`): `bun --compile` does not ship `docs/`, and the binary serves the docs it was built with.

**What the tools can do.** Each tool is one fixed operation on the project folder. Model input never becomes a shell command or a path: `resources/read` looks the URI up in the fixed set above (a `docs://../x` is "resource not found"), and `run_tests` spawns `bun test` with a fixed argv and no shell. Its `filter` must match `^[A-Za-z0-9 _.:/-]{1,100}$` and is passed as the single argument after `--test-name-pattern`. `run_tests` runs the project's own tests with the developer's permissions, as `bun test` in a terminal would. Values of `.env` (8 bytes or longer) are replaced by `[redacted]` in every tool result, so secrets never reach the model. While `renox dev` runs, it writes its state to `.renox/dev.json`, which `dev_status` and `dev_errors` read. A file left by a dead process reads as not running. Deploy, logs, data and module tools need the control plane: they are F3–F4, on the remote server with OAuth scopes.

Claude Code (`.mcp.json` in the app folder, or `claude mcp add renox -- renox mcp`):

```json
{
  "mcpServers": {
    "renox": { "command": "renox", "args": ["mcp"] }
  }
}
```

Cursor (`.cursor/mcp.json` in the app folder):

```json
{
  "mcpServers": {
    "renox": { "command": "renox", "args": ["mcp", "--project", "${workspaceFolder}"] }
  }
}
```

From this repository without the binary: `"command": "bun", "args": ["<repo>/cli/src/main.ts", "mcp"]`. To try it by hand: `npx @modelcontextprotocol/inspector --cli renox mcp --method tools/list`.

## Tests

`cli/tests/`: route discovery and conflicts on fixtures, the hash vectors, the lints, `renox new` + `renox build` (schema-valid artifact named by its hash, reproducible, migrations and public files), `renox check`, and `dev.e2e.test.ts` (skipped unless `RENOX_WORKER_PATH` is set: serves the hello app through the worker, edits the file, the new response arrives within 1 s). `negative/`: one fixture per CLI failure (messages and exit codes, snapshotted), and `renox dev` against a fake worker (`negative/fake-worker.ts`): 50 saves in 500 ms give one rebuild and one route switch, a failed build keeps the running artifact, a worker crash is restarted, repeated crashes, a missing binary, and a port in use are exit 3, Ctrl-C is exit 130. `mcp.test.ts` drives `renox mcp` through the official MCP SDK client (which validates every response against the MCP schemas): every tool and resource, the refused inputs, secret redaction, and the compiled binary serving the embedded docs; with `RENOX_MCP_INSPECTOR=<path to mcp-inspector>` it also runs the MCP Inspector CLI against every tool and resource.
