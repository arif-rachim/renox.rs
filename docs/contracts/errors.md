# Contract: tenant-facing error catalogue

| | |
| --- | --- |
| Version | **0.2** (F3, #50). New codes are added as rows (minor). Renaming or removing a code, or changing its HTTP status, is breaking. History: "Changelog" at the bottom |
| Producers | `crates/renox-gateway` (P3), `crates/renox-cell` (P5), `crates/renox-runtime` (P1), `crates/renox-data` (P2); from F3 `control/api` (P12, [`deploy-api.md`](deploy-api.md)) and `cli/` (P11) |
| Consumers | `sdk/` (P10) error classes; `cli/` (P11) and the dashboard (P13), which quote these rows; the public docs; tenants' own API clients |
| Related | [`ops.md`](ops.md) section 13 (which codes ops throw and which the platform answers with), [`meter.md`](meter.md) (`status`), `docs/23-failure-modes.md` (when each failure happens) |
| Checker | `bun run docs/contracts/validate.ts`: every code used in `ops.md`, `deploy-api.md`, `schemas/deploy-api.yaml` and `docs/23-failure-modes.md` has exactly one row here, and `ctx.d.ts` uses exactly the codes of `ops.md` section 13 |

Everything a tenant or an end user sees when the platform fails, refuses, or stops something is one of the codes below. It is never a stack trace, a file path, a hostname or IP of ours, an SQL statement, or a secret (`docs/23-failure-modes.md` rule 2; `docs/24-threat-model.md`). This file is the superset: `ops.md` defines the codes that cross the op boundary, and this catalogue adds the gateway, deploy, and availability codes. It is what the dashboard, the CLI, and the public docs quote.

## 1. Response body

### Function (API) routes

Every error response the **platform** produces on a function route has a JSON body:

```json
{ "error": { "code": "RENOX_CPU_LIMIT", "request_id": "01JBQ3Z7MA0000000000000001", "message": "The request used more CPU time than its limit." } }
```

- `Content-Type: application/json; charset=utf-8`, `Cache-Control: no-store`, and `x-renox-request-id` with the same id as in the body.
- `code` is a code from section 3 whose HTTP status is not "—". `message` is the **fixed** English text from the "Message" column, never built from tenant code, request input, or an internal error. `request_id` lets a developer find the full detail in their logs.
- `Retry-After` is set where the row says so.
- The TypeScript shape is `ErrorResponseBody` in `ctx.d.ts`.
- The body never contains `details`, a stack, or the code of a thrown error. An uncaught `RENOX_DB_AUTH` reaches the client as `RENOX_INTERNAL`; the original code goes to the tenant's log only.

A `Response` that tenant code returns itself (for example a 404 or a 400 built by the handler) is passed through untouched. Only platform-produced errors follow this format.

### Page (HTML) routes, F2

A platform error on a page route (`artifact.md` section 3, "Page routes") is answered with HTML, chosen in this order:

1. The tenant's `pages/_error.html`: the template with `kind: "error"` in `manifest.templates`.
2. The **platform default page**, if the app has no error template, if rendering it fails, or if it hits a limit itself: a static HTML page with the HTTP status, the message, and the request id, and no tenant content. It is never rendered with tenant code or tenant templates. It is the same page the gateway already sends for its own HTML errors (413), and the page every collateral request of a recycled isolate gets (`ops.md` section 10).

**Inputs.** The error template receives exactly four variables, and nothing else:

| Variable | Type | Value |
| --- | --- | --- |
| `status` | integer | The HTTP status from section 3 |
| `code` | string or `null` | The code from section 3; `null` only for the 404 page below |
| `request_id` | string | Same as `x-renox-request-id` |
| `message` | string | The fixed English text from the "Message" column |

No loader runs: `pages/_error.ts` is a build error (`renox check`), and the template sees no `ctx`, no session, no loader data of the failed request, no `params`, and no detail of the cause (limit values, stack, SQL). Layouts and partials may be used, so the page can look like the rest of the app.

**Render budget: a fixed error-page budget**, decided here (#93 proposed "a tiny fixed fuel budget", version 0 of this file said "the normal render limits"; the fixed budget wins). The error page renders exactly when a request has already failed, often under load (`RENOX_CPU_LIMIT`, `RENOX_BUSY`). With the normal limits, a heavy `_error.html` would double the cost of every failure, and a flood of failures would become a flood of renders. So the error template gets the same small budget on every tier, independent of what the failed request used:

| Limit | Value |
| --- | --- |
| Fuel | 10,000 units *proposed* |
| Output | 64 KiB |
| Include and `extends` depth | 4 |
| Render time | 10 ms |

Hitting any of them falls back to the platform default page, with the original status and code (never `RENOX_RENDER_LIMIT`), and logs one `RENOX_RENDER_LIMIT` line with `template: "pages/_error"`. #93 confirms the fuel number with a test against `renox-template`'s fuel unit (#38) and records it here as a patch. What the error render uses is added to the failed invocation's `render_fuel` and `render_ms` (`meter.md`).

**404 page.** A `GET` or `HEAD` that matches no route, on an artifact with templates, whose `Accept` header prefers `text/html`, gets the template with `kind: "not_found"` (`pages/_404.html`), with `status: 404`, `code: null`, the request id, and the message "Page not found.", under the same fixed budget. Without a `_404.html` it falls back to `_error.html`, then to the default page. A 404 like this has no meter record (no tenant code runs, `meter.md` section 1). A `Response` with status 404 returned by `load` is a tenant response and passes through untouched.

### When the route kind is not known

The gateway can fail a request before a route is matched (`RENOX_BODY_TOO_LARGE`, `RENOX_HOST_MISMATCH`, `RENOX_UNAVAILABLE`). It answers with the platform default page when the request's `Accept` header prefers `text/html`, and with the JSON body otherwise.

## 2. What is logged

Every row below produces one line in the tenant's log sink (`ops.md` section 4) unless it says otherwise. The line carries the standard fields (`ts`, `tenant_id`, `deployment_hash`, `request_id`, `module`, `level`) plus `code` and the fields listed in the row. These lines are what `renox logs` and the dashboard show the developer. Secret values are redacted from every field (`ops.md` section 3). Fields that would reveal our infrastructure (node names, internal addresses, file paths) go only to the platform's operator logs, never to the tenant sink.

Thrown codes (section 3, "Thrown into tenant code") are logged when they end a request uncaught, as part of the `RENOX_INTERNAL` line (`cause_code`, `cause_message`, redacted `stack`). If tenant code catches them, logging is up to the tenant. Exceptions: `RENOX_FETCH_BLOCKED` is always logged by the platform (`docs/24-threat-model.md` rule 4), and so is `RENOX_DB_AUTH`, because a refused table is a security-relevant event even when caught.

## 3. Catalogue

Columns: **HTTP** = status of the platform response ("—" = never a response by itself: thrown into tenant code, and 500 `RENOX_INTERNAL` if uncaught). **Message** = the fixed text in the response body and on the default page. **Logged** = fields added to the tenant log line. **What to do** = the guidance the dashboard, CLI, and docs give the developer.

### Request limits and platform responses

| Code | Phase | HTTP | When it happens | Message (end user) | Logged (tenant developer) | What to do | Refers to |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `RENOX_CPU_LIMIT` | F1 | 503 | The request's JavaScript used more CPU time than the tier limit (50 ms free / 500 ms paid), or module evaluation exceeded its budget. The isolate is recycled, and its other in-flight requests end with this code too | The request used more CPU time than its limit. | `route`, `cpu_ms`, `limit_ms`, `phase` (`request` / `module_load`) | Move heavy work out of the request path (precompute, paginate, cache in `ctx.db`), check for loops over unbounded input, or upgrade the tier | `ops.md` §10; `docs/04-isolation-security.md` "Per-tenant limits"; failure mode "Infinite loop / CPU over limit" |
| `RENOX_OOM` | F1 | 503 | The isolate reached its V8 heap limit (128 MB / 512 MB). The isolate is recycled, and its other in-flight requests end with this code too | The request ran out of memory. | `route`, `peak_heap_bytes`, `limit_bytes` | Stream large bodies instead of buffering them, limit query result sizes, avoid unbounded global caches | `ops.md` §10; failure mode "Unbounded allocation" |
| `RENOX_DEADLINE` | F1 | 504 | The request's wall-clock deadline (30 s / 60 s) passed. Also thrown into pending ops of that request | The request took too long. | `route`, `wall_ms`, `limit_ms`, `pending_ops` (op names) | Look for slow `fetch` targets or long database work; set timeouts on outbound calls with `ctx.deadline.remainingMs()` | `ops.md` §5, §10; failure mode "Handler never resolves" |
| `RENOX_INTERNAL` | F1 | 500 | The handler threw (including an uncaught thrown code below), returned something that is not a `Response`, module evaluation failed, or a route's export is missing | Internal error. Quote the request id when reporting it. | `route`, `cause_code` (if the cause was a `RenoxError`), `cause_message`, `stack` (redacted), `phase` | Read the logged cause and stack; catch expected errors and return your own `Response` | `ops.md` §6, §11; failure mode "Handler throws" |
| `RENOX_MODULE_EVAL` | F2 | 500 | A route module evaluated on its first request (ops 1.4.0, lazy route modules) threw while evaluating, or lacks the route's export. Only that route fails; the isolate stays up and the failure is cached until the isolate is replaced | Internal error. Quote the request id when reporting it. | `route`, `module`, `cause_message`, `stack` (redacted); logged once per isolate | Fix the module's top-level code (it now runs inside the first request, under its deadline and limits); run `renox check`, which refuses a missing export before deploy | `ops.md` §11, §13; failure mode "Route module fails to evaluate on first use" |
| `RENOX_BUSY` | F1 | 503, `Retry-After: 1` | All concurrency slots of the deployment (50 / 500) stayed busy until the request's deadline | The service is busy. Try again shortly. | `route`, `concurrency_limit`, `queued_ms` (one summary line per second while it lasts, not one per request) | Find slow handlers that hold slots; raise the tier for more concurrency | `ops.md` §10; failure modes "Too many concurrent requests", "Flood from many IPs on one tenant" |
| `RENOX_BODY_TOO_LARGE` | F1 | 413 | The request body exceeded the limit for the route kind (1 MB default) at the gateway, before any tenant code ran | The request body is too large. | `limit_bytes`, `received_bytes` (not metered, `meter.md` §1) | Upload large files through the storage module; raise the limit per route when available | `ops.md` §6; failure mode "Request body over limit" |
| `RENOX_RENDER_LIMIT` | F2 | 500 | Template rendering ran out of fuel, iterations, output size, include depth, or render time | The page could not be rendered. | `template`, `line`, `limit` (`fuel` / `iterations` / `output` / `depth` / `time`) | Paginate the data passed to the template; reduce nested loops | `docs/08-template-engine.md`; failure mode "Template nested loops / huge output" |
| `RENOX_CSRF` | F2 | 403 | A non-GET page action arrived without a valid CSRF token | The request could not be verified. Reload the page and try again. | `route`, `action`, `reason` (`missing` / `mismatch`) | Submit forms through the generated markup or htmx, which send the token; exempt webhook routes are automatic | `docs/04-isolation-security.md` "Web-layer protections"; failure mode "CSRF token missing or wrong" |
| `RENOX_FORBIDDEN` | F5 | 403 | A Cedar policy denied the action (route `guard`, `authz.require`) | You do not have permission to do this. | `action`, `resource`, `policy_id` (dev only), `principal` (id only) | Check the role assignments and policies for the action | `docs/11-authorization.md`; failure mode "Policy denies" |
| `RENOX_HOST_MISMATCH` | F2 | 421 | The TLS SNI name and the `Host` (or `:authority`) both resolve in the route table, to **different tenants**. Refused before routing; no cell is touched | The request was sent to the wrong host. | Not logged to any tenant sink, since the two names belong to different tenants. The operator log records both host names | Nothing in the app. Clients must send the same name in SNI and `Host`; browsers retry a 421 on a new connection by themselves | `artifact.md` §5; `docs/24-threat-model.md` "Host/SNI confusion" |
| `RENOX_UNAVAILABLE` | F3 | 503, `Retry-After: 5` | The worker cannot load the deployment: artifact not cached and object storage or the control plane is unreachable, or the cell is marked unhealthy. In the deploy API: no healthy node can take an activation, or Postgres or object storage is unreachable | The service is temporarily unavailable. | `reason` (`artifact_unavailable` / `cell_unhealthy`); deploy API: the deployment's `last_error.stage` = `no_worker` | Nothing in the app; the platform retries and alerts. Check the status page; retry the activation | failure modes "Control plane unreachable from the worker", "Object storage unreachable"; `deploy-api.md` §6 |

### Thrown into tenant code

| Code | Phase | HTTP | When it happens | Message (end user) | Logged (tenant developer) | What to do | Refers to |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `RENOX_FETCH_BLOCKED` | F1 | — | `fetch` to a host that is not on the allowlist, with the wrong scheme or port, resolving to a blocked address, over 5 redirects, or with a forbidden method | — | Always logged: `host`, `reason` (never the resolved IP) | Add the host to `[fetch] allow` in `renox.toml`; private and metadata addresses cannot be allowed | `ops.md` §2; `docs/24-threat-model.md` SSRF rows; failure mode "`fetch` to blocked destination" |
| `RENOX_FETCH_FAILED` | F1 | — | `fetch` failed for a network reason: DNS, connect, TLS, reset, redirect mode `error`, too many concurrent fetches, or too many headers | — | When uncaught: `host`, `reason` | Retry with backoff for transient reasons; check the remote certificate for `tls` | `ops.md` §2 |
| `RENOX_FETCH_EGRESS_LIMIT` | F1 | — | Outbound bytes of the request (sent + received over all fetches) passed 10 MB free / 100 MB paid; the stream is aborted | — | When uncaught: `host`, `limit_bytes` | Request smaller ranges or pages from the remote API; stream instead of downloading whole files | `ops.md` §2; failure mode "`fetch` response too large / too slow" |
| `RENOX_DB_AUTH` | F1 | — | The SQLite authorizer refused a table, view, `ATTACH`, `PRAGMA`, or function outside the module's prefix | — | Always logged: `table`, `action`, `module` | Use only your module's `<module>__*` tables and declared `<dep>__public_*` views | `ops.md` §1; `docs/06-data.md`; failure mode "SQL touching another module's table" |
| `RENOX_DB_BUSY` | F1 | — | The write lock stayed taken for the busy wait (2 s, or the remaining deadline if shorter) | — | When uncaught: `wait_ms` | Keep write transactions short; do not `fetch` inside `db.transaction` | `ops.md` §1 |
| `RENOX_DB_TIMEOUT` | F1 | — | A statement ran longer than 1 s (or the remaining deadline); the statement is interrupted and its transaction rolled back | — | When uncaught: `elapsed_ms` (the SQL text is not logged) | Add an index, add `limit`, avoid unbounded `WITH RECURSIVE` | `ops.md` §1; failure mode "Runaway query" |
| `RENOX_DB_QUOTA` | F1 | — | The tenant file reached its size quota (100 MB free / 10 GB paid); writes fail, reads continue | — | When uncaught: `quota_bytes`; also a dashboard warning | Delete old data or upgrade the tier | `ops.md` §1; failure modes "Database file over quota", "Disk full on node" |
| `RENOX_DB_CONSTRAINT` | F1 | — | A unique, foreign key, not-null, check, or primary-key constraint failed | — | When uncaught: `kind` | Expected in normal operation: catch it and return a 409 or 400 | `ops.md` §1 |
| `RENOX_DB_SQL` | F1 | — | Syntax error, unknown table or column, or another `SQLITE_ERROR` | — | When uncaught: SQLite's message (no file path) | Fix the statement; run `renox check`, which lints SQL | `ops.md` §1 |
| `RENOX_DB_PARAM` | F1 | — | A parameter has an unsupported type or value (`undefined`, `NaN`, object, bigint outside i64, lone surrogate), the count does not match, named parameters were used, or the SQL text or parameter count is over its limit | — | When uncaught: `index` of the parameter, `reason` | Pass `null` instead of `undefined`; use positional `?` parameters | `ops.md` §1, §12 |
| `RENOX_DB_COLUMN_NAME` | F1 | — | Two result columns have the same name | — | When uncaught: `column` | Alias the columns (`select a.id as a_id, b.id as b_id`) | `ops.md` §1 |
| `RENOX_DB_MULTI_STATEMENT` | F1 | — | More than one statement was passed in one call | — | When uncaught | Run one statement per call; group them in `db.transaction` | `ops.md` §1 |
| `RENOX_DB_RESULT_LIMIT` | F1 | — | A query returned more than 10,000 rows or 8 MB | — | When uncaught: `limit` (`rows` / `bytes`) | Paginate with `limit` and a cursor | `ops.md` §1 |
| `RENOX_DB_TX_STATE` | F1 | — | A transaction was begun while one was already open on the request, or a handle was used after commit or rollback | — | When uncaught | Do not nest `db.transaction`; savepoints arrive in F4 | `ops.md` §1 |
| `RENOX_DB_UNAVAILABLE` | F6 | 503, `Retry-After: 30` | The tenant's SQLite file failed its integrity check on open or is being restored | The service is temporarily unavailable. | `reason` (`integrity` / `restoring`) | Nothing in the app; the platform restores from the replica and alerts | failure mode "SQLite file corrupted, WAL unreadable" |
| `RENOX_DB_SCOPE` | F5 | — | Module code ran an unscoped query on a table that requires `db.scoped()` | — | When uncaught: `table`, `module` | Use `db.scoped({ ... })` for owned tables | `docs/11-authorization.md`; failure mode "Unscoped query on an owned table" |
| `RENOX_NO_REQUEST` | F1 | — | An op was called outside a live request: at module top level, or from a timer or promise that outlived its request | — | When uncaught at top level: as `RENOX_INTERNAL` with `phase: module_load`; later: one line with `op` | Do I/O inside handlers; do not keep work running after the response | `ops.md` §0 |
| `RENOX_SECRETS_CONSUMED` | F1 | — | `op_secrets_get_all` was called a second time. Unreachable from tenant code through the public API | — | `op` | Read secrets from `ctx.secrets` | `ops.md` §3 |
| `RENOX_MODULE_UNDECLARED` | F4 | — | Module code called a service of a module it does not list in `[dependencies]`, ran a hook point it does not export, or emitted an event it does not export | — | Always logged: `module` (the caller), `target` (the module, hook, or event) | Add the dependency (and the `[imports]` entry) to `module.toml`, then `renox install`; `renox check` finds it before deploy | `ops.md` §15.2–15.4; `manifest.md` MF7; `docs/24-threat-model.md` "Module calling a service or hook it did not declare" |
| `RENOX_MODULE_SERVICE` | F4 | — | A service, hook filler, or in-memory event handler of another module threw; the enclosing transaction was rolled back | — | When uncaught: `module`, `service` / `hook` / `event`, `cause_code`; the callee's own error is logged with the callee's `module` | Read the callee module's log line for the cause; catch it to answer the user, knowing the transaction is gone | `ops.md` §15.2; failure mode "Module service throws" |
| `RENOX_EVENT_PAYLOAD` | F4 | — | `ctx.events.emit` got a payload that does not match the event's exported schema, is not JSON-serialisable, or is over 64 KiB | — | When uncaught: `event`, `reason` (`schema` / `not_json` / `too_large`); never the payload | Send what the event's `payload` schema in `module.toml` says; put large data in a table and send its id | `ops.md` §15.4; `manifest.md` section 2 |

`RENOX_DB_UNAVAILABLE` has an HTTP status because it fails the request before any tenant code runs (the cell cannot open the file). When it happens during a request it is thrown like the other `RENOX_DB_*` codes.

### Client events (dev overlay only)

| Code | Phase | HTTP | When it happens | Message (end user) | Logged (tenant developer) | What to do | Refers to |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `RENOX_CLIENT_EVENTS_DROPPED` | F2 | — | The gateway dropped browser events sent to `/__renox/events`: body or batch over its limit, per-IP or per-tenant rate, sampling, or the daily cap. The endpoint still answers 204, so the browser never sees it | — (production never shows it) | One summary line per minute while it lasts: `reason` (`body_size` / `batch_size` / `ip_rate` / `tenant_rate` / `sampled` / `daily_cap` / `invalid`), `dropped` (count). Shown in the dev overlay's "Browser" tab | Fix the error that floods the endpoint; lower `extra` sizes; disable client events with `[client] events = false` | `client-events.md`; failure mode "Client-event flood (bug or abuse)" |

### Deploy (control plane and CLI)

| Code | Phase | HTTP | When it happens | Message (end user) | Logged (tenant developer) | What to do | Refers to |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `RENOX_DEPLOY_REJECTED` | F3 | 422 (deploy API) | An uploaded artifact failed validation: any of rules V1–V16 (bundle over 20 MB, route conflict, unknown permission key, path escape, hash mismatch, ...) or the upload rules T1–T8 (link or device entry, over 100 MiB or 10,000 entries, compression ratio over 50:1, extraction over 30 s, ...) | The artifact failed validation. | Deployment event with `rule` (`V1`–`V13`, `T1`–`T8`), `path` or `field`, `reason`; the deployment state becomes `rejected` | Run `renox check` locally, which applies the same rules, and fix what it reports | `artifact.md` §6; `deploy-api.md` §4; failure modes "Bundle over 20 MB, route conflict, unknown permission key", "Tarball decompression bomb / too many files" |
| `RENOX_ACTIVATION_FAILED` | F3 | 422 (deploy API) | Activation stopped on the owning node: the artifact could not be fetched, a migration file failed, module evaluation failed, the probe answered 5xx or hit a limit, or the node did not answer within 60 s. Nothing switched; the previous deployment keeps serving | The deployment could not be activated. | Deployment event with `stage` (`fetch` / `load` / `migrate` / `probe` / `timeout`), `module`, `file`, `sqlite_error`, `http_status`; the deployment returns to `validated` with `last_error` | Fix the failing migration file or handler and deploy again; applied migration files are not re-run | `deploy-api.md` §6; failure modes "Migration fails half-way during activation", "New deployment fails its first request" |
| `RENOX_CLI_WORKER_UNVERIFIED` | F3 | — (CLI, exit code 3) | The CLI refused to run a `renox-worker` binary whose sha256 differs from the pinned release or whose sigstore signature or provenance does not verify | — | CLI output only: `expected_sha256`, `actual_sha256`, the binary path on the developer's own machine | Re-download the worker (`renox dev` fetches the pinned release) or pass a binary from an official release; never disable the check | `docs/24-threat-model.md` F, "Tampered release"; #129 |

### Control API (deploy API, F3)

Answers of `control/api` to tenants, nodes and operators ([`deploy-api.md`](deploy-api.md) §1, §2, §12). The body is the JSON of section 1 plus, where `deploy-api.md` §12 says so, a `details` list; it never contains a secret value, a token, a server path, or an internal address. These codes are not thrown into tenant code and are not written to the tenant log sink; mutating requests are audit-logged instead (`deploy-api.md` §2).

| Code | Phase | HTTP | When it happens | Message (end user) | Logged (tenant developer) | What to do | Refers to |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `RENOX_VALIDATION` | F3 | 400 | A request body, parameter or header is malformed: bad JSON, an unknown field, a value outside its pattern or range, a secret value under 8 bytes, a non-`.map` file in a sourcemap upload (422 there) | The request is not valid. | Audit row with the status; `details` `{ field, reason }` in the response | Fix the field named in `details`; the CLI validates before sending | `deploy-api.md` §1, §9 |
| `RENOX_UNAUTHENTICATED` | F3 | 401, `WWW-Authenticate` | No token, an unknown, expired or revoked token, or a token of the wrong kind | Authentication is required. | Not logged per request; repeated failures per IP are counted | `renox login` again or create a new token; check the token has not expired | `deploy-api.md` §2; `docs/24-threat-model.md` E, "Leaked CLI or CI token" |
| `RENOX_TOKEN_SCOPE` | F3 | 403 | The token is valid but lacks the operation's scope, or a node token names another node | The token does not allow this action. | Audit row with the token id and the action | Create a token with the needed scope (`deploy:<app>`, `secrets:write`, ...) | `deploy-api.md` §2 |
| `RENOX_NOT_FOUND` | F3 | 404 | The app, deployment, secret, domain or token does not exist in the caller's tenant (another tenant's resources are also 404) | Not found. | — | Check the app name and hash (`renox deploy --list`) | `deploy-api.md` §2; `docs/24-threat-model.md` E, IDOR row |
| `RENOX_CONFLICT` | F3 | 409 | A state transition the state machine does not allow, an app name or hostname already taken, another activation of the app in progress, a suspended tenant, an unknown node heartbeating, or a late `prepare_result` | The request conflicts with the current state. | Audit row; `details` `{ field, reason }` | Read the current state (`GET` the resource) and retry the right action; wait for the running activation | `deploy-api.md` §5, §6, §10 |
| `RENOX_RATE_LIMITED` | F3 | 429, `Retry-After` | The token's request or upload bucket is empty, or too many unauthenticated requests came from one IP | Too many requests. Try again later. | — | Wait for `Retry-After`; batch work in CI instead of polling | `deploy-api.md` §2; `docs/24-threat-model.md` E, "Deploy API abuse" |

## 4. Rules for adding a code

- Codes are `RENOX_` followed by upper-case words joined by `_`. A code names a cause the tenant can act on, not an implementation detail.
- A new code needs a row here (all columns), and, if it crosses the op boundary, a row in `ops.md` section 13 and a type in `ctx.d.ts`, in the same PR. `validate.ts` fails otherwise.
- A code listed with a later phase is reserved: nothing may produce it before that phase, and the row is completed by the issue that implements it.
- The fixed messages are in English. Localised messages (EN/AR, `docs/21-uae-gcc-strategy.md`) are a later addition keyed by code. The `code` is the stable identifier, never the message.

## Open

1. **Localisation of messages.** The default page and the JSON `message` are English in F1. Arabic messages keyed by code and `Accept-Language` are expected with the F2 default page; the mechanism (a second fixed table) is not designed yet.
2. **Rate limit (429).** Gateway rate limiting (`docs/23-failure-modes.md`, "Request flood from one IP") answers 429 with `Retry-After` and no code. The control API answers 429 with `RENOX_RATE_LIMITED` (F3); using the same code at the gateway would make it consistent with the others. This needs #22 to decide whether rate-limit responses carry a body at all, since a body costs bytes under a flood.
3. **`RENOX_BUSY` log volume.** One summary line per second is a proposal for #28 to confirm.

## Changelog

| Version | Issue | Changes |
| --- | --- | --- |
| 0 | #91 | First catalogue (F1) |
| 0.1 | #152 | Page (HTML) routes: the four error-template inputs, the fixed error-page render budget, the 404 page, and the fallback order (section 1). New rows: `RENOX_HOST_MISMATCH` (421, F2), `RENOX_CLIENT_EVENTS_DROPPED` (F2, dev overlay only) |
| 0.2 | #50 | Deploy API (F3): section "Control API" (`RENOX_VALIDATION`, `RENOX_UNAUTHENTICATED`, `RENOX_TOKEN_SCOPE`, `RENOX_NOT_FOUND`, `RENOX_CONFLICT`, `RENOX_RATE_LIMITED`); `RENOX_ACTIVATION_FAILED`, `RENOX_CLI_WORKER_UNVERIFIED`; `RENOX_DEPLOY_REJECTED` gains T1-T8 and its message; `RENOX_UNAVAILABLE` covers the deploy API |
