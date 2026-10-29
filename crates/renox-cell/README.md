# renox-cell

The worker node (P5, `docs/03-architecture.md` Cell row): wires `renox-gateway`, `renox-runtime`, `renox-data`, and `renox-meter` into one process, the `renox-worker` binary. A **cell** is one tenant deployment on this node: its V8 isolate plus its share of the tenant's SQLite file (`docs/17-glossary.md`). Only this crate depends on the other four; nothing depends on it.

```
cargo run -p renox-cell --bin renox-worker -- --config crates/renox-cell/worker.example.toml
cargo test -p renox-cell        # tests/two_tenants.rs links V8
```

`renox-worker transpile` (#43) is the template compiler for the CLI: it reads `{ "files": { "<path>": "<source>" } }` on stdin and writes `renox_template::transpile::compile_json`'s result to stdout, then exits. No config, no V8, no network. `renox build` calls it for apps with templates (`cli/README.md`, "Templates").

## Configuration

`renox-worker --config worker.toml`. Relative paths are resolved against the config file's directory. Unknown keys are refused. Example: `worker.example.toml`.

| Key | Default | Meaning |
| --- | --- | --- |
| `listen` | — | Address of the gateway (plain HTTP in F1; TLS is `Gateway::serve_tls`, wired when certificates arrive from the control plane, F3) |
| `data_dir` | — | `<data_dir>/<tenant_id>/app.db` (the tenant file) and `<data_dir>/<tenant_id>/secrets.json` |
| `artifacts_dir` | — | Artifact directories named by their content hash (`docs/contracts/artifact.md`); also the gateway's static file root |
| `routes_file` | — | The route table (`docs/contracts/schemas/route-table.schema.json`); re-read on `SIGHUP` |
| `meters_dir` | — | Meter batches, `<meters_dir>/<YYYY-MM-DD>.ndjson`; dead letters under `dead/` (`docs/contracts/meter.md`) |
| `logs_dir` | — | Tenant log lines, `<logs_dir>/tenant.ndjson` (one JSON object per line, secrets redacted) |
| `node_id` | `node-local` | Written into meter batches (`cell_id` and `node_id`) |
| `idle_timeout_secs` | 600 | Scale to zero: a cell without a request for this long is evicted |
| `meter_flush_ms` | 5000 | Meter batches are written at least this often |
| `fetch_blocked_addresses` | `[]` | The node's own public addresses and the control plane's; tenant `fetch` is refused to them on top of the private ranges. Empty logs a warning at start; set it in production |
| `default_tier` | `free` | Tier of tenants not listed in `tenant_tiers` |
| `platform_key_file` | — | The node's platform key (mode 0600, ≥ 32 bytes); page session and CSRF keys are derived from it per tenant ("Sessions and CSRF"). Unset: a random key per process |
| `[gateway]` | 100 / 200 / 100 | `rate_limit_per_ip` (req/s), `rate_limit_burst`, `max_connections_per_ip`: the gateway's per-client limits (`renox-gateway` README). Benchmarks that send all load from one address raise them |
| `[tenant_tiers]` | — | `tenant_id = "free" \| "paid"` (F1 stand-in for the control plane) |
| `[tiers.free]`, `[tiers.paid]` | see "Tiers" | Overrides of single tier fields |

Process logs are structured JSON on stderr (`tracing`, filtered by `RUST_LOG`, default `info`). They name tenants, hashes, and request ids, never secret values or request content.

## Tiers

`src/tiers.rs`, defaults from `docs/04-isolation-security.md` ("Per-tenant limits") and `docs/contracts/ops.md` section 10. The manifest's `limits` can only lower them further (`Limits::with_overrides`).

| Field | `free` | `paid` |
| --- | --- | --- |
| `cpu_ms` (per request) | 50 | 500 |
| `wall_ms` (per request) | 30,000 | 60,000 |
| `heap_mb` (per isolate) | 128 | 512 |
| `concurrency` (per deployment) | 50 | 500 |
| `db_quota_bytes` | 100 MB | 10 GB |
| `egress_bytes` (fetch, per request) | 10 MB | 100 MB |
| `log_lines_per_min` (per tenant) | 1,000 | 10,000 |

The gateway's request deadline is the longest tier's wall clock; the runtime then caps each request at its own tier's `wall_ms`.

## Lifecycle

`CellManager` (`src/manager.rs`) implements `renox_gateway::CellDispatcher`. Cells are keyed by `(tenant_id, deployment_hash)`.

| State | What happens |
| --- | --- |
| **starting** | The first request for the key creates the cell; concurrent requests wait for the same creation. Steps: check the tenant id (it is a directory name), find the artifact, open the tenant's `TenantDb` (`app` authorizer, the tier's quota) on its DB thread or share the one already open, run the artifact's app migrations (`migrations/app/*.sql` against `migrations/checksums.json`), read `secrets.json`, create the isolate with the tier's limits. A failure answers 500 `RENOX_INTERNAL` (or the isolate's limit code) and is retried on the next request |
| **ready** | Requests are dispatched to the isolate; the request body (already limited by the gateway) is collected; the response is sent head first and its body streams (`docs/contracts/ops.md` 1.2.0, below) |
| **draining** | After a route table reload, a cell whose `(tenant, hash)` has no `active` entry anymore takes no new route; it is evicted as soon as its in-flight requests finish (`docs/05-tenant-lifecycle.md`, "Deployment switch"). New requests for the new hash create a new cell |
| **evicted** | No request for `idle_timeout`, or drained. The cell is removed from the map under the same lock that admits requests (so no request is admitted to an evicted cell; one arriving now waits for a fresh cell), its isolate is terminated, and the tenant's database is closed with a WAL truncate when no other cell of the tenant uses it. Once no cell was evicted for 2 s, the worker returns freed memory to the OS with glibc `malloc_trim(0)`, and again 10 s and 30 s later (`src/alloc.rs`, #144; B2 0.06 MB per idle tenant) |

One DB thread per tenant file, shared by all cells of the tenant (old and new deployment during a switch): one writer per file, as SQLite requires.

**Meter records.** For every dispatched request that matched a route, the manager completes the runtime's fields (`cpu_ms`, `peak_heap_bytes`, `fetch_*`, `db_ms`, `db_rows`, `logs_dropped`, `status`) with `request_id`, `tenant_id`, `deployment_hash`, `route`, `started_at`, `wall_ms`, `ingress_bytes` (request body), `egress_bytes` (response body), and `http_status`, then `Meter::record`. 404 and 405 from route matching produce no record (`meter.md` section 1).

**Secrets.** `<data_dir>/<tenant_id>/secrets.json` is an object of string values. A missing file means no secrets; a file readable by group or others (mode not 0600) is refused and the cell is not created. Only the names the manifest declares reach the isolate (`renox-runtime`).

## Artifacts

`src/artifact.rs` (#30). `ArtifactStore::get(hash) -> ArtifactDir` is the only way the manager finds code; `LocalArtifactStore(dir)` serves `<dir>/<hash>/` and is the F1 stand-in for object storage (F3 puts the S3 fetch and disk cache behind the same trait, #55). On the first `get` of a hash it checks:

| Rule (`docs/contracts/artifact.md` section 6) | Check |
| --- | --- |
| V1 | Tree walk without following links: symbolic links and special files refused, every path follows the path rules (no `..`, no `\`, no `:`) |
| V2 | The canonical hash (section 2) equals the directory name; a mismatch is `ArtifactError::HashMismatch` |
| V3, V9 | `manifest.json` validates against `docs/contracts/schemas/manifest.schema.json` (`jsonschema`, compiled in), so unknown keys are refused |
| V8 | Route conflicts: same method, same shape (static segments literally, parameter names ignored); repeated parameter names |
| V11 | `migrations/`: `<module>/NNN_<name>.sql` only, numbered from 001 without gaps, `checksums.json` lists exactly those files with matching hashes |

A verified hash is cached (artifacts are never overwritten); a failure is not, so a repaired copy is picked up. `renox-runtime` verifies V1-V7 again each time it creates an isolate from the directory. `canonical_listing` and `hash_files` compute the hash of in-memory files; `docs/contracts/examples/hash-vectors.json` holds vectors shared with the CLI's TypeScript implementation (`tests/artifact.rs` checks both the in-memory and the on-disk path against them).

## Pages

`src/render.rs` (#40). At cell creation the cell loads the artifact's `templates/` into a `renox_template::Renderer` (`PageRenderer`). When a dispatch returns a page render, the cell parses the loader JSON straight into `minijinja::Value` (`serde_json` with `float_roundtrip`) and renders on Tokio's blocking pool, outside the isolate and its CPU limit, under `RenderLimits::DEFAULT`:

| Case | Answer |
| --- | --- |
| Page or selected fragment rendered | 200 `text/html; charset=utf-8`, `Cache-Control: no-store`, `Vary: HX-Request, HX-Target` |
| Out-of-band fragments (an htmx action's `{ fragments }`, #41) | the `HX-Target` fragment if one is selected, then each block with `hx-swap-oob="true"` on its first element (only the blocks when no fragment is selected); an unknown name is 500 |
| Render limit | 500 `RENOX_RENDER_LIMIT`, meter `status: render_limit`, one tenant log line with `template` and `limit` |
| Platform error on a page route (handler threw, bad loader result, CPU, deadline) | the tenant's `pages/_error` with `status`, `code`, `request_id`, `message` under `RenderLimits::ERROR_PAGE`, else the platform default page |
| `GET`/`HEAD` with no matching route, `Accept` preferring HTML | `pages/_404`, else `_error`, else the default page; no meter record |

The meter record gets `render_fuel` and `render_ms` (render-thread CPU time) of every render of the invocation, error page included, the shell render of a streamed page too. The CSP nonce argument exists and is `None` until #47 wires the header. `date` uses the app's zone for the Gulf zones (`Asia/Dubai`, ...) and UTC otherwise.

## Sessions and CSRF

`src/pages/` (#41; `docs/contracts/ops.md` section 14). For a deployment with page routes, before dispatch:

| Step | What |
| --- | --- |
| Header | `x-renox-csrf` is taken out of the request (the gateway passes this one client `x-renox-*` header through); tenant code never sees it |
| Session | `__Host-renox_sid=<id>.<mac>`: 128-bit random id (base64url, 22 characters) signed with HMAC-SHA256 under the tenant key. Missing or invalid: a fresh id and `Set-Cookie` (`Path=/; Secure; HttpOnly; SameSite=Lax`). The id goes to `ctx.session.id` |
| CSRF cookie | `__Host-renox_csrf=<token>`, token = HMAC-SHA256(tenant key, session id); set when missing or wrong. Not `HttpOnly`, so the page's script can copy it into `x-renox-csrf` for htmx |
| Cookies | Both platform cookies are removed from `Cookie` before the isolate |
| Action | `POST ?/<name>` naming a declared action: the token from `x-renox-csrf` or the `_csrf` form field (urlencoded or multipart) must equal the cookie, and both the session's token (constant-time). Otherwise 403 `RENOX_CSRF` (the `_error` page or the default page), one tenant log line with `route`, `action`, `reason` (`missing`/`mismatch`), no tenant code, no meter record |
| Render | The token is the renderer's `__renox.csrf_token`: `<x-form action="name">` and `<x-csrf />` emit `<input type="hidden" name="_csrf">` with it |

**CSP nonce (#47).** Every render (page, fragment, error and 404 pages, the 403 page) gets the gateway's `RequestCtx.csp_nonce`, so each `<script>`/`<style>` carries the nonce of the response's CSP header.

**Rate-limit buckets (#47).** `security.ratelimit[]` buckets are enforced in `src/ratelimit.rs` after the runtime's router matched the route (the gateway does not match routes): a token bucket of `requests` per `window_s` per client IP (IPv6 by /64) per bucket, `HEAD` sharing the `GET` bucket. Over it: `429` with `Retry-After`, no body, no tenant code, no meter record, like the gateway's per-IP limit. The session cookie is `SameSite=None` only when `cors.credentials` is set with listed origins.

Function routes are not checked (APIs; webhooks verify signatures). **Keys:** the tenant key is HKDF-SHA256 (salt `renox-pages-v1`, info = tenant id) of the node's platform key, read from `platform_key_file` (mode 0600, at least 32 bytes). Without the key a worker uses a random key per process and logs a warning; sessions then end on restart. F3 delivers the node key (#54, #55). The keys never reach an isolate or a log. Token masking against BREACH is #111.

## Streamed responses

Since #161 the cell implements `docs/contracts/ops.md` 1.2.0 (`src/manager.rs`, `src/render.rs`):

- **Head first** (section 6, "Response body"): the head is answered as soon as the isolate hands it back. A static body goes with it in one piece; a `ReadableStream` body follows chunk by chunk (`op_response_write`, `op_response_end`), and a task moves each chunk to the connection. The runtime holds at most 16 chunks the cell has not taken (`STREAM_BUFFER_CHUNKS` in `renox-runtime`), and the cell at most `BODY_CHANNEL` (4) the connection has not taken, so a slow client holds the handler back. A handler's `Content-Length` is removed from a streamed body.
- **Compression per chunk** (section 6): the gateway's rules (type, `NoCompress`, `no-transform`) with a streaming encoder that flushes after every chunk, without the minimum-size rule.
- **Egress per chunk** (section 10, "Response egress"): the runtime counts each chunk against the tier's response egress limit as `op_response_write` takes it; the chunk that would pass it is refused, and the body is truncated (section 10, "Mid-stream"; `BodySender::truncate` ends it with an error, not a clean end), so a client can tell it from a complete body.
- **Meter at the end of the stream** (section 7, "When"): the record is written when the stream ends, whatever ended it. `wall_ms` runs to the end, `egress_bytes` counts the bytes handed to the connection after compression up to the stop, `http_status` is the status sent in the head, `status` the cause of the end.
- **Shell before the loader resolves** (section 14, "Streaming the shell"): a full-page `GET` whose `load` is slower than `SHELL_DELAY` (50 ms, proposed) gets status 200, the page headers, and the shell (`PageRenderer::shell_of`: the output up to the template's first data read, cut back to the last complete tag) at once; the rest of the page follows when `load` returns. An error after the shell is rendered inside the stream (`error page rendered inside the stream`, `streamed: true`); a `Response` from `load` after the shell is `RENOX_INTERNAL` with `reason: "response_after_shell"`. Fragments, actions, `HEAD`, and loaders that finish within the delay are sent in one piece as before.

## Modules (#232)

An artifact 1.1 with installed modules (`docs/contracts/artifact.md`, "Modules") needs nothing special to render: the build has compiled module templates into `templates/modules/<name>/…`, with any tenant override compiled into the module's id, and the slot registry into the layouts' `<r-slot>` includes. The cell:

- runs the migrations in `modules` order (each module under its own prefix, `renox_data::migrate_all`), then the app's, which may read every module's public views;
- dispatches module routes like the app's: their paths already carry the `mount`, and the route's owner gives the loader its module ctx (`renox-runtime`);
- gives the renderer the request's **action set** for `r-can` and slot fillers' `requires`. The set is empty until the policy engine (F5), unless the page loader's data has an `actions` array of action names (`src/render.rs`, `action_set`).

Override drift is detected by `renox build` (#235), not here: the artifact carries the original's hash (`overrides.json`), but not the original file.

Tests: `tests/modules_pages.rs`.

## Outbox delivery (#229)

Each cell runs one delivery task (`src/outbox.rs`) for the durable events of `docs/contracts/ops.md` 1.3.0 section 15.4 (ADR D14):

- **Woken, not polling.** `TenantDb::on_outbox_commit` (renox-data) fires after a commit that inserted into `renox__outbox`: SQLite's update hook marks the insert, the WAL hook runs after the commit, and the rollback hook forgets it. The task otherwise sleeps until the earliest `next_at`, or for good when the outbox is empty. When the cell starts, the task scans the rows already due, so events written before a restart or an eviction are delivered by the tenant's next cell.
- **Fan-out.** A new event (`target` empty) becomes one delivery per module whose `hooks.ts` has an `on` handler for it, ordered by module name (`IsolateHandle::event_handlers`). Each delivery has its own attempts.
- **Attempt.** `IsolateHandle::deliver_event` runs the handler under the tier's CPU, heap and wall-clock limits. The handler's transaction deletes the row together with its writes (the ack). A delivery is admitted like a request, under the manager's map lock, so a cell is never evicted while one is in flight; eviction stops the task.
- **Retries.** A failed attempt (throw, limit, busy) is due again after `base × 2^(n−1)` (10 s), capped at 1 h, ± 20 %. After the 8th it moves to `renox__outbox_dead` with the error code or `threw` as its last error, never the handler's message or the payload, and one `event_dead` line goes to the tenant log. A delivery whose module has no handler any more is dropped. `CellManager::set_outbox_config` changes these numbers.
- **Meter.** Every attempt that ran tenant code is one record with `kind: "event"`, route `EVENT <module> <name>`, request id `<event id>_<module>_<attempt>`, `http_status` 200 or 500, and `ingress_bytes`/`egress_bytes` 0 (`meter.md` 0.2).
- **Gauge.** `CellManager::outbox_stats(tenant)` returns the pending deliveries and dead letters of a tenant whose file is open on the node.

Tests: `tests/outbox.rs`.

## Not here yet

Artifact fetch from object storage and the disk cache (#55), route updates by pub/sub (F3), the process sandbox (F6), realtime (F5), TLS certificates from the control plane (F3). Request bodies are collected before dispatch (responses stream, above).
