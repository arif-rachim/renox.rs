# Contract: runtime ops and the `ctx` surface

| | |
| --- | --- |
| Version | **1.6.0** (F6, #315: the `jobs` module's read and write path, `op_jobs_list`, `op_jobs_retry`, `op_jobs_cancel`, the coalescing key, the lease and the `deliver` path, `RENOX_JOB_NOT_FOUND`, `RENOX_JOB_STATE` (section 20)). 1.5.0 (F5, #272: the principal, `guard`, `op_authz_*` and `ctx.authz`, `db.scoped()`, role assignments and the authz audit table (section 17); `ws` and `sse` routes, `op_realtime_*`, topics as Cedar resources, the change feed (section 18); App MCP tool routes and `/mcp` (section 19); jobs with `schedule` and `op_jobs_enqueue` (section 20); sections 0, 1, 6, 7, 8, 11, 13, 14 updated). 1.0.0 is implemented by the F1 runtime (#25–#28) and SDK (#31); the additions of 1.1.0 (#153: section 14, the blocked ranges of section 2) are implemented by #40, #41, #44, and #170; the additions of 1.2.0 are implemented by #161; the additions of 1.3.0 by #229, #230, #231, #233, and #236; the additions of 1.4.0 by #265 (lazy route modules) and #266 (locale extensions); the additions of 1.5.0 by #276–#281, #283–#285 and #291 (F5) and #297 (jobs, F6); the additions of 1.6.0 by #297 (the ops) and #307 (the Logs follower that uses them). History: "Changelog" at the bottom |
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
- **Module (1.3.0).** Ops that act for a module (`op_db_*`, `op_fetch`, `op_secrets_get_all`, `op_log`, `op_events_emit`, and from 1.5.0 `op_authz_*`, `op_realtime_*`, `op_jobs_enqueue`, and from 1.6.0 `op_jobs_list`, `op_jobs_retry`, `op_jobs_cancel`) take the module's name as an argument, `null` meaning the app. The bootstrap fills it from the `ctx` the call came through (section 15.1); tenant code never passes it, and Rust checks it against the artifact's `modules` list.
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
| `op_db_query` | `sql: string, params: Param[], tx: number \| null, module?: string \| null, scope?: Scope \| null` | `Row[]` |
| `op_db_query_one` | `sql: string, params: Param[], tx: number \| null, module?: string \| null, scope?: Scope \| null` | `Row \| null` (first row; the statement stops after it) |
| `op_db_execute` | `sql: string, params: Param[], tx: number \| null, module?: string \| null, scope?: Scope \| null` | `{ changes: number, lastInsertRowid: number \| bigint }` |
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
type Scope = { user_id?: string; org_id?: string; session_id?: string };   // 1.5.0, "Scoped statements"
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

### Scoped statements (1.5.0)

`ctx.db.scoped(scope)` returns a `Db` whose statements carry `scope` as the fifth argument of `op_db_query`, `op_db_query_one`, and `op_db_execute` (`null` or absent = unscoped). It is the row-level fence of D16 (`docs/11-authorization.md`, "`db.scoped()`"); the full rules, the ownership declaration, and `RENOX_DB_SCOPE` are in section 17, "`db.scoped()`". The scope is bound in Rust per statement: a scoped `Db` inside `db.transaction` runs its statements in the current transaction, under the same authorizer, with the owner predicate added.

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
| `RENOX_DB_SCOPE` (1.5.0) | `DbScopeError` (`details.table`, `details.module`, `details.reason`) | Module code touched an owned table without a scope, or a scoped statement could not be rewritten (section 17, "`db.scoped()`") |

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
| `principal` (1.5.0) | `Principal \| null` | Resolved by the cell before `guard` and before the handler (section 17, "Principal"); `null` is the anonymous principal |
| `authz` (1.5.0) | `Authz` | `require`, `can`, `canBatch`, `explain`, `roles` (section 17) |
| `realtime` (1.5.0) | `Realtime` | `subscribe`, `unsubscribe`, `publish`, `send`, `close` (section 18); `publish` works from any handler, the others need a `conn` |
| `jobs` (1.5.0) | `Jobs` | `enqueue` (section 20) |

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

Page modules export `load` and `actions` (section 14). Module trees add `services.ts` and `hooks.ts` (section 15), and an event handler is invoked with the event envelope of section 15.4, not a `Request`. From 1.5.0 a page or function module may export `guard` (section 17), a `functions/ws/**` module exports `ws` and a `functions/sse/**` module `sse` (section 18), a `functions/tools/**` module default-exports a `tool(...)` (section 19), and a `jobs/**` module exports `schedule` and `run` (section 20). Still reserved: `cors` and `frame` options (F2, `artifact.md` Open 6).

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
| `authz_evals` (1.5.0) | cell | Every Cedar evaluation of the invocation: `guard`, `op_authz_*`, `r-can` with a resource, the subscribe check of section 18, the tool check of section 19 (section 17, "Metering") |
| `realtime_conn_seconds`, `realtime_messages` (1.5.0) | cell | The realtime component, on the record of a `ws` or `sse` connection only (section 18, "Metering") |

Types, units, and the `status` values are defined in [`meter.md`](meter.md) section 2.

**When (1.2.0).** The record is written when the request ends (section 0, "Request scope"): for a static body when the response is handed to the gateway, for a **streamed body at the end of the stream**, whatever ended it: the normal end, the egress limit, the deadline, a CPU or heap kill, a failed stream, or the client going away. Then:

- `wall_ms` runs to the end of the stream; `cpu_ms`, `db_*`, `fetch_*` and `logs_dropped` include what the stream's `pull` used;
- `egress_bytes` counts the body bytes handed to the connection, after compression, up to the stop: a truncated response records the bytes sent so far;
- `http_status` is the status sent in the head, even when the stream was cut later;
- `status` is the cause of the end: `ok` for the normal end and for a client that went away, `timeout`, `cpu_limit` or `oom` for a kill mid-stream, `error` for the egress limit and for a failed stream (section 10, "Mid-stream").

**Modules (1.3.0).** A service call, a hook, and an in-memory event handler run inside the invocation that made them, so their CPU, `db_*`, and `fetch_*` are part of that invocation's one record. Each **event delivery** attempt (section 15.4) is an invocation of its own and gets its own record (`meter.md` 0.2, section 2, "Event records"): `kind: "event"`, `route` = `EVENT <module> <name>` (the handling module and the event name), `request_id` = `<event id>_<module>_<attempt>`, and `status` from section 10 (`ok` when the handler resolved, `error` when it threw). Each password op adds 1 ms to `cpu_ms` (section 16).

**Lazy route modules (1.4.0).** A route module evaluated on its first request (section 11, step 4) is evaluated inside that request: its top-level code's CPU is in that request's `cpu_ms`, and its evaluation time is in that request's `wall_ms`. Later requests to the same route on the same isolate pay nothing for it. Eager modules are evaluated at isolate creation, outside any request, and are not metered, as before.

**Realtime, tools, and jobs (1.5.0).** A `ws` or `sse` connection is **one invocation** from the upgrade to the close: one record, written at the close, with `route` `WS <pattern>` or `SSE <pattern>`, `http_status` 101 or 200, `wall_ms` the connection's lifetime, `cpu_ms` and `db_*` the sum of its `open`, `message`, and `close` handler runs, `realtime_conn_seconds`, and `realtime_messages` (section 18, "Metering"). A tool call through `/mcp` is one invocation: `kind: "tool"`, `route` `TOOL <name>` (section 19). A job run is one invocation per attempt, like an event delivery: `kind: "job"`, `route` `JOB <module> <name>`, `request_id` `<row id>_<attempt>` (section 20). The forms are fixed in `meter.md` 0.3, section 2.

## 8. Reserved ops and `ctx` fields

Not available yet. Names are reserved so nothing else takes them. `form`, `session.id`, `fragment`, and `action` are available to pages since 1.1.0 (section 14). `principal`, `authz` (`op_authz_*`), `realtime` (`op_realtime_*`), `db.scoped()`, and `jobs` (`op_jobs_enqueue`) are defined since 1.5.0 (sections 17–20); the runtime that implements them is F5 (#276–#285) and, for jobs, F6 (#297).

| `ctx` field / op area | Phase |
| --- | --- |
| `render` (`op_render_*`), `webhook` (`verify`), streamed `fetch` request bodies. Realtime payloads reach the renderer through the `fragment` payload of section 18, not through `ctx.render` | F2 (not scheduled yet) |
| `kv` (`op_kv_*`) | F2 (not scheduled yet) |
| `op_hooks_run` and the other cross-isolate broker ops of `isolate` mode (section 15.6). `config`, `events`, `hooks`, `services`, `password`, savepoints, and `setLocale` are available since 1.3.0, and `setLocale` takes the `-u-ca-`/`-u-nu-` extensions since 1.4.0; `auth` and session data beyond `session.id` are services of the `auth` module (`manifest.md`), not ops, so nothing is reserved for them | F4 (later issue) |
| MCP resources and prompts on `/mcp`, server-initiated notifications (section 19, Open 17) | F7 |
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

Per-op limits (statement time, rows, egress bytes, concurrent fetches, log rate) are in each op's section above. The realtime limits (connections, message size, backpressure) are in section 18, the authz evaluation limit in section 17, and the tool-call limits in section 19.

## 11. Isolate bootstrap

The sequence from an empty worker to a dispatched request. Each step finishes before the next starts, and a failure in steps 1–5 is a module-evaluation failure (section 10). From 1.4.0 a route module may be evaluated later, on its first request (step 4, "Lazy route modules"); its failure then fails that request, not the deployment.

1. **Worker and platform snapshot.** The runtime creates a `deno_runtime` worker for the deployment:
   - Deno permissions all **denied** (`net`, `read`, `write`, `env`, `run`, `ffi`, `sys`, `import`), so nothing upstream can open a socket or file on the tenant's behalf. `op_fetch` and `op_db_*` are not permission-gated; they enforce their own rules.
   - No environment variables, no remote modules, no npm resolution at runtime (dependencies are inside the artifact). The module loader serves the artifact's `code/` under a virtual root (`file:///<path>`), so no path of the machine is visible.
   - The isolate starts from the platform snapshot, built once per process: Web APIs plus the `renox` extension's ESM bootstrap.
2. **Capture and harden.** The bootstrap takes the op functions it needs into private closures, then changes the global scope as in the table below. After this step tenant code cannot reach `Deno.core` or the op table.
3. **Modules and secrets.** Rust passes the artifact's module list to the bootstrap's init function (1.3.0; `ops.schema.json` `$defs/moduleInfo`: each module's name, isolation, dependencies, resolved config, approved permissions, and exports, copied from `artifact.md` section 3, "Modules"). For the app and for each module the bootstrap calls `op_secrets_get_all` once, freezes the result, and keeps it in a closure (section 3).
4. **Tenant modules.** The runtime first checks that every module listed in `manifest.code.entry` (`artifact.md` section 3) exists in the module graph: the file under `code/` for `esm-dir`, or `file:///<path>` inside `bundle.eszip` for `eszip`. A missing one fails the deployment (fail closed, `RENOX_INTERNAL`). It then imports the **eager** entries, in the order of the `modules` list, then the app's. Top-level module code runs here, outside any request: `console` works (logged with `request_id: null`); `fetch`, `ctx.db` and the other ops reject with `RENOX_NO_REQUEST`. The module-evaluation limits of section 10 apply.
   - **Which entries are eager (1.4.0).** Without the artifact's `entries` field (`artifact.md` 1.2, section 3, "Entries"), every entry is eager: the 1.3.0 behaviour. With it, an entry is eager unless its record says `eager: false`. A module's `services` and `hooks` entries are always eager (V23), because the broker needs them before any request (section 15). `renox build` marks route modules `eager: false` and keeps eager what a page render may need before its own module runs: the error page's module (`pages/_error`), and any entry the app lists as eager.
   - **Lazy route modules (1.4.0).** A module with `eager: false` is evaluated on the first request whose route needs it, once per isolate: concurrent first requests on the same isolate wait for the one evaluation. Its top-level code runs **inside that request**: ops work, under the request's deadline and limits, and its CPU is charged to it (section 7). Code that should not run on behalf of a request belongs in an eager module.
   - **A lazy module that throws** at its first evaluation, or exceeds a limit while evaluating, ends that request with 500 `RENOX_MODULE_EVAL` (section 13). The error is logged once per isolate with the module id and the redacted error. The isolate stays up, and other routes keep answering. The failed evaluation is cached for the isolate's lifetime: later requests to that route get the same 500 without re-running the module, and a new isolate tries again. A CPU or heap kill during evaluation is that limit's response (section 10), as for any request.
5. **Handler lookup.** For each `manifest.routes[]` entry, the bootstrap checks that the module's `export` is a function and builds the matcher of `artifact.md` section 3 ("Route objects"). For an eager module this happens at isolate creation; a missing or non-function export fails the deployment as a whole (fail closed, `RENOX_INTERNAL`, logged with the route). For a lazy module (1.4.0) it happens right after its first evaluation; a missing or non-function export then answers that request with 500 `RENOX_MODULE_EVAL`, logged once as above. **The fail-closed export check moves to build and deploy (1.4.0):** `renox check` refuses a missing or non-function export, naming the file and the export, and `renox build` records each entry's static export names in the artifact's `entries` field. At prepare, before any isolate exists, the worker compares the recorded names with the module's static exports and refuses an artifact whose names differ (`artifact.md` V23). So a deployment whose lazy module lacks an export is refused at deploy, and the request-time check is a second line of defence. From 1.3.0 the same rule covers modules (section 15): every name in a module's `exports.services` must be a function export of its `services.ts`; every key of its `hooks.ts` `hooks` export must be a hook in its approved `permissions.hooks`, with a `handle` function (a filler the manifest does not declare is refused); every value of its `on` export must be a function. A key of `on` naming an event that no installed module exports is logged once and never called. These module checks stay at isolate creation, because `services` and `hooks` entries are always eager.
6. **Request dispatch.** For each request, Rust calls the bootstrap's dispatch function with a fresh request token, the matched route, the route parameters, the principal (1.5.0, section 17: resolved and the route's `guard` evaluated **before** this call; a denied guard never reaches the bootstrap), and the request head and body stream. The bootstrap:
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
| `RENOX_JOB_NOT_FOUND` | thrown | 1.6.0: `op_jobs_retry` / `op_jobs_cancel` for an id that is not a job row of this tenant (section 20) | `JobNotFoundError` | uncaught → 500 `RENOX_INTERNAL` | `error` |
| `RENOX_JOB_STATE` | thrown | 1.6.0: `op_jobs_retry` on a row that is not dead, `op_jobs_cancel` on a running row (section 20) | `JobStateError` | uncaught → 500 `RENOX_INTERNAL` | `error` |
| `RENOX_DB_SCOPE` | thrown | 1.5.0: `op_db_*` with module code touching an owned table without a scope, or a scoped statement the rewriter cannot prove (section 17) | `DbScopeError` | uncaught → 500 `RENOX_INTERNAL` | `error` |
| `RENOX_REALTIME_LIMIT` | both | 1.5.0: `op_realtime_subscribe` over the topics per connection, `op_realtime_publish` / `op_realtime_send` with a message over 64 KB (thrown); the connection caps at the upgrade, or an inbound flood (response, section 18) | `RealtimeLimitError` | 503 `RENOX_REALTIME_LIMIT` at the upgrade; close 1008 on an open connection; uncaught in a handler → the handler's failure (section 18) | `busy` at the upgrade; `ok` for a close |
| `RENOX_REALTIME_BACKPRESSURE` | both | 1.5.0: `op_realtime_send` to a connection whose outbound queue is full (thrown; the connection is closed); the fan-out closes a slow consumer (close 1008, section 18) | `RealtimeBackpressureError` | close 1008; never an HTTP response | `ok` (the connection record) |
| `RENOX_FORBIDDEN` | both | 1.5.0: `op_authz_*` through `ctx.authz.require` and `op_realtime_subscribe` (thrown); the route `guard` and the tool check before any handler (response, sections 17 and 19) | `ForbiddenError` | 403 `RENOX_FORBIDDEN`, **also when uncaught** (an uncaught `ForbiddenError` is not `RENOX_INTERNAL`, section 17) | `forbidden` |
| `RENOX_DEADLINE` | both | deadline (section 10) | `DeadlineError` | 504 `RENOX_DEADLINE` | `timeout` |
| `RENOX_CPU_LIMIT` | response | CPU watchdog | — | 503 `RENOX_CPU_LIMIT` | `cpu_limit` |
| `RENOX_OOM` | response | heap limit | — | 503 `RENOX_OOM` | `oom` |
| `RENOX_BUSY` | response | cell concurrency semaphore | — | 503 `RENOX_BUSY` + `Retry-After` | `busy` |
| `RENOX_INTERNAL` | response | dispatch wrapper: handler threw, returned a non-`Response`, or eager module evaluation failed | — | 500 `RENOX_INTERNAL` | `error` |
| `RENOX_MODULE_EVAL` | response | 1.4.0: a lazy route module threw at its first evaluation, or lacks the route's export (section 11, steps 4–5) | — | 500 `RENOX_MODULE_EVAL`, that route only | `error` |
| `RENOX_BODY_TOO_LARGE` | response | gateway body limit (section 6) | — | 413 `RENOX_BODY_TOO_LARGE` | no record (`meter.md` section 1) |
| `RENOX_CSRF` | response | cell, before a page action runs (section 14) | — | 403 `RENOX_CSRF` | no record: no tenant code runs, as for 404 and 405 (`meter.md` section 1) |
| `RENOX_RENDER_LIMIT` | response | cell renderer (section 14, "Rendering") | — | 500 `RENOX_RENDER_LIMIT` | `render_limit` |
| `RENOX_TOOL_INPUT` | response | 1.5.0: `/mcp` `tools/call` arguments fail the tool's declared input schema (section 19) | — | 400 `RENOX_TOOL_INPUT` as a JSON-RPC error | no record: `run` did not start |
| `RENOX_TOOL_SCOPE` | response | 1.5.0: the agent token's scopes do not cover the tool (section 19) | — | 403 `RENOX_TOOL_SCOPE` as a JSON-RPC error | no record |
| `RENOX_TOOL_CONFIRM` | response | 1.5.0: a `confirm: true` tool called with a missing, expired, or mismatched confirmation token (section 19) | — | 409 `RENOX_TOOL_CONFIRM` as a JSON-RPC error | no record |

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

- **Invocation** (Rust → bootstrap): `route` (the pattern), `phase` (`"load"` or `"action"`), `action` (the name, or `null` for `load`), `fragment` (name or `null`), `params`, and `session` (`{ id }`). From 1.3.0, optionally `module`: the installed module whose page it is (absent for the app's pages), so the bootstrap builds that module's `ctx` (section 15.1). From 1.5.0, optionally `principal` (`ops.schema.json` `$defs/principal`, or `null`; absent = `null`): the principal of section 17, already resolved and already past the page's `guard`; the bootstrap exposes it as `ctx.principal`.
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

- `setLocale(locale: string, dir?: "ltr" | "rtl")` on `LoaderContext` and `ActionContext` sets them for the current page invocation. The last call wins. Anything outside the rules below throws a `RangeError` in the bootstrap (as in 1.3.0). `locale` is a BCP 47 tag of at most 64 characters (`ops.schema.json` `$defs/locale`):
  - **Language part (1.3.0):** `^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$`, for example `ar`, `ar-AE`, `en-GB`.
  - **Unicode extension (1.4.0):** optionally one `-u-` extension after it, with the keys `ca` (calendar) and `nu` (numbering system) only, in that order (canonical), each at most once. Any other key, a key without a value, or a value outside these lists is refused:
    - `ca`: `gregory`, `islamic`, `islamic-civil`, `islamic-tbla`, `islamic-umalqura`, `persian` (CLDR `common/bcp47/calendar.xml`);
    - `nu`: `latn`, `arab`, `arabext` (CLDR `common/bcp47/number.xml`).
    - Examples: `ar-AE-u-nu-arab`, `ar-u-ca-islamic-umalqura-nu-arab`, `en-u-nu-latn`.
  - **Direction:** without `dir`, the direction comes from the language subtag only: `rtl` for `ar`, `fa`, `he`, `ur`, `ps`, `sd`, `ug`, `yi`, `dv`, `ckb`, and `ltr` otherwise. The extension never changes it.
  - **What the renderer does with the extension (1.4.0):** the `number`, `money`, and `date` filters write digits of the `nu` system (`latn` when absent), and `date` uses the `ca` calendar where the renderer supports it (`gregory` when absent or unsupported; the renderer documents which calendars it formats). `<html lang>` gets the full tag. Catalog lookup (`t`, `<r-t>`) ignores the extension: `ar-AE-u-nu-arab` reads the `ar-AE`, then `ar`, then `en` catalog.
- Defaults when nothing calls it: `en` and `ltr`. The `i18n` module (`manifest.md` section 8) does not set them behind the loader's back: its `detectLocale` service returns `{ locale, dir }`, and the loader passes them on. From 1.4.0 `locale` is the full tag, extension included (`ar-AE-u-nu-arab` when the app asks for Eastern Arabic digits), and `setLocale` passes it through unchanged.
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

## 17. Principal, `guard`, `authz`, `db.scoped()` (1.5.0)

The runtime side of `docs/11-authorization.md` (D15, D16): who the end user is, how a policy decision is asked for, and how owned rows are fenced. Policies are Cedar; the engine is `crates/renox-authz` (#276); the cell asks it (#279); the SDK types are in `ctx.d.ts` (#283). Two points `docs/11` and `docs/03` leave open are settled here: **the principal reaches Rust through the `auth` module's exported service `auth.principal`** ("Principal"), and **`realtime.authorize` is a Cedar policy, not a hook** (section 18).

### Principal

```ts
interface Principal {
  id: string;                                   // the auth module's user id, or the module name for a System principal
  kind: "user" | "system";
  roles: { role: string; scope_type: string; scope_id: string | null }[];   // from renox__role_assignments
  attrs: Record<string, JsonValue>;             // what auth.principal and its hook fillers added
}
```

- **Resolution.** The cell resolves the principal **once per request**, after the session cookie is verified (section 14, "Session") and before the route's `guard`, the loader, the action, the function handler, or the `open` of a realtime connection runs. It calls the `auth` module's exported service `auth.principal(sessionId)` (added by #291) through the broker, as a service call of the platform: `auth`'s own `ctx`, no current transaction, the request's deadline. The service answers a `Principal` or `null`, and runs the hook point `auth.principal` itself (`manifest.md` section 2, "the `auth.principal` hook"): each filler receives `{ principal }` and extends `attrs` (`2fa` sets `mfa_verified`, `org` sets `org`), and the extended principal is what the cell keeps. An app without `auth` installed, a request without a session, and an `auth` that answers `null` all give the **anonymous principal**: `ctx.principal` is `null`, and the Cedar principal is `Renox::Anonymous::"anonymous"` with no roles and no attributes.
- **Why a service, not the table.** The alternative, the cell reading `auth__sessions` and `auth__users` itself, is rejected: module tables are private to their module (D12, `manifest.md` MF4), the schema of `auth` would become a platform contract, and every other identity source (UAE PASS, passkeys, agent tokens) would need a second path. A service keeps one path, under `auth`'s authorizer.
- **Cache.** The result is cached per cell by session id for **60 s** *proposed* (Open 12), and dropped before the TTL on: a durable delivery of the platform event `authz.roles_changed` ("Role assignments", below), and of the `auth` events `auth.login` and `auth.logout` (the cell subscribes to its own outbox for these three names). A role change is therefore visible within one outbox round trip, and a logout at once. The cache holds the extended principal; fillers are not re-run on a hit.
- **In the ops.** The principal crosses into the bootstrap with the dispatch (section 11, step 6; `pageInvocation.principal`, section 14; the realtime, tool and job envelopes of sections 18–20) and is `ctx.principal` in every module's `ctx` of that request, frozen. `op_authz_*` never takes it as an argument: Rust uses the request's own principal, so tenant code cannot evaluate a policy as someone else. Event handlers and jobs run with a **System principal**: `{ id: "<module>", kind: "system", roles: [], attrs: {} }`, Cedar `Renox::System::"<module>"` (`docs/11`, "never as a superuser"); `app` for the app's own jobs.

### Cedar entities and the merged schema

| Cedar | Built from |
| --- | --- |
| `Renox::User::"<id>"` | A `user` principal. Attributes: `attrs`, converted JSON → Cedar (string, boolean, integer → `Long`, array → `Set`, object → record; floats and `null` are dropped). Parents: `Renox::Role::"<role>"` for every role assignment **in effect** |
| `Renox::Anonymous::"anonymous"`, `Renox::System::"<module>"` | The anonymous and system principals, no attributes, no parents |
| `Renox::Role::"<role>"` | A role name from `[authz.default_roles]` of a module or `renox.toml [authz]` of the app, or any role a role assignment names |
| `Renox::Action::"<action>"` | Every action of the merged action set: `[authz] actions` of the app and of each installed module (`<resource>.<verb>`). `Renox::Action::"sensitive"` is the action group of every `[authz] sensitive` action |
| `<Module>::<Type>::"<id>"` | A resource: `<Module>` is the owning module's name with its first letter upper-cased (`billing` → `Billing`, the app → `App`), `<Type>` a key of its `[authz.entities]`; attributes are exactly that entry's `attrs` |
| `Renox::Topic::"<name>"` | A realtime topic (section 18) |

A role assignment with the type `global` is in effect for every request of the tenant.
Any other assignment is in effect only while the principal's attribute named by its `scope_type` equals its `scope_id` (so a `finance` role on `org` `o_1` applies while `org` reports `attrs.org == "o_1"`). The Cedar `context` of every evaluation is the caller's `context` argument with the platform keys written over it: `mfa_verified` (from `attrs.mfa_verified`, `false` when absent), `now` (Unix time in milliseconds), and `request` (`{ method, path }`, absent outside a request); tenant code cannot spoof them.

The **merged schema** is the app's `policies/schema.cedarschema` plus a schema generated from each module's `[authz]` (`artifact.md` 1.3: entities, actions, the `sensitive` group), merged at `renox check` and at load; the app's and the modules' policy sets (`policies/app/*.cedar`, `policies/<module>/*.cedar`) are validated against it (V24; a policy that does not parse or validate is refused at check and deploy with the "Deploy" code of `errors.md` 0.4, never loaded). `docs/11` writes `Role::"finance"` and `Action::"invoice.read"` for short; the schema qualifies them as `Renox::Role` and `Renox::Action`.

### `authz` ops

| Op | Arguments | Result |
| --- | --- | --- |
| `op_authz_check` | `action: string, resource: ResourceRef \| null, context: Record<string, JsonValue> \| null, module: string \| null` | `Decision`: `{ allow: boolean, policy: string \| null }` (`policy` only in dev mode, else `null`) |
| `op_authz_check_batch` | `action: string, resources: ResourceRef[], context, module` | `boolean[]`, one per resource, in order |
| `op_authz_explain` | `action, resource, context, module` | `Explanation`: `{ decision: "allow" \| "deny", reasons: string[], errors: string[] }` (the permitting or forbidding policy ids; evaluation errors). **Dev mode only**: in production it rejects with `RENOX_FORBIDDEN`, `details.reason: "dev_only"` |
| `op_authz_roles_assign` | `user_id: string, role: string, scope_type: string, scope_id: string \| null, module, tx: number \| null` | `void` |
| `op_authz_roles_revoke` | `user_id, role, scope_type, scope_id, module, tx` | `boolean` (a row was removed) |
| `op_authz_roles_list` | `user_id: string, module` | `RoleAssignment[]` |

```ts
type ResourceRef = { type: string; id: string; [attr: string]: JsonValue };   // type: a key of [authz.entities]; the rest: its attrs
type RoleAssignment = { user_id: string; role: string; scope_type: string; scope_id: string | null; granted_by: string; at: number };
```

- **`ctx.authz`** (`ctx.d.ts`: `Authz`): `require(action, resource?, context?)` resolves when allowed and rejects with `ForbiddenError` (`RENOX_FORBIDDEN`) otherwise; `can(action, resource?, context?)` resolves the boolean; `canBatch(action, resources, context?)` resolves `boolean[]` (`docs/11`, "In templates": compute once in the loader, then `r-if`); `explain(action, resource?, context?)` resolves the `Explanation`; `roles.assign(userId, role, scope?)`, `roles.revoke(userId, role, scope?)`, `roles.list(userId)` with `scope = { type, id }` (`RoleScope`).
  Without the third argument an assignment is tenant-wide: `{ type: "global", id: null }`. Each call is one op; the bootstrap serialises `resource` and `context` as JSON (rules of section 14, "Page dispatch") and passes the module of the `ctx` the call came through.
- **Resources.** A `ResourceRef` becomes the entity `<Module>::<Type>::"<id>"` whose attributes are **only** the `attrs` declared for `type` in `[authz.entities]` (`manifest.md` 1.1): keys the caller adds are dropped, so a row loaded with `select *` can be passed as it is (`docs/11`: "the resource loaded from the database, not from the client"). The owning module of `type` is the `ctx`'s module; the app may name a module's type as `<module>:<Type>` (`"billing:Invoice"`). An unknown type, or a declared attribute that is missing from the object, is a **deny** (`reason: "missing_attribute"`) and, in dev mode, a warning in the overlay. Without a resource the request is evaluated against the resource `Renox::Action::"<action>"` itself (RBAC checks that need no resource).
- **Decision.** `forbid` wins over `permit`; no permitting policy, an action outside the merged action set (`reason: "unknown_action"`), a missing attribute, or an evaluation error (`reason: "evaluation_error"`, logged) is a deny (`docs/24-threat-model.md` rule 3, fail closed). `RENOX_FORBIDDEN` carries `details: { action, resource: { type, id } | null, reason, policy }` with `reason` ∈ `deny`, `unknown_action`, `missing_attribute`, `evaluation_error`, `eval_limit`, `dev_only` and `policy` the deciding policy id in dev mode, `null` otherwise. The error message never names a policy outside dev mode. **An uncaught `ForbiddenError` ends the request with 403 `RENOX_FORBIDDEN`** (the error page of `errors.md` for a page route, the JSON body for a function route), not with 500: the action of `docs/11` ("the user still sends `POST ?/refund` with curl") needs no `try`.
- **Audit.** A decision on a `sensitive` action (`[authz] sensitive` of the owning module or the app), allowed or denied, writes one row of the platform table `renox__authz_audit` (`id`, `principal` (the principal id, or `anonymous`), `action`, `resource_type`, `resource_id`, `result` (`allow` / `deny`), `policy`, `at`) **in the request's current transaction** (autocommit when none is open), so a denied refund and its audit row commit or roll back together with the action. The table is append-only: the authorizer refuses `UPDATE`, `DELETE`, `DROP`, and `ALTER` for everyone, `INSERT` for everyone but the platform, and `SELECT` through the view `renox__authz_audit_v1` for modules that depend on `audit` (#277, #288). A `guard` decision and the subscribe check of section 18 write the row too; a `can` or `canBatch` decision does not (it is a question, not an enforcement point), and neither does `explain`.
- **Role assignments.** The platform table `renox__role_assignments` (`user_id`, `role`, `scope_type`, `scope_id`, `granted_by`, `at`; unique on the first four) is written only through `op_authz_roles_assign` / `_revoke`, in the current transaction (`tx`). App code may assign any role; a **module may assign only the roles its `[authz.default_roles]` names** (a module's approved `roles`, `manifest.md` 1.1), any other role rejects with `RENOX_MODULE_UNDECLARED` (`details.target: "role:<name>"`) before anything is written. `granted_by` is the request's principal id (`system:<module>` for a job or event handler). Every assign and revoke emits the durable platform event `authz.roles_changed` with `{ user_id, role, scope_type, scope_id, op: "assign" | "revoke" }` in the same transaction (section 15.4; the name is the platform's, so no module may be named `authz`, `manifest.md` MF1), which invalidates the principal cache above and lets `audit` record it.
- **Metering and limits.** Every evaluation adds one to the invocation's `authz_evals` (section 7): a `guard`, each resource of a batch, each `r-can` with a resource (cached per `(action, resource.id)` within the request, so a cache hit does not count), a subscribe check, a tool check. A request may make at most **10,000** evaluations *proposed* (Open 13); the next evaluation is a deny with `reason: "eval_limit"` (fail closed, never an allow). `op_authz_check_batch` takes at most 1,000 resources (a `RangeError` in the bootstrap otherwise, like `setLocale`). Evaluation runs on the cell's thread, outside the tenant's CPU limit, like rendering; `authz_evals` is what the quota counts (`docs/11`, "Performance").

### `guard`

```ts
export const guard = { action: "invoice.read", resource: { type: "Invoice", id: ":id" } };
```

- A page module, a function module, and a `ws` or `sse` module may export `guard` (`ctx.d.ts`: `Guard`): `action` (a string of the merged action set) and an optional `resource` (`{ type, id }` with `id` a literal or `":<param>"`, a route parameter). `renox build` records it on the route entry (`artifact.md` 1.3, `guard`), so the cell reads it from the manifest, never from the module: a guard is evaluated **before** the module is evaluated and before any handler runs, for every method of the route, and on **every fragment request** of a page (`docs/11`, "Enforcement points").
- With a `resource`, the cell loads the entity through the type's `[authz.entities]` declaration (`table`, `id` column, `attrs`), under the owning module's authorizer, outside any tenant transaction; a row that does not exist is a deny (`reason: "missing_attribute"`), not a 404, so an id cannot be probed through the guard.
- A deny answers 403 `RENOX_FORBIDDEN` (page: the error page; function: the JSON body; realtime: no upgrade) with no tenant code run for the route, and a meter record with `status: forbidden` (the principal service did run). The decision is audited when the action is sensitive.
- The `renox check` rule that warns about a page without a guard whose policies name its action is #283's; it is not a load-time rule.

### `db.scoped()`

```toml
# module.toml (the module's tables) or renox.toml [authz] (the app's tables)
[authz.ownership]
"shop__orders"     = { owner = "user_id", org = "org_id" }
"shop__cart_items" = { owner = "session_id" }
```

- **Declaration.** `[authz.ownership]` maps an owned table (own prefix only, `manifest.md` MF14) to its `owner` column and, optionally, its `org` column. `ctx.db.scoped(scope)` with `Scope = { user_id?, org_id?, session_id? }` returns a `Db` whose statements carry the scope (section 1, "Scoped statements"). The owner predicate for a table is `<owner> = <scope.user_id>` when `owner` is a user column, `<owner> = <scope.session_id>` when the column is `session_id`, and additionally `<org> = <scope.org_id>` when the table declares `org` and the scope has `org_id`; a scope that lacks the value an owned table needs refuses the statement (`RENOX_DB_SCOPE`, `reason: "scope_missing"`).
- **Rewrite** (`crates/renox-data`, #277): for `SELECT`, `UPDATE`, and `DELETE`, every reference of an owned table (joins and aliases included) gets the predicate added to its `WHERE`; an `INSERT` into an owned table must set the owner column (and the org column) to the scope's value: a missing owner column is filled in, an explicit different value is refused (`reason: "owner_mismatch"`). A statement the rewriter cannot prove (an owned table inside a subquery or CTE it does not rewrite, `INSERT … SELECT` from an owned table, a trigger reaching an owned table) is refused whole with `RENOX_DB_SCOPE`, `reason: "unprovable"`; the rewriter test file of #277 lists the shapes it proves and refuses. Unowned tables are untouched; the module's authorizer still applies (section 1).
- **Unscoped access.** A statement from **module code** that touches an owned table without a scope rejects with `RENOX_DB_SCOPE` (`details: { table, module, reason: "unscoped" }`); the official modules use `scoped` for every user-owned table (`docs/11`). **App code** is only warned by `renox check` (D16: the app owns its data and may run reports across users); the runtime does not refuse it.
- `RENOX_DB_SCOPE` is thrown as `DbScopeError`, logged like `RENOX_DB_AUTH` (always: `table`, `module`, `reason`; never the SQL), and ends the request with 500 `RENOX_INTERNAL` when uncaught (section 13).

### Verification

- #276: `crates/renox-authz` evaluates the entities of this section; `forbid` wins; an unknown action, a missing attribute, and an evaluation error deny.
- #277: the rewriter shapes, `RENOX_DB_SCOPE` reasons, the two platform tables and their authorizer rules.
- #279: the principal from `auth.principal`, the cache and its three invalidations, `guard` before the loader and on fragments, `ctx.authz` and `ctx.db.scoped()`, the audit row in the request's transaction, `authz_evals`.
- #283: `ctx.d.ts` types in the SDK, `guard` in the route entry, the `renox check` warnings.

## 18. Realtime: `ws` and `sse` routes, `op_realtime_*` (1.5.0)

The runtime side of `docs/09-htmx-realtime.md`, "Realtime: SSE and WebSocket" (D9): connections are owned by Rust in the tenant's cell (`crates/renox-realtime`, #278; wired by #281; the gateway hands the connection over after a 101, #167); the isolate runs only `open`, `message`, and `close`. Fan-out never touches the isolate.

### Routes and handlers

| Kind | Files | Export | Handlers |
| --- | --- | --- | --- |
| `ws` | `functions/ws/**/*.ts` → `wss://<host>/ws/<path>` | `export const ws: WsModule` | `open(ctx)`, `message(ctx)`, `close(ctx)` |
| `sse` | `functions/sse/**/*.ts` → `https://<host>/sse/<path>` | `export const sse: SseModule` | `open(ctx)`, `close(ctx)` |

- The route entry is `artifact.md` 1.3 (`kind: "ws"` / `"sse"`, `path`, `module`, optional `guard`). A `ws` route answers a `GET` with `Upgrade: websocket`; an `sse` route answers a `GET` with `Accept: text/event-stream`; any other request to the path is 405 (`Allow: GET`). Patterns share the matcher of `artifact.md` section 3 with page and function routes (V8 applies).
- **Before the isolate.** The cell checks the `Origin` rule (below), verifies the session cookie, resolves the principal (section 17), evaluates the route's `guard` (403, no upgrade), checks the connection caps ("Limits"), and only then completes the handshake (101, or 200 `text/event-stream`) and runs `open`.
- **`RealtimeContext`** (`ctx.d.ts`) is `Ctx` (section 6: the upgrade request's `req`, `url`, `params`, `headers`, `principal`, `db`, …) plus `session` and `conn: Conn` (`{ id, transport }`); `message` gets `MessageContext`, which adds `data: string | Uint8Array` (text or binary frame). `close` gets `CloseContext` with `close: { code, reason }`. Each handler run is one request-scoped invocation for the ops (section 0): its own token, the tier's CPU and wall-clock limits per run (section 10), `db` the plain `Db`. The three runs share the connection's one meter record ("Metering").
- **Failures.** A throw in `open` closes the connection (WebSocket code 1011; SSE: the stream ends) and logs the redacted error; a throw in `message` is logged and the connection stays open (the message is dropped); a throw in `close` is logged. A `RENOX_FORBIDDEN` thrown in `open` (a denied `subscribe`) closes with 1008 instead. An uncaught `RENOX_REALTIME_LIMIT` or `RENOX_REALTIME_BACKPRESSURE` is a handler failure like any other.
- **Dispatch.** `ops.schema.json` `$defs/realtime_dispatch`: the cell calls the bootstrap with the **realtime envelope** `{ kind: "realtime", phase: "open" | "message" | "close", transport: "ws" | "sse", conn: "<id>", route, params, session, principal?, module?, data?, close? }` and gets `{ type: "ok" }` or `{ type: "failed", reason: "threw" | "no_handler" }` back (`no_handler`: the module has no `message` or `close`; the cell then skips the phase).

### Ops

| Op | Arguments | Result |
| --- | --- | --- |
| `op_realtime_subscribe` | `conn: string, topic: string, module: string \| null` | `void`; rejects with `RENOX_FORBIDDEN` when the policy denies ("Authorization") |
| `op_realtime_unsubscribe` | `conn: string, topic: string` | `void` |
| `op_realtime_publish` | `topic: string, payload: RealtimePayload, module: string \| null` | `number`: the connections the message was queued for |
| `op_realtime_send` | `conn: string, payload: RealtimePayload` | `void` |
| `op_realtime_close` | `conn: string, code: number, reason: string \| null` | `void` |

```ts
type Conn = { readonly id: string; readonly transport: "ws" | "sse" };
type RealtimePayload =
  | string                                                              // a text frame / an SSE data line
  | { text: string; event?: string }
  | { json: JsonValue; event?: string }                                 // sent as JSON text
  | { fragment: string; data: Record<string, unknown>; event?: string } // a partial rendered by the cell
```

- **`ctx.realtime`** (`ctx.d.ts`: `Realtime`) wraps them one to one. `publish` works from any handler of the tenant (a `ws` handler, an action, a service, an event handler, a job): all of a tenant's connections are on one node, so pub/sub is in-process (`docs/09`). `subscribe`, `unsubscribe`, `send`, and `close` take a `conn`; only `ws` and `sse` handlers hold one. A `conn` id names a connection of the same tenant; an id that is unknown, closed, or another tenant's is ignored (`subscribe` and `send` resolve, nothing happens): a connection may close at any moment, so this is not an error.
- **Topics** are strings of at most 256 characters, segments split on `:` (`room:42`, `user:u_1:inbox`); a segment is `[A-Za-z0-9_.-]+`. A topic outside that shape rejects with a `RangeError` in the bootstrap.
- **Payloads.** The bootstrap serialises the payload before the op (`ops.schema.json` `$defs/realtimePayload`): a string or `{ text }` crosses as text; `{ json }` as `JSON.stringify` text (rules of section 14); `{ fragment, data }` names a `partial` template of the caller's module (`modules/<name>/partials/…` for a module, `partials/…` for the app) and the cell renders it **off the isolate thread**, under the render limits of `docs/08-template-engine.md`, into the HTML that is sent; its fuel and CPU are the publishing invocation's `render_fuel` and `render_ms`. This is how `docs/09`'s `render("partials/chat-message.html", …)` reaches subscribers; `ctx.render` stays reserved (section 8). `event` names the SSE event (`event:` line, `sse-swap="order-updated"`); it is ignored on a WebSocket. A message over **64 KB** after rendering rejects with `RENOX_REALTIME_LIMIT` (`details.reason: "message_size"`) and is not sent.
- **On the wire.** WebSocket: text payloads as text frames; a `fragment` payload as a text frame holding the HTML (htmx `ws-connect` swaps it). SSE: `id: <n>` (the per-topic sequence, for replay), `event:` when set, `data:` lines, `retry: 1000` once at the start; a `: keep-alive` comment every 15 s.

### Authorization: topics as Cedar resources

Subscribing to a topic is the Cedar action **`Renox::Action::"realtime.subscribe"`** on the resource **`Renox::Topic::"<name>"`** with the attributes `name` (the topic string) and `segments` (the segments as a Cedar `Set`; the order is in `name`, test it with `like`: `resource.name like "room:*"`). The check runs on every `subscribe` with the connection's principal (resolved at connect, section 17) and is **fail-closed**: an app or module without a permitting policy for the action denies every subscribe (`docs/24-threat-model.md`, "Subscribing to another user's topic"). `realtime.authorize` of `docs/09` is therefore a policy, not a hook, and `realtime.subscribe` is a platform action every app may use in its policies without declaring it:

```cedar
permit (principal is Renox::User, action == Renox::Action::"realtime.subscribe", resource is Renox::Topic)
when { resource.name like "user:*:inbox" && resource.segments.contains(principal.id) };
```

A deny rejects `subscribe` with `RENOX_FORBIDDEN` (`details.resource: { type: "Topic", id: <name> }`), counts one `authz_evals`, and is audited when `realtime.subscribe` is listed as sensitive. Decisions are cached per connection and topic and dropped when the principal cache is invalidated (section 17). `publish` and `send` are not policy-checked: they run in server code that already decided; what a subscriber receives is what it was allowed to subscribe to.

### Change feed

```toml
[realtime.feeds]
"shop__orders" = "orders:{org_id}"
```

- `[realtime.feeds]` (`manifest.md` 1.1; the app's in `renox.toml [realtime]`) maps a table of the declarer's own prefix (MF14) to a topic pattern whose `{column}` placeholders name columns of that table (V26: the table exists in the migrations). After a transaction **commits**, the cell publishes, for each changed row of a fed table, the JSON message `{ "table", "rowid", "op": "insert" | "update" | "delete" }` to the topic with the placeholders filled from the row (for a `delete`, from the row as it was before the statement, captured by the pre-update hook; `docs/09`, "Realtime from data changes uses SQLite's `update_hook`"). A rolled-back transaction publishes nothing. Delivery goes only to connections that passed the subscribe check for that topic, so the policy above is the whole filter. Feed messages count as `realtime_messages` of the receiving connections and cost the publishing invocation nothing beyond the hook.
- A row whose placeholder column is `NULL` is not published. At most 1,000 feed messages per transaction *proposed* (Open 14); beyond that the transaction's feed is dropped and one log line says so.

### `Origin` and authentication at connect

- A browser upgrade (a request with a session cookie, or with a `Sec-WebSocket-Key` / `Sec-Fetch-Mode` header) must carry an `Origin` equal to one of the app's origins: its served hostnames (`deploy-api.md` section 3) and `security.cors.origins` (`artifact.md` section 3). A mismatch or a missing `Origin` on such a request is **403 before the isolate is touched** (`docs/24-threat-model.md`, "Cross-site WebSocket hijacking"; #118 proves it). A request without a cookie that carries an agent token (`Authorization: Bearer`, section 19) may omit `Origin`: it is not a browser.
- The principal of the connection is resolved from the session cookie at connect (section 17) and kept on the connection; it is re-resolved on reconnect, never from a message.

### Limits

| Limit | Value | On the limit |
| --- | --- | --- |
| Connections per tenant | 100 free / 10,000 paid (`docs/04-isolation-security.md`) | The upgrade is refused: 503 `RENOX_REALTIME_LIMIT`, `Retry-After: 5`; meter `status: busy` |
| Connections per user (principal id; per client IP for anonymous) | 10 | Same |
| Topics per connection | 64 *proposed* (Open 15) | `subscribe` rejects with `RENOX_REALTIME_LIMIT` (`reason: "topics"`) |
| Message size, inbound | 64 KB (one frame, or one SSE request body) | Closed with 1009 (message too big); logged |
| Message size, outbound | 64 KB after rendering | `publish` / `send` reject with `RENOX_REALTIME_LIMIT` (`reason: "message_size"`) |
| Inbound messages per connection | 100 per second *proposed* (Open 15) | Closed with 1008; logged with `reason: "flood"` (`docs/23-failure-modes.md`, "WebSocket message flood") |
| Outbound queue per connection | 256 messages | A consumer that falls behind is closed with 1008 `RENOX_REALTIME_BACKPRESSURE`; `publish` never waits for a slow consumer |
| Heartbeat | ping every 30 s, pong within 10 s *proposed* (Open 15); SSE `: keep-alive` every 15 s | Closed with 1001 (going away) |
| Replay buffer per topic | the last 100 events or 60 s *proposed* (Open 15) | An SSE reconnect with `Last-Event-ID` inside the buffer gets the missed events; outside it, none, and the client re-reads its state |
| Handler runs | The tier's CPU and wall-clock limits per `open`, `message`, `close` run (section 10) | As section 10; a kill closes the connection with 1011 |

`RENOX_REALTIME_LIMIT` is thrown as `RealtimeLimitError` (`details: { reason }`, `reason` ∈ `tenant`, `user`, `topics`, `message_size`, `flood`), `RENOX_REALTIME_BACKPRESSURE` as `RealtimeBackpressureError` (`details: { conn }`). A connection closed by the platform is logged with `code`, `reason`, and `route`; the tenant's client script reports `realtime.closed` (`client-events.md`).

### Metering

One record per connection, written at the close (section 7): `route` `WS <pattern>` or `SSE <pattern>`, `http_status` 101 / 200, `wall_ms` the lifetime, `cpu_ms`, `db_*`, `fetch_*`, `render_*` summed over the handler runs and the fragment renders they published, `realtime_conn_seconds` (the lifetime in seconds, 3 decimals), `realtime_messages` (frames received plus messages delivered to the connection: `send`, `publish`, feeds, replay), `status` `ok` (closed by either side, including the platform's limit closes), `error` (`open` threw), or the kill statuses of section 10. A refused upgrade (caps) writes a record with `status: busy`, like `RENOX_BUSY`. A denied guard writes `status: forbidden`. Messages a publisher sends are not counted on the publisher's record: `realtime_messages` is per receiving connection, so the fan-out of one `publish` to 1,000 connections is 1,000 messages across 1,000 records (`docs/24-threat-model.md`, "Realtime fan-out amplification": B14 measures it).

### Verification

- #278: every row of the limits table on the crate (caps, oversized frame, flood, backpressure close, replay, heartbeat), the 10,000 idle connections of B14 on the crate.
- #281: the handlers end to end, the feed after commit and nothing after rollback, the `fragment` payload rendered off the isolate, the connection record.
- #118: `Origin` 403 before the isolate, same-origin 101, a subscribe to another user's topic denied, no policy → denied, the connection's principal from the cookie at connect.
- #167: the gateway hands the connection to the cell after a 101.

## 19. App MCP: tool routes and `/mcp` (1.5.0)

The runtime side of `docs/20-ai-agents-mcp.md` section 2 (every row of its table) and section 5. Tenants declare tools; the cell serves `/mcp` for every app with authentication, authorization, limits, and metering applied (#285). The authorization server is the `auth` module (#286); the SDK's `tool()` and the route entry are #284.

### Tool routes

```ts
// functions/tools/create-invoice.ts
import { tool } from "renox";
export default tool({
  name: "create_invoice",
  description: "Create a draft invoice for a customer",
  input: z.object({ customerId: z.string(), items: z.array(z.object({ sku: z.string(), qty: z.number().int().positive() })) }),
  action: "invoice.create",          // the Cedar action, as for the UI button
  confirm: false,
  async run({ input, services }) { return services.billing.createInvoice(input.customerId, input.items); },
});
```

- Route kind `tool` (`artifact.md` 1.3): `functions/tools/*.ts` of the app and `tools/*.ts` of a module declared in its `[[tools]]` (`manifest.md`, carried from 1.1), one entry per tool with `name` (`^[a-z][a-z0-9_]{0,63}$`, unique across the app and its modules, V25), `description`, `input` (the JSON Schema `renox build` derives from the `input` schema through the Standard Schema adapter of `sdk/src/validate.ts`, restricted to the keyword subset of `validate.ts`), `action` (in the merged action set, V25), `confirm` (default `false`), and `module` (the code entry). The module default-exports the `tool(...)` value (`ctx.d.ts`: `Tool`, `ToolDefinition`); `entries` records `default`.
- **`run(ctx)`** gets `ToolContext`: the owning module's `ctx` without a request (`req`, `url`, `params`, `headers`, `form` absent, like an event handler's), `principal` the token's user, `db` the plain `Db`, and `tool: { name, input, client: { name, model? }, preview: boolean }`. It returns a JSON-serialisable value (rules of section 14, "Page dispatch"), the tool's output.

### `/mcp`

- **Reserved paths.** `/mcp` and `/.well-known/oauth-protected-resource/mcp` are served by the cell on every app, like `/__renox/*`; a route on them is refused by `renox check` and V21. Without the `auth` module installed, both answer 404 (there is no authorization server).
- **Transport.** Streamable HTTP, JSON-RPC 2.0: `POST /mcp` with one request (batches are refused with -32600) and `Accept: application/json, text/event-stream`; the answer is `application/json`. `GET /mcp` is 405: there is no server-initiated stream in 1.5.0 (Open 17). Methods: `initialize` (answers `protocolVersion: "2025-06-18"`, `capabilities: { tools: {} }`, `serverInfo: { name: <app name>, version: <first 12 hex of the deployment hash> }`), `notifications/initialized` (202, no body), `tools/list`, `tools/call`; any other method is -32601. The session is stateless: no `Mcp-Session-Id`.
- **Authentication.** `Authorization: Bearer <agent token>`, a token the `auth` module's OAuth 2.1 server issued to an end user's agent (#286). The cell verifies it through the exported service **`auth.verifyAgentToken(token)`** → `{ principal, scopes, client: { name, model? } }` or `null`, cached per token hash for 60 s and dropped on the `auth.agent_token_revoked` event. No token, or `null`, is 401 with `WWW-Authenticate: Bearer resource_metadata="https://<host>/.well-known/oauth-protected-resource/mcp"`. The principal of every call is the token's user (section 17): "Alice's agent can only do what Alice can".
- **Scopes.** A token's `scopes` are tool names, `tools:*`, or `tools:<name>`; `tools/list` returns only the tools the scopes cover (`name`, `description`, `inputSchema`, `annotations: { readOnlyHint: !confirm, destructiveHint: confirm }`); `tools/call` of a tool outside the scopes is 403 `RENOX_TOOL_SCOPE`.
- **One call**, in order: the token (401), the scope (403 `RENOX_TOOL_SCOPE`), the per-token rate limit (below), the input against the declared schema (400 `RENOX_TOOL_INPUT`, `details: [{ field, reason }]`), the Cedar check `op_authz_check(action)` with the token's user as principal and no resource (403 `RENOX_FORBIDDEN`; audited when the action is sensitive; a tool that acts on one resource calls `ctx.authz.require(action, resource)` inside `run`, like an action), then `run` in the isolate with the tool's module `ctx` under the tier's request limits (section 10), then the output. Errors before `run` are **JSON-RPC errors**: HTTP status and body code of `errors.md`, as `{ "jsonrpc": "2.0", "id", "error": { "code": -32000, "message", "data": { "code": "RENOX_…", "request_id" } } }`. Errors inside `run` (a throw, a limit) are **results** with `isError: true` and the fixed message of the code; never the throw's text.
- **Confirmation.** A tool with `confirm: true` runs twice. The first call runs `run` with `ctx.tool.preview = true` **inside a transaction the cell always rolls back** (so a preview cannot change state) and answers `structuredContent: { preview: <output>, confirmation: { token, expires_at } }` with `isError: false`; the confirmation token (opaque, 10 minutes) binds the tool name, the SHA-256 of the arguments, and the agent token. The second call repeats the arguments with `params._meta["renox/confirmation"] = <token>` and runs for real. A missing, expired, replayed, or mismatched token is 409 `RENOX_TOOL_CONFIRM`.
- **Output.** `run`'s value is serialised in the bootstrap; over **256 KB** of JSON the result is `isError: true` with the fixed text "The tool output is too large." (no code: the tool ran, and the record says `error`). Every result carries `_meta: { untrusted: true }` and its `content` is `[{ type: "text", text: <JSON> }]` plus `structuredContent` (`docs/20` section 5: tool results are data, never instructions). Secrets are redacted as in section 3 before the result leaves the cell.
- **Rate limit.** 60 calls per minute per token *proposed* (Open 16), 429 with `Retry-After` and no body code, like the gateway's rate limit (`errors.md` Open 2); not metered.
- **Metering and audit.** One meter record per `tools/call` that reached `run`: `kind: "tool"`, `route` `TOOL <name>`, `status` as for a request (`ok`, `error` for a throw, the kill statuses), `http_status` 200 (`meter.md` 0.3). A preview run is a record too. The request's log lines carry `client.name` and `client.model` (`docs/20` section 5, attribution); the authz audit row of a sensitive action carries the user id.
- **Discovery.** `GET /.well-known/oauth-protected-resource/mcp` answers RFC 9728 metadata: `{ "resource": "https://<host>/mcp", "authorization_servers": ["https://<host><auth mount>/oauth"], "scopes_supported": ["tools:*", …], "bearer_methods_supported": ["header"] }`; the issuer's own metadata (RFC 8414) is the `auth` module's route `<mount>/oauth/.well-known/oauth-authorization-server` (#286), and the cell serves `/.well-known/oauth-authorization-server<mount>/oauth` by invoking it, so a general-purpose agent finds both from the app's host.
- **Dispatch.** `ops.schema.json` `$defs/tool_dispatch`: the cell calls the bootstrap with the **tool envelope** `{ kind: "tool", name, module?, input, principal, client, preview, request_id }` and gets `{ type: "ok", output_json }` or `{ type: "failed", reason: "threw" | "output_too_large" }` back.

### Verification

- #285: list filtered by scope; allowed and denied calls; `RENOX_TOOL_INPUT`; the confirm flow (preview rolled back, expired and replayed tokens); the output cap; the rate limit; a revoked token refused after the event; no secret value in any output or log line; the meter record.
- #286: `auth.verifyAgentToken`, the OAuth 2.1 server and its metadata route.
- #284: `tool()` and the route entry; `renox check` on the reserved paths and V25.

## 20. Jobs: `schedule` and `op_jobs_enqueue` (1.5.0, implemented in F6)

The contract of the F6 `jobs` task (#297; `docs/07-app-model.md`, "Scheduled jobs"; `docs/18-build-plan.md` M10), written here so `ops.md` is edited once for the `schedule` export.

```ts
// jobs/nightly-report.ts (the app) or modules/<name>/jobs/<name>.ts (a module)
export const schedule = "0 3 * * *";          // minute hour day-of-month month day-of-week
export const tz = "Asia/Dubai";                // optional IANA zone; UTC when absent
export async function run(ctx: JobContext) { /* … */ }
```

- **Route kind `job`** (`artifact.md` 1.3): `{ kind: "job", name, module, schedule, tz? }` with `name` the file stem (`^[a-z][a-z0-9_-]{0,63}$`), `schedule` a five-field cron expression (`*`, lists `1,15`, ranges `1-5`, steps `*/10`; numeric fields only, V27), `tz` an IANA zone (V4's rule). The module exports `schedule`, optionally `tz`, and **`run`** (a named export, so `entries` and `renox check` can name it; `docs/07`'s default-export example reads as this).
- **Scheduler.** The cell computes each job's next tick in its zone. At the tick it writes **one durable outbox row** for `(job, tick)`, idempotently (unique on the pair), and the outbox worker runs it like an event delivery (section 15.4): its own `IMMEDIATE` transaction, committed with the acknowledgement, the tier's CPU and wall-clock limits per attempt, the retry schedule and dead-letter of section 15.4 (the `jobs` module shows dead letters). **At-least-once**, and **one at a time per job**: a running job holds a lease, so a second tick of the same job waits until the run ends. **Missed ticks coalesce**: after an eviction, a restart, or downtime, every missed tick of a job becomes one run whose `tick` is the latest missed one. A job runs on the deployment that is active when it runs.
- **Queued jobs.** `ctx.jobs.enqueue(name, payload, { runAt? })` → `op_jobs_enqueue(name: string, payload_json: string, run_at: number | null, module: string | null, tx: number | null)` → the row id (a ULID). It writes a row for `name`, a job of the caller's module (any other name rejects with `RENOX_MODULE_UNDECLARED`, `details.target: "job:<name>"`), **in the current transaction**, to run at `runAt` (Unix ms; `null` or absent = as soon as possible; at most 30 days ahead *proposed*, Open 18); a queued run is a `run` call with `ctx.job.payload` set. The payload is JSON of at most 64 KiB; the bootstrap throws a `RangeError` for anything else, as for `setLocale`.
- **`JobContext`** (`ctx.d.ts`): the module's `ctx` without the request (as `EventContext`): `db` is the attempt's transaction (`DbStatements`), `principal` the System principal `Renox::System::"<module>"` (`app` for the app's jobs; section 17; `docs/11`: "jobs run as `System::"<module>"` with explicit permissions, never as a superuser"), `job: { id, name, tick, attempt, payload }` (`payload` `null` for a scheduled run).
- **Dispatch.** `ops.schema.json` `$defs/job_dispatch`: the **job envelope** `{ kind: "job", id, name, module, tick, attempt, payload }` and the result `{ type: "ok" }` or `{ type: "failed", reason: "threw" | "no_handler" }` (`no_handler`: the active deployment has no such job any more; the row is dropped and logged).
- **Metering.** One record per attempt: `kind: "job"`, `route` `JOB <module> <name>` (`JOB app nightly-report`), `request_id` `<row id>_<attempt>`, `status` as for an event record (`meter.md` 0.3). Charged to the tenant's quota (`docs/07`).

- **The `jobs` module's read and write path (1.6.0).** The authorizer refuses every `renox__*` table to module code (section 1), so the `jobs` module (the dashboard's and CLI's view of dead letters) reads and changes job rows through three ops. All three take the caller's module as in section 0 and are **callable only by module `jobs`**: any other caller, the app included, rejects with `RENOX_FORBIDDEN` (`details: { action: "jobs.list" | "jobs.retry" | "jobs.cancel", resource: null, reason: "deny", policy: null }`) before any row is read, the way `op_authz_roles_*` are limited to their module. The module evaluates its Cedar action `jobs.manage` (retry and cancel) or `jobs.read` (list) with `ctx.authz.require` before calling the op; the op checks only the caller module, so the permission stays the app's policy.
  - `op_jobs_list(state, limit, cursor, module)` → `JobPage` `{ items: JobRow[], next_cursor }`. `state` is `scheduled` (one entry per `job` route with its next tick, computed, no row), `queued` (rows waiting for `run_at` or a retry), `running` (rows holding the lease) or `dead` (dead letters, section 15.4). `limit` is 1 to 100; `cursor` is opaque, `null` for the first page; order is `next_at`/`run_at` ascending, dead letters newest first. `JobRow` is `{ id, name, module, tick, next_at, run_at, attempts, started_at, finished_at, last_error }` (`ops.schema.json` `$defs/jobRow`): jobs of the app and of every module, **never the payload**, `last_error` the redacted message of the last failed attempt (at most 512 characters, no secret, no path, `docs/23-failure-modes.md` rule 2).
  - `op_jobs_retry(id, module, tx)` → `void`: a dead row goes back to `renox__outbox` as queued with `attempts` reset to 0 and `run_at` now, in the current transaction (`tx`), and writes one row of `renox__authz_audit` (section 17) with action `jobs.retry` with the id, job, and caller principal. A row that is not dead rejects with `RENOX_JOB_STATE` (`details: { id, state, op: "retry" }`); an unknown id with `RENOX_JOB_NOT_FOUND` (`details: { id }`).
  - `op_jobs_cancel(id, module, tx)` → `void`: a queued or dead row is deleted in the current transaction, with one `renox__authz_audit` row, action `jobs.cancel`. A running row rejects with `RENOX_JOB_STATE` (`state: "running"`, `op: "cancel"`: the run ends first); an unknown id with `RENOX_JOB_NOT_FOUND`. A scheduled job is not cancelled by this op: it follows the deployed `schedule`.
  - `ctx.jobs` gains `list`, `retry`, `cancel` (`ctx.d.ts`: `Jobs`, `JobRow`, `JobPage`, `JobState`) with these arguments; on any other module's `ctx` they exist and reject as above.
- **Coalescing key.** The scheduler's idempotent write (above) is keyed `job_tick:<module>:<name>` in `renox__outbox_meta`, with the latest unprocessed tick as value: a tick that finds the key already queued overwrites the value instead of adding a row, which is how missed ticks coalesce into one run. The key of a queued run (`enqueue`) is its row id.
- **Lease.** The per-job lease is in memory, held by the one node that owns the tenant (a tenant has one owning node, `deploy-api.md` section 8). It is not persisted: after a restart or a move the new owner starts with no lease, and a row left `running` by a dead process is returned to `queued` with `attempts` unchanged when the cell starts.
- **Delivery path.** A `job` entry reaches the bootstrap's `deliver` through `build_event_args` like an event (section 15.4) with `kind: "job"`: the bootstrap dispatches on `kind` and calls the module's exported `run` (the `JobEnvelope` above); a cell that routes a job entry as an event is a bug the verification below tests.

Verification: #297 (one row per tick, no overlap, coalescing after a simulated downtime, the System principal, the meter record, `enqueue` in a rolled-back transaction enqueues nothing; 1.6.0: `op_jobs_list` per state without the payload, `retry` of a dead row and its audit row, `retry` of a queued row is `RENOX_JOB_STATE`, `cancel` of a running row is `RENOX_JOB_STATE`, every other module and the app get `RENOX_FORBIDDEN`, the coalescing key keeps one row after three missed ticks, a row left running is requeued at start); #284 (the route entry, V27); #307 (the Logs follower job uses `op_jobs_list` only through the `jobs` module).

Types for sections 17–20 in `ctx.d.ts`: `Principal`, `RoleAssignment`, `Scope`, `ResourceRef`, `Decision`, `Explanation`, `Authz`, `AuthzRoles`, `Guard`, `ForbiddenReason`, `DbScopeReason`; `Conn`, `RealtimePayload`, `Realtime`, `RealtimeContext`, `MessageContext`, `CloseContext`, `WsModule`, `SseModule`; `ToolDefinition`, `Tool`, `ToolContext`, `tool()`; `JobContext`, `JobInfo`, `JobModule`, `Jobs`, `EnqueueOptions`, and from 1.6.0 `JobRow`, `JobPage`, `JobState`; the dispatch types `RealtimeEnvelope`, `RealtimeResult`, `ToolEnvelope`, `ToolResult`, `JobEnvelope`, `JobResult`; the errors `ForbiddenError`, `DbScopeError`, `RealtimeLimitError`, `RealtimeBackpressureError`, and from 1.6.0 `JobNotFoundError`, `JobStateError`.

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
9. **Lazy route modules and locale extensions** (sections 7, 11, 13, 14; 1.4.0):
   - #265 tests that a route module is not evaluated before its first request, that a throwing lazy module answers 500 `RENOX_MODULE_EVAL` for its route only while another route answers 200, that the worker refuses at prepare an artifact whose recorded exports differ from the module's, and that `renox check` names the file and export of a missing or non-function export. It re-runs B1.
   - #266 tests `setLocale` with `ar-AE-u-nu-arab` and the `number`, `money`, and `date` filters in both digit sets, and that an unknown key or value is refused.
10. **Authorization, realtime, App MCP, jobs** (sections 17–20; 1.5.0, jobs ops 1.6.0): the "Verification" list at the end of each section names the task per rule (#276–#281, #283–#286, #291, #118, #167 for F5; #297 for jobs). The numbers marked *proposed* are Open 12–18.

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
9. **Locale error type (1.4.0)**: #263 asked for the control plane's validation code on an unknown extension key or value. `setLocale` keeps the `RangeError` of 1.3.0 instead: it is a programming error in the loader, like an invalid `dir`, and adding a thrown `RenoxErrorCode` for it would be a second error type for the same call. Revisit if a tenant needs to tell the two apart.
10. **Extension values (1.4.0)**: the `ca` and `nu` lists are the values a GCC app needs. Adding a value from the CLDR lists is a minor version; a key other than `ca` and `nu` (`hc`, `fw`, `cu`) needs a renderer that uses it first.
11. **Which entries are eager (1.4.0)**: `renox build` keeps `pages/_error` eager and makes every other route module lazy. Layouts are templates, not code, so nothing about them is evaluated. Whether the app gets a way to list more eager entries (a `[build] eager = [...]` key in `renox.toml`) is left to #265. Until then the CLI marks only `pages/_error`, `services` and `hooks` eager.
12. **Principal cache TTL (1.5.0, section 17)**: 60 s *proposed*. #279 measures the hit rate and the invalidation latency (a role change visible within one outbox round trip) on `node-small` and may change it; the three invalidations stay whatever the TTL.
13. **Evaluation limit per request (1.5.0, section 17)**: 10,000 *proposed*, a deny past it. #280 measures `r-can` with a resource on a 1,000-row page (B-series of `docs/14-benchmarks.md`) and sets the number that keeps a page under its render budget.
14. **Feed messages per transaction (1.5.0, section 18)**: 1,000 *proposed*. #281 measures a bulk import against a fed table and may raise it or replace the drop with coalescing per topic.
15. **Realtime numbers (1.5.0, section 18)**: topics per connection 64, inbound 100 messages per second, heartbeat 30 s / 10 s, replay 100 events or 60 s are *proposed*; #278 measures them on the crate and #282 end to end with B14; the connection caps (100 / 10,000, 10 per user), the 64 KB message and the 256-message queue are `docs/04` values, not proposals.
16. **Tool rate limit (1.5.0, section 19)**: 60 calls per minute per token *proposed*; #285 sets it from the cost of a call on `node-small`.
17. **MCP resources, prompts, and notifications (section 19)**: 1.5.0 serves tools only, statelessly; `GET /mcp` is 405. Read-only resources over public views (`docs/20`, "Resources"), prompts, and an SSE stream for server-initiated notifications are F7 and need a session id; adding them is a minor version.
18. **Queued jobs (1.5.0, section 20)**: `runAt` at most 30 days ahead *proposed*; the per-attempt budget is the tier's request limits, so a long job splits itself with `enqueue`. #297 measures the scheduler's tick lag and may propose a job budget of its own as a minor version.
19. **Jobs read path (1.6.0, section 20)**: the page size (at most 100), the 512-character `last_error` and the reset of `attempts` on retry are *proposed*. Whether `scheduled` rows should be pausable from the `jobs` module (a `paused` flag per job) is not decided; 1.6.0 follows the deployed `schedule` only. #297 measures `op_jobs_list` on a tenant with 10,000 dead letters (the cap of Open 5).

## Changelog

| Version | Issue | Changes |
| --- | --- | --- |
| 0 | #12 | First sketch (F0): db, fetch, secrets, log, deadline, request envelope, meter fields, reserved ops |
| 1.0.0-f1 | #17 | **Exposure:** `op2` extension `renox` in `crates/renox-runtime` (section 0). **Request scope:** carried by the async context, with the one-request-per-isolate fallback; only `op_log` works outside a request (section 0). **Secrets:** consumed before tenant code runs; values under 8 bytes refused; exact-substring redaction stated as a limitation (section 3). **New sections:** limits per tier and behaviour on each limit (section 10), isolate bootstrap and global hardening (section 11), serialisation rules (section 12), shared error code table, with response codes `RENOX_CPU_LIMIT`, `RENOX_OOM`, `RENOX_BUSY`, `RENOX_INTERNAL`, `RENOX_BODY_TOO_LARGE` alongside the thrown codes (section 13). **Numbers:** every "proposed" value is now the F1 value. **Meter fields:** section 7 renamed to the names in `meter.md` (`route`, `fetch_sent_bytes`, `fetch_received_bytes`, `http_status`, `ingress_bytes`). **Versioning:** moved to `MAJOR.MINOR.PATCH` (section 9). **Open list:** replaced by "Verification by implementing issues" and "Future" |
| 1.1.0 | #153 | **Pages (section 14):** `LoaderContext`, `ActionContext` (`form`, `action`, `fragment`, `session`, `db` as the action's transaction), `ActionResult`, `Session`, CSRF before actions, the page dispatch exchange (`ops.schema.json` `$defs/page_dispatch`), rendering off the isolate thread; response codes `RENOX_CSRF` and `RENOX_RENDER_LIMIT` (section 13). **Termination bound and collateral rule** stated for tenants (section 10). **Blocked ranges (section 2):** SIIT, NAT64 network-specific prefixes, `192.88.99.0/24`, `3fff::/20`, `5f00::/16`, `fec0::/10`, and the refused names. **Stale text removed:** the Edge Runtime per-worker options and user-worker wording (sections 0, 10, 11), the semaphore's location, the async-context fallback, the `node:` row; `op_fetch` is registered as `op_renox_fetch`. Meter fields `render_fuel` and `render_ms` filled by the cell (section 7) |
| 1.2.0 | #206 | Minor (additive). **Streamed response bodies (section 6):** head first; a static body crosses with the head as before, a `ReadableStream` body crosses chunk by chunk through the new ops `op_response_write` (async, backpressure at 16 chunks) and `op_response_end` (sync, explicit end, or the failure message); a stopped stream is truncated so the client can tell; `Content-Length` removed from streamed bodies; per-chunk gateway compression. **Request scope (section 0):** a request ends when its response ends. **Meter (section 7):** written at the end of the stream, with `wall_ms`, `egress_bytes` and `status` of the whole stream. **Limits (section 10):** response egress per request, 10 MB free / 100 MB paid, counted per chunk before compression, separate from the `fetch` counter; the mid-stream table (egress limit, stream failure, deadline, CPU, heap, client gone). **Pages (section 14):** the shell is flushed after a 50 ms *proposed* shell delay for full-page `GET`s with a loader; errors after the shell are rendered inside the stream; a loader `Response` after the shell is `response_after_shell`. No new error code; `ctx.d.ts` unchanged except its version line |
| 1.3.0 | #226 | Minor (additive). **Modules (new section 15):** per-module `ctx` built by the bootstrap from the artifact's `modules` list (db under the module's authorizer, its own secrets, `fetch` allowlist, and config); `renox:modules` and `ctx.services` (service calls checked against the caller's dependencies, run in the callee's `ctx` with the same user, request, deadline, and current transaction; a callee error reaches the caller as `RENOX_MODULE_SERVICE` and rolls back the enclosing transaction); `ctx.hooks.run` (fillers in priority order, halt, undeclared fillers refused at load); `ctx.events.emit` and `op_events_emit` (durable into `renox__outbox` in the current transaction, or in-memory in the same request; payload checked against the exported schema); the event envelope and delivery (own transaction committed with the acknowledgement, retries, dead-letter); `ctx.config`; isolation modes. **Ops:** a trailing `module` argument on `op_db_*`, `op_secrets_get_all` (now once per module), `op_log`, and `FetchRequest.module` (sections 0–4); savepoint ops `op_db_savepoint_begin`/`_release`/`_rollback` (section 1); `op_events_emit` (section 15.4); `op_password_hash`, `op_password_verify` (argon2id off the isolate thread, new section 16). **Pages:** `setLocale`, `locale` and `dir` in the render result, optional `module` in the page invocation (section 14). **Errors:** `RENOX_MODULE_UNDECLARED`, `RENOX_MODULE_SERVICE`, `RENOX_EVENT_PAYLOAD` (section 13). **Meter:** event delivery records (section 7, Open 4). Section 8 reserves only `op_hooks_run` and the `isolate`-mode ops for F4 |
| 1.4.0 | #263 | Minor (additive). **Locale (section 14):** `setLocale` and the page result's `locale` accept one Unicode extension `-u-` with the keys `ca` (calendar: `gregory`, `islamic`, `islamic-civil`, `islamic-tbla`, `islamic-umalqura`, `persian`) and `nu` (numbering system: `latn`, `arab`, `arabext`), in canonical order; at most 64 characters; `dir` from the language subtag only; `number`, `money`, and `date` honour `nu` (and `date` `ca` where supported); catalog lookup ignores the extension; `ops.schema.json` gains `$defs/locale`. **Lazy route modules (section 11):** a route module whose artifact `entries` record says `eager: false` (`artifact.md` 1.2) is evaluated on its first request, once per isolate; every entry's existence is still checked at isolate creation; `services` and `hooks` entries stay eager; the fail-closed export check moves to `renox check` and to the worker's prepare (V23). **Errors (section 13):** response code `RENOX_MODULE_EVAL` (500, that route only, logged once per isolate, the isolate stays up). **Meter (section 7):** a lazy evaluation is charged to the request that triggered it. Section 8 updated; Open 9–11 added |
| 1.5.0 | #272 | Minor (additive). **Principal and authorization (new section 17):** the principal resolved once per request through the `auth` module's service `auth.principal` (hook fillers extend `attrs`; cached per cell by session id, invalidated by `authz.roles_changed`, `auth.login`, `auth.logout`; anonymous without `auth`), crossing as `ctx.principal` and in the dispatch envelopes; the Cedar entity model and the merged schema; `op_authz_check`, `op_authz_check_batch`, `op_authz_explain` (dev only), `op_authz_roles_assign` / `_revoke` / `_list` and `ctx.authz` (`require`, `can`, `canBatch`, `explain`, `roles`); resources become entities with only their declared attributes; `forbid` wins and everything else denies; the append-only `renox__authz_audit` row for sensitive actions in the request's transaction; `renox__role_assignments` written only by the role ops, a module limited to its approved roles; `guard` on pages, functions and realtime routes, evaluated before the handler and on fragments; `db.scoped()` with the ownership rules, its fifth argument on `op_db_*`, and its refusal code; `authz_evals`. **Realtime (new section 18):** route kinds `ws` and `sse`, `RealtimeContext` and the `conn` handle; `op_realtime_subscribe` / `_unsubscribe` / `_publish` / `_send` / `_close` and `ctx.realtime`; payloads text, JSON, or a partial rendered by the cell; subscribing as the Cedar action `realtime.subscribe` on `Renox::Topic`, fail closed; the change feed from `[realtime.feeds]` after commit; the `Origin` rule; the limits table; one meter record per connection with `realtime_conn_seconds` and `realtime_messages`. **App MCP (new section 19):** route kind `tool`, `/mcp` and the protected-resource metadata as reserved paths, agent tokens through `auth.verifyAgentToken` and what they cover, the call order, the confirm flow with a rolled-back preview, the 256 KB output cap and `untrusted`, the meter record `kind: "tool"`. **Jobs (new section 20):** `schedule`, `tz`, `run`, route kind `job`, durable ticks through the outbox (idempotent, one at a time, coalesced), `op_jobs_enqueue` and `ctx.jobs.enqueue`, `JobContext` with the System principal, `kind: "job"`. **Errors (section 13):** `RENOX_FORBIDDEN` (both; an uncaught `ForbiddenError` is 403), the owned-table refusal code of section 17, `RENOX_REALTIME_LIMIT`, `RENOX_REALTIME_BACKPRESSURE`, `RENOX_TOOL_INPUT`, the tool coverage code and `RENOX_TOOL_CONFIRM` of section 19; `RENOX_MODULE_UNDECLARED` also for roles and jobs. Sections 0, 1, 6, 7, 8, 11, 14 updated; `ops.schema.json` `$defs` for the principal, the authz ops, the realtime payload and envelope, the tool envelope and the job envelope; Open 12–18 |
| 1.1.1 | #201 | Patch, wording only: section 10 states what #155 and #156 implement. **CPU attribution** per async context: a request is charged the CPU of its own continuations, unattributed CPU is split among the requests in flight, and CPU used before a request was admitted is never split onto it. **Collateral rule** per pool member: one bad request ends the in-flight requests on its own member only; the pool size is per tier (`IsolateSpec::max_isolates`); collateral meter records carry the same `status` and are indistinguishable from the request that hit the limit. `ctx.d.ts` and `ops.schema.json` unchanged |
| 1.6.0 | #315 | Minor (additive). **Jobs (section 20):** `op_jobs_list`, `op_jobs_retry`, `op_jobs_cancel` for the `jobs` module only (any other caller is `RENOX_FORBIDDEN`), `JobRow` without the payload, the audit rows; the coalescing key `job_tick:<module>:<name>` in `renox__outbox_meta`, the in-memory per-job lease, the `job` entry through `build_event_args` to `deliver`. **Errors (section 13):** `RENOX_JOB_NOT_FOUND`, `RENOX_JOB_STATE`. `ctx.d.ts`: the ops, `Jobs.list / retry / cancel`, `JobRow`, `JobPage`, `JobState`, `JobNotFoundError`, `JobStateError`; `ops.schema.json` `$defs` `jobState`, `jobRow`, `jobPage`, `call_op_jobs_*`; Open 19 |
