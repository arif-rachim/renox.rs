# Contract: runtime ops and the `ctx` surface

| | |
| --- | --- |
| Version | **1.0.0-f1** (F1, #17). The `-f1` tag is dropped (→ `1.0.0`) when the F1 runtime (#25) and SDK (#31) both implement it. History: "Changelog" at the bottom |
| Producer | `crates/renox-runtime` (P1): implements the ops |
| Consumers | `sdk/` (P10): types and the `ctx` wrapper; `crates/renox-cell` (P5): request envelope and meter record |
| TypeScript view | [`ctx.d.ts`](ctx.d.ts): the same surface, one to one |
| Machine-readable | [`ops.schema.json`](ops.schema.json): arguments, results, and errors of every op; examples under [`examples/ops/`](examples/ops/) (checked by `validate.ts`) |
| Error catalogue | `errors.md`: HTTP status, tenant guidance, and logged fields for every code in section 13 |
| Sources | `docs/07-app-model.md` ("The `ctx` surface"), `docs/06-data.md` ("The `db` API"), `docs/04-isolation-security.md` (limits, secrets, `fetch`), `docs/05-tenant-lifecycle.md` (metering), `bench/edge-runtime/NOTES.md` (what the pinned Edge Runtime offers) |

Ops are the only way tenant JavaScript reaches anything outside its isolate. Tenant code never calls an op directly: the runtime's bootstrap script wraps them into `ctx` (and into `console`, `fetch`). The op names are therefore a contract between Rust and the SDK, not a tenant API. A tenant sees only `ctx.d.ts`.

Every limit below is enforced in Rust (`AGENTS.md`, "Per-tenant limits must be enforced in Rust"). The numbers are the F1 values. An implementing issue that measures a reason to change one changes it here first, as a minor version (section 9).

## 0. Conventions

- **How ops are exposed.** Every op is a `deno_core` `#[op2]` function in one extension, `renox`, defined in `crates/renox-runtime` and added to the user-worker runtime that the crate builds on the pinned Supabase Edge Runtime (D3). Not a JavaScript shim over upstream APIs: the F0 spike (`bench/edge-runtime/NOTES.md`, "Per-worker limit options") shows the runtime has no per-request deadline, no egress byte limit, and no DNS-checked allowlist, and SQLite has no upstream op at all. If the pinned Edge Runtime cannot take an extra extension for user workers without a change, the patch lives in `crates/renox-runtime` and is listed in its notes. The extension's ESM bootstrap (section 11) is part of the platform snapshot.
- **Naming.** `op_<area>_<verb>`, snake_case, as registered with `deno_core`.
- **Async.** Every op that can wait on I/O returns a `Promise`. The runtime may resolve it synchronously when the work is already done; tenant code must not rely on that. `op_log`, `op_deadline_remaining_ms`, and `op_secrets_get_all` are synchronous.
- **Request scope.** Every op call is tied to the request whose handler made it. The dispatch wrapper (section 11, step 6) runs each handler inside a fresh **async context** that carries an opaque request token. The mechanism is V8's continuation-preserved embedder data, which `deno_core` exposes and Deno's `AsyncLocalStorage` uses. The token therefore follows every `await`, promise continuation, and timer created by that handler. Ops read the token from the current async context; it is never an op argument the SDK or tenant code supplies, so tenant code cannot act on behalf of another request. Rust keeps the set of live tokens per isolate. An op called with no token (module top level) or with the token of a request that has ended (a timer that fires after the response) rejects with `RENOX_NO_REQUEST`. The one exception is `op_log`, which then logs with `request_id: null`. `op_secrets_get_all` is consumed by the bootstrap before tenant code runs (section 3). Fallback: if #25 finds that the pinned runtime does not propagate the async context reliably, the cell admits **one in-flight request per isolate**, which makes the current request unambiguous. Concurrency (section 10) is then reached with more isolates per deployment, and every rule in this contract stays true.
- **Errors.** An op that fails rejects with a `RenoxError` whose `code` is one of the codes in section 13. Every code there also appears in `errors.md`, which owns HTTP status and tenant guidance, and `validate.ts` checks the sets. The SDK maps codes to the error subclasses in `ctx.d.ts`. An error message never contains a file path, an internal hostname or IP, a stack frame from Rust, or a secret value (`docs/23-failure-modes.md` rule 2).
- **Cancellation.** When the request's deadline passes or the CPU watchdog fires, every pending op of that request is cancelled. Pending promises reject with `RENOX_DEADLINE`, or are dropped with the isolate after `RENOX_CPU_LIMIT` or `RENOX_OOM` (section 10).
- **Values.** How arguments and results cross the boundary (`bigint`, `Uint8Array`, `null`, strings) is fixed in section 12.
- **Metering.** Each op adds to the invocation's meter record (section 7). Ops never return meter data to tenant code.

```ts
// Error shape every op rejects with (TypeScript view in ctx.d.ts).
interface RenoxErrorShape { name: string; code: string; message: string; details?: Record<string, unknown> }
```

## 1. Database: `op_db_*`

Backs `ctx.db` (`docs/06-data.md`, "The `db` API"). The connection is bound by the runtime to the tenant's own SQLite file and to the calling module's authorizer (`<module>__*` tables, read access to `<dep>__public_*` views). Neither the file nor the module is an argument.

### Signatures

| Op | Arguments | Result |
| --- | --- | --- |
| `op_db_query` | `sql: string, params: Param[], tx: number \| null` | `Row[]` |
| `op_db_query_one` | `sql: string, params: Param[], tx: number \| null` | `Row \| null` (first row; the statement stops after it) |
| `op_db_execute` | `sql: string, params: Param[], tx: number \| null` | `{ changes: number, lastInsertRowid: number \| bigint }` |
| `op_db_tx_begin` | `mode: "deferred" \| "immediate"` | `number` (transaction handle) |
| `op_db_tx_commit` | `tx: number` | `void` |
| `op_db_tx_rollback` | `tx: number` | `void` |

```ts
type Param = null | number | bigint | string | Uint8Array | boolean;
type Value = null | number | bigint | string | Uint8Array;
type Row = Record<string, Value>;
```

### Transactions: begin/commit/rollback, not a batch op

We pick explicit `op_db_tx_begin`/`commit`/`rollback` with a handle over a single `op_db_batch`. The reason is that `db.transaction(async (tx) => { ... })` in `docs/06-data.md` runs arbitrary JavaScript between statements: read a row, decide, then write. A batch op takes all statements up front and cannot express that. The costs of handles are bounded by these rules:

- The SDK's `db.transaction(fn)` is the only caller. It calls `begin`, runs `fn(tx)`, then `commit`, or `rollback` if `fn` throws. Handles never reach tenant code.
- One open write transaction per tenant file at a time (SQLite's own rule). `immediate` takes the write lock at `begin`; the SDK uses `immediate` for `db.transaction` so a read-then-write never fails with a busy upgrade.
- A handle belongs to one request. Statements with `tx = null` while a transaction is open on the same request run outside it on a reader connection.
- **Every open transaction of a request is rolled back by Rust when the request ends for any reason**: handler returned without commit, throw, deadline, CPU watchdog, or isolate disposal (`docs/23-failure-modes.md`, "Watchdog fires while a DB transaction is open", #89). The writer connection is released before the next request is admitted.
- Nesting: `tx_begin` while the request already holds a transaction rejects with `RENOX_DB_TX_STATE`. Savepoints are reserved (F4, module broker).

### Parameters and values

| JavaScript in (`Param`) | Binds as |
| --- | --- |
| `null` | `NULL` |
| `boolean` | `INTEGER` 1 / 0 |
| `number`, integer within ±(2^53 − 1) | `INTEGER` |
| `number`, any other finite value | `REAL` |
| `number`, `NaN` or ±`Infinity` | rejected: `RENOX_DB_PARAM` |
| `bigint` within i64 | `INTEGER`; outside i64 → `RENOX_DB_PARAM` |
| `string` | `TEXT` (UTF-8) |
| `Uint8Array` | `BLOB` (copied) |
| anything else (`undefined`, objects, `Date`) | rejected: `RENOX_DB_PARAM` with the parameter index |

| SQLite column out | JavaScript (`Value`) |
| --- | --- |
| `NULL` | `null` |
| `INTEGER` within ±(2^53 − 1) | `number` |
| `INTEGER` outside that range | `bigint` |
| `REAL` | `number` |
| `TEXT` | `string` |
| `BLOB` | `Uint8Array` (fresh copy) |

- Parameters are positional (`?`); the count must equal the statement's parameter count, else `RENOX_DB_PARAM`. Named parameters (`:name`, `$name`) are rejected.
- Rows are plain objects keyed by result column name, in column order. Two result columns with the same name reject with `RENOX_DB_COLUMN_NAME` (alias them). Silently dropping one would hide data.
- One statement per call. Trailing statements after the first `;` reject with `RENOX_DB_MULTI_STATEMENT`.

### Limits

| Limit | Value | Error |
| --- | --- | --- |
| Statement time | min(1 s, remaining deadline), enforced by `progress_handler` | `RENOX_DB_TIMEOUT` (transaction rolled back) |
| Busy wait for the write lock | min(`busy_timeout` 2 s, remaining deadline) | `RENOX_DB_BUSY` |
| Rows returned by one `op_db_query` | 10,000 | `RENOX_DB_RESULT_LIMIT` |
| Bytes returned by one call | 8 MB | `RENOX_DB_RESULT_LIMIT` |
| SQL text length | 100 KB | `RENOX_DB_PARAM` |
| Parameters per statement | 1,000 | `RENOX_DB_PARAM` |
| File size | tenant quota via `max_page_count` (100 MB free / 10 GB paid, `docs/04-isolation-security.md`) | `RENOX_DB_QUOTA` (reads continue) |

### Errors

| Code | SDK class | When |
| --- | --- | --- |
| `RENOX_DB_AUTH` | `DbPermissionError` (`details.table`, `details.action`) | `SQLITE_AUTH`: the authorizer refused a table, view, `ATTACH`, `PRAGMA`, or function outside the module's prefix |
| `RENOX_DB_BUSY` | `DbBusyError` | `SQLITE_BUSY` after the busy wait |
| `RENOX_DB_TIMEOUT` | `DbTimeoutError` | Statement time limit hit |
| `RENOX_DB_QUOTA` | `DbQuotaError` | `SQLITE_FULL` from `max_page_count` |
| `RENOX_DB_CONSTRAINT` | `DbConstraintError` (`details.kind`: `unique`, `foreign_key`, `not_null`, `check`, `primary_key`) | Constraint violation |
| `RENOX_DB_SQL` | `DbSqlError` | Syntax error, unknown column, other `SQLITE_ERROR`; message is SQLite's text with no file path |
| `RENOX_DB_PARAM`, `RENOX_DB_COLUMN_NAME`, `RENOX_DB_MULTI_STATEMENT`, `RENOX_DB_RESULT_LIMIT`, `RENOX_DB_TX_STATE` | `DbUsageError` | See above |

### Example

```ts
// SDK, not tenant code:
const rows = await op_db_query("select id, name from shop__products where org_id = ? limit ?", ["org_1", 50], null);
// -> [{ id: "p1", name: "Dates 1 kg" }, ...]
const tx = await op_db_tx_begin("immediate");
try {
  await op_db_execute("update shop__products set stock = stock - 1 where id = ? and stock > 0", ["p1"], tx);
  await op_db_tx_commit(tx);
} catch (e) { await op_db_tx_rollback(tx); throw e; }
```

## 2. Outbound HTTP: `op_fetch`

Backs the global `fetch` and `ctx.fetch` (both are the same function). Controls: `docs/04-isolation-security.md` ("Outbound network"), `docs/24-threat-model.md` section B (SSRF, DNS rebinding, TLS rows; #27, #108).

### Signatures

| Op | Arguments | Result |
| --- | --- | --- |
| `op_fetch` | `FetchRequest` | `FetchResponseHead` |
| `op_fetch_body_read` | `body: number` (resource id) | `Uint8Array \| null` (`null` = end of body) |
| `op_fetch_body_close` | `body: number` | `void` |

```ts
interface FetchRequest {
  method: string;                        // uppercased; CONNECT and TRACE are rejected
  url: string;                           // absolute http(s) URL
  headers: [string, string][];
  body: Uint8Array | null;               // streamed request bodies are reserved (F2)
  redirect: "follow" | "manual" | "error";
}
interface FetchResponseHead {
  status: number;
  statusText: string;
  headers: [string, string][];
  url: string;                           // final URL after redirects
  redirected: boolean;
  body: number | null;                   // resource id for op_fetch_body_read; null for no body
}
```

The SDK builds a standard `Response` from the head and a `ReadableStream` over `op_fetch_body_read`.

### Allowlist

Declared in `renox.toml` (per app; a module declares its own in its manifest and the tenant approves it at install):

```toml
[fetch]
allow = ["api.stripe.com", "*.tabby.ai", "graph.facebook.com:443", "http://legacy.example.com"]
```

- **Exact host**: `api.stripe.com` matches only that host. Matching is case-insensitive, after IDNA to ASCII, with a trailing dot removed.
- **Wildcard**: `*.tabby.ai` matches any subdomain at any depth (`api.tabby.ai`, `a.b.tabby.ai`) but not `tabby.ai` itself. A bare `*` and wildcards in any other position are rejected at deploy time.
- **Scheme**: `https` only, unless the entry is written `http://host`, which allows plain HTTP for that host (`docs/24-threat-model.md`, TLS row).
- **Port**: 443 for `https`, 80 for `http://` entries, unless the entry names a port.
- An IP literal URL is allowed only if that exact literal is in the list, and it is still checked against the blocked ranges.
- No allowlist means no outbound network at all.

### Order of checks (every hop)

1. Parse the URL. Scheme, host, and port must match an allowlist entry. Otherwise reject with `reason: "not_allowlisted"`, `"scheme"`, or `"port"`.
2. Resolve DNS in Rust. **Every** resolved address is checked against the blocked ranges below; if any address is blocked, the request is rejected (`reason: "blocked_address"`). Failing closed avoids depending on which address happy-eyeballs would pick.
3. Connect to one of the **already-checked** socket addresses: no second resolution (DNS rebinding, #108). TLS: rustls with webpki roots, SNI = the URL host. Tenants have no option to skip certificate checks.
4. On a 3xx with `redirect: "follow"`, repeat 1–3 for the `Location` target. At most 5 hops (`reason: "redirect_limit"`). `https` → `http` is allowed only to a host declared with `http://`. `Authorization`, `Cookie`, and `Proxy-Authorization` are dropped when the origin changes. With `"manual"` the 3xx is returned as is; with `"error"` it rejects with `RENOX_FETCH_FAILED`.

### Blocked ranges

The address is normalised first: IPv4-mapped (`::ffff:a.b.c.d`), IPv4-compatible (`::a.b.c.d`), NAT64 (`64:ff9b::/96`, `64:ff9b:1::/48`) and 6to4 (`2002::/16`) addresses are checked as the IPv4 address they embed.

| IPv4 | Why |
| --- | --- |
| `0.0.0.0/8` | "This network" |
| `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` | Private |
| `100.64.0.0/10` | CGNAT (shared address space) |
| `127.0.0.0/8` | Loopback |
| `169.254.0.0/16` | Link-local, including the metadata endpoint `169.254.169.254` |
| `192.0.0.0/24`, `192.0.2.0/24`, `198.18.0.0/15`, `198.51.100.0/24`, `203.0.113.0/24` | IETF protocol assignments, documentation, benchmarking |
| `224.0.0.0/4` | Multicast |
| `240.0.0.0/4`, `255.255.255.255/32` | Reserved, broadcast |

| IPv6 | Why |
| --- | --- |
| `::/128`, `::1/128` | Unspecified, loopback |
| `fc00::/7` | Unique local, including the AWS metadata endpoint `fd00:ec2::254` |
| `fe80::/10` | Link-local |
| `ff00::/8` | Multicast |
| `100::/64` | Discard |
| `2001:db8::/32` | Documentation |
| `2001::/23` | IETF protocol assignments (includes Teredo `2001::/32`) |

The node's own public addresses and the control plane's addresses are also blocked (configured per node, not hard-coded here).

### Limits

| Limit | Value | Error |
| --- | --- | --- |
| Time | Bound to the request deadline: the whole fetch (DNS, connect, TLS, every hop, body read) must finish before `op_deadline_remaining_ms()` reaches 0 | `RENOX_DEADLINE` |
| Egress bytes per request | Sum of request bytes sent and response bytes received over all fetches of the request: 10 MB free / 100 MB paid | `RENOX_FETCH_EGRESS_LIMIT` (stream aborted mid-body) |
| Concurrent fetches per request | 16 | `RENOX_FETCH_FAILED` (`reason: "concurrency"`) |
| Request headers | 64 headers, 16 KB total | `RENOX_FETCH_FAILED` (`reason: "headers"`) |

### Errors

| Code | SDK class | Details |
| --- | --- | --- |
| `RENOX_FETCH_BLOCKED` | `FetchBlockedError` | `{ host, reason }`, `reason` ∈ `not_allowlisted`, `scheme`, `port`, `blocked_address`, `redirect_limit`, `method`. The resolved IP is **not** included |
| `RENOX_FETCH_FAILED` | `FetchError` | `{ host, reason }`, `reason` ∈ `dns`, `connect`, `tls`, `reset`, `redirect`, `concurrency`, `headers` |
| `RENOX_FETCH_EGRESS_LIMIT` | `FetchEgressLimitError` | `{ host, limitBytes }` |
| `RENOX_DEADLINE` | `DeadlineError` | — |

Bytes are counted on the wire as `fetch_sent_bytes` and `fetch_received_bytes` (`meter.md`), and their sum is checked against the egress limit. Every blocked attempt increments `fetch_blocked` in the meter record and is logged with `tenant_id`, `request_id`, host, and reason (`docs/24-threat-model.md` rule 4).

### Example

```ts
await fetch("http://169.254.169.254/latest/meta-data/");
// rejects: FetchBlockedError { code: "RENOX_FETCH_BLOCKED", details: { host: "169.254.169.254", reason: "not_allowlisted" } }
// with "169.254.169.254" in the allowlist it would still reject with reason "blocked_address".
```

## 3. Secrets: `op_secrets_get_all`

| Op | Arguments | Result |
| --- | --- | --- |
| `op_secrets_get_all` | — | `Readonly<Record<string, string>>` |

- Called **once** by the runtime bootstrap at isolate creation, before any tenant module is evaluated (section 11, step 3; `docs/04-isolation-security.md`, "Secrets"). The bootstrap freezes the object and exposes it as `ctx.secrets` on every request. Top-level module code has no `ctx` and therefore no secrets. A second call rejects with `RENOX_SECRETS_CONSUMED`. The op table itself is unreachable from tenant code (section 11, step 2), so this is defence in depth.
- Secret values shorter than 8 bytes are refused when secrets are loaded: by the worker in F1, which fails isolate creation with `RENOX_INTERNAL` and logs the secret's **name**, and by `renox secrets set` from F3 (#115). Redacting very short strings would mangle every log line, and refusing them keeps the redaction rule exact.
- Contains only the secrets the app (or module) declares in `renox.toml` and the tenant has set. A declared but unset secret is absent: no `undefined` key, no empty string. A marketplace module sees only its own declared and approved secrets.
- Values are decrypted in Rust from the deployment's secret bundle. They never appear in the artifact, the bundle, or any op argument.
- **Redaction.** Rust keeps the set of secret values of the isolate. Every string that leaves the isolate towards a log or error sink is scanned before it is written: `op_log` message and fields, uncaught errors and their stacks, and `RenoxError` messages built from tenant input. Each occurrence of a secret value is replaced with `[redacted]`. Matching is on exact substrings of the UTF-8 value. Encoded forms (base64, URL-encoded, split across lines) are **not** caught, and this is a documented limitation of version 1, not an open point: tenant code that encodes a secret before logging it is logging it on purpose. Responses to end users are not scanned (cost). The dispatch wrapper never puts error text into a response: the `RENOX_INTERNAL` body has only the fixed message from `errors.md`.

```ts
ctx.secrets.STRIPE_KEY;               // "sk_live_…" (only if declared and set)
Object.isFrozen(ctx.secrets);         // true
console.log(`key=${ctx.secrets.STRIPE_KEY}`);  // tenant log sink receives "key=[redacted]"
```

## 4. Logging: `op_log`

| Op | Arguments | Result |
| --- | --- | --- |
| `op_log` | `level: "debug" \| "info" \| "warn" \| "error", message: string, fields: Record<string, JsonValue> \| null` | `void` (never throws) |

- Backs `ctx.log.{debug,info,warn,error}` and `console.*` (`console.log` → `info`, `console.debug` → `debug`, `console.warn` → `warn`, `console.error` → `error`). Non-string `console` arguments are formatted by the bootstrap before the op is called.
- Rust adds `ts`, `tenant_id`, `deployment_hash`, `request_id`, `module`, and `level`. Tenant fields with those names are moved under `fields.user_<name>`, so tenant code cannot spoof them.
- Secret values are redacted as in section 3.
- Limits: message 8 KB, serialized fields 16 KB. Longer values are truncated with a `…[truncated N bytes]` suffix.
- Rate limit per tenant: 1,000 lines per minute free / 10,000 paid. Over the limit, lines are **dropped**, not queued. `logs_dropped` in the meter record counts them, and one summary line `{"dropped": N}` is written when the window resets. Dropping never blocks or fails the handler.
- Outside a request (module top level) the line is attributed to the deployment with `request_id: null`.

## 5. Deadline: `op_deadline_remaining_ms`

| Op | Arguments | Result |
| --- | --- | --- |
| `op_deadline_remaining_ms` | — | `number`: whole milliseconds left before the request's wall-clock deadline, ≥ 0 |

- The deadline is set at the gateway as a duration and propagated, so a skewed clock cannot extend it (`docs/23-failure-modes.md`, clock skew row). Defaults: 30 s free / 60 s paid (`docs/04-isolation-security.md`).
- Wall clock, not CPU. The CPU limit (50 ms / 500 ms) is separate, is not observable from JavaScript, and ends the isolate with `RENOX_CPU_LIMIT` (section 10).
- What happens when the deadline passes is section 10, "Wall-clock deadline".
- The value is coarsened to whole milliseconds, consistent with the coarse-timer rule against side channels.
- Backs `ctx.deadline.remainingMs()`.

## 6. Request envelope and handler shape

### What the runtime hands to the handler

The cell (P5) builds a Web API `Request` for each invocation and calls the matching export with `ctx`:

| `ctx` field (F1) | Type | Source |
| --- | --- | --- |
| `req` | `Request` | Method, absolute URL (`https://<host><path>?<query>`), headers, body stream |
| `url` | `URL` | `new URL(req.url)` |
| `params` | `Record<string, string \| string[]>` | Route parameters from the file path (`[id]` → string, `[...slug]` → string[]) |
| `headers` | `Headers` | Same object as `req.headers` |
| `db`, `fetch`, `secrets`, `log`, `deadline` | see sections 1–5 | |

Headers: hop-by-hop headers are removed. Any `x-renox-*` header sent by the client is removed, and then the gateway sets `x-renox-request-id` and `x-renox-client-ip`, so tenant code can trust those two. The body is limited by the gateway (1 MB default, `RENOX_BODY_TOO_LARGE`) before the isolate sees it.

### Handler exports

Functions (`functions/**/*.ts`, F1): named exports per HTTP method.

```ts
export const GET: Handler = (ctx) => Response.json({ ok: true });
export const POST: Handler = async ({ req, db }) => { /* ... */ return new Response(null, { status: 201 }); };
```

- Supported names: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`. `HEAD` is served by `GET` with the body dropped, unless `HEAD` is exported.
- A method with no export → 405 with an `Allow` header listing the exported methods.
- The handler must return (or resolve to) a `Response`. Anything else → 500 `RENOX_INTERNAL`, and the reason goes to the tenant log only.
- A throw → 500 `RENOX_INTERNAL` with the request id; the error and its stack (redacted) go to the tenant log sink only.

Reserved exports: `load`, `actions`, `guard` for pages (F2); `ws` for WebSocket (F5); `sse` (F5); `schedule` for jobs (F6); `cors` and `frame` options (F2).

## 7. Meter record (emitted, not an op)

The runtime and cell emit one record per invocation (`docs/05-tenant-lifecycle.md`, "Metering and billing"). The schema itself is owned by [`meter.md`](meter.md) (#16). This contract only fixes which fields the runtime is responsible for filling:

| Field | Filled by | From |
| --- | --- | --- |
| `request_id`, `tenant_id`, `deployment_hash`, `route`, `started_at` | cell | Routing |
| `wall_ms`, `ingress_bytes`, `egress_bytes`, `http_status`, `status` | cell | Request and response streams; section 13 maps codes to `status` |
| `cpu_ms`, `peak_heap_bytes` | runtime | Per-request thread CPU accounting (section 10), V8 heap statistics |
| `fetch_sent_bytes`, `fetch_received_bytes`, `fetch_blocked` | runtime | `op_fetch` |
| `db_ms`, `db_rows` | runtime | `op_db_*` |
| `render_fuel` | runtime | Reserved (F2), 0 in F1 |
| `logs_dropped` | runtime | `op_log` |

Types, units, and the `status` values are defined in [`meter.md`](meter.md) section 2.

## 8. Reserved ops and `ctx` fields

Not part of F1. Names are reserved so nothing else takes them.

| `ctx` field / op area | Phase |
| --- | --- |
| `form`, `render` (`op_render_*`), `webhook` (`verify`), streamed `fetch` request bodies | F2 |
| `kv` (`op_kv_*`) | F2 |
| `auth`, `session` (from the `auth` module), `config`, `events` (`op_events_emit`), `hooks` (`op_hooks_run`), savepoints in `db` | F4 |
| `authz` (`op_authz_*`), `realtime` (`op_realtime_*`), `db.scoped()` | F5 |
| `datasource(name)` (`op_datasource_*`) | F6–F7 |
| `ai` (`op_ai_*`), `domains` (`op_domains_*`) | F7 |
| `offload` | not scheduled |

## 9. Versioning

- This contract carries a version `MAJOR.MINOR.PATCH` (the table at the top), with a phase tag (`-f1`) while it is not yet implemented on both sides. The runtime exposes the major number as `op_contract_version() -> number` (sync, reserved name), and the SDK refuses to start when it differs from the major it was built for.
- **Minor** (additive): a new op, a new optional argument at the end, a new error code, a new `ctx` field moved out of "reserved", a changed limit value.
- **Patch**: wording and examples, no behaviour change.
- **Major** (breaking): renaming or removing an op, changing an argument or result type, changing a value mapping, changing the meaning of an error code. A breaking change lands as one PR that touches this file, `ctx.d.ts`, `ops.schema.json`, `crates/renox-runtime`, and `sdk/` together.
- Version 0 (the F0 sketch) was never implemented, so the move to 1.0.0 needs no migration.
- Contract edits are made only by `type:contract` issues (`docs/22-development-plan.md`, section 3).


## 10. Limits per tier and behaviour on limit

Defaults from `docs/04-isolation-security.md`, "Per-tenant limits". An app may lower them in its manifest (`artifact.md` section 3, "Limits overrides") but never raise them.

| Limit | Free | Paid | Enforced by |
| --- | --- | --- | --- |
| CPU per request | 50 ms | 500 ms | Per-request CPU accounting + watchdog thread → `TerminateExecution` |
| Wall clock per request | 30 s | 60 s | Deadline set at the gateway as a duration, propagated to every op |
| V8 heap per isolate | 128 MB | 512 MB | V8 heap limit + near-heap-limit callback |
| Concurrent requests per deployment | 50 | 500 | Semaphore in the cell |
| Module evaluation at isolate start (section 11, step 4) | 500 ms CPU, 10 s wall | 5 s CPU, 10 s wall | Same watchdog and deadline as requests |

What happens on each limit:

| Limit hit | Tenant code sees | Response to the client | Meter `status` | Isolate |
| --- | --- | --- | --- | --- |
| **CPU** | Nothing: execution stops | 503 `RENOX_CPU_LIMIT` | `cpu_limit` | **Recycled.** `TerminateExecution` leaves the isolate in an unknown state, so it is marked poisoned, every other in-flight request on it also ends with 503 `RENOX_CPU_LIMIT` (they share the heap that was interrupted), open transactions are rolled back (#89), and the isolate is disposed. The next request creates a fresh isolate from the snapshot |
| **Heap** | Nothing: execution stops | 503 `RENOX_OOM` | `oom` | **Recycled.** The near-heap-limit callback raises the limit temporarily so V8 does not abort the process, then terminates. The isolate is disposed on its own thread, as for CPU, and so are the other in-flight requests (503 `RENOX_OOM`) |
| **Wall clock** | Pending ops reject with `RENOX_DEADLINE`; later ops of that request reject with `RENOX_NO_REQUEST` | 504 `RENOX_DEADLINE`, sent at the deadline whatever the handler does afterwards; a `Response` the handler returns later is discarded | `timeout` | **Kept.** JavaScript that is still running synchronously at the deadline is caught by the CPU limit, which is always shorter |
| **Concurrency** | Nothing (no tenant code runs) | 503 `RENOX_BUSY` with `Retry-After: 1`, after queueing up to the request's deadline (`docs/23-failure-modes.md`, "Too many concurrent requests") | `busy` | Kept |
| **Module evaluation** (CPU, wall, or a throw) | — | 503 `RENOX_CPU_LIMIT`, 504 `RENOX_DEADLINE`, or 500 `RENOX_INTERNAL` for every request waiting on that isolate | the matching status | Isolate creation fails. The failure is cached per deployment for 5 s, so a broken deployment does not rebuild an isolate on every request. One log line with `phase: "module_load"` per failure |

Per-request CPU accounting: the runtime reads the isolate thread's CPU clock (`CLOCK_THREAD_CPUTIME_ID`) each time execution enters and leaves JavaScript or a synchronous op. It charges each slice to the request whose async context (section 0, "Request scope") is current. The watchdog thread checks the running slice every 1 ms and terminates when the request's total would exceed its limit. Overshoot is bounded by that interval plus V8's interrupt latency, and the limits test asserts termination before 2× the limit. The same total is the meter's `cpu_ms`.

Mapping to the pinned Edge Runtime's per-worker options (`bench/edge-runtime/NOTES.md`): the V8 heap limit is `memoryLimitMb`. `cpuTimeSoftLimitMs`, `cpuTimeHardLimitMs`, and `workerTimeoutMs` are cumulative per worker, not per request, so they are **not** used for these limits. #25 sets them so they never fire before the per-request watchdog. Idle eviction (10 minutes, `docs/05-tenant-lifecycle.md`) belongs to the cell.

Per-op limits (statement time, rows, egress bytes, concurrent fetches, log rate) are in each op's section above.

## 11. Isolate bootstrap

The sequence from an empty worker to a dispatched request. Each step finishes before the next starts, and a failure in steps 1–5 is a module-evaluation failure (section 10).

1. **Worker and platform snapshot.** The cell creates a user worker for the deployment:
   - Deno permissions all **denied** (`net`, `read`, `write`, `env`, `run`, `ffi`, `sys`, `import`), so nothing upstream can open a socket or file on the tenant's behalf. `op_fetch` and `op_db_*` are not permission-gated; they enforce their own rules.
   - `envVars` empty, no remote modules, no npm resolution at runtime (dependencies are inside the artifact), and the module root is the artifact's `code/`.
   - The isolate starts from the platform snapshot: Web APIs plus the `renox` extension's ESM bootstrap.
2. **Capture and harden.** The bootstrap takes the op functions it needs into private closures, then changes the global scope as in the table below. After this step tenant code cannot reach `Deno.core` or the op table.
3. **Secrets.** The bootstrap calls `op_secrets_get_all` once, freezes the result, and keeps it in a closure (section 3).
4. **Tenant modules.** The runtime imports every module listed in `manifest.code.entry` (`artifact.md` section 3): files under `code/` for `esm-dir`, or `file:///<path>` inside `bundle.eszip` for `eszip`. Top-level module code runs here, outside any request: `console` works (logged with `request_id: null`); `fetch`, `ctx.db` and the other ops reject with `RENOX_NO_REQUEST`. The module-evaluation limits of section 10 apply.
5. **Handler lookup.** For each `manifest.routes[]` entry, the bootstrap checks that the module's `export` is a function and builds the matcher of `artifact.md` section 3 ("Route objects"). A missing or non-function export fails the deployment as a whole (fail closed, `RENOX_INTERNAL`, logged with the route). `renox check` catches it before deploy.
6. **Request dispatch.** For each request, Rust calls the bootstrap's dispatch function with a fresh request token, the matched route, the route parameters, and the request head and body stream. The bootstrap:
   - enters a new async context carrying the token;
   - builds the `Request` and a frozen per-request `ctx` (section 6);
   - calls the handler and awaits a `Response`;
   - checks it, and streams it back.
   When the request ends for any reason, Rust:
   - invalidates the token;
   - rolls back the request's open transactions;
   - closes its open fetch bodies;
   - cancels its pending ops.

Changes to the global scope (step 2):

| Global | Treatment | Why |
| --- | --- | --- |
| `Deno` | Deleted from `globalThis` | File system, environment, sockets, subprocesses; permissions deny them anyway, and the namespace leaks platform details |
| `EdgeRuntime` and other upstream control globals | Deleted | Worker and pool control belong to the platform |
| `SharedArrayBuffer` | Absent. The runtime sets the V8 flag `--enable-sharedarraybuffer-per-context` and never enables it for tenant contexts, so shared `WebAssembly.Memory` is rejected too. `Atomics` stays (harmless without shared memory) | High-resolution timers for Spectre-class side channels (`docs/04-isolation-security.md`) |
| `performance.now()`, `performance.timeOrigin` | Coarsened to whole milliseconds | Same; `Date.now()` already has millisecond resolution |
| `fetch` | Replaced by the `op_fetch`-backed implementation (section 2); identical to `ctx.fetch` | Allowlist and blocked ranges |
| `console` | Replaced by the `op_log`-backed implementation (section 4) | Redaction, rate limit, tenant attribution |
| `WebSocket`, `WebSocketStream`, `EventSource` | Deleted | Outbound connections that would bypass `op_fetch`. Inbound WebSocket is F5 |
| `caches`, `localStorage`, `sessionStorage`, `indexedDB` | Deleted | No persistence except `ctx.db` (docs/04: "Filesystem: none") |
| `process.env` (from `node:process`) | Empty frozen object | No host environment |
| `node:` modules that open sockets or files (`node:net`, `node:http` client, `node:fs`, `node:dns`, `node:child_process`, `node:worker_threads`) | Importable, but every I/O call fails with Deno's permission error | Fail closed. npm clients that use `fetch` work; clients built on `node:http` do not (B17 used no such client) |
| `eval`, `new Function`, `WebAssembly.compile` | Kept | npm packages depend on them; the code still runs inside the isolate's limits |
| `setTimeout`, `setInterval` | Kept | A timer that outlives its request runs without a request: ops reject with `RENOX_NO_REQUEST`. Timers are dropped with the isolate |
| `ctx`, `ctx.secrets` | Frozen; a new `ctx` per request | Tenant code cannot replace platform objects |

Built-in prototypes are **not** frozen: npm packages patch them, and module contexts are shared per deployment by design (`docs/07-app-model.md`, "State rules").

## 12. Serialisation across the op boundary

| JavaScript | Crosses as | Rule |
| --- | --- | --- |
| `null` | `null` / `Option::None` | Ops return `null`, never `undefined`. For optional arguments the SDK passes `null` |
| `undefined` | — | Rejected where a value is expected (`RENOX_DB_PARAM` for SQL parameters). Dropped from `op_log` fields |
| `boolean` | `bool` | SQL: `INTEGER` 1/0 (section 1) |
| `number` | `f64`, or `i64` when it is an integer within ±(2^53 − 1) | `NaN` and ±`Infinity` are rejected as SQL parameters. A SQL `INTEGER` outside ±(2^53 − 1) comes back as `bigint` (section 1) |
| `bigint` | `i64` | Outside i64 → `RENOX_DB_PARAM`. In `op_log` fields the bootstrap converts it to a decimal string, since `JsonValue` has no bigint |
| `string` | UTF-8 `String` | Lone UTF-16 surrogates cannot be UTF-8: rejected as SQL parameters (`RENOX_DB_PARAM`), replaced with U+FFFD in log messages and fields. Fetch header names and values must be byte strings, and the SDK throws a `TypeError` before the op is called |
| `Uint8Array` (and subclasses such as `Buffer`) | Byte buffer, **copied** in both directions | Rust never keeps a view into a JavaScript buffer, and JavaScript never receives a view into Rust memory. Other typed arrays, `ArrayBuffer`, and `DataView` are rejected as SQL parameters. The SDK converts any `fetch` `BodyInit` to one `Uint8Array` |
| Plain objects | Typed structs via `serde_v8` | Unknown properties are ignored; missing required properties reject with the op's usage error |
| Values in `op_log` fields | `JsonValue` | The bootstrap converts: `bigint` → string, `Uint8Array` → `"[N bytes]"`, `Error` → `{ name, message, stack }` (redacted), cycles → `"[circular]"`, functions and symbols dropped |

The `$bigint` and `$bytes` wrappers in `ops.schema.json` exist only to write examples as JSON. They are not a wire format: values cross the boundary as V8 values.

## 13. Error codes

One table, shared by Rust (`crates/renox-runtime`, `crates/renox-cell`) and TypeScript (`ctx.d.ts`, `sdk/`). Every code here appears in `errors.md`, with its HTTP status, what the end user sees, what is logged, and what the tenant should do. "Thrown" codes reject an op promise inside tenant code and are the `RenoxErrorCode` type in `ctx.d.ts`. "Response" codes are produced by the platform when a request ends and are the `ResponseErrorCode` type. `RENOX_DEADLINE` is both.

| Code | Kind | Raised by | Thrown as (SDK class) | If the request ends with it | Meter `status` |
| --- | --- | --- | --- | --- | --- |
| `RENOX_DB_AUTH` | thrown | `op_db_*` | `DbPermissionError` | uncaught → 500 `RENOX_INTERNAL` | `error` |
| `RENOX_DB_BUSY` | thrown | `op_db_*` | `DbBusyError` | uncaught → 500 `RENOX_INTERNAL` | `error` |
| `RENOX_DB_TIMEOUT` | thrown | `op_db_*` | `DbTimeoutError` | uncaught → 500 `RENOX_INTERNAL` | `error` |
| `RENOX_DB_QUOTA` | thrown | `op_db_*` | `DbQuotaError` | uncaught → 500 `RENOX_INTERNAL` | `error` |
| `RENOX_DB_CONSTRAINT` | thrown | `op_db_*` | `DbConstraintError` | uncaught → 500 `RENOX_INTERNAL` | `error` |
| `RENOX_DB_SQL` | thrown | `op_db_*` | `DbSqlError` | uncaught → 500 `RENOX_INTERNAL` | `error` |
| `RENOX_DB_PARAM` | thrown | `op_db_*` | `DbUsageError` | uncaught → 500 `RENOX_INTERNAL` | `error` |
| `RENOX_DB_COLUMN_NAME` | thrown | `op_db_*` | `DbUsageError` | uncaught → 500 `RENOX_INTERNAL` | `error` |
| `RENOX_DB_MULTI_STATEMENT` | thrown | `op_db_*` | `DbUsageError` | uncaught → 500 `RENOX_INTERNAL` | `error` |
| `RENOX_DB_RESULT_LIMIT` | thrown | `op_db_*` | `DbUsageError` | uncaught → 500 `RENOX_INTERNAL` | `error` |
| `RENOX_DB_TX_STATE` | thrown | `op_db_*` | `DbUsageError` | uncaught → 500 `RENOX_INTERNAL` | `error` |
| `RENOX_FETCH_BLOCKED` | thrown | `op_fetch` | `FetchBlockedError` | uncaught → 500 `RENOX_INTERNAL` | `blocked_fetch` |
| `RENOX_FETCH_FAILED` | thrown | `op_fetch` | `FetchError` | uncaught → 500 `RENOX_INTERNAL` | `error` |
| `RENOX_FETCH_EGRESS_LIMIT` | thrown | `op_fetch`, `op_fetch_body_read` | `FetchEgressLimitError` | uncaught → 500 `RENOX_INTERNAL` | `error` |
| `RENOX_NO_REQUEST` | thrown | any op outside a live request | `RenoxError` | — (there is no request to end) | — |
| `RENOX_SECRETS_CONSUMED` | thrown | `op_secrets_get_all` after bootstrap | `RenoxError` | uncaught → 500 `RENOX_INTERNAL` | `error` |
| `RENOX_DEADLINE` | both | deadline (section 10) | `DeadlineError` | 504 `RENOX_DEADLINE` | `timeout` |
| `RENOX_CPU_LIMIT` | response | CPU watchdog | — | 503 `RENOX_CPU_LIMIT` | `cpu_limit` |
| `RENOX_OOM` | response | heap limit | — | 503 `RENOX_OOM` | `oom` |
| `RENOX_BUSY` | response | cell concurrency semaphore | — | 503 `RENOX_BUSY` + `Retry-After` | `busy` |
| `RENOX_INTERNAL` | response | dispatch wrapper: handler threw, returned a non-`Response`, or module evaluation failed | — | 500 `RENOX_INTERNAL` | `error` |
| `RENOX_BODY_TOO_LARGE` | response | gateway body limit (section 6) | — | 413 `RENOX_BODY_TOO_LARGE` | no record (`meter.md` section 1) |

"Uncaught" means the error propagated out of the handler. Tenant code that catches an op error and returns its own `Response` ends the request normally (`status: ok`). The error body format of platform responses (`{ error: { code, request_id, message } }` for API routes) is defined in `errors.md`.

## Verification by implementing issues

These are not open design questions. Each is a decided rule with a decided fallback, and the named issue proves it with a test:

1. **Async context propagation** (section 0, "Request scope"): #25 proves that the request token survives `await`, timers, and promise continuations on the pinned runtime. Otherwise the cell uses the fallback, one in-flight request per isolate.
2. **Extension on user workers** (section 0, "How ops are exposed"): #25 adds the `renox` extension to the pinned Edge Runtime's user workers, with a patch in `crates/renox-runtime` if needed.
3. **Limit values**: #18–#21 (data), #27 (fetch), #28 (logs and secrets) assert the numbers in their tests. A change goes through this file as a minor version.
4. **`x-renox-client-ip`** (section 6): the header name is fixed here. #22 decides which proxies are trusted to supply the client address.

## Future (additive, not scheduled)

- `op_db_query_raw` returning `{ columns, rows: Value[][] }` if B9/B10 show that building row objects dominates.
- Redaction of common encodings of secret values (section 3), if a cheap way is found.
- Tenant response body limits (streamed vs buffered) belong to the cell (#28, #89), not to this contract.

## Changelog

| Version | Issue | Changes |
| --- | --- | --- |
| 0 | #12 | First sketch (F0): db, fetch, secrets, log, deadline, request envelope, meter fields, reserved ops |
| 1.0.0-f1 | #17 | **Exposure:** `op2` extension `renox` in `crates/renox-runtime` (section 0). **Request scope:** carried by the async context, with the one-request-per-isolate fallback; only `op_log` works outside a request (section 0). **Secrets:** consumed before tenant code runs; values under 8 bytes refused; exact-substring redaction stated as a limitation (section 3). **New sections:** limits per tier and behaviour on each limit (section 10), isolate bootstrap and global hardening (section 11), serialisation rules (section 12), shared error code table, with response codes `RENOX_CPU_LIMIT`, `RENOX_OOM`, `RENOX_BUSY`, `RENOX_INTERNAL`, `RENOX_BODY_TOO_LARGE` alongside the thrown codes (section 13). **Numbers:** every "proposed" value is now the F1 value. **Meter fields:** section 7 renamed to the names in `meter.md` (`route`, `fetch_sent_bytes`, `fetch_received_bytes`, `http_status`, `ingress_bytes`). **Versioning:** moved to `MAJOR.MINOR.PATCH` (section 9). **Open list:** replaced by "Verification by implementing issues" and "Future" |
