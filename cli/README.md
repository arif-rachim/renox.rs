# renox CLI (v0, F3)

One CLI for the tenant dev loop and deploys (`docs/12-developer-experience.md`, P11): `new`, `build`, `dev`, `check`, `mcp` (P21), and against the control plane `login`, `tokens`, `deploy`, `logs`, `secrets`, `db`. Bun, no runtime dependencies (the TOML parser, transpiler, bundler, and file watcher are Bun's own; the JSON Schema checks use `src/lib/schema.ts` against `docs/contracts/schemas`).

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

Commands that call the control plane (`deploy`, `logs`, `secrets`, `db`, `tokens`, `login`) map the API's answer onto the same codes: not signed in, 400, 401, 403, 404, 409 → `1` (with the API's code, message and `details`); 422 `RENOX_DEPLOY_REJECTED` and `RENOX_ACTIVATION_FAILED` → `2` (the artifact or its migrations, cell or probe are wrong); 5xx, 429 and an unreachable API → `3` (after the retries below). A command never prints a token or a secret value.

Every error is one message: `renox <command>: <file>:<line>:<col>: <what is wrong>`, then `hint: <what to do>` when there is something to do (`src/errors.ts`). `renox check` prints each problem as `<file>:<line>  error  <message>`. A TypeScript syntax error carries the transpiler's line and column, relative to the app folder. A `renox.toml` problem carries the line of the key; for a TOML syntax error, the line where parsing first fails. An unknown key comes with the closest valid key ("did you mean"). The messages are snapshotted in `tests/negative/__snapshots__/`.

## Commands

| Command | What it does |
| --- | --- |
| `renox new <name> [--template blank\|hello]` | Creates `<name>/` with `renox.toml`, `package.json` (depends on `renox`), `tsconfig.json`, `.gitignore`, and the template's files (`cli/templates/<template>/`; `hello` mirrors `examples/hello`, `blank` has `GET /api/health`). Refuses a non-empty folder |
| `renox build [--out <dir>]` | Builds the artifact (`docs/contracts/artifact.md`, version 1) into `.renox/artifact/<hash>/` (or `<dir>/<hash>/`). Leaves forbidden files out of `public/` and fails on a secret in what it ships (step 5 and the secret scan below). Prints the hash. An app with templates needs the `renox-worker` binary (see "Templates") |
| `renox dev [--port 8787]` | Builds, starts the prebuilt `renox-worker` on the app, serves it on `http://localhost:<port>`, rebuilds on every change and switches the worker to the new artifact |
| `renox dev --worker <path>` | Runs another `renox-worker` binary: it must have the pinned release's sha256 or carry a sigstore signature (`<path>.sigstore.json`) and the release's provenance bundle beside it that `cosign` verifies; otherwise `RENOX_CLI_WORKER_UNVERIFIED`, exit code 3 (#129) |
| `renox check [--secrets] [--security] [--json] [--strict]` | Validates `renox.toml`, the modules and `renox.lock` (MF rules), route conflicts, templates, `[security]`, and the manifest (by building in memory), lints the sources, and scans for secrets. `--secrets` runs only the secret scan; `--security` also prints the effective response headers, CORS, and rate-limit buckets per route (#47). Exit code 2 on any error |
| `renox add <module> [--version <range>] [--source …] [--mount <path>] [--yes]` | Installs a module after showing and approving its permissions; writes `renox.toml` and `renox.lock` (below) |
| `renox remove <module>` | Uninstalls a module; its tables stay |
| `renox test [pattern...] [--seed <file.sql>]... [-u]` | Runs `tests/*.test.ts` with `renox/test` on the worker, a fresh tenant file per test file (below) |
| `renox migrate [--db <file>]` | Builds, then runs the artifact's migration plan (installed modules in lock order, then the app's) on the dev tenant file `.renox/data/dev/app.db` through `renox-worker migrate` (below) |
| `renox deploy [--json]` | Builds, uploads, validates and activates the app of `renox.toml` against the control plane (below) |
| `renox deploy --rollback [<hash>] [--app <name>] [--json]` | Switches the app back to the previous deployment, or to the superseded one named by a hash or a unique prefix of at least 6 characters |
| `renox logs [--follow] [--since <t>] [--source all\|server\|client] [--deployment <hash>] [--app <name>] [--json]` | The app's log lines; `--follow` keeps streaming |
| `renox secrets set <NAME> \| list \| rm <NAME> [--app <name>]` | App secrets; `set` reads the value from stdin |
| `renox db export [--out <file>] \| import <file> \| restore --at <time> --as <new-app> [--app <name>]` | The app's database: download a snapshot, import into a staging app, restore into a new app (#258) |
| `renox login`, `renox tokens` | Sign in, manage tenant tokens (#113) |
| `renox mcp [--project <dir>]` | Local MCP server on stdio for coding agents: the docs, the project's config and routes, and the `check`/`dev` status as tools (below) |

### `renox build`

1. `renox.toml` is read and validated: `[app] name, timezone`, `[permissions] network, secrets`, `[limits] cpu_ms, wall_ms, memory_mb, concurrency`, `[security.csp]`, `[security.cors]`, `[security.headers]`, `[[security.ratelimit]]` (unknown keys are errors). `[security]` is checked against the manifest schema's `security` object and rule V16 (`'unsafe-inline'`/`'unsafe-eval'` only with `allow_unsafe = true`, `credentials` only with `origins`, every bucket names a `(method, path)` a route answers) and becomes `manifest.security` (`src/check/security.ts`).
2. Routes are discovered from `functions/` and `pages/` (`docs/07-app-model.md`, "Routing rules" and "Pages"): the file path without extension is the URL, `index` is its folder, `[id]` is `:id`, `[...slug]` is `*slug` (last segment only). Files and folders starting with `_`, `.d.ts`, and `*.test.*` files are not routes; a module that exports no method (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`, `HEAD`) is not a route. Two routes with the same method and shape conflict (V8): `/a/:id` and `/a/:slug` conflict, `/a/new` and `/a/:id` do not (static wins). Pages (#41): `pages/<path>.html` and/or `pages/<path>.ts` is one page route; the `.ts` file's `load` export and the keys of its `export const actions = { ... }` literal (read at build time, so the worker never guesses) go into the route. A `.ts`-only page must export `load`; `pages/_error.ts` and `pages/_404.ts` are errors (error pages get no loader). A page answers `GET`/`HEAD` (and `POST` with actions), so it conflicts with a page or a function of the same shape for those methods.
3. All function and page modules are bundled in one `Bun.build` (`target: "browser"`, ESM, code splitting): types stripped, local and npm imports vendored into the artifact, `node:` imports kept (the runtime allows its compute-only `node:` modules). Code imported by more than one module (zod, a project `lib/`) is emitted once under `code/chunks/chunk-<hash>.js`, so an isolate evaluates each dependency once (#143). Nothing is resolved at runtime (`code.format = "esm-dir"`). Source maps are not in the artifact (they would be loaded into every isolate as module text): they are written to `<out>/../sourcemaps/<hash>/` (`.renox/sourcemaps/<hash>/` by default), for `renox deploy` to upload privately (#128). Source paths are relative to the project (the build runs with the project as working directory), so the same project always builds to the same hash and no machine path enters the artifact.
4. Templates: every `.html` under `pages/`, `partials/`, `modules/`, `overrides/` is transpiled by `renox-worker transpile` into `templates/<id>.jinja`, and `manifest.templates` gets each template's kind and the pages' fragment maps (#43, "Templates" below). A template error fails the build with its file, line, and column.
5. `migrations/NNN_name.sql` → `migrations/app/` with `checksums.json` (numbered from 001 without gaps). `public/**` → `public/`, indexed by `public.json` at the artifact root (sha256, size, content type by extension); `public/manifest.json` is an ordinary file in version 1. Forbidden files are left out and printed as `skipped public/<path>: <reason>`: dotfiles and dot-directories (`.git/`, `.env*`, `.DS_Store`) except `public/.well-known/`, `node_modules/`, keys and certificates (`*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`), databases (`*.db`, `*.sqlite`), `*.log`, symbolic links, and files over 5 MiB (serve those from storage). The rules are `forbiddenReason` of `@renox/artifact-validate`, which the control plane applies to uploads too (rule H1, #115).
6. `manifest.json` (`artifact.version: 1`), validated against `manifest.schema.json`. `code/` over 20 MiB fails (V5).
7. The content hash (`src/lib/hash.ts`, the twin of `crates/renox-cell/src/artifact.rs`, both tested against `docs/contracts/examples/hash-vectors.json`) names the directory. An existing directory with that name is reused.

Limitations found so far (B17 will add to this list): the bundle targets a browser-like environment, so a package that needs Node APIs beyond the runtime's `node:` allowlist builds but fails at isolate creation; dynamic `import()` of a computed specifier cannot be vendored; one module's dependencies are duplicated in every module that imports them (no shared chunks in `esm-dir`).

### Templates (#43)

The CLI does not compile templates itself: `renox-worker transpile` (the `renox-template` compiler behind one JSON call on stdin/stdout, `crates/renox-template/src/transpile.rs`) does. The issue asked to measure both candidates, a Wasm build of `renox-template` and the worker subcommand, on the cold path with the shop templates (`bun bench/scenarios/B16/transpile.ts <renox_template.wasm> <renox-worker>`, 30 iterations each, 4 vCPU container, debug worker):

| Path | p50 | p99 | Size |
| --- | --- | --- | --- |
| Wasm: read the module, instantiate, compile (`bench/scenarios/B16/build-wasm.sh`, C ABI in `src/wasm.rs`) | 17.5 ms | 25.4 ms | 1.2 MB |
| `renox-worker transpile`: spawn, stdin, stdout | **9.0 ms** | 13.5 ms | the worker binary |

The worker is the faster cold path, needs no Wasm file next to the compiled CLI, and `renox dev` needs the binary anyway, so it is the one used. The cost: `renox build` and `renox check` of an app with templates need `RENOX_WORKER_PATH` or the downloaded worker (exit 3 with the download hint otherwise); apps without templates do not. Both paths return the same templates (the benchmark checks it). In `renox dev`, an unchanged set of templates is not recompiled.

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

- The worker binary is `RENOX_WORKER_PATH` if set (not verified: for a worker built from source), else `cli/bin/<platform>-<arch>/renox-worker` or, for a compiled `renox`, the `renox-worker` installed beside it; either must have the sha256 pinned for its target in `cli/src/worker/verify.ts` or the CLI stops with `RENOX_CLI_WORKER_UNVERIFIED` (#129). `cli/bin/<platform>-<arch>/renox-worker` is the one that `bun cli/scripts/fetch-worker.ts [<version>]` downloads from the GitHub release `worker-v<version>` (default: the pinned `WORKER_VERSION`; asset `renox-worker-<version>-<target triple>` and its `.sha256`, the names `.github/workflows/release-worker.yml` publishes; the download is refused on a checksum mismatch). Locally: `cargo build -p renox-cell --bin renox-worker` and `RENOX_WORKER_PATH=target/debug/renox-worker`.
- The route table requires a dotted hostname (`route-table.schema.json`), so the app is routed as `<app>.localhost` and the worker listens on a free loopback port. `renox dev` listens on `localhost:<port>` and forwards every request to the worker with that `Host`.
- On a change to an app input (sources, templates under `pages/` `partials/` `modules/` `overrides/`, `migrations/`, `public/`, `renox.toml`; not `tests/`, `.renox/`, `node_modules/`), debounced by 30 ms (a burst of saves is one rebuild and one route switch; builds run one at a time): a changed module under `functions/` is rebuilt alone (per-module cache keyed by the source's hash); a change anywhere else rebuilds every module. When the hash changes, `routes.json` is rewritten and the worker gets `SIGHUP`: new requests create a fresh isolate for the new hash (D19), the old cell drains and is evicted. The terminal prints `rebuilt in N ms`.
- **Browser (#43).** The proxy injects `<script src="/__renox/dev/client.js">` before `</body>` of HTML documents (never into htmx fragments, never into an artifact), with the response's CSP nonce when there is one. The script listens on `/__renox/dev/events` (SSE): `reload` after a code, route, or config change; `templates` with the fragment targets when only page templates changed, after which the client re-fetches the page, swaps the targets whose HTML changed, and reloads if anything outside them changed; `error` with the build problems (file, line, column) for an overlay; `ok` when a build succeeds again. Measured in `tests/dev.e2e.test.ts`: template edit to swapped fragment 66 ms; B16 is `bench/scenarios/B16/run.sh`.
- **Types (#43).** Every successful build rewrites `.renox/types/`: `routes.d.ts` (`RouteParams` per module id, `[id]` → `string`, `[...slug]` → `string[]`; `Fragments` per page; `LoaderContextOf<"pages/products/[id]">`, `ActionContextOf<...>`), `db.d.ts` (`Tables`: one row type per table from `migrations/` applied to an in-memory SQLite, `RowOf<"app__products">`), `index.d.ts`. Import them with `import type { LoaderContextOf } from "../../.renox/types"`.
- **Stacks.** Tenant log lines with a `stack` are printed with the frames mapped to the TypeScript sources through `.renox/sourcemaps/<hash>/` (`src/lib/sourcemap.ts`).
- A failed build prints `build failed: <file>:<line>:<col>: <message>` and changes nothing: the worker keeps serving the last good artifact. `routes.json` is replaced atomically (write, then rename) and only after a build succeeded, so the worker never reads a half-written table.
- A worker that exits is restarted with `renox dev: renox-worker exited (…); restarting`; requests in between get 502. More than 5 exits within 30 s end `renox dev` with exit code 3. So does a worker that exits during startup, or a missing binary (with the download instruction).

**Dev loop timing (first B16 data point, informational).** `examples/hello` copied by `renox new devtest --template hello`, 4 vCPU cloud container, debug build of `renox-worker`: rebuild 5 ms; edit of `functions/api/hello.ts` to the first response with the new body 69 ms (watcher latency, 30 ms debounce, build, SIGHUP, route reload, fresh isolate). Target 300 ms is F2's (`docs/14-benchmarks.md`, B16); F1's acceptance is 1 s.

### `renox check`

| Rule | Severity |
| --- | --- |
| `renox.toml` schema, route discovery (functions and pages), route conflicts (V8), template diagnostics (one per problem, with file and line), manifest schema, migration names, bundle size | error |
| `sql-interpolation`: the first argument of `db.query` / `db.queryOne` / `db.execute` (also `tx.` and `ctx.db.`) is a template literal with `${}`, uses `+`, or calls `.concat(` | error |
| `fetch-undeclared-host`: `fetch("https://…")` / `ctx.fetch(...)` with a literal URL whose host is not in `[permissions] network` | warning |
| `global-state`: inside a function body, a write to `globalThis` (`globalThis.x = …`, `globalThis["x"] = …`, compound assignments, `++`/`--`, `Object.assign(globalThis, …)`, `Object.defineProperty(globalThis, …)`) or an assignment to a module-level `let`/`var` binding that no parameter or local declaration shadows. Module state is shared by every request of the deployment (`docs/07-app-model.md`, "State rules"); `// renox-allow-global` on the line or the line above marks an intentional cache | error |

| `secret`: a credential in what the build ships (below) | error |
| `forbidden-file`: a file of `public/` the build leaves out | warning |

**Secret scan** (`renox build`, `renox check`, `renox check --secrets`; #115). Scanned: the project's own sources that went into `code/` (read from the source maps, so findings carry the original file and line; vendored npm code is not scanned) and the files copied as they are (`public/`, `migrations/`). Patterns (`@renox/artifact-validate`, `src/secrets.ts`): private key blocks, AWS access key ids, GitHub tokens, Stripe live secret and restricted keys, Slack tokens and webhooks, Google API keys, unsigned JWTs (`alg: none`), and a high-entropy string assigned to a name containing `secret`, `token`, `key`, `password` (hashes, UUIDs, `data:` URLs, and placeholders pass). A finding prints `file:line:col  pattern  description: <masked prefix> (N chars)`, never the value, with `hint: … renox secrets set <NAME> …`. A line that must keep such a string carries `renox-allow-secret: <reason>` on it or alone on the line above; the reason is required, and `renox build` prints it (`allowed <file>:<line> … renox-allow-secret: <reason>`). The control plane rejects the same patterns in `public/` and `migrations/` of an upload (rule H2); bundled `code/` is checked here only, because bundling removes the markers.

The lint is a small tokenizer (comments, strings, and template literals with nested `${}` are understood), not a type checker: SQL passed through a variable is not followed. `global-state` adds brace scopes on that tokenizer, not a parser: it does not see writes into a shared object (`cache.set(k, v)`, `counts[k] = 1` on a module-level `const`), writes through a cast (`(globalThis as any).x = 1`), or writes inside a `${}` of a template literal. Tests are not linted.

### `renox add`, `renox remove` and `renox.lock` (#234)

`renox add <module> [--version <range>] [--source path:<dir>|git:https://<repo>#<ref>] [--mount <path>] [--yes]` installs a module (`docs/contracts/manifest.md`):

1. Reads `renox.toml [modules]` and fetches every module tree: `path:` relative to the app, `git:` cloned at the ref into `.renox/modules/<name>/<commit>/` (the lock pins the commit), no source = an official module from this CLI's `modules/` directory.
2. Validates each `module.toml` (schema and MF1, MF4–MF6, MF8–MF10), checks every `[dependencies]` range against the installed version (an unsatisfied range names both modules), and orders the modules topologically, ties by name; a cycle is printed (`a -> b -> a`). A dependency is never installed implicitly.
3. Prints what the module asks for (tables, network hosts, secrets, slots, hooks, tools, config, dependencies) and asks `y/N`; `--yes` approves without asking (CI). Declining leaves both files unchanged (exit 1).
4. Writes the `renox.toml` entry (other lines and comments untouched) and `renox.lock`: version, source, tree hash, isolation, mount, dependencies, resolved config, and the approved permissions. Without `--version` the range is `^<fetched version>`.

Running `renox add` again for an installed module re-resolves it and asks again: that is how a changed manifest is approved. `renox remove <module>` drops the entry from both files; its tables stay (migrations are forward-only, D17), and a module another one depends on cannot be removed.

`renox check` applies the project rules MF2, MF3, MF5, MF7–MF12 to `renox.toml`, the module trees, and `renox.lock`: a module without a lock entry fails (MF3); a manifest whose `[permissions]` differ from the approved ones, or whose tree, version, config, or mount changed, fails (MF12). Each error starts with its rule id; `renox check --json` prints `{ ok, errors: [{ rule, file, message }], findings }`.

### Building with modules, `renox check` contracts, `renox migrate` (#235)

With a `renox.lock`, `renox build` writes an artifact 1.1 (`docs/contracts/artifact.md`, "Modules"). For each lock entry, in lock order:

- **Code.** The module's `functions/`, `pages/`, `services.ts`, and `hooks.ts` are bundled from its tree (one bundle per module, `renox:*` left to the runtime's loader) into `code/modules/<name>/`, with code ids `modules/<name>/…`.
- **Routes.** The module's routes go under its `mount` (`/login` of `auth` at `/auth` is `/auth/login`). A collision with the app or another module fails the build with `V21`, naming both owners.
- **Migrations, policies, catalogs.** `migrations/` → `migrations/<name>/`, with the checksums in `migrations/checksums.json`. `policies/*.cedar` → `policies/<name>/`. `i18n/<locale>.json` → `code/modules/<name>/i18n/` (where the cell reads it, #233).
- **Templates.** The module's `pages/` and `partials/` are compiled as `modules/<name>/…`, from the installed tree, not from the app's `modules/` folder. Its `[[slots]]` (by priority, then module name) go to the compiler and to the manifest's `slots`.
- **Overrides.** The app's `overrides/<name>/(pages|partials)/….html` are compiled in place of the original and carried with `overrides.json`, which holds the original's sha256 at the installed version. The app keeps its own `overrides.json` at the project root: the hash each override was made against. When the module's original no longer has that hash, `renox build` warns with a unified diff of the override against the new original ("Template override drifted"), and `renox check` reports it: a warning, or an error with `--strict`. Fix the override, then delete its entry from the root `overrides.json` to record the new original.
- **`modules`.** The manifest's `modules` field holds the lock entries, the manifest's permissions, and the exports (service names, event payload schemas, hook names, views).

`renox check` also compares what each module's code uses against the manifests (`docs/23-failure-modes.md`, "Module contract broken on upgrade"; MF7):

- every `renox:modules` import is a declared dependency (the app may import every installed module);
- every `<dep>.<service>` call or `ctx.services.<dep>.<service>` is exported by the installed `<dep>` and listed in `[imports].services`;
- every `<dep>__public_<id>_v<n>` view in the code is exported by `<dep>` (a different version names both) and listed in `[imports].views`.

`renox migrate` runs `renox-worker migrate <artifact> <db>` (`renox_data::migrate_all`, #228): each module's files under its own prefix, the app's last. It prints what was applied per module and refuses a changed file that already ran (checksum). `renox dev` needs nothing extra: the worker's cell runs the same plan when it opens the artifact. `.renox/types/db.d.ts` includes the module tables, and `TablesOf<"auth">` groups them by prefix.

### `renox test` and `renox/test` (#238)

`renox test` builds the app (`src/lib/test-harness.ts`, `prepare`) and writes a test artifact: the app's plus `POST /__renox_test/service`. That function route imports `renox:modules` and calls a service like app code does, so the broker's dependency checks and transaction rules apply. It exists only in the test artifact, never in `renox build` or `renox deploy`. `bun test` then runs with `sdk/src/test.ts` preloaded and `RENOX_TEST_SPEC` pointing at the build.

In a test file, `await app()` starts the worker on a temporary tenant file. The first request opens and migrates it, then the seeds run (`seeds/*.sql`, `--seed`), and the worker stops after the file. The returned app has:

- `request(method, path, init)`, `page(path)`, and `action(path, name, form)` (the CSRF token taken from the session's cookie);
- `as(user)`, a separate cookie jar, so a separate session: roles are whatever the app's own code ties to a session;
- `service(module).<name>(...args)`;
- `db.query(sql)`, read-only;
- `logs()` and `meters()`.

`snapshot(html, { role })` strips request ids, deployment hashes, nonces, CSRF tokens and ULIDs, then matches the snapshot named `role: <role>`. `policyCases()` registers each case of `policies/tests/*.json` as a pending test (F5 evaluates them). A malformed file fails.

`installModule(name, "path:…")` runs `renox add` + `renox check` + `renox build` + `renox migrate` on a scratch copy of the app and a scratch tenant file. `.upgrade("path:…")` does it again on the same copy, with the range `^<version>` of the new tree. Each returns the check report (drift, broken contracts) and the migration report.

Without `renox test` (plain `bun test` in CI), `app()` builds the project itself when `RENOX_WORKER_PATH` is set: `examples/shop/tests/shop.e2e.test.ts` runs that way.

### `renox deploy`, `renox logs`, `renox secrets` (#58)

All three use the token of `renox login` (`$XDG_CONFIG_HOME/renox/credentials.json`, default `~/.config/renox/`, mode 0600) or `RENOX_TOKEN` and `RENOX_API_URL` (CI). The endpoints are `docs/contracts/deploy-api.md`.

```
$ renox deploy
  Bundling… <routes> routes, <modules> modules, <templates> templates  <s>
  Uploading <size> MB → <api host>                                     <s>
  Validating… ✓ manifest ✓ routes ✓ templates ✓ permissions ✓ bundle (validated)
  Activating… ✓ migrations ✓ cell ✓ probe                              <s>
  Live: https://shop.renox.app  (<new hash, 12 characters>)            total <s>
  Rollback: renox deploy --rollback <previous hash, 12 characters>
```

Measured times are B15's (`bench/scenarios/B15/run.sh`).
```

- **Deploy.** `renox build` (with the secret scan), then the artifact directory as a gzip tar with `x-renox-artifact-hash` to `POST /v1/apps/{app}/deployments` (the app is created on the first deploy), the source maps of `.renox/sourcemaps/<hash>/` to the private `PUT …/sourcemaps` (a failure there is a warning, not an error), and `POST /v1/apps/{app}/activate`, which answers once the owning node has migrated, loaded and probed the new cell. The live URL is the app's first hostname. An upload is idempotent by hash, so it is retried on a network failure, a 5xx or a 429; activation and rollback are retried on 503 and 429. At most 4 attempts, waiting `Retry-After` (capped at 30 s) or 1, 2, 4 s. A rejected upload prints every violation (`rule=… path=… reason=…`); a failed activation prints the stage (`migrate` with module, file and the SQLite message; `probe` with the status) and the old deployment keeps serving.
- **Rollback.** `renox deploy --rollback` is a pointer switch to the most recently superseded deployment (`POST /v1/apps/{app}/rollback`); no build, upload or migration. It prints the command that undoes it.
- **`--json`** prints one object instead of the progress lines: `app`, `hash`, `previous`, `url`, `hostnames`, `sourcemaps`, `stages` (`build_ms`, `upload_ms`, `sourcemaps_ms`, `activate_ms`) and `total_ms` (B15 reads it).
- **Logs.** `GET /v1/apps/{app}/logs` as Server-Sent Events: the last 100 lines (or those since `--since`, Unix ms or `30s`/`10m`/`2h`/`1d`), one per line (`time level [browser] module message (request id)`, or the raw JSON with `--json`). With `--follow` the stream stays open; when it drops, or nothing arrives for 45 s (three missed keep-alives), the CLI reconnects with `Last-Event-ID`, backing off from 1 s to 30 s, so no line is lost or repeated. 401, 403, 404 end it with exit 1; 10 failed reconnects in a row with exit 3.
- **Secrets.** `renox secrets set NAME` reads the value from stdin (`printf %s "$VALUE" | renox secrets set NAME`; in a terminal it prompts with the echo off) and refuses it as an argument, where it would reach the shell history and `ps`. One trailing newline is dropped. A value under 8 bytes or 8 characters, or over 64 KiB, is refused before anything is sent. `list` prints names, update times and the secret version; `rm` removes. A new value is used from the next `renox deploy` or rollback. No output contains a value.

### `renox db` (#258)

The app's database, through `docs/contracts/deploy-api.md` 0.3 section 14.

- **Export.** `renox db export [--out <file>]` asks for a consistent snapshot (`exportBackup`). The API answers a signed URL that expires within 15 minutes, and the file is downloaded through that URL, without the API token. The file's SHA-256 is compared with the one the API reported; a mismatch writes nothing and exits `3`. The file is written as `<file>.partial` with mode 0600, then renamed. The default name is `<app>-<UTC time of the export>.db`.
- **Import.** `renox db import <file> --app <staging-app>` replaces the database of a staging app (`POST /v1/apps`, `"staging": true`) with a SQLite file, sent as `application/vnd.sqlite3`. A file that is missing, or does not start with the SQLite header, is refused before anything is sent. The API refuses a production app and a file whose tables break the naming rules (422 `RENOX_IMPORT_REJECTED`, exit `1`, with the reasons).
- **Restore.** `renox db restore --at <time> --as <new-app>` restores the database as of `<time>` (milliseconds since the epoch, or an ISO 8601 time with a zone) into a new app with the source app's active artifact. 0.3 never restores in place. A time that no backup generation covers is 422 `RENOX_RESTORE_POINT_UNKNOWN` (exit `1`), and nothing is created.

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
