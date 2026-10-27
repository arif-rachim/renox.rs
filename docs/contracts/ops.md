# Contract: runtime ops and the `ctx` surface

| | |
| --- | --- |
| Version | **0** (draft, F0). Becomes 1 when the F1 runtime (#25) and SDK (#31) both implement it |
| Producer | `crates/renox-runtime` (P1): implements the ops |
| Consumers | `sdk/` (P10): types and the `ctx` wrapper; `crates/renox-cell` (P5): request envelope and meter record |
| TypeScript view | [`ctx.d.ts`](ctx.d.ts): the same surface, one to one |
| Machine-readable | [`ops.schema.json`](ops.schema.json): arguments, results, and errors of every op; examples under [`examples/ops/`](examples/ops/) |
| Sources | `docs/07-app-model.md` ("The `ctx` surface"), `docs/06-data.md` ("The `db` API"), `docs/04-isolation-security.md` (limits, secrets, `fetch`), `docs/05-tenant-lifecycle.md` (metering) |

Ops are the only way tenant JavaScript reaches anything outside its isolate. Tenant code never calls an op directly: the runtime's bootstrap script wraps them into `ctx` (and into `console`, `fetch`). The op names are therefore a contract between Rust and the SDK, not a tenant API. A tenant sees only `ctx.d.ts`.

Every limit below is enforced in Rust (`AGENTS.md`, "Per-tenant limits must be enforced in Rust"). Numbers marked *proposed* are defaults this contract suggests. The issue that implements the op confirms them (see "Open").

## 0. Conventions

- **Naming.** `op_<area>_<verb>`, snake_case, as registered with `deno_core`.
- **Async.** Every op that can wait on I/O returns a `Promise`. The runtime may resolve it synchronously when the work is already done; tenant code must not rely on that. `op_log`, `op_deadline_remaining_ms`, and `op_secrets_get_all` are synchronous.
- **Request scope.** Every op call is tied to the request whose handler made it. The runtime knows the current request; it is never an op argument, so tenant code cannot act on behalf of another request. Calls made outside a request (top-level module code at isolate start) may use only `op_log` and `op_secrets_get_all`; others throw `RENOX_NO_REQUEST`.
- **Errors.** An op that fails rejects with a `RenoxError` whose `code` is one of the codes below. The codes are a subset of `docs/contracts/errors.md` (#91, which owns HTTP status and tenant guidance). The SDK maps codes to the error subclasses in `ctx.d.ts`. An error message never contains a file path, an internal hostname or IP, a stack frame from Rust, or a secret value (`docs/23-failure-modes.md` rule 2).
- **Cancellation.** When the request's deadline passes or the CPU watchdog fires, every pending op of that request is cancelled. Pending promises reject with `RENOX_DEADLINE`, or are dropped with the isolate after `RENOX_CPU_LIMIT`.
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
| Statement time | min(1 s *proposed*, remaining deadline), enforced by `progress_handler` | `RENOX_DB_TIMEOUT` (transaction rolled back) |
| Busy wait for the write lock | min(`busy_timeout` 2 s *proposed*, remaining deadline) | `RENOX_DB_BUSY` |
| Rows returned by one `op_db_query` | 10,000 *proposed* | `RENOX_DB_RESULT_LIMIT` |
| Bytes returned by one call | 8 MB *proposed* | `RENOX_DB_RESULT_LIMIT` |
| SQL text length | 100 KB *proposed* | `RENOX_DB_PARAM` |
| Parameters per statement | 1,000 *proposed* | `RENOX_DB_PARAM` |
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
| Egress bytes per request | Sum of request bytes sent and response bytes received over all fetches of the request: 10 MB free / 100 MB paid *proposed* | `RENOX_FETCH_EGRESS_LIMIT` (stream aborted mid-body) |
| Concurrent fetches per request | 16 *proposed* | `RENOX_FETCH_FAILED` (`reason: "concurrency"`) |
| Request headers | 64 headers, 16 KB total *proposed* | `RENOX_FETCH_FAILED` (`reason: "headers"`) |

### Errors

| Code | SDK class | Details |
| --- | --- | --- |
| `RENOX_FETCH_BLOCKED` | `FetchBlockedError` | `{ host, reason }`, `reason` ∈ `not_allowlisted`, `scheme`, `port`, `blocked_address`, `redirect_limit`, `method`. The resolved IP is **not** included |
| `RENOX_FETCH_FAILED` | `FetchError` | `{ host, reason }`, `reason` ∈ `dns`, `connect`, `tls`, `reset`, `redirect`, `concurrency`, `headers` |
| `RENOX_FETCH_EGRESS_LIMIT` | `FetchEgressLimitError` | `{ host, limitBytes }` |
| `RENOX_DEADLINE` | `DeadlineError` | — |

Every blocked attempt increments `fetch_blocked` in the meter record and is logged with `tenant_id`, `request_id`, host, and reason (`docs/24-threat-model.md` rule 4).

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

- Called **once** by the runtime bootstrap at isolate creation (`docs/04-isolation-security.md`, "Secrets"). The bootstrap freezes the object and exposes it as `ctx.secrets` on every request. A second call rejects with `RENOX_SECRETS_CONSUMED`, so tenant code that reaches the op table later gets nothing.
- Contains only the secrets the app (or module) declares in `renox.toml` and the tenant has set. A declared but unset secret is absent: no `undefined` key, no empty string. A marketplace module sees only its own declared and approved secrets.
- Values are decrypted in Rust from the deployment's secret bundle. They never appear in the artifact, the bundle, or any op argument.
- **Redaction.** Rust keeps the set of secret values of the isolate. Every string that leaves the isolate towards a log or error sink is scanned before it is written: `op_log` message and fields, uncaught errors and their stacks, and `RenoxError` messages built from tenant input. Each occurrence of a secret value is replaced with `[redacted]`. Responses to end users are not scanned (cost); the dispatch wrapper never puts error text into a response (`RENOX_INTERNAL` body has no message).

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
- Rate limit per tenant: 1,000 lines per minute free / 10,000 paid *proposed*. Over the limit, lines are **dropped**, not queued. `logs_dropped` in the meter record counts them, and one summary line `{"dropped": N}` is written when the window resets. Dropping never blocks or fails the handler.
- Outside a request (module top level) the line is attributed to the deployment with `request_id: null`.

## 5. Deadline: `op_deadline_remaining_ms`

| Op | Arguments | Result |
| --- | --- | --- |
| `op_deadline_remaining_ms` | — | `number`: whole milliseconds left before the request's wall-clock deadline, ≥ 0 |

- The deadline is set at the gateway as a duration and propagated, so a skewed clock cannot extend it (`docs/23-failure-modes.md`, clock skew row). Defaults: 30 s free / 60 s paid (`docs/04-isolation-security.md`).
- Wall clock, not CPU. The CPU limit (50 ms / 500 ms) is separate, is not observable from JavaScript, and ends the isolate with `RENOX_CPU_LIMIT`.
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

The runtime and cell emit one record per invocation (`docs/05-tenant-lifecycle.md`, "Metering and billing"). The schema itself is owned by #16 (`docs/contracts/meter.md`). This contract only fixes which fields the runtime is responsible for filling:

| Field | Filled by | From |
| --- | --- | --- |
| `tenant_id`, `deployment_hash`, `route_or_function`, `started_at`, `request_id` | cell | Routing |
| `cpu_ms`, `wall_ms`, `peak_heap_bytes` | runtime | Watchdog, V8 heap statistics |
| `egress_bytes`, `fetch_blocked` | runtime | `op_fetch` |
| `db_ms`, `db_rows` | runtime | `op_db_*` |
| `render_fuel` | runtime | Reserved (F2), 0 in F1 |
| `logs_dropped` | runtime | `op_log` |
| `status` | cell | `ok`, `error`, `cpu_limit`, `oom`, `timeout`, `busy` |

`request_id`, `fetch_blocked`, and `logs_dropped` are proposed additions to the list in `docs/05-tenant-lifecycle.md` for #16 to accept or reject.

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

- This contract carries a single integer version (the table at the top). The runtime exposes it as `op_contract_version() -> number` (sync, reserved name) and the SDK checks it at bootstrap.
- **Additive** changes keep the version: a new op, a new optional argument at the end, a new error code, a new `ctx` field moved out of "reserved".
- **Breaking** changes bump the version: renaming or removing an op, changing an argument or result type, changing a value mapping, changing the meaning of an error code. A breaking change lands as one PR that touches this file, `ctx.d.ts`, `ops.schema.json`, `crates/renox-runtime`, and `sdk/` together.
- Contract edits are made only by `type:contract` issues (`docs/22-development-plan.md`, section 3).

## Open

1. **Proposed numbers.** Statement time 1 s, busy wait 2 s, row cap 10,000, result cap 8 MB, SQL text 100 KB, 1,000 parameters, egress 10/100 MB, 16 concurrent fetches, log rate 1,000/10,000 lines per minute. #18–#21 (data), #27 (fetch), and #28 (logs/secrets) confirm or change them.
2. **Error catalogue.** The codes here must be added to `docs/contracts/errors.md` (#91) with HTTP status and tenant guidance. If #91 picks different names, this file follows in the same PR.
3. **Short secrets.** Redacting a 2-character secret would mangle every log line. Proposal: the control plane refuses secrets shorter than 8 bytes at `renox secrets set` (#115). Not decided.
4. **Encoded secrets.** Redaction matches exact substrings only; base64, URL-encoded, or split forms of a secret are not caught. Whether to also redact common encodings is open (cost vs coverage).
5. **Row representation.** Objects keyed by column name are convenient but slower to build than arrays. If B10 or B9 show the object build dominates, an `op_db_query_raw` returning `{ columns, rows: Value[][] }` may be added (additive).
6. **Response body limit** for tenant responses (streamed vs buffered) belongs to the cell (#28/#89) and is not fixed here.
7. **`x-renox-client-ip`** depends on the gateway's trusted-proxy configuration (#22); the header name is proposed here and must be confirmed there.
