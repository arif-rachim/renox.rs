# renox CLI (v0, F1)

One CLI for the tenant dev loop (`docs/12-developer-experience.md`, P11): `new`, `build`, `dev`, `check`. Bun, no runtime dependencies (the TOML parser, transpiler, bundler, and file watcher are Bun's own; the JSON Schema checks use `src/lib/schema.ts` against `docs/contracts/schemas`).

```
bun cli/src/main.ts <command>        # from the repository
bun run --cwd cli compile            # single binary: cli/dist/renox
bun test --cwd cli                   # tests; the dev end-to-end test needs RENOX_WORKER_PATH
```

## Commands

| Command | What it does |
| --- | --- |
| `renox new <name> [--template blank\|hello]` | Creates `<name>/` with `renox.toml`, `package.json` (depends on `renox`), `tsconfig.json`, `.gitignore`, and the template's files (`cli/templates/<template>/`; `hello` mirrors `examples/hello`, `blank` has `GET /api/health`). Refuses a non-empty folder |
| `renox build [--out <dir>]` | Builds the artifact (`docs/contracts/artifact.md`) into `.renox/artifact/<hash>/` (or `<dir>/<hash>/`). Prints the hash |
| `renox dev [--port 8787]` | Builds, starts the prebuilt `renox-worker` on the app, serves it on `http://localhost:<port>`, rebuilds on every change and switches the worker to the new artifact |
| `renox check` | Validates `renox.toml`, route conflicts, and the manifest (by building in memory), and lints the sources. Exit code 1 on any error |

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
```

- The worker binary is `RENOX_WORKER_PATH` if set, else `cli/bin/<platform>-<arch>/renox-worker`, which `bun cli/scripts/fetch-worker.ts <version>` downloads from the GitHub release (asset `renox-worker-<platform>-<arch>` and its `.sha256`; the download is refused on a checksum mismatch). Locally: `cargo build -p renox-cell --bin renox-worker` and `RENOX_WORKER_PATH=target/debug/renox-worker`.
- The route table requires a dotted hostname (`route-table.schema.json`), so the app is routed as `<app>.localhost` and the worker listens on a free loopback port. `renox dev` listens on `localhost:<port>` and forwards every request to the worker with that `Host`.
- On a change to an app input (sources, `migrations/`, `public/`, `renox.toml`; not `tests/`, `.renox/`, `node_modules/`), debounced by 30 ms: a changed module under `functions/` is rebuilt alone (per-module cache keyed by the source's hash); a change anywhere else rebuilds every module. When the hash changes, `routes.json` is rewritten and the worker gets `SIGHUP`: new requests create a fresh isolate for the new hash (D19), the old cell drains and is evicted. The terminal prints `rebuilt in N ms`. The error overlay is F2.

**Dev loop timing (first B16 data point, informational).** `examples/hello` copied by `renox new devtest --template hello`, 4 vCPU cloud container, debug build of `renox-worker`: rebuild 5 ms; edit of `functions/api/hello.ts` to the first response with the new body 69 ms (watcher latency, 30 ms debounce, build, SIGHUP, route reload, fresh isolate). Target 300 ms is F2's (`docs/14-benchmarks.md`, B16); F1's acceptance is 1 s.

### `renox check`

| Rule | Severity |
| --- | --- |
| `renox.toml` schema, route discovery, route conflicts (V8), manifest schema, migration names, bundle size | error |
| `sql-interpolation`: the first argument of `db.query` / `db.queryOne` / `db.execute` (also `tx.` and `ctx.db.`) is a template literal with `${}`, uses `+`, or calls `.concat(` | error |
| `fetch-undeclared-host`: `fetch("https://…")` / `ctx.fetch(...)` with a literal URL whose host is not in `[permissions] network` | warning |

The lint is a small tokenizer (comments, strings, and template literals with nested `${}` are understood), not a type checker: SQL passed through a variable is not followed. Tests are not linted.

## Tests

`cli/tests/`: route discovery and conflicts on fixtures, the hash vectors, the lints, `renox new` + `renox build` (schema-valid artifact named by its hash, reproducible, migrations and public files), `renox check`, and `dev.e2e.test.ts` (skipped unless `RENOX_WORKER_PATH` is set: serves the hello app through the worker, edits the file, the new response arrives within 1 s).
