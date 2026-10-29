# Contract: artifact format and route table

| | |
| --- | --- |
| Version | **1.2** (F4, #263: `entries`, the export names and `eager` flag of each code entry, for the lazy route modules of `ops.md` 1.4.0). 1.1 (#227) added modules. The major number is written into every manifest as `artifact.version`; 1.1 and 1.2 are additive and keep `artifact.version: 1` (section 8). Version 0 (F1, #15) stays valid: every consumer accepts 0 and 1 (section 8). History: "Changelog" at the bottom |
| Producers | `cli/` (P11): `renox build` writes an artifact directory; examples are also written by hand |
| Consumers | `crates/renox-cell` (P5) and `crates/renox-runtime` (P1): load and verify an artifact; `crates/renox-gateway` (P3): reads the route table, the public index, and the `security` object; `control/api` (P12, F3): validates, stores, and routes artifacts |
| Machine-readable | [`schemas/manifest.schema.json`](schemas/manifest.schema.json), [`schemas/route-table.schema.json`](schemas/route-table.schema.json), [`schemas/migrations-checksums.schema.json`](schemas/migrations-checksums.schema.json), [`schemas/public-manifest.schema.json`](schemas/public-manifest.schema.json) (JSON Schema draft 2020-12) |
| Examples | Worked example for `examples/hello` (version 0): [`examples/hello-artifact/`](examples/hello-artifact/); a version 1 artifact with pages, templates, and `security`: [`examples/artifact/shop-artifact/`](examples/artifact/shop-artifact/); a version 1.1 artifact with the `auth` module mounted at `/auth`: [`examples/artifact/modules-artifact/`](examples/artifact/modules-artifact/); more valid and invalid examples under [`examples/artifact/`](examples/artifact/) |
| Checker | `bun run docs/contracts/validate.ts` (schemas, examples, and the semantic rules of section 6) |
| Sources | [`manifest.md`](manifest.md) (the module manifest and `renox.lock`, which the `modules` field copies), `docs/10-modules.md` ("At deploy", "Overrides and migrations"), `docs/05-tenant-lifecycle.md` ("Deploy pipeline", "Artifact contents", "Routing and cold start"), `docs/03-architecture.md` ("Request path"), `docs/07-app-model.md` ("Routing rules", "Pages"), `docs/08-template-engine.md` ("Compile pipeline"), `docs/09-htmx-realtime.md` ("Fragment flow"), `docs/06-data.md` ("Migrations"), `docs/04-isolation-security.md` ("Per-tenant limits", "Web-layer protections") |

An artifact is everything one deployment needs to run, frozen at build time and referenced by its content hash. Nothing in it is changed after it is written. In F1 and F2 there is no control plane: an artifact is a local directory that `renox-worker` loads from disk, and the route table is a local JSON file. F3 stores and ships the same bytes (as a tarball of the same tree) without a format change.

## 1. Layout

```
<hash>/                              directory name = artifact hash (section 2)
├── manifest.json                    required; section 3, schemas/manifest.schema.json
├── code/                            required
│   ├── bundle.eszip                 code.format = "eszip": the only file in code/
│   ├── <module>.js ...              code.format = "esm-dir": plain ES modules
│   └── modules/<name>/...           version 1.1, esm-dir: the code of installed module <name> (section 3, "Modules")
├── migrations/                      optional; absent when the app has no migrations
│   ├── checksums.json               required when migrations/ exists; schemas/migrations-checksums.schema.json
│   └── <module>/NNN_<name>.sql      forward-only SQL per module (docs/06-data.md, D17); <module> is app or an installed module
├── public.json                      version 1: required when public/ exists; the public index (section 4)
├── public/                          optional; absent when the app has no static files
│   ├── manifest.json                version 0 only: the public index. In version 1 an ordinary file
│   └── <path> ...                   static files served by the gateway
├── templates/                       version 1, optional: compiled minijinja sources (section 3, "Templates")
│   └── <template id>.jinja          a module's ids start with modules/<name>/
├── overrides.json                   version 1.1: required when overrides/ exists; the override index (section 3, "Modules")
├── overrides/                       version 1.1, optional: tenant template overrides
│   └── <module>/<path>.html         the override source of a module template
└── policies/                        version 1.1: policies/<module>/<name>.cedar of installed modules (carried; evaluated from F5).
                                     The app's own policy set and schema stay reserved for F5
```

Rules for the tree:

- Only the entries above may appear at the top level. `policies/`, `overrides/`, and `overrides.json` must be **absent** unless the manifest lists at least one installed module (version 1.1); `policies/` then holds only `policies/<module>/<name>.cedar` files of listed modules (V18), and F5 defines the app's own policies. In version 0, `templates/` and `public.json` must be absent too.
- Only regular files and directories. Symbolic links, hard links to files outside the tree, device files, sockets, and FIFOs are rejected. Empty directories carry no meaning and are ignored by the hash (they cannot be represented in it).
- `code.format = "esm-dir"`: `code/` holds `.js`, `.mjs`, and `.json` files only. `code.format = "eszip"`: `code/` holds exactly one file, `bundle.eszip` (Deno's module archive, with the V8 code cache when the CLI produces one).
- Migration files: `migrations/<module>/NNN_<name>.sql` where `<module>` matches `^[a-z][a-z0-9_]{0,31}$` (the app's own migrations use the module name `app`, matching the `app__` table prefix), `NNN` is three digits from `001` upward with no gaps per module, and `<name>` matches `^[a-z0-9_]{1,64}$`. Nothing else may appear under `migrations/` besides `checksums.json`.
- Public files, version 1: every file under `public/` is a static asset served at the URL path `/<path>`, including `public/manifest.json` (a web app manifest served at `/manifest.json`). The index lives outside `public/`, in `public.json`.
- Public files, version 0: every file under `public/` except `public/manifest.json` itself is a static asset; `public/manifest.json` is the index.
- Template files, version 1: `templates/<template id>.jinja`, UTF-8 minijinja source written by the CLI's transpiler (`docs/08-template-engine.md`, "Compile pipeline"). Nothing else may appear under `templates/`.

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
- Template files are covered by the hash like every other file, so the manifest carries no per-template checksum.

## 3. Manifest: `manifest.json`

UTF-8 JSON, schema [`schemas/manifest.schema.json`](schemas/manifest.schema.json). It is the resolved form of `renox.toml` (and, from F4, `renox.lock`): the CLI resolves conventions (file-based routes, `.ts`/`.html` pairs, fragments) into explicit entries, so the worker never scans directories or guesses.

Version 1, abridged from [`examples/artifact/shop-artifact/`](examples/artifact/shop-artifact/):

```json
{
  "artifact": { "version": 1 },
  "app": { "name": "shop", "timezone": "Asia/Dubai" },
  "code": {
    "format": "esm-dir",
    "entry": {
      "pages/products/[id]": "pages/products/[id].js",
      "functions/api/health": "functions/api/health.js"
    }
  },
  "routes": [
    { "kind": "page", "path": "/", "template": "pages/index" },
    { "kind": "page", "path": "/products/:id", "module": "pages/products/[id]", "load": true, "actions": ["addToCart"], "template": "pages/products/[id]" },
    { "kind": "function", "method": "GET", "path": "/api/health", "module": "functions/api/health", "export": "GET" }
  ],
  "templates": {
    "pages/_layouts/main": { "kind": "layout" },
    "pages/index": { "kind": "page", "fragments": {} },
    "pages/products/[id]": { "kind": "page", "fragments": { "product": { "target": "product" }, "cart_badge": { "target": "cart-badge" } } }
  },
  "permissions": { "network": [], "secrets": [] },
  "security": { "csp": { "script_src": ["https://js.stripe.com"] } }
}
```

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `artifact.version` | integer, `0` or `1` | yes | Version of this contract. A consumer refuses a manifest with a version it does not know |
| `app.name` | string, `^[a-z][a-z0-9-]{0,62}$` | yes | The app name from `renox.toml`; used in `<app>.renox.app` and in logs |
| `app.timezone` | string, IANA zone name | yes | Tenant-local time zone (`docs/07-app-model.md`, scheduled jobs from F6). Must be a zone known to `Intl` |
| `code.format` | `"esm-dir"` \| `"eszip"` | yes | How `code/` is laid out (section 1) |
| `code.entry` | object: module id → module path | yes, at least one entry | One entry per route module. The path is relative to `code/` for `esm-dir`, and the specifier `file:///<path>` inside `bundle.eszip` for `eszip`. Ends in `.js` or `.mjs`. A module id is the source path without extension: `functions/...` for function routes, `pages/...` for page routes (version 1) |
| `entries` | object: module id → `{ exports, eager? }` | version 1.2, optional | What `renox build` recorded for each `code.entry` module: its static export names and whether the runtime evaluates it at isolate creation (below, "Entries"). Absent: every entry is eager, as in 1.1 |
| `routes[]` | array of route objects | yes, at least one | The deployment's route table (below) |
| `templates` | object: template id → template entry | version 1, optional | Every template in `templates/` (below). Absent or empty when the app has no templates. Not allowed in version 0 |
| `permissions.network[]` | array of allowlist entries | yes (may be empty) | Outbound hosts for `fetch`, entry syntax as in `ops.md` section 2 ("Allowlist"). Empty = no outbound network |
| `permissions.secrets[]` | array of secret names, `^[A-Z][A-Z0-9_]{0,63}$` | yes (may be empty) | Secrets the app declares. Only these are ever injected (`ops.md` section 3) |
| `limits` | object | no | Per-app overrides within the tier's bounds (below) |
| `security` | object | version 1, optional | Web-layer settings from `renox.toml [security]` (below). Absent = every default of `docs/04-isolation-security.md`. Not allowed in version 0 |
| `modules` | version 1.1: array of module entries; versions 0 and 1: an empty object | no | The installed modules, copied from `renox.lock` in its order (section 3, "Modules"). Absent or `{}`: no modules. Not allowed as an array in version 0 |
| `slots` | version 1.1: object, slot name → fillers | no | The slot registry (section 3, "Modules"). Absent: no slot is filled |

No other keys are allowed at any level of the manifest (`additionalProperties: false` throughout). In particular, an unknown key under `permissions` or `security` is rejected rather than ignored, so a typo can never silently grant or drop a permission or a protection. Reserved for later versions: `jobs` (F6), `policies` (F5), `signature` (F7).

### Route objects

Each route object has a `kind`. Version 0 has only `"function"`; version 1 adds `"page"`. `"ws"` and `"sse"` are reserved (F5).

**Function routes** (`functions/**`, versions 0 and 1):

| Field | Type | Meaning |
| --- | --- | --- |
| `kind` | `"function"` | |
| `method` | `GET` \| `POST` \| `PUT` \| `PATCH` \| `DELETE` \| `OPTIONS` \| `HEAD` | The HTTP method. `HEAD` is listed only when the module exports `HEAD`; otherwise the cell serves `HEAD` from the `GET` route (`ops.md` section 6) |
| `path` | route pattern (below) | The URL path pattern |
| `module` | module id under `functions/`, a key of `code.entry` | The module that handles the route, e.g. `functions/api/orders` |
| `export` | same set as `method` | The named export to call. It must equal `method` |

**Page routes** (`pages/**`, version 1). One object per page path, built from the `.ts`/`.html` pair rules of `docs/07-app-model.md` ("Pages"):

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `kind` | `"page"` | yes | |
| `path` | route pattern (below) | yes | The URL path pattern, derived from the file path like function routes |
| `module` | module id under `pages/`, a key of `code.entry` | when the page has a `.ts` file | The page module. Absent for an `.html`-only page |
| `load` | boolean | no, default `false` | The module exports `load`. Requires `module` |
| `actions` | array of action names, `^[A-Za-z_][A-Za-z0-9_]{0,63}$`, unique, at most 64 | no, default `[]` | Keys of the module's `export const actions`. Requires `module` |
| `template` | template id, a key of `templates` with `kind: "page"` | when the page has an `.html` file | The page template. Absent for a `.ts`-only page |

The three pair rules map to these combinations, and V15 rejects any other:

| Files present | `module` | `load` | `template` | Behaviour |
| --- | --- | --- | --- | --- |
| `.html` only | absent | `false` | present | Template rendered with `{}` as data |
| `.ts` only | present | `true` | absent | `load()` must return a `Response`; an object is 500 `RENOX_INTERNAL` (logged with the route) |
| `.ts` + `.html` | present | `true` or `false` | present | `load()` returns an object → template data, or a `Response` → sent as is. Without `load`, the template gets `{}` |

Methods of a page route:

- `GET` runs `load` (if any), then renders. `HEAD` is the same with the body dropped.
- `POST` runs an action and exists only when `actions` is non-empty. The action is named by the query string: `POST /products/42?/addToCart` runs `addToCart` (`docs/07-app-model.md`). The query component must start with `/<name>`; anything after a following `&` is ordinary query data. A `POST` with no `?/<name>` runs the action named `default` if the page declares one. An unknown or missing action name is 404 with no tenant code run.
- Any other method is 405 with `Allow: GET, HEAD` (plus `POST` when the page has actions).
- What an action returns (object, `Response`, `{ fragments }`) and what `load` and actions receive is `ops.md` section 14 ("Pages").

Route pattern syntax: `/` alone, or one or more segments `/<segment>` where a segment is

- **static**: `[A-Za-z0-9._~-]+`, matched case-sensitively against the percent-decoded path segment;
- **parameter**: `:<name>`, matches exactly one non-empty segment, e.g. `/products/:id` → `params.id = "42"`;
- **catch-all**: `*<name>`, only as the last segment, matches one or more segments, e.g. `/docs/*slug` → `params.slug = ["a", "b"]`.

`<name>` matches `^[a-z_][a-z0-9_]{0,31}$` and is unique within a pattern. No trailing `/` except the root pattern. The CLI derives patterns from file names: `[id]` → `:id`, `[...slug]` → `*slug`, `index` → the folder path. Files whose name starts with `_` (`_layouts/`, `_404`, `_error`) are not routes.

Matching: segment by segment, a static segment beats a parameter, which beats a catch-all (`docs/07-app-model.md`, "Priority on conflict"). Page and function routes share one matcher: a page route takes part in matching for `GET` and `HEAD`, and for `POST` when it has actions. A request path with no matching pattern is a 404; a path that matches a pattern but not for the request's method is a 405 with an `Allow` header (`ops.md` section 6).

**Trailing slashes** (Open 4 of version 0, settled here):

- Version 1: a `GET` or `HEAD` request whose path ends in `/` (other than `/` itself), that matches no route, and whose path without the trailing `/` matches a **page** route, is answered with `308 Permanent Redirect` to that path, query string kept. Nothing else is normalised: function routes are never redirected (`/api/hello/` is a 404, as clients of an API should not depend on redirects), and a `POST` is never redirected (a redirect would lose the body on some clients).
- Version 0: no normalisation at all. `/api/hello/` does not match `/api/hello`.
- No app setting. A setting can be added as a minor change if a tenant needs the opposite.

### Templates (version 1)

`manifest.templates` lists every file under `templates/`. The key is the **template id**: the source path without extension relative to the app root, e.g. `pages/products/[id]`, `pages/_layouts/main`, `partials/product-card`. It matches `^(pages|partials)(/[A-Za-z0-9_.\[\]-]+)+$` and the file is `templates/<id>.jinja`.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `kind` | `"page"` \| `"layout"` \| `"partial"` \| `"error"` \| `"not_found"` | yes | `page`: the template of a page route. `layout`: under `pages/_layouts/`. `partial`: under `partials/`, for `ctx.render` (F2) and realtime payloads. `error`: `pages/_error`. `not_found`: `pages/_404` |
| `fragments` | object: fragment name → fragment entry | `kind: "page"` only, required there (may be empty) | **The fragment map** of the page (below) |

Fragment map (`docs/08-template-engine.md`, "Compile pipeline" step 5; `docs/09-htmx-realtime.md`, "Fragment flow"):

- A fragment name is the value of `r-fragment` and is also the minijinja block name it compiles to. It matches `^[a-z_][a-z0-9_]{0,63}$`.
- The map of a page lists **every** fragment reachable when rendering that page, including those defined in its layouts and in components inlined into it. The cell finds a fragment with one map read, without walking the template chain.
- A fragment entry has one field, `target`: the `id` attribute of the element that carries `r-fragment`, or `null` when that element has no static `id`. It matches `^[A-Za-z][A-Za-z0-9_:.-]{0,127}$`. Targets are unique within a page's map (V15).

Fragment selection on a page `GET`:

1. A request with `HX-Request: true` and an `HX-Target` equal to the `target` of a fragment renders **only that block** (no layout). The loader is told the fragment name (`ops.md` section 14, `LoaderContext.fragment`).
2. Any other request renders the full page, including an htmx request whose `HX-Target` matches no fragment (the dev overlay warns about it).
3. Page responses carry `Vary: HX-Request, HX-Target`.

Fragment names in an action's `{ fragments: [...] }` result must be keys of the page's map; the extra blocks are rendered and marked `hx-swap-oob="true"` (`docs/09-htmx-realtime.md`). An unknown name is 500 `RENOX_INTERNAL`, logged with the name.

Error and 404 templates (`kind: "error"`, `"not_found"`) are rendered as in `errors.md` section 1, "Page (HTML) routes".

### Security (version 1)

`security` is the resolved `renox.toml [security]` table (`docs/04-isolation-security.md`, "Web-layer protections"). Every sub-object is optional; an absent field takes the default in the right-hand column. The gateway (CSP, CORS, headers) and the cell (rate-limit buckets keyed by the matched route, #47) apply it. `renox check --security` prints the effective result.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `csp.script_src`, `csp.style_src`, `csp.img_src`, `csp.connect_src`, `csp.frame_src`, `csp.font_src` | arrays of CSP source expressions, at most 32 each | `[]` | Sources **added** to the platform's strict CSP (`'self'` plus the per-request nonce for scripts and styles). A source is an `https://` origin, optionally with a `*.` host wildcard and a path (`https://js.stripe.com`, `https://*.tabby.ai`), or one of `data:`, `blob:`. `'unsafe-inline'` and `'unsafe-eval'` are allowed in `script_src` and `style_src` only with `allow_unsafe` (V16) |
| `csp.allow_unsafe` | boolean | `false` | Explicit opt-in to `'unsafe-inline'` / `'unsafe-eval'`; flagged in the dashboard |
| `csp.report_only` | boolean | `false` | Send `Content-Security-Policy-Report-Only` instead of enforcing. Reports always go to the client-events endpoint (`client-events.md`) |
| `cors.origins` | array of origins `http(s)://host[:port]`, at most 32 | `[]` (closed: only the app's own origins) | Origins allowed by CORS. No `*` |
| `cors.methods` | array of methods | `["GET", "HEAD", "POST"]` | `Access-Control-Allow-Methods` |
| `cors.headers` | array of header names, lower case | `[]` | `Access-Control-Allow-Headers` |
| `cors.credentials` | boolean | `false` | `Access-Control-Allow-Credentials`. Requires a non-empty `origins` (V16), and is the only case in which the session cookie may be `SameSite=None` |
| `cors.max_age_s` | integer, 0–86,400 | `600` | `Access-Control-Max-Age` |
| `headers.referrer_policy` | one of the standard `Referrer-Policy` values | `"strict-origin-when-cross-origin"` | |
| `headers.permissions_allow` | array of Permissions-Policy feature names, e.g. `camera` | `[]` | Features allowed for `self`. Every other feature in the platform's default list stays denied |
| `ratelimit[]` | array of bucket objects, at most 64 | `[]` | Per-route buckets, in addition to the platform's per-IP limit. Object: `method`, `path` (a pattern equal to one in `routes[]`, V16), `requests` (1–10,000), `window_s` (1–3,600), `key` (`"ip"`; `"user"` is reserved for F4, with the auth module) |

Not configurable on purpose: HSTS (always on for `*.renox.app`), `frame-ancestors 'none'` and `X-Frame-Options: DENY` (the per-page `export const frame` override is Open 6), `X-Content-Type-Options`, `Cross-Origin-Opener-Policy`, `object-src 'none'`, and the cookie defaults.

### Modules (version 1.1)

An app with installed modules (`docs/10-modules.md`; [`manifest.md`](manifest.md)) is still one artifact: `renox build` reads `renox.lock`, puts each module's code, templates, migrations, and policies next to the app's under the module's name, merges its routes under its `mount`, and records the lock in `modules`. Nothing is resolved at load; the worker reads the manifest as it reads an app's. Abridged from [`examples/artifact/modules-artifact/`](examples/artifact/modules-artifact/):

```json
{
  "artifact": { "version": 1 },
  "code": { "format": "esm-dir", "entry": {
    "functions/api/health": "functions/api/health.js",
    "modules/auth/pages/login": "modules/auth/pages/login.js",
    "modules/auth/services": "modules/auth/services.js",
    "modules/auth/hooks": "modules/auth/hooks.js"
  } },
  "routes": [
    { "kind": "page", "path": "/", "template": "pages/index" },
    { "kind": "page", "path": "/auth/login", "module": "modules/auth/pages/login", "load": true, "actions": ["default"], "template": "modules/auth/pages/login" }
  ],
  "modules": [
    { "name": "auth", "version": "1.0.0", "hash": "<module tree hash>", "source": "path:modules/auth", "mount": "/auth",
      "isolation": "shared", "dependencies": [], "config": { "registration": "invite" },
      "permissions": { "tables": "auth__*", "network": [], "secrets": [], "slots": ["app.header"], "hooks": [] },
      "approved": { "tables": "auth__*", "network": [], "secrets": [], "slots": ["app.header"], "hooks": [] },
      "exports": { "services": ["currentUser"], "events": { "auth.user_registered": { "type": "object" } }, "hooks": ["auth.after_login"], "views": ["auth__public_users_v1"] } }
  ],
  "slots": { "app.header": [{ "module": "auth", "template": "modules/auth/partials/account-menu" }] }
}
```

**The `modules` field.** One entry per installed module, **in the order of `renox.lock`**: topological, every module after its dependencies. This order is the **migration order** (the app's own migrations run last) and the order in which the bootstrap loads the modules. An entry:

| Field | From | Meaning |
| --- | --- | --- |
| `name`, `version`, `hash`, `source`, `mount`, `isolation`, `dependencies`, `config` | the lock entry (`manifest.md` section 5) | As there. `hash` is the module tree's hash; `config` the resolved config the module reads as `ctx.config` |
| `approved` | the lock entry's `approved` | What the tenant approved |
| `permissions` | the manifest's `[permissions]` at build time | What the runtime enforces for the module: its authorizer prefix, `fetch` allowlist, secrets, slots, and hook fills. Never more than `approved` (V22); `renox build` refuses to build when they differ at all (`manifest.md` MF12), so in a CLI-built artifact they are equal |
| `exports` | the manifest's `[exports]` | `services` (names), `events` (name → payload schema), `hooks` (names), `views` (names): what the broker checks calls, hook runs, and emits against |

**Ids and layout.** Every id of a module starts with `modules/<name>/` and is otherwise the id the module would have as an app:

| What | App | Module `auth` |
| --- | --- | --- |
| Route module (`code.entry` key) | `pages/…`, `functions/…` | `modules/auth/pages/…`, `modules/auth/functions/…` |
| Services and hooks (`code.entry` keys, used by no route) | — | `modules/auth/services`, `modules/auth/hooks` |
| Code path (`esm-dir`) | `code/<path>.js`, never under `code/modules/` | `code/modules/auth/<path>.js` |
| Template id and file | `pages/…`, `partials/…` → `templates/<id>.jinja` | `modules/auth/pages/…`, `modules/auth/partials/…` → `templates/modules/auth/….jinja` |
| Migrations | `migrations/app/` | `migrations/auth/` (V19) |
| Policies | reserved, F5 | `policies/auth/<name>.cedar` |

A module's template `kind` follows from the id without its prefix (V14), so `modules/auth/pages/_layouts/main` is a layout.

**Route merge.** A module's routes are in `routes[]` like the app's, with their `path` already prefixed by the module's `mount` (`/login` of `auth` mounted at `/auth` is `/auth/login`; with `mount = "/"` the path is unchanged). The owner of a route is the module of its `module` id, or of its `template` id for an `.html`-only page; anything else is the app's. A route path must be its owner's mount or under it (V21). Routes are matched exactly as in "Route objects": one matcher for the app and every module, static before parameter before catch-all. Two routes of different owners that answer the same method with the same shape are a **conflict after mounting**, rejected at build and at load (V21, V8's rule); so are two modules on overlapping mounts that define the same path.

**Slots.** `slots` maps a slot name to its fillers, in render order: ascending `priority` from the filler's manifest (default 100), then module name. A filler is `{ module, template, requires? }`: `template` is a `partial` of that module, and `requires` the action from its manifest, carried for F5 (`manifest.md`, `[[slots]]`). The cell renders `<r-slot name>` by rendering each filler's partial in that order, with the request's template data (section 14 of `ops.md`, "Rendering"); a slot with no entry renders nothing.

**Overrides.** A tenant may override a module's templates, never its code (`docs/10-modules.md`, "Overrides and migrations"). The build compiles the override instead of the module's original into the module's template id, and carries the override source and an index so that an upgrade can show what changed:

```json
{ "version": 0, "files": { "auth/pages/login.html": { "template": "modules/auth/pages/login", "original_sha256": "<sha256 of modules/auth/pages/login.html at the installed version>" } } }
```

- `overrides/<module>/<path>.html` is the tenant's override source; `<path>` is under `pages/` or `partials/` of the module, so only templates can be overridden. `overrides.json` at the root (schema: `manifest.schema.json` `$defs/overridesIndex`) lists exactly those files (V20).
- `template` is the module template id the override replaces, `modules/<module>/<path without .html>`; it must be in `manifest.templates`, and `templates/<id>.jinja` is compiled from the override.
- `original_sha256` is the SHA-256 of the module's original file **at the installed version**. On the next build against a new module version, the CLI compares it with the new original: a difference is the "Template override drifted" case of `docs/23-failure-modes.md`. The build goes on with the override and warns with the diff; the dashboard flags the override by comparing the active deployment's `overrides.json` with the new one.


### Entries (version 1.2)

`ops.md` 1.4.0 lets the runtime evaluate a route module on its first request instead of at isolate creation, so an isolate does not pay for code only one route needs (a payment SDK in `checkout`, #157). The fail-closed check that every route's export is a function then cannot run at isolate creation for that module. `entries` moves that check before any isolate:

```json
"entries": {
  "functions/api/checkout": { "exports": ["POST"], "eager": false },
  "pages/_error": { "exports": ["load"] },
  "pages/products/[id]": { "exports": ["actions", "load"], "eager": false },
  "modules/auth/services": { "exports": ["currentUser", "login"] }
}
```

- **Keys** are exactly the keys of `code.entry` (V23).
- **`exports`** lists the module's static export names, sorted, as the bundler saw them (`export function POST`, `export const actions`, `export { x as y }` gives `y`; `export *` is resolved). Every route's handler must be in its module's list: `export` for a function route, `load` for a page route with `load: true`, and `actions` for one with actions. A module's `services` entry lists every name of its `exports.services` (V23).
- **The worker re-checks at prepare,** before any isolate: it reads each module's static exports from the code (`code/` or `bundle.eszip`) and refuses the artifact when they differ from the recorded list. A tampered or stale `entries` cannot hide a missing export until a request finds it.
- **`eager`** defaults to `true`. `false` lets the runtime evaluate the module on its first request, once per isolate (`ops.md` 1.4.0, section 11, step 4). A module's `services` and `hooks` entries must stay eager (V23): the broker needs them before any request. `renox build` writes `eager: false` for route modules and keeps `pages/_error` eager (`ops.md` Open 11).

### Limits overrides

An app may lower a limit below its tier's default, never raise it. The worker applies `min(override, tier default)`, and a value above the tier default is a validation error at deploy time (F3) and in `renox check`. The schema bounds are the paid-tier values from `docs/04-isolation-security.md`:

| Field | Unit | Schema bounds | Free / paid default |
| --- | --- | --- | --- |
| `cpu_ms` | CPU milliseconds per request | 1–500 | 50 / 500 |
| `wall_ms` | wall-clock milliseconds per request | 1,000–60,000 | 30,000 / 60,000 |
| `memory_mb` | V8 heap MB per isolate | 16–512 | 128 / 512 |
| `concurrency` | in-flight requests per deployment | 1–500 | 50 / 500 |

Behaviour at each limit is specified in `ops.md` section 10. Render limits are not overridable per app; they are the platform's (`docs/08-template-engine.md`, "Optimizations and limits").

## 4. Migrations and public assets

### `migrations/checksums.json`

```json
{ "version": 0, "files": { "app/001_init.sql": "<sha256 hex of the file bytes>" } }
```

- Keys are paths relative to `migrations/`; values are the lower-case SHA-256 hex of the file bytes.
- The keys must be exactly the set of `.sql` files under `migrations/`, and every hash must match.
- The migration runner (`crates/renox-data`, F1) records the checksum of each applied file in `renox__migrations` and refuses to start a deployment whose already-applied file changed (`docs/06-data.md`, "Checksums are recorded so old migration files cannot be changed silently").

### The public index: `public.json` (version 1) or `public/manifest.json` (version 0)

```json
{ "version": 0, "files": { "/robots.txt": { "sha256": "<hex>", "size": 24, "content_type": "text/plain; charset=utf-8" } } }
```

- Location: version 1 artifacts carry it at the root as `public.json`; version 0 artifacts carry it as `public/manifest.json`. The gateway picks the location from `artifact.version` in `manifest.json`, which it reads once per hash. The file format is the same in both, and its own `version` field stays `0`: it versions the index format, not the artifact.
- Keys are URL paths: `/` followed by the file's path relative to `public/`. They must be exactly the set of served files: every file under `public/` in version 1, every file but `public/manifest.json` in version 0.
- `sha256` is the hex hash of the bytes, `size` the byte length, `content_type` the value the gateway sends in `Content-Type`. The gateway uses `sha256` as the `ETag` and serves the files outside the tenant's isolate and quota (`docs/07-app-model.md`).

## 5. Route table

The gateway maps a request's hostname to the tenant and deployment that serve it (`docs/05-tenant-lifecycle.md`, "Routing and cold start", step 1). Schema: [`schemas/route-table.schema.json`](schemas/route-table.schema.json). Unchanged in version 1.

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
- When the TLS SNI name and the `Host` (or `:authority`) both resolve, to **different tenants**, the request is refused with 421 `RENOX_HOST_MISMATCH` before routing (`errors.md`; `docs/24-threat-model.md`, "Host/SNI confusion").
- `(hostname, deployment_hash)` is unique.
- F1/F2: the table is a local JSON file read at start and re-read on `SIGHUP`. A file that fails validation is refused as a whole and the previous table stays in use.
- F3: the control plane publishes changes over pub/sub, with a per-entry `version` for ordering and a periodic full resync (#97). That field is reserved here and added as a minor change in F3.
- Preview hosts (`<app>-<hash>.renox.app`) and verified custom domains are ordinary entries.

## 6. Validation rules

One set of rules, applied by `renox check` and `renox build` (P11), by the worker when it loads an artifact (P5, rules marked *load*), and from F3 by the control plane on upload (P12). In F3 the CLI and the control plane run the same code (`docs/23-failure-modes.md`, "Bundle over 20 MB, route conflict, unknown permission key"). `validate.ts` implements them for the examples in this directory.

| # | Rule | Where |
| --- | --- | --- |
| V1 | Every path follows section 1, "Paths"; no symlinks or special files; only the allowed top-level entries for the manifest's version (`templates/` and `public.json` absent in version 0; `policies/`, `overrides/`, and `overrides.json` absent unless `modules` lists a module, version 1.1) | check, *load* |
| V2 | The directory name equals the content hash of section 2 | *load* (the CLI names the directory) |
| V3 | `manifest.json` validates against `manifest.schema.json`; `artifact.version` is known. The schema also rejects version 1 fields (`templates`, `security`, page routes) in a version 0 manifest | check, *load* |
| V4 | `app.timezone` is an IANA zone known to `Intl` | check |
| V5 | **Bundle size**: the bytes under `code/` total at most 20 MiB (20,971,520 bytes) (`docs/04-isolation-security.md`, "Bundle size and versions"). The whole artifact totals at most 100 MiB and 10,000 files *proposed* (decompression-bomb caps for F3 are #95) | check, *load* |
| V6 | `code/` matches `code.format` (section 1); every `code.entry` path exists in `code/` (for `esm-dir`) | check, *load* |
| V7 | Every `routes[].module` is a key of `code.entry`, under `functions/` for function routes and under `pages/` for page routes (after a `modules/<name>/` prefix, version 1.1); `export` equals `method` for function routes; every `code.entry` key is used by at least one route, except the `modules/<name>/services` and `modules/<name>/hooks` entries | check, *load* |
| V8 | **Route conflicts**: two routes that answer the same method with patterns of the same shape are rejected. Shape = the sequence of segment kinds with static segments compared literally and parameter / catch-all names ignored, so `/a/:id` and `/a/:slug` conflict, while `/a/new` and `/a/:id` do not (static wins). A page route answers `GET` and `HEAD`, and `POST` when it has actions, so it conflicts with a function route of the same shape for any of those methods, and with any other page route of the same shape. Parameter names are unique within a pattern; a catch-all is only the last segment | check, *load* |
| V9 | **Unknown permission keys** (and unknown keys anywhere in the manifest) are rejected by the schema; network entries follow the allowlist syntax; no duplicate network entries or secret names | check, *load* |
| V10 | `limits` values are within the tier defaults of the tenant (the schema only checks the paid-tier bounds) | F3 control plane; *load* clamps |
| V11 | `migrations/`: file names as in section 1, numbering without gaps per module, `checksums.json` lists exactly the `.sql` files with matching hashes | check, *load* |
| V12 | The public index (`public.json` in version 1, `public/manifest.json` in version 0) exists when `public/` does, and lists exactly the served files under `public/` with matching hashes and sizes | check, *load* |
| V13 | The route table file validates against `route-table.schema.json`; at most one `active` entry per hostname; `(hostname, deployment_hash)` unique | gateway on (re)load |
| V14 | **Templates** (version 1): `templates/` holds exactly the files `templates/<id>.jinja` for the keys of `manifest.templates`; each file is valid UTF-8. A template's `kind` matches its id (read without a `modules/<name>/` prefix, version 1.1): `layout` under `pages/_layouts/`, `partial` under `partials/`, `error` is `pages/_error`, `not_found` is `pages/_404`, `page` any other id under `pages/` whose last segment does not start with `_` | check, *load* |
| V15 | **Page routes** (version 1): the field combination is one of the three rows of section 3 ("Page routes"); `template` is a key of `manifest.templates` with `kind: "page"`; action names are unique; fragment targets are unique within each page's map; every `kind: "page"` template is used by exactly one page route | check, *load* |
| V16 | **Security** (version 1): `'unsafe-inline'` / `'unsafe-eval'` appear only with `csp.allow_unsafe: true`; `cors.credentials: true` requires a non-empty `cors.origins`; every `ratelimit[]` entry names a `(method, path)` some route answers (page routes answer `GET`, `HEAD`, and `POST` with actions); no two `ratelimit[]` entries share `(method, path, key)` | check, *load* |

| V17 | **Module entries** (version 1.1): names are unique and are module names (`manifest.md` MF1: no `__`, no trailing `_`, not `app` or `renox`); every module comes after each of its `dependencies` (the lock's topological order); `permissions.tables` and `approved.tables` are exactly `"<name>__*"` and every secret starts with `<NAME>_` (`manifest.md` MF4). With the lock at hand (`renox build`), every entry equals its `renox.lock` entry (`manifest.md` MF12) | check, *load*; the lock match in `renox build` |
| V18 | **Ownership** (version 1.1): every `code.entry` id, template id, `slots` filler, and route under `modules/<name>/` belongs to a listed module, and its code path is under `code/modules/<name>/` (an app entry is never under `code/modules/`); a module that exports services has its `modules/<name>/services` entry; a filler's template is a `partial` of its own module; every `policies/` file is `policies/<module>/<name>.cedar` of a listed module | check, *load* |
| V19 | **Module migrations** (version 1.1): every listed module with `permissions.tables` has migrations under `migrations/<name>/`; a `migrations/<name>/` other than `app` belongs to a listed module with tables | check, *load* |
| V20 | **Overrides** (version 1.1): `overrides.json` exists when `overrides/` does and lists exactly its files; each is `<module>/(pages\|partials)/….html` of a listed module (templates only: logic cannot be overridden) and names the template `modules/<module>/<path without .html>`, which is a key of `manifest.templates`. With the module tree at hand (`renox build`), each `original_sha256` equals the original file at the installed version | check, *load*; the original hash in `renox build` |
| V21 | **Routes after mounting** (version 1.1): a module's route path is its `mount` or under it; no two routes of different owners (the app, a module) answer the same method with the same shape (V8's rule, reported as V21 when the owners differ) | check, *load* |
| V22 | **Approved permissions** (version 1.1): each module's `permissions` are a subset of its `approved` (tables equal when present; `network`, `secrets`, `slots`, `hooks` contained); a `slots` filler fills only a slot in its module's `permissions.slots` | check, *load* |
| V23 | **Entries** (version 1.2): when `entries` is present, `artifact.version` is 1; its keys are exactly the keys of `code.entry`; every route's handler (`export` of a function route, `load` and `actions` of a page route that has them) is in its module's `exports`; every name of a module's `exports.services` is in the exports of its `modules/<name>/services` entry; the `services` and `hooks` entries of a module are not `eager: false`. At prepare, the recorded exports equal the module's static exports | check, *load* |

Every rejection names the rule (`V1`–`V22`), the path or field, and a one-line reason; it never contains a filesystem path of the machine doing the check. In F3, a rejected upload sets the deployment state `rejected` with `RENOX_DEPLOY_REJECTED` (`errors.md`).

## 7. Worked examples

[`examples/hello-artifact/`](examples/hello-artifact/) is the version 0 artifact for `examples/hello`, written by hand:

- `examples/hello-artifact/<hash>/` holds `manifest.json` and `code/functions/api/hello.js` (the transpiled `functions/api/hello.ts`). The directory name is the content hash of section 2 and `validate.ts` recomputes it.
- `examples/hello-artifact/route-table.json` routes `hello.renox.app` and its preview host to that hash.

[`examples/artifact/shop-artifact/`](examples/artifact/shop-artifact/) is a version 1 artifact, written by hand: the three page shapes (`.html` only, `.ts` + `.html` with `load` and actions, `.ts` only), a function route, a layout, `_error` and `_404` templates, a fragment map with a fragment defined in the layout, a tenant `public/manifest.json` served as a static file next to the root `public.json`, and a `security` object.

[`examples/artifact/modules-artifact/`](examples/artifact/modules-artifact/) is a version 1.1 artifact, written by hand: the app's own page and function routes and the `auth` module mounted at `/auth` (a page with a loader and an action, a function route, its `services` and `hooks` entries), the module's migrations after the app's, a tenant override of `auth`'s login template with `overrides.json`, a policy file, and the slot `app.header` filled by an `auth` partial. Its `modules` entry is the `auth` lock entry of [`manifest.md`](manifest.md)'s `projects/shop.valid` example. `broken-module-migrations-artifact` (V19) and `broken-override-artifact` (V20) are the same artifact with one thing broken.

[`examples/artifact/`](examples/artifact/) also holds a version 0 artifact (`notes`: a parameter route, a migration, a public file), two deliberately broken artifacts (`broken-artifact`: a file changed after hashing; `broken-templates-artifact`: a template file not in the manifest), and single-file valid and invalid examples for each schema. Each invalid file states why in `$comment`, and `validate.ts` checks it fails for that reason.

## 8. Versions and consumers

- Every consumer accepts **both** version 0 and version 1 manifests: `crates/renox-runtime` (`manifest.rs`), `crates/renox-cell` (`artifact.rs`), and `crates/renox-gateway` (public index location). A version 0 artifact keeps its version 0 behaviour (no page routes, no trailing-slash redirect, index in `public/manifest.json`); nothing is upgraded in place, because the hash fixes the bytes.
- The consumers are changed by the issues that implement version 1 (pages: #40, #41; templates: #38, #43; security: #47; error pages: #93). Until they land, a consumer that refuses `artifact.version: 1` with V3 is correct, not a bug.
- `renox build` writes version 1 from F2 on, also for apps with no pages, so the public index is always `public.json` in new artifacts.
- **Version 1.1** (#227) keeps `artifact.version: 1`: an artifact without modules is byte-for-byte a version 1 artifact, and one with modules carries the new `modules` array, `slots`, and top-level entries. The consumers learn them in #232 (`crates/renox-cell` loads module code, migrations in `modules` order, the slot registry, and the module list for the bootstrap) and #235 (the CLI writes them). Until then a consumer that refuses a manifest whose `modules` is a non-empty array, with V3, is correct, not a bug. `packages/artifact-validate`, and so `control/api` uploads, accept 1.1 from this version on.
- **Version 1.2** (#263) keeps `artifact.version: 1`: `entries` is optional, and without it everything behaves as in 1.1. The consumers learn it in #265: the CLI writes it, the cell checks it at prepare, and the runtime evaluates `eager: false` entries on first use. Until then a consumer that ignores `entries` and evaluates every entry eagerly is correct, not a bug: that is the 1.1 behaviour.
- A future breaking change bumps the version again. A field added under an existing object, with a default that keeps old behaviour, is a minor change and does not bump the version.

## Open

1. **eszip specifiers.** `code.entry` maps to `file:///<path>` inside `bundle.eszip`. The CLI's eszip step (#30) confirms that this matches what the bundler writes; if not, the mapping rule changes here before any eszip artifact exists.
2. **Whole-artifact caps.** 100 MiB and 10,000 files are proposals; #95 fixes the F3 upload caps.
3. **Signing (F7).** A `signature` over the artifact hash is reserved; it does not change the hash rule.
4. **Template file size.** No per-template cap beyond V5's artifact total. #38 measures compile time on large templates and proposes one if needed.
5. **Lock and module tree at upload.** V17's lock match and V20's original hashes need `renox.lock` and the module trees, which only `renox build` has. The control plane checks what the artifact alone proves; carrying the lock in the artifact would let it check more, as a minor change, if a hand-built upload ever matters.
6. **Per-route `cors` and `frame` exports.** `docs/04-isolation-security.md` allows `export const cors` on a function and `export const frame` on a page. Reading them needs the CLI to evaluate module exports at build time. When #47 implements that, they are added as optional route fields (`cors`, `frame_ancestors`), a minor change.
7. **`isolate` modules.** An entry with `isolation: "isolate"` is valid here; the runtime that runs it is not scheduled in F4 (`manifest.md` Open 2), and #235 refuses to build one until it is.
8. **Event and hook exports.** `exports` copies the module's public API for the broker (ops 1.3.0, #226, not merged yet: blocked on the SDK type sync). If #226 lands with different names, `exports` follows it as a minor change before #232 reads it.

Settled in version 1: the `public/manifest.json` name clash (version 0 Open 1, now section 4: the index moved to `public.json`) and trailing slashes (version 0 Open 4, now section 3, "Trailing slashes"). Settled in version 1.1: module templates and overrides (version 1 Open 5): a module's ids are prefixed with `modules/<name>/` instead of a `<module>:` namespace, so an id stays a path and the template file stays `templates/<id>.jinja`.
9. **Static exports (version 1.2).** The worker's prepare-time check (V23) reads a module's static exports from its code. For `esm-dir` that is the ES module's export list after the CLI bundled it; for `eszip` the same list inside the bundle. A module whose exports are only known at run time (`export default` of a computed object used as a handler table) is not a route module the CLI produces, so the rule does not try to support it.

## Changelog

| Version | Issue | Changes |
| --- | --- | --- |
| 0 | #15 | First version (F1): layout, content hash, manifest with function routes, migrations, public index, route table, rules V1–V13 |
| 1 | #152 | **Pages:** `kind: "page"` routes with `module`, `load`, `actions`, `template`; methods and action selection (`?/name`); page and function routes share V8. **Templates:** `templates/<id>.jinja`, `manifest.templates` with `kind` and the per-page fragment map; fragment selection by `HX-Target`. **Security:** optional `security` object from `renox.toml [security]` (CSP, CORS, headers, rate-limit buckets). **Public index** moved to `public.json`, so `public/manifest.json` is an ordinary file (Open 1). **Trailing slash:** 308 redirect for page routes only (Open 4). **Rules:** V14–V16 added; V1, V3, V7, V8, V12 extended. Consumers accept versions 0 and 1 (section 8) |
| 1.1 | #227 | Minor (additive), `artifact.version` stays `1`. **Modules:** the `modules` array copied from `renox.lock` in topological (migration) order, each entry with `name`, `version`, `hash`, `source`, `mount`, `isolation`, `dependencies`, `config`, `permissions`, `approved`, `exports`; module code under `code/modules/<name>/`, code ids and template ids under `modules/<name>/`, the `services` and `hooks` entries; `migrations/<name>/`; `policies/<name>/*.cedar` (carried, F5); `overrides/<name>/…` with `overrides.json`; module routes under their `mount`; the `slots` registry. **Rules:** V17–V22 added; V1, V7, V14 extended. Open 5 settled |
| 1.2 | #263 | Minor (additive), `artifact.version` stays `1`. **Entries:** optional `entries`, code entry id → `{ exports, eager? }`, written by `renox build`: each module's static export names and whether the runtime evaluates it at isolate creation (`ops.md` 1.4.0, lazy route modules). **Rule:** V23 (keys match `code.entry`, route handlers and services are among the recorded exports, `services` and `hooks` stay eager, the worker re-checks the exports at prepare). Without `entries` an artifact behaves as in 1.1 |
