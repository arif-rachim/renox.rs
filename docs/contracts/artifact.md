# Contract: artifact format and route table

| | |
| --- | --- |
| Version | **0** (F1). The number is written into every manifest as `artifact.version` |
| Producers | `cli/` (P11): `renox build` writes an artifact directory; F1 examples are also written by hand |
| Consumers | `crates/renox-cell` (P5): loads and verifies an artifact; `crates/renox-gateway` (P3): reads the route table; `control/api` (P12, F3): validates, stores, and routes artifacts |
| Machine-readable | [`schemas/manifest.schema.json`](schemas/manifest.schema.json), [`schemas/route-table.schema.json`](schemas/route-table.schema.json), [`schemas/migrations-checksums.schema.json`](schemas/migrations-checksums.schema.json), [`schemas/public-manifest.schema.json`](schemas/public-manifest.schema.json) (JSON Schema draft 2020-12) |
| Examples | Worked example for `examples/hello`: [`examples/hello-artifact/`](examples/hello-artifact/); more valid and invalid examples under [`examples/artifact/`](examples/artifact/) |
| Checker | `bun run docs/contracts/validate.ts` (schemas, examples, and the semantic rules of section 6) |
| Sources | `docs/05-tenant-lifecycle.md` ("Deploy pipeline", "Artifact contents", "Routing and cold start"), `docs/03-architecture.md` ("Request path"), `docs/07-app-model.md` ("Routing rules"), `docs/06-data.md` ("Migrations"), `docs/04-isolation-security.md` ("Per-tenant limits") |

An artifact is everything one deployment needs to run, frozen at build time and referenced by its content hash. Nothing in it is changed after it is written. In F1 there is no control plane: an artifact is a local directory that `renox-worker` loads from disk, and the route table is a local JSON file. The format is already the final one, so F3 stores and ships the same bytes (as a tarball of the same tree) without a format change.

## 1. Layout

```
<hash>/                              directory name = artifact hash (section 2)
├── manifest.json                    required; section 3, schemas/manifest.schema.json
├── code/                            required
│   ├── bundle.eszip                 code.format = "eszip": the only file in code/
│   └── <module>.js ...              code.format = "esm-dir": plain ES modules (F1, until the CLI's eszip step exists)
├── migrations/                      optional; absent when the app has no migrations
│   ├── checksums.json               required when migrations/ exists; schemas/migrations-checksums.schema.json
│   └── <module>/NNN_<name>.sql      forward-only SQL per module (docs/06-data.md, D17)
├── public/                          optional; absent when the app has no static files
│   ├── manifest.json                required when public/ exists; schemas/public-manifest.schema.json
│   └── <path> ...                   static files served by the gateway
├── templates/                       reserved, F2 (minijinja sources and the fragment map)
└── policies/                        reserved, F5 (Cedar policy set and schema)
```

Rules for the tree:

- Only the entries above may appear at the top level. In version 0, `templates/` and `policies/` must be **absent**: their content is defined by the phase that introduces them (F2 for templates, issue for the template pipeline; F5 for policies) and the artifact version is bumped then.
- Only regular files and directories. Symbolic links, hard links to files outside the tree, device files, sockets, and FIFOs are rejected. Empty directories carry no meaning and are ignored by the hash (they cannot be represented in it).
- `code.format = "esm-dir"`: `code/` holds `.js`, `.mjs`, and `.json` files only. `code.format = "eszip"`: `code/` holds exactly one file, `bundle.eszip` (Deno's module archive, with the V8 code cache when the CLI produces one).
- Migration files: `migrations/<module>/NNN_<name>.sql` where `<module>` matches `^[a-z][a-z0-9_]{0,31}$` (the app's own migrations use the module name `app`, matching the `app__` table prefix), `NNN` is three digits from `001` upward with no gaps per module, and `<name>` matches `^[a-z0-9_]{1,64}$`. Nothing else may appear under `migrations/` besides `checksums.json`.
- Public files: any file under `public/` except `public/manifest.json` itself is a static asset served at the URL path `/<path>`. A tenant file at `public/manifest.json` therefore cannot exist in version 0 (see "Open").

### Paths

Every path in an artifact (file paths in the tree and in every path-valued manifest field) is a **relative path** that follows these rules. The checker and the worker loader apply them before anything else is read:

| Rule | Rejected example |
| --- | --- |
| UTF-8, Unicode NFC | a path in NFD form |
| `/` is the only separator; no leading `/`, no trailing `/`, no empty segment | `/code/a.js`, `code//a.js` |
| No segment equal to `.` or `..` | `code/../../etc/passwd` |
| No backslash, no control characters (U+0000–U+001F, U+007F), no `:` | `code\a.js`, `a:b` |
| At most 512 bytes and 32 segments | — |
| No two paths that are equal after Unicode case folding | `public/Logo.png` and `public/logo.png` |

## 2. Content hash

The artifact hash is the SHA-256 of a **canonical listing** of the tree, written as 64 lower-case hex characters. The directory (in F3, the tarball and the object-storage key) is named by it.

Canonical listing:

1. Collect every regular file in the tree, recursively, including `manifest.json`. Each file is identified by its relative path from the artifact root (section 1, "Paths").
2. Sort the paths by their UTF-8 bytes, ascending (plain byte order, as `LC_ALL=C sort`; not locale order, not by Unicode code point of UTF-16).
3. For each file, in that order, write one line: the SHA-256 of the file's bytes as 64 lower-case hex characters, two spaces, the path, and a single `\n` (U+000A). No `\r`, no BOM, no trailing whitespace. The last line ends with `\n` too.
4. The artifact hash is SHA-256 over the UTF-8 bytes of the concatenated lines.

The line format is the output format of `sha256sum`, so the hash can be reproduced with standard tools:

```sh
cd <artifact-dir> && find . -type f -printf '%P\n' | LC_ALL=C sort | while IFS= read -r p; do sha256sum "$p"; done | sha256sum
```

Notes:

- File metadata (mode, owner, timestamps) is not part of the hash. The worker treats every file as read-only data; nothing in an artifact is ever executable as a process.
- The fixed 64-character prefix makes each line unambiguous, since paths cannot contain `\n` (section 1).
- The worker recomputes the hash before it loads an artifact (`docs/23-failure-modes.md`, "Artifact hash mismatch, symlink, `..` path") and refuses the artifact on mismatch. A cached artifact is re-verified when it is loaded from disk into a new isolate, not on every request.

## 3. Manifest: `manifest.json`

UTF-8 JSON, schema [`schemas/manifest.schema.json`](schemas/manifest.schema.json). It is the resolved form of `renox.toml` (and, from F4, `renox.lock`): the CLI resolves conventions (file-based routes) into explicit entries, so the worker never scans directories or guesses.

```json
{
  "artifact": { "version": 0 },
  "app": { "name": "hello", "timezone": "Asia/Dubai" },
  "code": {
    "format": "esm-dir",
    "entry": { "functions/api/hello": "functions/api/hello.js" }
  },
  "routes": [
    { "kind": "function", "method": "GET", "path": "/api/hello", "module": "functions/api/hello", "export": "GET" }
  ],
  "permissions": { "network": [], "secrets": [] }
}
```

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `artifact.version` | integer, `0` | yes | Version of this contract. A worker refuses a manifest with a version it does not know |
| `app.name` | string, `^[a-z][a-z0-9-]{0,62}$` | yes | The app name from `renox.toml`; used in `<app>.renox.app` and in logs |
| `app.timezone` | string, IANA zone name | yes | Tenant-local time zone (`docs/07-app-model.md`, scheduled jobs from F6). Must be a zone known to `Intl` |
| `code.format` | `"esm-dir"` \| `"eszip"` | yes | How `code/` is laid out (section 1) |
| `code.entry` | object: module id → module path | yes, at least one entry | One entry per route module. The path is relative to `code/` for `esm-dir`, and the specifier `file:///<path>` inside `bundle.eszip` for `eszip`. Ends in `.js` or `.mjs` |
| `routes[]` | array of route objects | yes, at least one | The deployment's route table (below) |
| `permissions.network[]` | array of allowlist entries | yes (may be empty) | Outbound hosts for `fetch`, entry syntax as in `ops.md` section 2 ("Allowlist"). Empty = no outbound network |
| `permissions.secrets[]` | array of secret names, `^[A-Z][A-Z0-9_]{0,63}$` | yes (may be empty) | Secrets the app declares. Only these are ever injected (`ops.md` section 3) |
| `limits` | object | no | Per-app overrides within the tier's bounds (below) |
| `modules` | object, must be empty | no | Reserved, F4 (installed modules with resolved versions, mounts, and approved permissions) |

No other keys are allowed at any level of the manifest (`additionalProperties: false` throughout). In particular, an unknown key under `permissions` is rejected rather than ignored, so a typo can never silently grant or drop a permission. Reserved for later versions: `templates` (F2), `pages` routes (F2), `jobs` (F6), `policies` (F5), `security` headers (F2), `signature` (F7).

### Route objects

| Field | Type | Meaning |
| --- | --- | --- |
| `kind` | `"function"` | F1 has only function routes. `"page"` (F2), `"ws"` and `"sse"` (F5) are reserved |
| `method` | `GET` \| `POST` \| `PUT` \| `PATCH` \| `DELETE` \| `OPTIONS` \| `HEAD` | The HTTP method. `HEAD` is listed only when the module exports `HEAD`; otherwise the cell serves `HEAD` from the `GET` route (`ops.md` section 6) |
| `path` | route pattern (below) | The URL path pattern |
| `module` | module id, a key of `code.entry` | The module that handles the route, e.g. `functions/api/orders` |
| `export` | same set as `method` | The named export to call. For `kind = "function"` it must equal `method` |

Route pattern syntax: `/` alone, or one or more segments `/<segment>` where a segment is

- **static**: `[A-Za-z0-9._~-]+`, matched case-sensitively against the percent-decoded path segment;
- **parameter**: `:<name>`, matches exactly one non-empty segment, e.g. `/products/:id` → `params.id = "42"`;
- **catch-all**: `*<name>`, only as the last segment, matches one or more segments, e.g. `/docs/*slug` → `params.slug = ["a", "b"]`.

`<name>` matches `^[a-z_][a-z0-9_]{0,31}$` and is unique within a pattern. No trailing `/` except the root pattern. The CLI derives patterns from file names: `[id]` → `:id`, `[...slug]` → `*slug`, `index` → the folder path.

Matching: segment by segment, a static segment beats a parameter, which beats a catch-all (`docs/07-app-model.md`, "Priority on conflict"). A request path with no matching pattern is a 404; a path that matches a pattern but not for the request's method is a 405 with an `Allow` header (`ops.md` section 6). Trailing slashes in requests are not normalised in version 0: `/api/hello/` does not match `/api/hello`.

### Limits overrides

An app may lower a limit below its tier's default, never raise it. The worker applies `min(override, tier default)`, and a value above the tier default is a validation error at deploy time (F3) and in `renox check`. The schema bounds are the paid-tier values from `docs/04-isolation-security.md`:

| Field | Unit | Schema bounds | Free / paid default |
| --- | --- | --- | --- |
| `cpu_ms` | CPU milliseconds per request | 1–500 | 50 / 500 |
| `wall_ms` | wall-clock milliseconds per request | 1,000–60,000 | 30,000 / 60,000 |
| `memory_mb` | V8 heap MB per isolate | 16–512 | 128 / 512 |
| `concurrency` | in-flight requests per deployment | 1–500 | 50 / 500 |

Behaviour at each limit is specified in `ops.md` section 10.

## 4. Migrations and public assets

### `migrations/checksums.json`

```json
{ "version": 0, "files": { "app/001_init.sql": "<sha256 hex of the file bytes>" } }
```

- Keys are paths relative to `migrations/`; values are the lower-case SHA-256 hex of the file bytes.
- The keys must be exactly the set of `.sql` files under `migrations/`, and every hash must match.
- The migration runner (`crates/renox-data`, F1) records the checksum of each applied file in `renox__migrations` and refuses to start a deployment whose already-applied file changed (`docs/06-data.md`, "Checksums are recorded so old migration files cannot be changed silently").

### `public/manifest.json`

```json
{ "version": 0, "files": { "/robots.txt": { "sha256": "<hex>", "size": 24, "content_type": "text/plain; charset=utf-8" } } }
```

- Keys are URL paths: `/` followed by the file's path relative to `public/`. They must be exactly the set of files under `public/` other than `manifest.json`.
- `sha256` is the hex hash of the bytes, `size` the byte length, `content_type` the value the gateway sends in `Content-Type`. The gateway uses `sha256` as the `ETag` and serves the files outside the tenant's isolate and quota (`docs/07-app-model.md`).

## 5. Route table

The gateway maps a request's hostname to the tenant and deployment that serve it (`docs/05-tenant-lifecycle.md`, "Routing and cold start", step 1). Schema: [`schemas/route-table.schema.json`](schemas/route-table.schema.json).

```json
{
  "version": 0,
  "entries": [
    {
      "hostname": "hello.renox.app",
      "tenant_id": "t_hello",
      "deployment_hash": "<artifact hash>",
      "status": "active",
      "updated_at": 1793318400000
    }
  ]
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `hostname` | lower-case ASCII host name (IDNA A-labels), no port, no trailing dot | The `Host` / SNI name. Matched exactly after the gateway lower-cases the request's host and removes a port and a trailing dot |
| `tenant_id` | string, `^[a-z0-9][a-z0-9_-]{0,62}$` | Opaque tenant id. From this point on the tenant identity comes only from routing, never from request input (`docs/03-architecture.md`, "Cross-cutting concerns") |
| `deployment_hash` | 64 lower-case hex characters | The artifact hash (section 2) |
| `status` | `"active"` \| `"draining"` | `active`: receives new requests. `draining`: a superseded deployment that finishes its in-flight requests and is then evicted (`docs/05-tenant-lifecycle.md`, "Deployment switch") |
| `updated_at` | integer, Unix time in milliseconds | When the entry was last written |

Rules:

- **The gateway keeps the table in memory, keyed by `hostname`.** A lookup is one hash-map read on the request path; no file or network access happens per request.
- Per hostname there is at most one `active` entry and any number of `draining` entries. New requests always go to the `active` entry. A hostname whose entries are all `draining`, or that has no entry, is answered like an unknown host: 404, and no cell is touched (`docs/23-failure-modes.md`, "Unknown `Host`").
- `(hostname, deployment_hash)` is unique.
- F1: the table is a local JSON file read at start and re-read on `SIGHUP`. A file that fails validation is refused as a whole and the previous table stays in use.
- F3: the control plane publishes changes over pub/sub, with a per-entry `version` for ordering and a periodic full resync (#97). That field is reserved here and added as a minor change in F3.
- Preview hosts (`<app>-<hash>.renox.app`) and verified custom domains are ordinary entries.

## 6. Validation rules

One set of rules, applied by `renox check` and `renox build` (P11), by the worker when it loads an artifact (P5, rules marked *load*), and from F3 by the control plane on upload (P12). In F3 the CLI and the control plane run the same code (`docs/23-failure-modes.md`, "Bundle over 20 MB, route conflict, unknown permission key"). `validate.ts` implements them for the examples in this directory.

| # | Rule | Where |
| --- | --- | --- |
| V1 | Every path follows section 1, "Paths"; no symlinks or special files; only the allowed top-level entries; `templates/` and `policies/` absent in version 0 | check, *load* |
| V2 | The directory name equals the content hash of section 2 | *load* (the CLI names the directory) |
| V3 | `manifest.json` validates against `manifest.schema.json`; `artifact.version` is known | check, *load* |
| V4 | `app.timezone` is an IANA zone known to `Intl` | check |
| V5 | **Bundle size**: the bytes under `code/` total at most 20 MiB (20,971,520 bytes) (`docs/04-isolation-security.md`, "Bundle size and versions"). The whole artifact totals at most 100 MiB and 10,000 files *proposed* (decompression-bomb caps for F3 are #95) | check, *load* |
| V6 | `code/` matches `code.format` (section 1); every `code.entry` path exists in `code/` (for `esm-dir`) | check, *load* |
| V7 | Every `routes[].module` is a key of `code.entry`; `export` equals `method` for function routes; every `code.entry` key is used by at least one route | check, *load* |
| V8 | **Route conflicts**: two routes with the same `method` whose patterns have the same shape are rejected. Shape = the sequence of segment kinds with static segments compared literally and parameter / catch-all names ignored, so `/a/:id` and `/a/:slug` conflict, while `/a/new` and `/a/:id` do not (static wins). Parameter names are unique within a pattern; a catch-all is only the last segment | check, *load* |
| V9 | **Unknown permission keys** (and unknown keys anywhere in the manifest) are rejected by the schema; network entries follow the allowlist syntax; no duplicate network entries or secret names | check, *load* |
| V10 | `limits` values are within the tier defaults of the tenant (the schema only checks the paid-tier bounds) | F3 control plane; *load* clamps |
| V11 | `migrations/`: file names as in section 1, numbering without gaps per module, `checksums.json` lists exactly the `.sql` files with matching hashes | check, *load* |
| V12 | `public/`: `manifest.json` lists exactly the other files under `public/` with matching hashes and sizes | check, *load* |
| V13 | The route table file validates against `route-table.schema.json`; at most one `active` entry per hostname; `(hostname, deployment_hash)` unique | gateway on (re)load |

Every rejection names the rule (`V1`–`V13`), the path or field, and a one-line reason; it never contains a filesystem path of the machine doing the check. In F3, a rejected upload sets the deployment state `rejected` with `RENOX_DEPLOY_REJECTED` (`errors.md`).

## 7. Worked example

[`examples/hello-artifact/`](examples/hello-artifact/) is the artifact for `examples/hello`, written by hand:

- `examples/hello-artifact/<hash>/` holds `manifest.json` and `code/functions/api/hello.js` (the transpiled `functions/api/hello.ts`). The directory name is the content hash of section 2 and `validate.ts` recomputes it.
- `examples/hello-artifact/route-table.json` routes `hello.renox.app` and its preview host to that hash.

[`examples/artifact/`](examples/artifact/) holds a second, fuller valid artifact (`notes`: a parameter route, a migration, a public file), a deliberately broken artifact, and single-file valid and invalid examples for each schema. Each invalid file states why in `$comment`, and `validate.ts` checks it fails for that reason.

## Open

1. **`public/manifest.json` name clash.** Web app manifests are commonly served at `/manifest.json`, which version 0 cannot hold. Moving the index to `public.json` at the artifact root is a breaking change; deciding before F2 (when `renox build` first ships public files) avoids a version bump later.
2. **eszip specifiers.** `code.entry` maps to `file:///<path>` inside `bundle.eszip`. The CLI's eszip step (#30) confirms that this matches what the bundler writes; if not, the mapping rule changes here before any eszip artifact exists.
3. **Whole-artifact caps.** 100 MiB and 10,000 files are proposals; #95 fixes the F3 upload caps.
4. **Trailing slashes.** Version 0 does not redirect `/x/` to `/x`. A `trailing_slash` app setting (redirect or ignore) can be added as a minor change in F2 together with pages.
5. **Signing (F7).** A `signature` over the artifact hash is reserved; it does not change the hash rule.
