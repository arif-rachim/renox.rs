# Contract: runtime ops and the `ctx` surface

| | |
| --- | --- |
| Version | **1.3.0** (F4, #226: modules — per-module `ctx`, `renox:modules`, service, hook and event semantics, the event envelope, savepoints, `ctx.config`, passwords, the page locale; sections 1–4, 6–8, 11, 13–16). 1.0.0 is implemented by the F1 runtime (#25–#28) and SDK (#31); the additions of 1.1.0 (#153: section 14, the blocked ranges of section 2) are implemented by #40, #41, #44, and #170; the additions of 1.2.0 are implemented by #161; the additions of 1.3.0 by #229, #230, #231, #233, and #236. History: "Changelog" at the bottom |
| Producer | `crates/renox-runtime` (P1): implements the ops |
| Consumers | `sdk/` (P10): types and the `ctx` wrapper; `crates/renox-cell` (P5): request envelope, page dispatch and rendering, meter record, the module broker's outbox worker (P9, section 15) |
| TypeScript view | [`ctx.d.ts`](ctx.d.ts): the same surface, one to one |
| Machine-readable | [`ops.schema.json`](ops.schema.json): arguments, results, and errors of every op; examples under [`examples/ops/`](examples/ops/) (checked by `validate.ts`) |
| Error catalogue | `errors.md`: HTTP status, tenant guidance, and logged fields for every code in section 13 |
| Sources | `docs/10-modules.md` (the five mechanisms, cross-module transactions), [`manifest.md`](manifest.md) (what a module declares and the tenant approves), `docs/07-app-model.md` ("The `ctx` surface", "Pages"), `docs/06-data.md` ("The `db` API"), `docs/04-isolation-security.md` (limits, secrets, `fetch`, CSRF), `docs/05-tenant-lifecycle.md` (metering), `crates/renox-runtime/README.md` (how the runtime is built on `deno_runtime`) |

Ops are the only way tenant JavaScript reaches anything outside its isolate. Tenant code never calls an op directly: the runtime's bootstrap script wraps them into `ctx` (and into `console`, `fetch`). The op names are therefore a contract between Rust and the SDK, not a tenant API. A tenant sees only `ctx.d.ts`.

Every limit below is enforced in Rust (`AGENTS.md`, "Per-tenant limits must be enforced in Rust"). The numbers are the F1 values. An implementing issue that measures a reason to change one changes it here first, as a minor version (section 9).

## 0. Conventions

- **How ops are exposed.** Every op is a `deno_core` `#[op2]` function in one extension, `renox`, defined in `crates/renox-runtime` and added to the `deno_runtime` worker the crate creates for each deployment. The crate uses `deno_runtime` from crates.io directly, not the Supabase Edge Runtime crates (D3; `crates/renox-runtime/README.md`, "Upstream consumption mode"), so no upstream patch is needed. Not a JavaScript shim over upstream APIs: upstream has no per-request deadline, no egress byte limit, and no DNS-checked allowlist, and SQLite has no upstream op at all. The extension's ESM bootstrap (section 11) is part of the platform snapshot.
- **Naming.** `op_<area>_<verb>`, snake_case, as registered with `deno_core`.
- **Async.** Every op that can wait on I/O returns a `Promise`. The runtime may resolve it synchronously when the work is already done; tenant code must not rely on that. `op_log`, `op_deadline_remaining_ms`, `op_secrets_get_all`, and `op_response_end` are synchronous.
- **Module (1.3.0).** Ops that act for a module (`op_db_*`, `op_fetch`, `op_secrets_get_all`, `op_log`, `op_events_emit`) take the module's name as an argument, `null` meaning the app. The bootstrap fills it from the `ctx` the call came through (section 15.1); tenant code never passes it, and Rust checks it against the artifact's `modules` list.
- **Request scope.** Every op call is tied to the request whose handler made it. The dispatch wrapper (section 11, step 6) runs each handler inside a fresh **async context** that carries an opaque request token. The mechanism is V8's continuation-preserved embedder data, which `deno_core` exposes and Deno's `AsyncLocalStorage` uses. The token therefore follows every `await`, promise continuation, and timer created by that handler. The bootstrap reads the token from the current async context and hands it to the op; the ops are held in the bootstrap's closures and are unreachable from tenant code, so tenant code can neither supply a token nor act on behalf of another request. Rust keeps the set of live tokens per isolate. **A request ends when its response has ended**: for a static body when the handler's `Response` is handed back, for a streamed body when the stream ends for any reason (section 6, "Response body"). Until then its token is live, so a stream's `pull` may call `ctx.db` or `fetch`. An op called with no token (module top level) or with the token of a request that has ended (a timer that fires after the response) rejects with `RENOX_NO_REQUEST`. The one exception is `op_log`, which then logs with `request_id: null`. `op_secrets_get_all` is consumed by the bootstrap before tenant code runs (section 3). #25 proved that the token follows `await`, timers, and promise continuations (`deno_core` `AsyncVariable`), so concurrent requests share one isolate.
- **Errors.** An op that fails rejects with a `RenoxError` whose `code` is one of the codes in section 13. Every code there also appears in `errors.md`, which owns HTTP status and tenant guidance, and `validate.ts` checks the sets. The SDK maps codes to the error subclasses in `ctx.d.ts`. An error message never contains a file path, an internal hostname or IP, a stack frame from Rust, or a secret value (`docs/23-failure-modes.md` rule 2).
- **Cancellation.** When the request's deadline passes or the CPU watchdog fires, every pending op of that request is cancelled. So are they when a streamed response stops early (egress limit, client gone; section 6). Pending promises reject with `RENOX_DEADLINE`, or are dropped with the isolate after `RENOX_CPU_LIMIT` or `RENOX_OOM` (section 10).
- **Values.** How arguments and results cross the boundary (`bigint`, `Uint8Array`, `null`, strings) is fixed in section 12.
- **Metering.** Each op adds to the invocation's meter record (section 7). Ops never return meter data to tenant code.

```ts
// Error shape every op rejects with (TypeScript view in ctx.d.ts).
interface RenoxErrorShape { name: string; code: string; message: string; details?: Record<string, unknown> }
```

## 1. Database: `op_db_*`

Backs `ctx.db` (`docs/06-data.md`, "The `db` API"). The connection is bound by the runtime to the tenant's own SQLite file, which is never an argument. Each statement runs under the authorizer of the module it is made for: that module's `<module>__*` tables, and read access to the `<dep>__public_*` views of its declared dependencies (`manifest.md` MF7). From 1.3.0 that module is the op's last argument ("Module argument", below).

### Signatures

| Op | Arguments | Result |
| --- | --- | --- |
| `op_db_query` | `sql: string, params: Param[], tx: number \| null, module?: string \| null` | `Row[]` |
| `op_db_query_one` | `sql: string, params: Param[], tx: number \| null, module?: string \| null` | `Row \| null` (first row; the statement stops after it) |
| `op_db_execute` | `sql: string, params: Param[], tx: number \| null, module?: string \| null` | `{ changes: number, lastInsertRowid: number \| bigint }` |
| `op_db_tx_begin` | `mode: "deferred" \| "immediate"` | `number` (transaction handle) |
| `op_db_tx_commit` | `tx: number` | `void` |
| `op_db_tx_rollback` | `tx: number` | `void` |
| `op_db_savepoint_begin` (1.3.0) | `tx: number` | `number` (savepoint handle) |
| `op_db_savepoint_release` (1.3.0) | `tx: number, sp: number` | `void` |
| `op_db_savepoint_rollback` (1.3.0) | `tx: number, sp: number` | `void` (rolls back to the savepoint, then releases it) |

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
- Nesting: `tx_begin` while the request already holds a transaction rejects with `RENOX_DB_TX_STATE`. A nested `db.transaction` is a savepoint (1.3.0, below).

### Module argument (1.3.0)

- The fourth argument of `op_db_query`, `op_db_query_one`, and `op_db_execute` names the module the statement is made for; `null` or absent means the app (`app__*` tables). The bootstrap passes the module of the `ctx` whose `db` was called (section 15.1). A name that is neither `app` nor in the artifact's `modules` list rejects with `RENOX_DB_PARAM` (`details.reason: "module"`), before the statement is prepared.
- The authorizer is chosen **per statement**, so one transaction carries statements of several modules, each under its own authorizer. That is how a cross-module transaction (`docs/10-modules.md`, "Cross-module transactions") stays inside the prefix rule: the broker passes the transaction, never a wider authorizer.
- A module reads a public view only of a module in its own `dependencies` (the artifact's `modules[].dependencies`); the app may read the public views of every installed module.
- **The current transaction.** The SDK keeps the handle of the innermost open transaction in the request's async context: the action's (section 14), a `db.transaction` callback's, or the caller's of a service (section 15.2). A callee's `ctx.db` statements run inside the current transaction, so a service called from an action writes in the action's transaction. The app's own `ctx.db` statements keep the 1.2 rule: with `tx = null` they run outside an open transaction on a reader connection; tenant code uses the `tx` argument of `db.transaction` to write inside it.

### Savepoints (1.3.0)

- `db.transaction(fn)` called while a transaction is current (above) does not begin a new one: the SDK calls `op_db_savepoint_begin(tx)`, runs `fn`, then `op_db_savepoint_release` when `fn` resolves, or `op_db_savepoint_rollback` and rethrows when it throws. The outer transaction goes on either way; only the savepoint's statements are undone.
- Rust names the savepoints (`renox_sp_<n>`); no tenant text reaches a `SAVEPOINT` statement. Tenant SQL that names a savepoint starting with `renox_` is refused by the authorizer (`RENOX_DB_AUTH`, `details.action: "savepoint"`).
- Savepoints nest last-in, first-out. Releasing or rolling back a savepoint that is not the innermost open one, using a savepoint of another transaction, or opening more than 32 at once rejects with `RENOX_DB_TX_STATE`. Committing or rolling back the transaction ends its open savepoints with it.
- The end-of-request rule above applies unchanged: Rust rolls back the whole transaction, savepoints included.

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
| `RENOX_DB_PARAM`, `RENOX_DB_COLUMN_NAME`, `RENOX_DB_MULTI_STATEMENT`, `RENOX_DB_RESULT_LIMIT`, `RENOX_DB_TX_STATE` | `DbUsageError` | See above, including the module argument and savepoints (1.3.0) |

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
  module?: string | null;                // 1.3.0: whose allowlist applies; null or absent = the app (section 15.1)
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

The SDK builds a standard `Response` from the head and a `ReadableStream` over `op_fetch_body_read`. `deno_fetch` already registers an op named `op_fetch`, so the runtime registers this one as `op_renox_fetch`. The name is internal (only the bootstrap calls it); the contract, the schema, and the examples keep `op_fetch`.

### Allowlist

Declared in `renox.toml` (per app; a module declares its own in its manifest and the tenant approves it at install, `manifest.md` section 3). From 1.3.0 `FetchRequest.module` selects the list: a module's `fetch` is checked against its own approved list only, never the app's or another module's, and the app's against `manifest.permissions.network`:

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

1. Parse the URL. Scheme, host, and port must match an allowlist entry. Otherwise reject with `reason: "not_allowlisted"`, `"scheme"`, or `"port"`. The names `localhost`, `*.localhost`, and `metadata.google.internal` are refused with `"blocked_address"` whatever the allowlist says.
2. Resolve DNS in Rust. **Every** resolved address is checked against the blocked ranges below; if any address is blocked, the request is rejected (`reason: "blocked_address"`). Failing closed avoids depending on which address happy-eyeballs would pick.
3. Connect to one of the **already-checked** socket addresses: no second resolution (DNS rebinding, #108). TLS: rustls with webpki roots, SNI = the URL host. Tenants have no option to skip certificate checks.
4. On a 3xx with `redirect: "follow"`, repeat 1–3 for the `Location` target. At most 5 hops (`reason: "redirect_limit"`). `https` → `http` is allowed only to a host declared with `http://`. `Authorization`, `Cookie`, and `Proxy-Authorization` are dropped when the origin changes. With `"manual"` the 3xx is returned as is; with `"error"` it rejects with `RENOX_FETCH_FAILED`.

### Blocked ranges

The address is normalised first, and these forms are checked as the IPv4 address they embed:

- IPv4-mapped `::ffff:0:0/96` (`::ffff:a.b.c.d`) and IPv4-compatible `::/96` (`::a.b.c.d`);
- IPv4-translated (SIIT) `::ffff:0:0:0/96` (`::ffff:0:a.b.c.d`);
- NAT64: the well-known prefixes `64:ff9b::/96` and `64:ff9b:1::/48`, and the **network-specific prefixes** of the node's network (RFC 6052). Those are configured per node, like the node's own addresses below, and the embedded address is read at the position RFC 6052 gives for the prefix length (/32, /40, /48, /56, /64, /96);
- 6to4 `2002::/16`.

An address in one of these forms that embeds a blocked IPv4 address is blocked.

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
| `192.88.99.0/24` | Former 6to4 relay anycast (deprecated, RFC 7526) |

| IPv6 | Why |
| --- | --- |
| `::/128`, `::1/128` | Unspecified, loopback |
| `fc00::/7` | Unique local, including the AWS metadata endpoint `fd00:ec2::254` |
| `fe80::/10` | Link-local |
| `ff00::/8` | Multicast |
| `100::/64` | Discard |
| `2001:db8::/32` | Documentation |
| `2001::/23` | IETF protocol assignments (includes Teredo `2001::/32`) |
| `3fff::/20` | Documentation (RFC 9637) |
| `5f00::/16` | Segment Routing (SRv6) SIDs (RFC 9602) |
| `fec0::/10` | Site-local (deprecated) |

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
| `op_secrets_get_all` | `module?: string \| null` (1.3.0; `null` or absent = the app) | `Readonly<Record<string, string>>` |

- Called **once per module** by the runtime bootstrap at isolate creation, before any tenant module is evaluated (section 11, step 3; `docs/04-isolation-security.md`, "Secrets"): once for the app and, from 1.3.0, once for each module of the artifact's `modules` list. The bootstrap freezes each object and exposes it as `ctx.secrets` on every `ctx` of that module (section 15.1). Top-level module code has no `ctx` and therefore no secrets. A second call for the same module, or a call for a module that is not in the list, rejects with `RENOX_SECRETS_CONSUMED`. The op table itself is unreachable from tenant code (section 11, step 2), so this is defence in depth.
- Secret values shorter than 8 bytes are refused when secrets are loaded: by the worker in F1, which fails isolate creation with `RENOX_INTERNAL` and logs the secret's **name**, and by `renox secrets set` from F3 (#115). Redacting very short strings would mangle every log line, and refusing them keeps the redaction rule exact.
- Contains only the secrets the app declares in `renox.toml`, or the module's approved `secrets` (`artifact.md` section 3, `modules[].permissions.secrets`), that the tenant has set. A declared but unset secret is absent: no `undefined` key, no empty string. A module sees only its own approved secrets, whose names start with its own prefix (`manifest.md` MF4); the app does not see a module's secrets.
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
| `op_log` | `level: "debug" \| "info" \| "warn" \| "error", message: string, fields: Record<string, JsonValue> \| null, module?: string \| null` | `void` (never throws) |

- Backs `ctx.log.{debug,info,warn,error}` and `console.*` (`console.log` → `info`, `console.debug` → `debug`, `console.warn` → `warn`, `console.error` → `error`). Non-string `console` arguments are formatted by the bootstrap before the op is called.
- Rust adds `ts`, `tenant_id`, `deployment_hash`, `request_id`, `module`, and `level`. `module` is the op's fourth argument (1.3.0: the module of the `ctx` whose `log` or `console` was called, section 15.1; `app` when `null` or absent). Tenant fields with those names are moved under `fields.user_<name>`, so tenant code cannot spoof them.
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

### Response body (1.2.0)

The bootstrap hands a `Response` back to Rust **head first**: status and headers, then the body. Rust sends the head to the client before the body is complete. There are two body shapes; which one a body takes is not visible to the end user except in timing.

| Body | What crosses | When the request ends |
| --- | --- | --- |
| **Static**: `null`, a string, a `BufferSource`, `URLSearchParams`, `FormData`, a `Blob`, `Response.json(...)` | The bytes, in one piece, together with the head (as in 1.1) | When the head and bytes are handed back |
| **Streamed**: a `ReadableStream` (written by the handler, or a `fetch` response body passed through) | The head, with `body: "stream"`; then each chunk through `op_response_write`, and the end through `op_response_end` | When `op_response_end` is called, or the stream is stopped (below) |

The bootstrap may treat any static body as streamed (a `Blob`, for example, is a stream inside Deno); it never treats a streamed body as static, because reading a whole stream first is what this version removes.

| Op | Arguments | Result |
| --- | --- | --- |
| `op_response_write` | `chunk: Uint8Array` | `Promise<void>`: resolves when Rust has taken the chunk; rejects with `RENOX_NO_REQUEST` when the response can take no more bytes (the stream was stopped, below) |
| `op_response_end` | `error: string \| null` | `void` (sync, never throws): `null` is the normal end; a string says the handler's stream failed, with its message |

- **Only the bootstrap calls them**, like every op (section 0). It reads the handler's stream with a reader in the request's async context, so the CPU of the stream's `pull` and of the copy is the request's `cpu_ms`, under the same CPU limit, and every op the stream calls works until the stream ends.
- **Chunks.** A chunk is bytes (`Uint8Array`, copied, section 12). An empty chunk is skipped. A chunk of any other type is a stream failure (`op_response_end` with a `TypeError` message). Rust may split a chunk or join small ones on the wire; the bytes and their order are kept.
- **Backpressure.** Rust holds at most 16 chunks of one response that the connection has not taken yet. `op_response_write` stays pending while that buffer is full, so a handler that produces faster than the client reads waits, and its wait counts against the deadline.
- **Explicit end.** The body is complete only when `op_response_end(null)` is called. A stream that is stopped any other way (below) is **truncated**: the client gets the head and the bytes sent so far, and the body ends with an error instead of a clean end (HTTP/1.1: the connection is closed before the last chunk; HTTP/2: the stream is reset). A client can therefore always tell a truncated body from a complete one.
- **Stops.** A streamed response stops early when: the response egress limit is reached (section 10); the deadline passes; the CPU or heap limit ends the isolate; the handler's stream fails (it errors, or yields a chunk that is not bytes); or the client goes away. Rust then ends the request (its token stops working, its pending ops are cancelled, its open transaction is rolled back, as in section 11, step 6), and the bootstrap cancels the handler's stream (its `cancel` callback runs) when the isolate is still alive. What the client sees and what the meter records in each case is section 10, "Mid-stream".
- **Headers of a streamed body.** A `Content-Length` set by the handler is removed: the body is sent with chunked transfer coding (HTTP/1.1) or without a length (HTTP/2). Every other header is handled as for a static body.
- **HEAD.** A `HEAD` served by `GET` sends the head only; the bootstrap cancels a streamed body without reading it.
- **Compression** stays the gateway's (`crates/renox-gateway/src/compress.rs`): the same rules as for static bodies (type, size, `NoCompress`, `no-transform`), with a streaming encoder that flushes after each chunk, so a chunk reaches the client without waiting for the next one. A streamed body is compressed without the minimum-size rule, since its size is not known at the head.

```ts
// Tenant code: a body that streams.
export const GET: Handler = () => new Response(new ReadableStream({
  async pull(c) { const rows = await nextPage(); rows ? c.enqueue(encode(rows)) : c.close(); },
}), { headers: { "content-type": "text/csv" } });

// Bootstrap, not tenant code: what crosses after the head.
await op_response_write(new Uint8Array([104, 105]));  // resolves once Rust holds the chunk
op_response_end(null);                                // the body is complete
```

Page modules export `load` and `actions` (section 14). Module trees add `services.ts` and `hooks.ts` (section 15), and an event handler is invoked with the event envelope of section 15.4, not a `Request`. Reserved exports: `guard` for pages (F5, with `authz`); `ws` for WebSocket (F5); `sse` (F5); `schedule` for jobs (F6); `cors` and `frame` options (F2, `artifact.md` Open 6).

## 7. Meter record (emitted, not an op)

The runtime and cell emit one record per invocation (`docs/05-tenant-lifecycle.md`, "Metering and billing"). The schema itself is owned by [`meter.md`](meter.md) (#16). This contract only fixes which fields the runtime is responsible for filling, and when the record is written.

| Field | Filled by | From |
| --- | --- | --- |
| `request_id`, `tenant_id`, `deployment_hash`, `route`, `started_at` | cell | Routing |
| `wall_ms`, `ingress_bytes`, `egress_bytes`, `http_status`, `status` | cell | Request and response streams; section 13 maps codes to `status` |
| `cpu_ms`, `peak_heap_bytes` | runtime | Per-request thread CPU accounting (section 10), V8 heap statistics |
| `fetch_sent_bytes`, `fetch_received_bytes`, `fetch_blocked` | runtime | `op_fetch` |
| `db_ms`, `db_rows` | runtime | `op_db_*` |
| `render_fuel`, `render_ms` | cell | The renderer (section 14, "Rendering"). Rendering runs off the isolate thread, so it is not in `cpu_ms`. 0 / absent when nothing was rendered |
| `logs_dropped` | runtime | `op_log` |

Types, units, and the `status` values are defined in [`meter.md`](meter.md) section 2.

**When (1.2.0).** The record is written when the request ends (section 0, "Request scope"): for a static body when the response is handed to the gateway, for a **streamed body at the end of the stream**, whatever ended it: the normal end, the egress limit, the deadline, a CPU or heap kill, a failed stream, or the client going away. Then:

- `wall_ms` runs to the end of the stream; `cpu_ms`, `db_*`, `fetch_*` and `logs_dropped` include what the stream's `pull` used;
- `egress_bytes` counts the body bytes handed to the connection, after compression, up to the stop: a truncated response records the bytes sent so far;
- `http_status` is the status sent in the head, even when the stream was cut later;
- `status` is the cause of the end: `ok` for the normal end and for a client that went away, `timeout`, `cpu_limit` or `oom` for a kill mid-stream, `error` for the egress limit and for a failed stream (section 10, "Mid-stream").

**Modules (1.3.0).** A service call, a hook, and an in-memory event handler run inside the invocation that made them, so their CPU, `db_*`, and `fetch_*` are part of that invocation's one record. Each **event delivery** attempt (section 15.4) is an invocation of its own and gets its own record (`meter.md` 0.2, section 2, "Event records"): `kind: "event"`, `route` = `EVENT <module> <name>` (the handling module and the event name), `request_id` = `<event id>_<module>_<attempt>`, and `status` from section 10 (`ok` when the handler resolved, `error` when it threw). Each password op adds 1 ms to `cpu_ms` (section 16).

## 8. Reserved ops and `ctx` fields

Not available yet. Names are reserved so nothing else takes them. `form`, `session.id`, `fragment`, and `action` are available to pages since 1.1.0 (section 14).

| `ctx` field / op area | Phase |
| --- | --- |
| `render` (`op_render_*`), `webhook` (`verify`), streamed `fetch` request bodies | F2 |
| `kv` (`op_kv_*`) | F2 |
| `op_hooks_run` and the other cross-isolate broker ops of `isolate` mode (section 15.6). `config`, `events`, `hooks`, `services`, `password`, savepoints, and `setLocale` are available since 1.3.0; `auth` and session data beyond `session.id` are services of the `auth` module (`manifest.md`), not ops, so nothing is reserved for them | F4 (later issue) |
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
| CPU per request | 50 ms | 500 ms | Per-request CPU accounting (per async context) + watchdog thread → `TerminateExecution` |
| Wall clock per request | 30 s | 60 s | Deadline set at the gateway as a duration, propagated to every op |
| V8 heap per isolate (per pool member) | 128 MB | 512 MB | V8 heap limit + near-heap-limit callback |
| Concurrent requests per deployment | 50 | 500 | Semaphore per deployment in `crates/renox-runtime/src/limits/concurrency.rs`, shared by every member of the deployment's isolate pool, acquired before the request enters an isolate |
| Isolates per hot deployment (pool size, `IsolateSpec::max_isolates`) | one per core, up to 2 | one per core, up to 8 | `crates/renox-cell/src/manager.rs` sets it per tier; a deployment grows past one isolate only while requests wait on a busy one (`crates/renox-runtime/src/isolate.rs`, "Pool") |
| Module evaluation at isolate start (section 11, step 4) | 500 ms CPU, 10 s wall | 5 s CPU, 10 s wall | Same watchdog and deadline as requests |
| Response egress per request (streamed body, 1.2.0) | 10 MB | 100 MB | Counted per chunk in `op_response_write`, before compression; separate from the `fetch` egress counter of section 2 |

What happens on each limit:

| Limit hit | Tenant code sees | Response to the client | Meter `status` | Isolate |
| --- | --- | --- | --- | --- |
| **CPU** | Nothing: execution stops | 503 `RENOX_CPU_LIMIT` | `cpu_limit` | **Recycled.** `TerminateExecution` leaves the isolate in an unknown state, so that pool member is marked poisoned, every other in-flight request on the same member also ends with 503 `RENOX_CPU_LIMIT` (they share the heap that was interrupted), their open transactions are rolled back (#89), and the member is disposed. Other members of the deployment are unaffected. The pool's spare takes the member's place, or, with no spare, the next request creates a fresh isolate from the snapshot |
| **Heap** | Nothing: execution stops | 503 `RENOX_OOM` | `oom` | **Recycled.** The near-heap-limit callback raises the limit temporarily so V8 does not abort the process, then terminates. The member is disposed on its own thread, as for CPU, and so are the other in-flight requests on that member (503 `RENOX_OOM`) |
| **Wall clock** | Pending ops reject with `RENOX_DEADLINE`; later ops of that request reject with `RENOX_NO_REQUEST` | 504 `RENOX_DEADLINE`, sent at the deadline whatever the handler does afterwards; a `Response` the handler returns later is discarded | `timeout` | **Kept.** JavaScript that is still running synchronously at the deadline is caught by the CPU limit, which is always shorter |
| **Concurrency** | Nothing (no tenant code runs) | 503 `RENOX_BUSY` with `Retry-After: 1`, after queueing up to the request's deadline (`docs/23-failure-modes.md`, "Too many concurrent requests") | `busy` | Kept |
| **Module evaluation** (CPU, wall, or a throw) | — | 503 `RENOX_CPU_LIMIT`, 504 `RENOX_DEADLINE`, or 500 `RENOX_INTERNAL` for every request waiting on that isolate | the matching status | Isolate creation fails. The failure is cached per deployment for 5 s, so a broken deployment does not rebuild an isolate on every request. One log line with `phase: "module_load"` per failure |

**Response egress.** Every chunk of a streamed body is counted as `op_response_write` takes it. The chunk that would pass the limit is refused whole, so the client never gets more than the limit; the stream stops (section 6, "Stops"), the response is truncated, and the tenant log gets one line with `reason: "egress_limit"`, `route`, `limit_bytes` and `sent_bytes`. The limit counts the bytes the handler wrote, before compression, so it does not depend on the client's `Accept-Encoding`. A static body is bounded by the heap limit instead; the egress limit does not apply to it.

**Mid-stream.** Once the head of a streamed response is sent, its status cannot change. A limit or failure after that point therefore truncates the body instead of answering with an error status:

| Stop after the head | Client | Meter `status` | Tenant log |
| --- | --- | --- | --- |
| Normal end (`op_response_end(null)`) | Complete body | `ok` | — |
| Client went away | — | `ok` | — |
| Response egress limit | Truncated | `error` | `reason: "egress_limit"`, `limit_bytes`, `sent_bytes` |
| The handler's stream failed | Truncated | `error` | `reason: "stream_error"`, `cause_message` (redacted) |
| Wall-clock deadline | Truncated at the deadline | `timeout` | `code: "RENOX_DEADLINE"`, `phase: "stream"`, `sent_bytes` |
| CPU limit | Truncated | `cpu_limit` | `code: "RENOX_CPU_LIMIT"`, `phase: "stream"`, `cpu_ms`, `limit_ms`, `sent_bytes` |
| Heap limit | Truncated | `oom` | `code: "RENOX_OOM"`, `phase: "stream"`, `peak_heap_bytes`, `limit_bytes`, `sent_bytes` |

A CPU or heap kill ends every in-flight request on the pool member, as in the collateral rule below: those whose head was sent are truncated, the others get 503 as before. Each gets its own record with the kill's `status` and the bytes it sent. A limit hit before the head is sent is answered as in the first table of this section: the handler has not returned a `Response` yet, so the client still gets the error status.

Per-request CPU accounting (#155): the runtime reads the isolate thread's CPU clock (`CLOCK_THREAD_CPUTIME_ID`) and charges each run of JavaScript and synchronous op work to the request whose async context it runs in. The request's token travels in V8's continuation-preserved embedder data through every `await`, promise reaction, op, and timer of that request, and promise hooks report each switch; so **a request is charged the CPU of its own continuations**, not the CPU of other requests that ran while it was in flight. CPU that runs in no request's context (platform glue between reactions) is split evenly among the requests in flight, rounded up; with one request in flight everything is its own. **CPU used before a request was admitted is never split onto it**: the run so far is charged before the joining request counts as in flight. JavaScript with no request in flight (a timer that outlived its request) runs under the per-request limit, so orphaned work cannot spin forever (`crates/renox-runtime/README.md`, "CPU accounting"). A watchdog thread per isolate checks the running context every 1 ms and calls V8's `TerminateExecution` when the request it is running for would exceed its limit (for unattributed work: when the request in flight with the least CPU left would). The same total is the meter's `cpu_ms`. The V8 heap limit is set with `CreateParams::heap_limits`; no upstream per-worker CPU or wall-clock timer is used. Idle eviction (10 minutes, `docs/05-tenant-lifecycle.md`) belongs to the cell.

**Termination bound.** Termination lands within one interrupt check: ± 5 ms for JavaScript loops. A single builtin call (a large `JSON.parse`, a regular expression, a sort) or a garbage collection already in progress runs to its end first, because V8 checks for interrupts only between them; under host CPU saturation, termination also waits until the watchdog thread is scheduled. So the CPU limit is a bound with a tail, not an exact cut: #146 measured a termination p99 of 13.2 ms over a 50 ms limit under allocation. The limits tests assert the ± 5 ms bound on a JavaScript loop on an idle host; the tail cases are measured by B12, not asserted.

**Collateral rule (for tenants).** A deployment runs in a pool of isolates (#156): one while it is cold, up to the tier's pool size (`IsolateSpec::max_isolates`, table above) while requests wait on a busy isolate, plus one spare once it has grown. Concurrent requests on the same pool member share its isolate. When one request hits the CPU or heap limit, that member is recycled, so **one bad request ends every in-flight request on the same pool member; other members of the deployment are unaffected**. Each ended request gets the same 503 code (`RENOX_CPU_LIMIT` or `RENOX_OOM`) and its own meter record with that `status` and its own `cpu_ms`; there is no marker that tells the request that hit the limit from the collateral ones, so in the meter they are indistinguishable (the log line of each carries the same `code`). Open transactions of all of them are rolled back. A request sent to a member that was already terminated, and that had not started on it, runs on another member instead. A deployment with one isolate (cold, or a pool size of 1) loses every in-flight request, as in 1.1.0. Tenants should keep handlers idempotent or safe to retry, and keep work that can run away (unbounded loops over input, large parses) out of hot routes.

Per-op limits (statement time, rows, egress bytes, concurrent fetches, log rate) are in each op's section above.

## 11. Isolate bootstrap

The sequence from an empty worker to a dispatched request. Each step finishes before the next starts, and a failure in steps 1–5 is a module-evaluation failure (section 10).

1. **Worker and platform snapshot.** The runtime creates a `deno_runtime` worker for the deployment:
   - Deno permissions all **denied** (`net`, `read`, `write`, `env`, `run`, `ffi`, `sys`, `import`), so nothing upstream can open a socket or file on the tenant's behalf. `op_fetch` and `op_db_*` are not permission-gated; they enforce their own rules.
   - No environment variables, no remote modules, no npm resolution at runtime (dependencies are inside the artifact). The module loader serves the artifact's `code/` under a virtual root (`file:///<path>`), so no path of the machine is visible.
   - The isolate starts from the platform snapshot, built once per process: Web APIs plus the `renox` extension's ESM bootstrap.
2. **Capture and harden.** The bootstrap takes the op functions it needs into private closures, then changes the global scope as in the table below. After this step tenant code cannot reach `Deno.core` or the op table.
3. **Modules and secrets.** Rust passes the artifact's module list to the bootstrap's init function (1.3.0; `ops.schema.json` `$defs/moduleInfo`: each module's name, isolation, dependencies, resolved config, approved permissions, and exports, copied from `artifact.md` section 3, "Modules"). For the app and for each module the bootstrap calls `op_secrets_get_all` once, freezes the result, and keeps it in a closure (section 3).
4. **Tenant modules.** The runtime imports every module listed in `manifest.code.entry` (`artifact.md` section 3), including each installed module's `services` and `hooks` entries (1.3.0), in the order of the `modules` list, then the app's: files under `code/` for `esm-dir`, or `file:///<path>` inside `bundle.eszip` for `eszip`. Top-level module code runs here, outside any request: `console` works (logged with `request_id: null`); `fetch`, `ctx.db` and the other ops reject with `RENOX_NO_REQUEST`. The module-evaluation limits of section 10 apply.
5. **Handler lookup.** For each `manifest.routes[]` entry, the bootstrap checks that the module's `export` is a function and builds the matcher of `artifact.md` section 3 ("Route objects"). A missing or non-function export fails the deployment as a whole (fail closed, `RENOX_INTERNAL`, logged with the route). `renox check` catches it before deploy. From 1.3.0 the same rule covers modules (section 15): every name in a module's `exports.services` must be a function export of its `services.ts`; every key of its `hooks.ts` `hooks` export must be a hook in its approved `permissions.hooks`, with a `handle` function (a filler the manifest does not declare is refused); every value of its `on` export must be a function. A key of `on` naming an event that no installed module exports is logged once and never called.
6. **Request dispatch.** For each request, Rust calls the bootstrap's dispatch function with a fresh request token, the matched route, the route parameters, and the request head and body stream. The bootstrap:
   - enters a new async context carrying the token;
   - builds the `Request` and a frozen per-request `ctx` (section 6) for the route's owner: the app, or the module whose route it is (section 15.1);
   - calls the handler and awaits a `Response`;
   - checks it, hands back the head (with a static body, or `body: "stream"`), and, for a streamed body, writes it chunk by chunk with `op_response_write` and ends it with `op_response_end` (section 6, "Response body").
   When the request ends for any reason (for a streamed body: when the stream ends, section 0), Rust:
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
| `node:` modules | Only compute-only modules (`buffer`, `events`, `path`, `util`, `stream`, `url`, `string_decoder`, `zlib`, ...) can be imported. Modules that open sockets or files or create contexts (`node:fs`, `net`, `http`, `https`, `dns`, `child_process`, `worker_threads`, `vm`, `perf_hooks`, ...) are refused at import | Fail closed, even where a polyfill has an ungated op. npm clients that use `fetch` work; clients built on `node:http` do not |
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
| `RENOX_MODULE_UNDECLARED` | thrown | broker (section 15): a service call, hook run, or event emit the caller's manifest does not allow | `ModuleUndeclaredError` | uncaught → 500 `RENOX_INTERNAL` | `error` |
| `RENOX_MODULE_SERVICE` | thrown | broker: a service, hook filler, or in-memory event handler of another module threw (section 15.2) | `ModuleServiceError` | uncaught → 500 `RENOX_INTERNAL` | `error` |
| `RENOX_EVENT_PAYLOAD` | thrown | `op_events_emit`: the payload does not match the event's exported schema, is not JSON, or is too large (section 15.4) | `EventPayloadError` | uncaught → 500 `RENOX_INTERNAL` | `error` |
| `RENOX_DEADLINE` | both | deadline (section 10) | `DeadlineError` | 504 `RENOX_DEADLINE` | `timeout` |
| `RENOX_CPU_LIMIT` | response | CPU watchdog | — | 503 `RENOX_CPU_LIMIT` | `cpu_limit` |
| `RENOX_OOM` | response | heap limit | — | 503 `RENOX_OOM` | `oom` |
| `RENOX_BUSY` | response | cell concurrency semaphore | — | 503 `RENOX_BUSY` + `Retry-After` | `busy` |
| `RENOX_INTERNAL` | response | dispatch wrapper: handler threw, returned a non-`Response`, or module evaluation failed | — | 500 `RENOX_INTERNAL` | `error` |
| `RENOX_BODY_TOO_LARGE` | response | gateway body limit (section 6) | — | 413 `RENOX_BODY_TOO_LARGE` | no record (`meter.md` section 1) |
| `RENOX_CSRF` | response | cell, before a page action runs (section 14) | — | 403 `RENOX_CSRF` | no record: no tenant code runs, as for 404 and 405 (`meter.md` section 1) |
| `RENOX_RENDER_LIMIT` | response | cell renderer (section 14, "Rendering") | — | 500 `RENOX_RENDER_LIMIT` | `render_limit` |

"Uncaught" means the error propagated out of the handler. Tenant code that catches an op error and returns its own `Response` ends the request normally (`status: ok`). The error body format of platform responses (`{ error: { code, request_id, message } }` for API routes) is defined in `errors.md`.

## 14. Pages

Page routes (`artifact.md` section 3, "Page routes") run tenant code in two places: `load` for `GET`/`HEAD`, and one of `actions` for `POST ?/<name>`. Both run in the isolate exactly like a function handler (sections 0, 10, 11): same request token, same limits, same meter record. What differs is the `ctx` they get and what they return. The HTML is rendered by the cell, off the isolate thread (D7, path A; `docs/08-template-engine.md`).

### Loader

```ts
export async function load(ctx: LoaderContext): Promise<object | Response>;
```

`LoaderContext` is `Ctx` (section 6) plus:

| Field | Type | Meaning |
| --- | --- | --- |
| `fragment` | `string \| null` | The fragment the cell will render (`artifact.md` section 3, "Fragment selection"), or `null` for a full page. A loader may skip queries the fragment does not need |
| `session` | `Session` | Below |
| `setLocale(locale, dir?)` | method (1.3.0) | Sets the page's locale and direction ("Locale", below) |

- `params` are the route parameters, as for functions. `db` is the plain `Db` (no implicit transaction).
- Returning a `Response` sends it as is: nothing is rendered (a redirect, JSON, custom HTML, a 404).
- Returning an object makes it the template data. Anything else (a primitive, `null`, an array, `undefined`) is 500 `RENOX_INTERNAL`, logged with `reason: "load_result"`.
- A `.html`-only page has no loader; its template data is `{}`.

### Actions

```ts
export const actions: Record<string, (ctx: ActionContext) => Promise<ActionResult>>;
```

`ActionContext` is `Ctx` (section 6) with `db` replaced, plus:

| Field | Type | Meaning |
| --- | --- | --- |
| `action` | `string` | The action name from `?/<name>` (`default` when the request had none) |
| `form` | `FormData` | The request body parsed by the bootstrap from `application/x-www-form-urlencoded` or `multipart/form-data` before the action runs. Any other content type gives an empty `FormData` and leaves `req.body` unread. Bounded by the gateway's body limit (section 6) |
| `fragment` | `string \| null` | As for the loader: the fragment selected by `HX-Target`, if any |
| `session` | `Session` | Below |
| `db` | `DbStatements` | **The action's transaction** (below). No `transaction()` method |
| `setLocale(locale, dir?)` | method (1.3.0) | As for the loader |

**CSRF, before the action.** The cell checks the token before the request reaches the isolate (`docs/04-isolation-security.md`, CSRF). The token comes from the `x-renox-csrf` header (htmx, through the platform client script) or from the `_csrf` form field (`<x-form>`, `<x-csrf>`, `docs/08-template-engine.md`). It must match the double-submit cookie `__Host-renox_csrf`, which is bound to the session. A missing or wrong token is 403 `RENOX_CSRF` and no tenant code runs. Tenant code never sees or handles the token. Function routes are not CSRF-checked: they are APIs, and webhooks under `functions/webhooks/` verify signatures instead.

**Transaction.** Every action runs in one `IMMEDIATE` transaction that the bootstrap opens before calling it (`op_db_tx_begin("immediate")`). The transaction commits when the action resolves, and rolls back when it throws or the request ends first (section 1). `ctx.db` statements all run inside it. Consequences tenants must know:

- Actions of one tenant **serialise on its one writer**: while an action runs, other actions and writes wait for the write lock, up to the busy wait (`RENOX_DB_BUSY`). Keep actions short.
- **Do not `fetch` inside an action** when you can avoid it: the transaction, and so the writer, stays held while the fetch waits. Fetch first in the loader, or emit a durable event (F4).
- An action that opens the transaction and never writes still takes the write lock. Read-only work belongs in the loader.

**Action results.**

```ts
type ActionResult = Response | (Record<string, unknown> & { fragments?: string[] }) | void;
```

| The action returns | Then |
| --- | --- |
| a `Response` | Sent as is, after the commit. Use `303` to `GET` after a plain form `POST` |
| an object, or nothing (`{}`) | After the commit, the page's `load` runs again (if exported) with `ctx.fragment` unchanged. The template data is `{ ...loadResult, ...actionObject }` without the `fragments` key: the action's keys win. If `load` returns a `Response`, it is sent |
| anything else | 500 `RENOX_INTERNAL`, logged with `reason: "action_result"`; the transaction is rolled back |

What is rendered after an object result:

- A plain form `POST` (no `HX-Request`) gets the **full page** with that data.
- An htmx `POST` gets the fragment selected by `HX-Target` (if any), followed by every fragment named in `fragments`, each marked `hx-swap-oob="true"` (`docs/09-htmx-realtime.md`). With neither, it gets the full page.
- A name in `fragments` that is not in the page's fragment map is 500 `RENOX_INTERNAL`, logged with the name. The commit has already happened; the dev overlay shows the error.
- A page with no template (`.ts` only) must return a `Response` from its actions: an object is 500 `RENOX_INTERNAL`.

### Session

```ts
interface Session { readonly id: string }
```

- `id` is an opaque random id (128 bits, base64url, 22 characters) carried in the signed cookie `__Host-renox_sid` (`HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`). The cell verifies the signature before dispatch. A missing or invalid cookie gets a fresh id, and the response sets the cookie.
- The signing key is per tenant, derived in the worker (HKDF) from node key material; it never reaches the isolate (#41).
- F2 stores nothing per session: `id` is the key a tenant (or the F4 `auth` module) uses for its own tables, and what CSRF tokens are bound to. Session data and `auth` arrive in F4 (section 8).

### Page dispatch: what crosses into Rust

`ops.schema.json` (`$defs/page_dispatch`) fixes the exchange between the cell and the bootstrap for one page invocation. It is not an op: Rust calls the bootstrap's dispatch function, as for functions (section 11, step 6).

- **Invocation** (Rust → bootstrap): `route` (the pattern), `phase` (`"load"` or `"action"`), `action` (the name, or `null` for `load`), `fragment` (name or `null`), `params`, and `session` (`{ id }`). From 1.3.0, optionally `module`: the installed module whose page it is (absent for the app's pages), so the bootstrap builds that module's `ctx` (section 15.1).
- **Result** (bootstrap → Rust), one of:
  - `{ "type": "response" }`: the handler returned a `Response`; its head and body go back as for functions (section 6, "Response body"), a streamed body included.
  - `{ "type": "render", "data_json": "...", "fragments": [...], "locale"?: "...", "dir"?: "ltr" | "rtl" }`: the template data, the out-of-band fragment names (`[]` after `load`), and, from 1.3.0, the locale and direction set with `setLocale` (absent = `en`, `ltr`; "Locale", below). The bootstrap serialises the data with `JSON.stringify` inside V8, and the cell parses the string straight into the renderer's values (the B9 path, #10). Serialisation rules: `bigint` becomes a decimal string, `Date` its ISO string (`toJSON`), `undefined` and functions are dropped, a `Uint8Array` or a cycle is 500 `RENOX_INTERNAL`, and so is data over 8 MiB of JSON *proposed*.
  - `{ "type": "internal", "reason": "..." }`: the handler threw (`threw`), or its result broke a rule above (`load_result`, `action_result`, `data_not_serialisable`, `data_too_large`, `no_template` for an object from a `.ts`-only page). The client gets 500 `RENOX_INTERNAL`; the reason and the redacted error go to the tenant log only.

### Rendering

- The cell renders on a blocking thread pool, outside the isolate and outside the tenant's CPU limit, under the render limits of `docs/08-template-engine.md` (fuel, iterations, output size, include depth, render time). The renderer's thread CPU time is the meter's `render_ms` and its fuel `render_fuel` (`meter.md`).
- A render limit ends the request with 500 `RENOX_RENDER_LIMIT` (meter `status: render_limit`), answered with the error page of `errors.md` section 1.
- The cell adds two values to the template data that tenant code cannot set: the CSP nonce for `<x-script>` and the platform's `<script>`/`<style>` tags, and the CSRF token for `<x-form>` and `<x-csrf>`. They live outside the tenant's data object, so a loader key with the same name cannot replace them.
- Page responses get `Content-Type: text/html; charset=utf-8`, `Cache-Control: no-store` unless the loader returned a `Response`, and `Vary: HX-Request, HX-Target`.

### Locale (1.3.0)

The renderer needs the page's language and direction for `<html lang dir>`, for the `money`, `date`, and `number` filters, and for RTL (`docs/08-template-engine.md`, "RTL"; #233 reads them).

- `setLocale(locale: string, dir?: "ltr" | "rtl")` on `LoaderContext` and `ActionContext` sets them for the current page invocation. `locale` is a BCP 47 tag of at most 35 characters matching `^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$`; anything else throws a `RangeError` in the bootstrap. Without `dir`, the direction is `rtl` for the languages `ar`, `fa`, `he`, `ur`, `ps`, `sd`, `ug`, `yi`, `dv`, `ckb`, and `ltr` otherwise. The last call wins.
- Defaults when nothing calls it: `en` and `ltr`. The `i18n` module (`manifest.md` section 8) does not set them behind the loader's back: its `detectLocale` service returns `{ locale, dir }`, and the loader passes them on.
- They cross in the page result (above), are platform values outside the tenant's data object like the CSP nonce (section 14, "Rendering"), and apply to the error page of the same request. For a streamed page (below) the shell is rendered with the values set before the shell delay ends.
- `ratelimit[].key = "user"` (`artifact.md` section 3, "Security") stays reserved: it needs the `auth` module's user, which F4 delivers as a service, not as a platform value.

### Streaming the shell (1.2.0)

`docs/08-template-engine.md` ("Streaming"): the `<head>` and the layout shell are sent while the loader awaits the database.

- **Which requests.** A full-page `GET` of a page route that has both `load` and a template: not `HEAD`, not a fragment request (`LoaderContext.fragment` is `null`), not an action. Every other page request is rendered and sent in one piece, as in 1.1.
- **The shell delay.** The cell waits for `load` up to **50 ms** *proposed* after the request entered the isolate. A loader that finishes within it gets exactly the 1.1 behaviour: its `Response` is sent as is, its object is rendered and sent in one piece, with the status the outcome calls for. Only a slower loader gets the shell first, so fast pages, and the B6 path, are unchanged.
- **The shell** is the page's output up to the first point where the template reads the template data, cut back to the end of the last complete tag, with the platform tags of the page shell (`client-events.md` section 1) after `<head>` as for a buffered page. The cell finds it by rendering the page, layout included, with template data that records the first read; the output before that read depends on no loader data, so the full page starts with exactly these bytes. The shell render's fuel and CPU are part of the invocation's `render_fuel` and `render_ms`. A page whose template reads data before writing any complete tag has an empty shell: nothing is sent early, and the page is sent in one piece when `load` finishes.
- **Sending it.** At the shell delay the cell sends the head (status 200, the page headers above, and the session `Set-Cookie` if any) and the shell. The response is a streamed body from then on (section 6: chunked, compressed per chunk, meter at the end).
- **When `load` returns an object** the cell renders the full page with the data and sends the bytes after the shell. Out-of-band fragments do not apply (a `GET` has none).
- **Errors after the shell.** The status is already sent, so any outcome that would have been an error page is **rendered inside the stream**: `load` threw or broke a result rule (`RENOX_INTERNAL`), a render limit (`RENOX_RENDER_LIMIT`), the deadline (`RENOX_DEADLINE`), a CPU or heap kill (`RENOX_CPU_LIMIT`, `RENOX_OOM`). The cell renders the error page exactly as it would for a buffered response (`pages/_error` with the same `status`, `code`, `request_id` and `message`, then the platform default page; `errors.md` section 1) and sends its markup from its opening `<body>` tag on (all of it when it has no `<body>` tag), then ends the stream normally. The meter `status` is the one the buffered page would have had (`error`, `render_limit`, `timeout`, `cpu_limit`, `oom`), and `http_status` is 200. The tenant log gets the line the buffered page would have logged (a render failure's line carries `streamed: true`), and the cell adds one line `error page rendered inside the stream` with `code`, `route`, `reason` (`error_after_shell`, `response_after_shell`, or `shell_mismatch` should the full page not start with its shell, which the shell rule rules out) and `streamed: true`. The error page's `<meta name="renox-error-code">` cannot be added to a `<head>` already sent; the client script reads no error code from such a page.
- **A `Response` from `load` after the shell** cannot be sent (a redirect or a 404 needs its status). It is rendered inside the stream as `RENOX_INTERNAL`, logged with `reason: "response_after_shell"`. A loader that redirects or answers 404 should decide that before its first slow `await`, within the shell delay.

### TypeScript view

`ctx.d.ts`: `LoaderContext`, `ActionContext`, `ActionResult`, `Session`, `Loader`, `Action`, `PageModule`, `TextDirection`, and the dispatch types `PageInvocation` and `PageResult`.

## 15. Modules (1.3.0)

The runtime side of `docs/10-modules.md`: what the bootstrap and the cell do with the modules an artifact carries (`artifact.md` section 3, "Modules", which copies `renox.lock`, `manifest.md` section 5). The app itself is the module `app`: it has the app's `permissions`, no `config` (an empty object), no dependencies, and may call every installed module.

Each mechanism of `docs/10-modules.md` maps to one rule here or in a sibling contract:

| `docs/10-modules.md` | Where |
| --- | --- |
| Isolation modes `shared` / `isolate` (D12) | 15.6 |
| Service call (`renox:modules`, the broker supplies the callee's `ctx`) | 15.1, 15.2 |
| Event, in-process and durable (D14) | 15.4; the envelope in 15.4, "Delivery" |
| Hook | 15.3 |
| Public view | Section 1, "Module argument"; `manifest.md` MF6, MF7 |
| Slot | `artifact.md` section 3, "Modules" (the slot registry); rendered by the cell like a partial (section 14, "Rendering") |
| Cross-module transactions | Section 1, "Module argument" (the current transaction) and "Savepoints"; 15.2 |
| Overrides | `artifact.md` section 3, "Modules" (`overrides/`, V20) |
| Migrations in topological order | `artifact.md` section 3, "Modules" (the `modules` order); `manifest.md` section 5 |
| `renox-modules.d.ts` | `manifest.md` section 1; #236 |

The failure modes of the broker and the outbox are testable by these rules:

| `docs/23-failure-modes.md` row | Rule |
| --- | --- |
| "Module service throws" | 15.2, "Errors": `RENOX_MODULE_SERVICE` with `module` and `service`, the enclosing transaction rolled back |
| "Event handler fails repeatedly" | 15.4, "Delivery": 8 attempts with backoff, then dead-letter |
| "Outbox or logs grow unbounded" | 15.4, "Outbox limits": the payload cap, pruning of delivered rows, the dead-letter cap, the tenant file quota |
| "Module contract broken on upgrade" | `manifest.md` MF7 at build; at run time 15.2: a call outside the caller's dependencies is `RENOX_MODULE_UNDECLARED`, never a silent call. `docs/24-threat-model.md`, "Module calling a service or hook it did not declare", is the same rule |

### 15.1 Per-module `ctx`

For each request, the bootstrap builds a frozen `ctx` for each module that runs in it: the route's owner (section 11, step 6) and every module reached by a service call, hook, or in-memory event during the request. A module's `ctx` is built once per request and reused. It differs from the app's `ctx` only in what is bound to the module:

| Field | Bound to the module |
| --- | --- |
| `db` | Every statement carries the module's name as its `module` argument (section 1), so it runs under that module's authorizer; inside a current transaction it runs in that transaction |
| `fetch` | `FetchRequest.module` is the module: its own approved `network` list, nothing else (section 2) |
| `secrets` | The frozen object of `op_secrets_get_all(module)` (section 3) |
| `log`, `console` | Lines carry `module` (section 4). `console` is shared by every module of a `shared` context, so its lines are attributed to the module of the `ctx` the current async context runs for (below) |
| `config` | The module's resolved config from the artifact (`modules[].config`), frozen. The app's is `{}` |
| `module` | The module's name (`"app"` for the app) |
| `services`, `events`, `hooks` | The caller-side objects of 15.2–15.4, checked against this module's manifest |

The request's `req`, `url`, `params`, `headers`, `deadline`, `session`, `fragment`, and `setLocale` are the same objects in every module's `ctx`. The deadline and the CPU limit are the request's: a service call does not get a budget of its own.

The bootstrap marks the async context with the module whose code runs (as it marks the request, section 0), so code that runs without a `ctx` in hand (`console`, `renox:modules` members called from a helper) is attributed to the right module.

**What this boundary is.** In `shared` mode every module runs in one JavaScript context with shared globals (D12). The per-module `ctx` makes the declared permissions the ones that apply: the authorizer, the allowlist, and the secrets are enforced in Rust from the `module` argument. It does not stop module code from reaching another module's `ctx` through shared globals (a patched prototype sees the objects passed through it). That is the reason D12 runs other people's modules `isolate`, and why `shared` is for the tenant's own and the official modules.

### 15.2 Service calls: `renox:modules` and `ctx.services`

```ts
import { billing } from "renox:modules";             // or ctx.services.billing
const plan = await billing.getActivePlan(user.id);   // the broker supplies billing's ctx
```

- **Resolution.** `renox:modules` is a virtual module served by the runtime's module loader. It is resolved **per importing module**: the loader knows the referrer's path (`code/modules/<name>/…`, or the app's code), so each module gets its own instance, bound to it as the caller. It has one named export per installed module; each export is a frozen object with one function per name in that module's `exports.services`, and nothing else. `ctx.services` holds the same objects. Calling a member outside a request rejects with `RENOX_NO_REQUEST`.
- **Dependency check.** A call to a module that is not in the caller's `dependencies` rejects with `RENOX_MODULE_UNDECLARED` (`details: { module: <caller>, target: <callee> }`) before any callee code runs. The app may call every installed module. `manifest.md` MF7 finds the same mistake at build; this check is the run-time guarantee. Cycles are rejected at build (`manifest.md` MF5), not at call.
- **The call.** The broker calls the callee's `services.ts` export as `fn(calleeCtx, ...args)` and returns its result. `calleeCtx` is the callee's `ctx` for this request (15.1): same user (`session`), request id, deadline, and **current transaction** (section 1). In `shared` mode the arguments and the result are passed by reference, with no copy and no serialisation (D12); a callee must not keep them past the call.
- **Errors.** When the callee throws (or its promise rejects), the caller gets a `ModuleServiceError` with `code: "RENOX_MODULE_SERVICE"`, `details: { module, service, cause_code }`: `module` and `service` name the callee, `cause_code` is the callee error's `code` when it was a `RenoxError` and `null` otherwise. The error also carries `module` and `service` as fields of its own (`service` is `null` when a hook filler or an event handler threw, whose `details` name the `hook` or `event` instead of `service`). The callee's error (redacted, section 3) goes to the tenant log with the callee's `module`; the caller's `message` is `"<module>.<service> failed"` plus the callee error's message. **If the call was made inside a transaction, Rust rolls that transaction back at once**: later statements on it and its commit reject with `RENOX_DB_TX_STATE`, so a caller that catches the error can still answer, but nothing of the transaction is kept (`docs/23-failure-modes.md`, "Module service throws"). A `RENOX_MODULE_SERVICE` from a nested call is wrapped again by each module it passes through.
- **Limits.** Calls nest at most 16 deep; a deeper call rejects with `RENOX_MODULE_SERVICE` (`cause_code: null`, message `"call depth"`) without running. Recursion inside a module is ordinary JavaScript.

### 15.3 Hooks: `ctx.hooks.run`

```ts
const r = await ctx.hooks.run("auth.after_login", { user_id });   // in auth
if (r.halt) return r.response;
```

- **Who may run.** Only the module that exports the hook point (`exports.hooks`) may run it; any other caller gets `RENOX_MODULE_UNDECLARED`.
- **Fillers.** The fillers are the modules whose approved `permissions.hooks` lists the hook and whose `hooks.ts` exports `hooks[name] = { priority?, handle(ctx, args) }` (section 11, step 5 refuses a filler the manifest does not declare). They run one after another in ascending `priority` (default 100, 0–1000), ties by module name. Each runs with its own module's `ctx`, in the caller's current transaction.
- **Results.** A filler returns `undefined` to continue, or `{ halt: true, response }` (`response` a `Response`) to stop: the remaining fillers are skipped and `run` resolves to `{ halt: true, response, module }`. When every filler continued, `run` resolves to `{ halt: false }`. Any other return value is treated as a throw (`TypeError`).
- **Errors.** A filler that throws ends the run: the caller gets `RENOX_MODULE_SERVICE` with `details: { module: <filler>, hook: <name>, cause_code }`, and the current transaction is rolled back, as for a service (15.2).
- `args` are passed by reference in `shared` mode. The exported `args` schema is documentation and the source of the types in #236; it is not validated at run time.

### 15.4 Events: `ctx.events.emit` and `op_events_emit`

```ts
const id = await ctx.events.emit("billing.invoice_paid", { invoice_id, user_id, amount });   // durable
await ctx.events.emit("billing.cart_changed", { cart_id }, { durable: false });              // in-memory
```

| Op | Arguments | Result |
| --- | --- | --- |
| `op_events_emit` | `name: string, payload_json: string, durable: boolean, module: string \| null, tx: number \| null` | `string`: the event id (a ULID) |

- **Who may emit.** A module emits only the events it exports (`exports.events`, names `<module>.<event>`). Any other name rejects with `RENOX_MODULE_UNDECLARED`. The app exports no events in F4 (Open 8).
- **Payload.** The bootstrap serialises the payload with `JSON.stringify` (rules of section 14, "Page dispatch"). Rust parses it and validates it against the event's exported `payload` schema. A payload that is not JSON-serialisable, does not match, or is over 64 KiB of JSON rejects with `RENOX_EVENT_PAYLOAD`, `details: { event, reason }` (`reason`: `"schema"`, `"not_json"`, `"too_large"`), and nothing is written or run.
- **Durable** (default, D14). Rust inserts the event into the platform table `renox__outbox` **in the current transaction** (`tx`; with `tx = null`, as its own autocommit write), so a transaction that rolls back never delivers its events, and a committed one always does. The op resolves with the id once the row is written; handlers run later, after the commit, by the cell's outbox worker ("Delivery").
- **In-memory** (`{ durable: false }`). Rust validates the payload and returns an id; nothing is stored. The bootstrap then runs, before `emit` resolves, the `on[name]` handler of every installed module that has one, in the `modules` order (the app last), each with its own module's `ctx` and the emitter's current transaction. A handler that throws fails the `emit` with `RENOX_MODULE_SERVICE` (`details: { module: <handler>, event: <name>, cause_code }`) and rolls back the current transaction; uncaught, it fails the request (`docs/10-modules.md`, "Handler fails: request fails").
- **Handlers** are the `on` export of each module's `hooks.ts`: `on[name] = async (ctx, e) => void`, with `e = { id, name, payload, attempt }`. A module may handle any exported event without a declared dependency.

#### Delivery (durable events)

The outbox worker of the cell is woken by SQLite's `update_hook` on `renox__outbox` (D14), not by polling. For each event and each module with an `on` handler for it, there is **one delivery**, with its own attempts: one failing handler does not re-run the others. Deliveries go to the deployment that is active when they run, not the one that emitted.

The cell invokes the bootstrap with the **event envelope** (`ops.schema.json` `$defs/event_dispatch`), alongside the request envelope of section 6:

```json
{ "kind": "event", "id": "01JBQ3Z7MA0000000000000001", "name": "billing.invoice_paid", "payload": { "invoice_id": "inv_1", "user_id": "u_1", "amount": 4200 }, "attempt": 1, "module": "email" }
```

- The handler runs with a **fresh `ctx`** of its module: `db` is its own `IMMEDIATE` transaction opened by the bootstrap (a `DbStatements`, like an action's), and there is no `req`, `url`, `params`, `headers`, `session`, or user. `ctx.event` holds `{ id, name, attempt }`.
- It runs under the tier's CPU and wall-clock limits per attempt (section 10), with the same token and cancellation rules as a request.
- When the handler resolves, the bootstrap commits its transaction, and Rust records the delivery as done **in the same transaction**, so the handler's writes and its acknowledgement commit together. A throw, a limit, or a crash before the commit is a **failed attempt**: the transaction rolls back, and nothing of the attempt is kept.
- The result crosses back as `{ "type": "ok" }` or `{ "type": "failed", "reason": "threw" | "no_handler" }` (`no_handler`: the active deployment has no `on` handler for it any more; the delivery is dropped and logged, not retried).
- **Retries.** A failed attempt is retried after 10 s × 2^(attempt − 1), capped at 1 h, with ± 20 % jitter; after the 8th failed attempt the delivery is **dead-lettered**: kept with its last error (redacted), shown in the dashboard and in the `jobs` module (F6), never retried on its own (`docs/23-failure-modes.md`, "Event handler fails repeatedly"). The numbers are *proposed* (Open 5).
- **Guarantee.** At-least-once per (event, module): a handler may see the same `id` again after a crash between its commit and the worker's bookkeeping, or after a deadline. Handlers are idempotent using `e.id` (`docs/10-modules.md`).
- Each attempt gets its own meter record and log lines with `module`, `event`, `event_id`, `attempt` (section 7).

#### Outbox limits

- A payload is at most 64 KiB of JSON (above).
- Delivered and dropped rows are pruned 7 days after delivery. Dead letters are kept up to 10,000 per tenant; past that the oldest is deleted and one log line says so (`docs/23-failure-modes.md`, "Outbox or logs grow unbounded").
- The outbox lives in the tenant's SQLite file and counts against its quota: an `emit` into a full file rejects with `RENOX_DB_QUOTA`, like any write.

### 15.5 Config: `ctx.config`

`ctx.config` is the module's resolved `[config]` (`manifest.md` section 2): every declared key that has a value, from `renox.toml` or the default, typed `string`, `number` (an `int` key), or `boolean`, frozen. It is the same object for every request of a deployment. A config change is a new lock, so a new artifact and deployment: there is no run-time reload. Secrets are never in config.

### 15.6 Isolation modes (D12)

- **`shared`** (default): what this section describes. Every `shared` module and the app run in the deployment's one JavaScript context; calls are plain function calls.
- **`isolate`**: the module runs in an isolate of its own, with its own heap limit, inside the tenant's process. Service calls, hooks, and in-memory events then cross between isolates with structured-clone semantics (no functions, no shared objects; a `Response` crosses as status, headers, and body bytes), through broker ops reserved here (`op_hooks_run` and the call ops, section 8). The checks of 15.2–15.4 are the same. Not implemented in F4 (Open 7).
- Whatever the mode, table permissions are enforced by the authorizer and network permissions by `op_fetch`, from the `module` argument, never by JavaScript convention (`docs/10-modules.md`).

## 16. Passwords: `op_password_hash`, `op_password_verify` (1.3.0)

Argon2id with the parameters of `docs/24-threat-model.md` needs 64 MiB per hash: more than a free-tier tenant heap (128 MB) can give, and seconds of CPU the tenant's limit does not have. So password hashing is a Rust op, for the `auth` module and any tenant code, as `ctx.password`.

| Op | Arguments | Result |
| --- | --- | --- |
| `op_password_hash` | `password: string` | `string`: a PHC string `$argon2id$v=19$m=65536,t=3,p=1$<salt>$<hash>` |
| `op_password_verify` | `password: string, hash: string` | `boolean` |

- **Parameters.** Argon2id, version 0x13, m = 65,536 KiB (64 MiB), t = 3, p = 1, a 16-byte random salt from the OS, a 32-byte output. `verify` reads the parameters from the PHC string, so hashes made with other parameters keep verifying; it accepts only `argon2id` and parameters no larger than the platform's (a hash asking for more memory or time resolves `false`, so a crafted hash cannot exhaust the pool). A malformed hash resolves `false`. Comparison is constant-time.
- **Input.** `password` is a string of 1 to 1,024 UTF-8 bytes with no lone surrogates; the bootstrap throws a `RangeError` before the op for anything else, so it never crosses. A password is never logged, never in an error message, and never in a meter record.
- **Off the isolate thread.** The hash runs on the platform's password pool (one thread per two cores *proposed*, outside the tenant's isolate and heap). At most 2 password ops of one tenant run at once *proposed*; further calls wait. The wait and the hash count against the request's **wall-clock deadline** (a pending op rejects with `RENOX_DEADLINE` and its pool slot is released when the hash ends).
- **Metering.** Each call adds **1 ms to the request's `cpu_ms`** and to the CPU limit check, whatever the hash really took; the pool's real CPU is platform time (Open 6).
- **Rate guidance for `auth`** (and #100): each login, registration, or reset attempt costs one op, so the `auth` module must rate-limit them before calling `verify`: per account (5 failed attempts per 15 minutes, then a delay) in its own tables, and per IP with a `security.ratelimit` bucket on its login route (`artifact.md` section 3; `key = "user"` stays reserved). A tenant that calls `hash` in a loop is bounded by its CPU limit (50 calls per free request) and by the per-tenant concurrency above.

`ctx.password` in `ctx.d.ts`: `hash(password): Promise<string>`, `verify(password, hash): Promise<boolean>`.

Types for section 15 in `ctx.d.ts`: `Ctx.module`, `Ctx.config` (`ModuleConfig`), `Ctx.services` (`Services`), `Ctx.events` (`Events`, `EmitOptions`), `Ctx.hooks` (`Hooks`, `HookRunResult`), `ServicesModule`, `HooksModule` (`HookFiller`, `HookFillerResult`, `EventHandler`, `EventContext`, `EventInfo`, `DeliveredEvent`), the dispatch types `EventEnvelope`, `EventResult`, `ModuleInfo`, and the errors `ModuleUndeclaredError`, `ModuleServiceError`, `EventPayloadError`.

## Verification by implementing issues

These are not open design questions. Each is a decided rule with a decided fallback, and the named issue proves it with a test:

1. **Async context propagation** (section 0, "Request scope"): proved by #25 (`crates/renox-runtime/tests/dispatch.rs`, `request_scope_follows_async_context`).
2. **Extension on the worker** (section 0, "How ops are exposed"): done by #25 on `deno_runtime`, with no patch.
3. **Limit values**: #18–#21 (data), #27 (fetch), #28 (logs and secrets) assert the numbers in their tests. A change goes through this file as a minor version.
4. **`x-renox-client-ip`** (section 6): the header name is fixed here. #22 decides which proxies are trusted to supply the client address.
5. **Pages** (section 14): #41 tests CSRF (403 without a token, the action runs with one), the action transaction (rollback on throw), the re-run of `load` after an object result, and out-of-band fragments; #40 tests fragment selection and the `render_fuel`/`render_ms` fields; #44 tests that the SDK types are assignable to `ctx.d.ts`.
6. **Blocked ranges** (section 2): #170 adds one test per range added in 1.1.0.
7. **Streamed bodies** (sections 0, 6, 7, 10, 14): #161 tests that the head and the first chunk of a streamed body reach the client before the stream ends, that the egress limit truncates the body and logs `egress_limit`, that a CPU kill mid-stream truncates it and records `cpu_limit` with the bytes sent, that the meter record is written at the end of the stream, that the shell of a page reaches the client before a slow loader finishes, and that a loader error after the shell is rendered inside the stream; B6 is re-run before and after.

8. **Modules** (sections 1, 3, 11, 15, 16): #230 tests the per-module `ctx` (a module's statement on another module's table is `RENOX_DB_AUTH`; its `fetch` to a host only the app allows is `RENOX_FETCH_BLOCKED`; its `ctx.secrets` holds only its own), `RENOX_MODULE_UNDECLARED` for an undeclared call, `RENOX_MODULE_SERVICE` with the rollback of the enclosing transaction, hook order and halt, and the refusal of an undeclared filler at load; #229 tests savepoints (rollback of the inner part only, the `renox_` name refusal, the depth limit); #231 tests the outbox (a rolled-back transaction delivers nothing, a delivered handler's writes and its acknowledgement commit together, retries with backoff, dead-letter after the last attempt, the event meter record); #229 also tests the password ops (parameters read back from the PHC string, 1 ms charged per call, wall time against the deadline); #233 tests `locale` and `dir` in the rendered page; #236 tests that the SDK types are assignable to `ctx.d.ts`.

## Future (additive, not scheduled)

- `op_db_query_raw` returning `{ columns, rows: Value[][] }` if B9/B10 show that building row objects dominates.
- Redaction of common encodings of secret values (section 3), if a cheap way is found.
- A body limit for static responses (today bounded only by the heap limit, section 10) and a per-app override of the response egress limit (`artifact.md` section 3, "Limits overrides").
- Streamed `fetch` request bodies (section 8) and SSE framing (F5, #70) build on the chunk ops of section 6.

## Open

Values of 1.2.0 that #161 checks by measurement, and of 1.3.0 that #229–#231 check. The implementing issues do not edit this file: a measured reason to change one goes to a new `type:contract` issue, as a minor version (section 9).

1. **Shell delay** (section 14): 50 ms *proposed*. Shorter flushes more pages early but commits status 200 for more slow loaders that would have redirected; #161 re-runs B6 before and after.
2. **Chunk buffer** (section 6, "Backpressure"): 16 chunks per response. A byte bound may replace it if a tenant's large chunks hold too much memory between the isolate and the connection.
3. **Static body limit** (section 10, "Response egress"): none beyond the heap limit; listed under "Future".
4. **Event meter records** (section 7): settled in this version: `meter.md` 0.2 adds `kind: "request" | "event"` and the event route form `EVENT <module> <name>`.
5. **Retry schedule and outbox caps** (section 15.4): 8 attempts, 10 s doubling to 1 h, 7 days of delivered rows, 10,000 dead letters per tenant are *proposed*; #231 measures and may change them.
6. **Password parameters and pool** (section 16): m = 64 MiB, t = 3, p = 1 come from `docs/24-threat-model.md`; the pool size and the per-tenant concurrency of 2 are *proposed*; #229 measures hash time on `node-small` (B-series in `docs/14-benchmarks.md`).
7. **`isolate` mode** (section 15.6): the semantics are fixed here; the runtime that runs a module in its own isolate is not scheduled in F4. Until it exists, a build that asks for `isolate` fails (`manifest.md` Open 2).
8. **App events and hooks**: the app has no manifest, so it can neither export events nor expose hook points (`manifest.md` Open 5).

## Changelog

| Version | Issue | Changes |
| --- | --- | --- |
| 0 | #12 | First sketch (F0): db, fetch, secrets, log, deadline, request envelope, meter fields, reserved ops |
| 1.0.0-f1 | #17 | **Exposure:** `op2` extension `renox` in `crates/renox-runtime` (section 0). **Request scope:** carried by the async context, with the one-request-per-isolate fallback; only `op_log` works outside a request (section 0). **Secrets:** consumed before tenant code runs; values under 8 bytes refused; exact-substring redaction stated as a limitation (section 3). **New sections:** limits per tier and behaviour on each limit (section 10), isolate bootstrap and global hardening (section 11), serialisation rules (section 12), shared error code table, with response codes `RENOX_CPU_LIMIT`, `RENOX_OOM`, `RENOX_BUSY`, `RENOX_INTERNAL`, `RENOX_BODY_TOO_LARGE` alongside the thrown codes (section 13). **Numbers:** every "proposed" value is now the F1 value. **Meter fields:** section 7 renamed to the names in `meter.md` (`route`, `fetch_sent_bytes`, `fetch_received_bytes`, `http_status`, `ingress_bytes`). **Versioning:** moved to `MAJOR.MINOR.PATCH` (section 9). **Open list:** replaced by "Verification by implementing issues" and "Future" |
| 1.1.0 | #153 | **Pages (section 14):** `LoaderContext`, `ActionContext` (`form`, `action`, `fragment`, `session`, `db` as the action's transaction), `ActionResult`, `Session`, CSRF before actions, the page dispatch exchange (`ops.schema.json` `$defs/page_dispatch`), rendering off the isolate thread; response codes `RENOX_CSRF` and `RENOX_RENDER_LIMIT` (section 13). **Termination bound and collateral rule** stated for tenants (section 10). **Blocked ranges (section 2):** SIIT, NAT64 network-specific prefixes, `192.88.99.0/24`, `3fff::/20`, `5f00::/16`, `fec0::/10`, and the refused names. **Stale text removed:** the Edge Runtime per-worker options and user-worker wording (sections 0, 10, 11), the semaphore's location, the async-context fallback, the `node:` row; `op_fetch` is registered as `op_renox_fetch`. Meter fields `render_fuel` and `render_ms` filled by the cell (section 7) |
| 1.2.0 | #206 | Minor (additive). **Streamed response bodies (section 6):** head first; a static body crosses with the head as before, a `ReadableStream` body crosses chunk by chunk through the new ops `op_response_write` (async, backpressure at 16 chunks) and `op_response_end` (sync, explicit end, or the failure message); a stopped stream is truncated so the client can tell; `Content-Length` removed from streamed bodies; per-chunk gateway compression. **Request scope (section 0):** a request ends when its response ends. **Meter (section 7):** written at the end of the stream, with `wall_ms`, `egress_bytes` and `status` of the whole stream. **Limits (section 10):** response egress per request, 10 MB free / 100 MB paid, counted per chunk before compression, separate from the `fetch` counter; the mid-stream table (egress limit, stream failure, deadline, CPU, heap, client gone). **Pages (section 14):** the shell is flushed after a 50 ms *proposed* shell delay for full-page `GET`s with a loader; errors after the shell are rendered inside the stream; a loader `Response` after the shell is `response_after_shell`. No new error code; `ctx.d.ts` unchanged except its version line |
| 1.3.0 | #226 | Minor (additive). **Modules (new section 15):** per-module `ctx` built by the bootstrap from the artifact's `modules` list (db under the module's authorizer, its own secrets, `fetch` allowlist, and config); `renox:modules` and `ctx.services` (service calls checked against the caller's dependencies, run in the callee's `ctx` with the same user, request, deadline, and current transaction; a callee error reaches the caller as `RENOX_MODULE_SERVICE` and rolls back the enclosing transaction); `ctx.hooks.run` (fillers in priority order, halt, undeclared fillers refused at load); `ctx.events.emit` and `op_events_emit` (durable into `renox__outbox` in the current transaction, or in-memory in the same request; payload checked against the exported schema); the event envelope and delivery (own transaction committed with the acknowledgement, retries, dead-letter); `ctx.config`; isolation modes. **Ops:** a trailing `module` argument on `op_db_*`, `op_secrets_get_all` (now once per module), `op_log`, and `FetchRequest.module` (sections 0–4); savepoint ops `op_db_savepoint_begin`/`_release`/`_rollback` (section 1); `op_events_emit` (section 15.4); `op_password_hash`, `op_password_verify` (argon2id off the isolate thread, new section 16). **Pages:** `setLocale`, `locale` and `dir` in the render result, optional `module` in the page invocation (section 14). **Errors:** `RENOX_MODULE_UNDECLARED`, `RENOX_MODULE_SERVICE`, `RENOX_EVENT_PAYLOAD` (section 13). **Meter:** event delivery records (section 7, Open 4). Section 8 reserves only `op_hooks_run` and the `isolate`-mode ops for F4 |
| 1.1.1 | #201 | Patch, wording only: section 10 states what #155 and #156 implement. **CPU attribution** per async context: a request is charged the CPU of its own continuations, unattributed CPU is split among the requests in flight, and CPU used before a request was admitted is never split onto it. **Collateral rule** per pool member: one bad request ends the in-flight requests on its own member only; the pool size is per tier (`IsolateSpec::max_isolates`); collateral meter records carry the same `status` and are indistinguishable from the request that hit the limit. `ctx.d.ts` and `ops.schema.json` unchanged |
