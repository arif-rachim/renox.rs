# renox-runtime

The data plane's JavaScript runtime (P1): V8 isolates on `deno_runtime`, a pool of isolates per deployment (one while it is cold, see "Isolate pool"), created from a platform snapshot; artifact loading (`docs/contracts/artifact.md`); request dispatch to the function handlers of the manifest; the `renox` op extension (`docs/contracts/ops.md`).

```
cargo test -p renox-runtime                          # everything, links V8
cargo test -p renox-runtime --no-default-features    # pure modules only, no V8
cargo test -p renox-runtime --test dispatch -- --nocapture   # prints creation time and memory
```

Public surface (issue #25):

```rust
let rt = Runtime::new(RuntimeConfig { log_sink });                       // once per process
let db = DbHandle::spawn(TenantDb::open(path, options)?.with_authorizer(AuthorizerPolicy::module("app"))?)?;
let iso = rt.create_isolate(IsolateSpec { tenant_id, deployment_hash, artifact_dir, limits, secrets, db: Some(db) }).await?;
let Dispatched { response, meter } = iso.dispatch(RequestCtx { request_id, deadline }, http_request).await;
iso.terminate();
```

## Upstream consumption mode

**Decision: `deno_runtime` from crates.io as a library, with our own worker setup, not the `supabase/edge-runtime` crates.**

| | `supabase/edge-runtime` crates (`base`, `sb_*`) as git dependencies | `deno_runtime` directly (chosen) |
| --- | --- | --- |
| Library API | Built as a server binary; the public entry points start an HTTP server and a main/user worker supervisor, not "create an isolate, dispatch a request" | `MainWorker` with `WorkerOptions` / `WorkerServiceOptions`: extensions, snapshot, `CreateParams` (heap limit), module loader, permissions are all arguments |
| Our `renox` extension on user workers | Needs a patch (the user-worker extension list is fixed in `base`) | One entry in `WorkerOptions.extensions` |
| Patches to the V8 / `deno_core` forks | Their workspace `[patch.crates-io]` (Supabase's `deno_core` and `rusty_v8` forks) does not apply to dependants; we would have to copy it into our root `Cargo.toml` and track it | None: crates.io `deno_core` and `v8` |
| Build | Also pulls `ai` (onnxruntime, BLAS), S3 FS, their main-worker JS | `deno_runtime` and its extensions only |
| What we lose | Supabase's supervisor (per-worker CPU/memory accounting, pool policy) | Nothing we use: `ops.md` section 10 already rules out the per-worker cumulative limits; #26 implements per-request limits in Rust |

**Versions: the current Deno release, not the spike's.** `deno_runtime = 0.268.0` (released 2026-10-21), `deno_core = 0.413.0`, `v8 = 150.4.0`, `eszip = 0.138`. The `v8` crate downloads its prebuilt static library; nothing builds V8 from source (`docs/12-developer-experience.md`, rule 1).

The first version of this crate pinned the F0 spike's Deno 2.1.4 (`deno_runtime` 0.191, `v8` 130, the versions inside the pinned Edge Runtime v1.77.8). That could not share a lockfile with the rest of the workspace: it pins `hyper-util = 0.1.7` and needs `serde` ≤ 1.0.219, while `renox-gateway` needs `hyper-util` 0.1.21 and `serde` 1.0.229. Moving to the current release fixed that and replaced a V8 that was nearly two years old. What the move required outside this crate (PR #138, "Differences"):

- **`renox-gateway`**: `rustls` minimum lowered from 0.23.46 to 0.23.40, the version `deno_tls` pins exactly.
- **`renox-data`**: `rusqlite` 0.41 → 0.40, because five Deno extensions (`deno_cache`, `deno_kv`, `deno_webstorage`, `deno_node_sqlite`, `denokv_sqlite`) use `rusqlite` 0.40 and only one `libsqlite3-sys` (`links = "sqlite3"`) may be in a workspace. 0.40's WAL hook is a plain `fn`, so the WAL accounting reaches its connection through a thread-local set around every writer call that can commit, and explicit checkpoints use `PRAGMA wal_checkpoint`. Behaviour and tests unchanged.
- **`bench/spike/marshal-bench`**: `v8` 130.0.7 → 150.4.0 and `serde_v8` 0.233 → 0.322 (scope API port only). Cargo accepts two `v8` versions in one lockfile (no `links` key), but every version downloads its static library to the same `target/<profile>/gn_out/obj/librusty_v8.a`, so the link picks whichever build script ran last. One `v8` per workspace.

Consequences recorded for the risk register (`docs/16-risks.md`, "Dependence on Supabase Edge Runtime"):

- **We run a newer Deno than the Edge Runtime spike measured.** F0's numbers (B1, B4, B17) were taken on Deno 2.1.4; the measurements below are on this version, and #34/#35 re-measure the gate numbers on it.
- **Deno pins exact versions** of shared crates (`rustls`, `rusqlite` through its extensions). Every future Deno upgrade, or any crate in the workspace that wants a newer `rustls` or `rusqlite`, must move together. Keep the minimum versions in the other crates' `Cargo.toml` at or below Deno's pins.
- **Patches:** none.

## Platform snapshot

`Runtime::new` builds the V8 startup snapshot **once per process**: every `deno_runtime` extension plus the `renox` extension's ESM (`src/js/bootstrap.js`) are evaluated into it with `deno_runtime::snapshot::create_runtime_snapshot`, and every isolate starts from that blob, so isolate creation never re-evaluates the bootstrap JavaScript.

It is built at process start rather than in `build.rs` because a build-time snapshot needs `deno_runtime` as a build dependency as well, which compiles the whole Deno tree a second time for the host and roughly doubles a cold build (B20). The cost moves to process start (measured below) and is paid once per worker process, not per isolate. Snapshot creation runs on its own thread (it drives its own Tokio runtime), and V8 is initialised in non-snapshotting mode first, so the process does not run with `--predictable`.

Deno 0.268 keeps many extension scripts out of the snapshot and loads them on first use (`core.loadExtScript`). The snapshot builder reports which ones it did not consume; `Runtime::new` reads them once, transpiles the TypeScript ones (Node polyfills, timers), and hands the same `'static` sources to every worker (`WorkerOptions::residual_lazy_*_sources`). The bootstrap loads the modules behind `Request`, `Response`, `ReadableStream`, and `URL` at its top level, which runs while the snapshot is built, so they are evaluated into the snapshot. Before #145/#146 they were loaded on first use, which cost a fresh isolate's first request about 13 ms inside its CPU budget (B4) and caused occasional `RENOX_CPU_LIMIT` on cold first requests (B2/B3). `Runtime::residual_lazy_specifiers` lists what is still loaded lazily. A verified artifact is kept per directory (`Runtime::load_artifact`), so a deployment is hashed once per process, not once per isolate.

## Packaging

By default (the dev path: `renox dev` from a checkout, tests, CI) the snapshot and the lazy sources are read from the Deno crates' source files at process start, so the binary only runs where the cargo registry sources exist. The `packaged` feature (#154) embeds them instead, so a release `renox-worker` runs on a clean machine. It takes two builds of the same source:

```
RENOX_PACKAGED_DIR=$dir cargo test --release --locked -p renox-runtime --test packaged -- --ignored --exact write_packaged_sources
RENOX_PACKAGED_DIR=$dir cargo build --release --locked -p renox-cell --bin renox-worker --features renox-runtime/packaged
```

The first writes this process's snapshot (`snapshot.bin`) and the transpiled residual lazy sources (`lazy/*.js`, listed in `lazy.tsv`) with `Runtime::write_packaged`. The second embeds them: `build.rs` generates `include_bytes!`/`include_str!` code, and `Runtime::new` uses it without reading any file (`Runtime::is_packaged()`). Both builds must use the same source, features, and `v8`, or the snapshot does not match the binary's ops (`deno_core` refuses a mismatched snapshot at start). This replaces a `build.rs` snapshot, which would compile the whole Deno tree a second time as a build dependency on every build; here the second build recompiles only `renox-runtime` and `renox-cell`, and only in the release pipeline (`.github/workflows/release-worker.yml`, which also runs the binary in a clean `ubuntu:24.04` container).

## Module loader

`src/loader.rs`. Tenant modules get a **virtual** root: `code/functions/api/hello.js` is `file:///functions/api/hello.js`, which is also its specifier inside `bundle.eszip` (`artifact.md`, "Open" 2). `import.meta.url` and stack traces therefore never show a path of the machine.

- `esm-dir`: files are read from the artifact's `code/` only. The specifier is checked with the artifact path rules (no `..`, no `\`, no `:`), and the file's canonical path must stay under the canonical `code/` (so a symbolic link created after the load-time check cannot escape). `.js`, `.mjs`, and `.json` only.
- `eszip`: `bundle.eszip` (v2) is parsed completely when the isolate is created and served from memory.
- Refused at resolution: `http:`, `https:`, `data:`, `blob:`, `npm:`, `jsr:`, `file://host/`, query strings and fragments. `ext:` is refused by `deno_core` for non-`ext:` referrers.
- `node:` built-ins: only the compute-only modules in `loader::NODE_ALLOWED` (`buffer`, `events`, `path`, `util`, `stream`, `url`, `string_decoder`, `zlib`, ...). See "Hidden globals".
- **No `npm:` resolution at runtime.** In F1 an `esm-dir` artifact must already contain its dependencies as plain ES modules (vendored by the CLI, #32), or the dependencies are bundled into `bundle.eszip`. An `npm:` or bare package specifier in an artifact fails isolate creation. This is the gap until the CLI's eszip step (#30, #32) produces every artifact.
- Every artifact is verified before loading: path rules and no symbolic links (V1), the directory name equals the content hash (V2), manifest schema and version (V3), code size (V5), code layout (V6), routes and entries (V7).

## Request dispatch

`src/router.rs` matches `manifest.routes[]` by method and path (static beats `:param` beats `*catch-all`, percent-decoded segments, no trailing-slash normalisation). No match → 404 and a method mismatch → 405 with `Allow`, both answered in Rust without entering the isolate (no meter record, `meter.md` section 1). `HEAD` uses the `GET` route and drops the body.

The bootstrap's `dispatch` runs the handler with a frozen `ctx` (`req`, `url`, `params`, `headers`, `db`, `fetch`, `secrets`, `log`, `deadline`, as `docs/contracts/ctx.d.ts` of contract 1.0.0-f1 declares them) inside a fresh async context carrying the request token. A handler that throws, or returns something that is not a `Response`, produces 500 `RENOX_INTERNAL` with the fixed message of `errors.md` and the request id; the error name, message, and stack go to the tenant log sink only.

**Request scope.** `ops.md` section 0 asks #25 to prove that the request token survives `await`, timers, and promise continuations (`tests/dispatch.rs`, `request_scope_follows_async_context`). It does: the token lives in a `deno_core` `AsyncVariable` (continuation-preserved embedder data), so concurrent requests on one isolate each see their own token, and the one-request-per-isolate fallback is not needed. A timer that fires after its request ended gets `RENOX_NO_REQUEST`. The bootstrap reads the token and passes it to each op as the first argument; the ops are captured in the bootstrap's closures and are unreachable from tenant code, so tenant code cannot supply a token of its own, and Rust refuses a token that is not live.

### Page routes (artifact v1, #40)

`src/manifest.rs` accepts artifact versions 0 and 1. Version 1 adds `kind: "page"` routes, `manifest.templates`, `security`, `templates/` and `public.json`; a version 0 manifest with any of them is V3. Load also checks V14 (template files match `manifest.templates`, kinds match ids) and V7/V15 for page routes. A page route is a `GET` route of the router (so `HEAD` works); its handler is the module's `load` export, or none.

`src/pages.rs` picks the fragment (`HX-Request: true` and an `HX-Target` equal to a fragment's `target`, `artifact.md` "Fragment selection"). Then:

- No `load` (`.html` page, or `.ts` + `.html` without `load`): nothing enters the isolate; `Dispatched::render` asks the cell to render the template with `{}`.
- `load` returns a `Response`: sent as for a function.
- `load` returns a plain object: the bootstrap serialises it with `JSON.stringify` inside V8 (`bigint` as a string, `Date` via `toJSON`, bytes and cycles refused), and `Dispatched::render` carries the JSON to the cell (the B9 path). Anything else, or a `.ts`-only page returning an object, is 500 `RENOX_INTERNAL` with `reason` (`load_result`, `data_not_serialisable`, `data_too_large`, `no_template`) in the tenant log.

The loader's `ctx` has `fragment` and `session` (`ops.md` section 14). The runtime never renders and does not depend on `renox-template`: rendering happens in `renox-cell`, so it is never in `cpu_ms`.

**Actions (#41).** A page route with `actions` also answers `POST` in the router (`Allow: GET, HEAD, POST`). `pages::page_call` reads the action from the query (`?/<name>`, up to `&`; no `?/` names `default`); an unknown or malformed name is 404 before any tenant code. At isolate creation every declared action must be a function of the module's `export const actions` (fail closed, like a missing `load`). The bootstrap's `runAction`:

1. parses `ctx.form` from `application/x-www-form-urlencoded` or `multipart/form-data` (any other type: an empty `FormData`) and deletes `_csrf`;
2. opens the request's `IMMEDIATE` transaction and calls the action with `db` bound to it (no `transaction()`);
3. on a throw, or a result that is not a `Response`, a plain object, or nothing, rolls back (500 with `reason` `threw`, `action_result`, or `no_template` for an object from a `.ts`-only page); otherwise commits;
4. after an object, runs `load` again outside the transaction and returns `{ ...loadResult, ...actionObject }` without `fragments`, plus the `fragments` names.

Only an htmx request (`HX-Request: true`) gets the out-of-band fragments; a plain form `POST` gets the full page. A name not in the page's fragment map is 500 `RENOX_INTERNAL` (after the commit), logged with the name. Since every transaction is `IMMEDIATE`, a tenant's actions serialise on its one writer: keep them short and keep `fetch` out of them (`ops.md` section 14).

The session id comes from the cell as a `pages::PageSession` request extension (the cell verifies the signed cookie; the runtime never sees a key). A request without it gets an empty id.

**Trailing slashes (artifact v1).** `GET`/`HEAD` `/products/42/` with no route of its own, whose path without the `/` is a page route, is answered `308` to `/products/42` with the query kept, before the isolate and without a meter record. Function routes and `POST` are never redirected.

## Limits

`src/limits/` (issue #26), behaviour per `ops.md` section 10. The cell passes the tier's numbers in `IsolateSpec.limits` (`Limits::FREE`, `Limits::PAID`); the manifest's `limits` can only lower them.

| Limit | Mechanism | On the limit |
| --- | --- | --- |
| CPU per request (50 / 500 ms) | `limits/cpu.rs`: the isolate thread's `CLOCK_THREAD_CPUTIME_ID` (read through `pthread_getcpuclockid` + `clock_gettime`, the only `unsafe` in the crate, with a `SAFETY` note per call) and a watchdog thread per isolate that samples the running slice every 1 ms and calls `v8::IsolateHandle::terminate_execution()` | 503 `RENOX_CPU_LIMIT`, meter `cpu_limit`; the pool member is poisoned, every other request in flight on that member gets the same answer, the thread disposes it, and the pool's spare takes its place, or the next request creates a fresh isolate from the snapshot (`RuntimeMetrics::recycles`; "Isolate pool") |
| Wall clock per request (30 / 60 s, or the cell's earlier deadline) | `tokio::time::timeout_at` on the handle side; the isolate then ends the request: its token stops working and its `CancelHandle` cancels pending ops | 504 `RENOX_DEADLINE` at the deadline, meter `timeout`; the isolate is kept. Later ops of that request get `RENOX_NO_REQUEST` |
| V8 heap per isolate (128 / 512 MB) | `CreateParams::heap_limits` plus `limits/heap.rs`: a near-heap-limit callback that doubles the limit for a moment (so V8 does not abort the process) and terminates execution | 503 `RENOX_OOM`, meter `oom`; recycled as for CPU |
| Concurrent requests per deployment (50 / 500) | `limits/concurrency.rs`: a `tokio::sync::Semaphore` per `IsolateHandle`, shared by every pool member; a request queues for a slot up to its deadline | 503 `RENOX_BUSY` with `Retry-After: 1`, meter `busy`, no tenant code runs |
| Module evaluation (500 ms / 5 s CPU, 10 s wall) | The same watchdog with the module budget, and a timeout around module loading | Isolate creation fails with `CreateError::Limit`; requests get 503 `RENOX_CPU_LIMIT` / 504 `RENOX_DEADLINE` / 503 `RENOX_OOM`, and the failure is cached for 5 s per deployment |

**CPU accounting (#155).** JavaScript runs only inside the isolate loop's poll, one "slice" per poll. Within a slice, `limits/cpu.rs` (`CpuLedger`) charges each run of JavaScript to the request whose async context it runs in:

- Before it calls the handler, the isolate sets V8's continuation-preserved embedder data to a null-prototype object holding the request's token (`set_async_context` in `src/isolate.rs`; the key is one the bootstrap's `AsyncVariable` spread carries along). V8 restores that value for every promise reaction the request creates: `await` continuations, `then` callbacks, ops, and timers.
- Context-level promise hooks (`before` and `after` only, `install_promise_hooks`) report each switch, and the ledger charges the thread CPU of each run to the request it belongs to. A request is therefore charged the CPU of its own continuations, not of the other requests that ran while it was in flight.
- CPU that runs in no request's context (platform glue between reactions) is split evenly among the requests in flight, rounded up. With one request in flight everything is its own, so a single request is never under-counted.
- A request is charged from the moment it is admitted (`CpuLedger::admit`): the run so far is charged first, so CPU a slice used before the request joined is never split onto it. Its synchronous part runs in its own context, under its own budget.
- The watchdog's budget follows the running context: the running request's own remaining CPU, or for unattributed work the smallest remaining CPU among the requests in flight. JavaScript running with no request in flight (a timer that outlived its request) gets the per-request limit, so orphaned work cannot spin forever. A seqlock keeps the watchdog's (start, budget) pair consistent when the isolate thread re-arms it at a switch.

Tests (`tests/cpu_accounting.rs`, on one isolate, so two threads: the isolate and its watchdog; `max_isolates = 1` whatever `RENOX_TEST_POOL` says): 16 concurrent light requests are each charged at most 2× their solo cost and at least 0.8× their own JavaScript work, and none is ended (`concurrent_light_requests_are_charged_their_own_cpu`; measured 0.94–1.07× the solo cost); an infinite loop that starts while 15 requests are in flight is terminated at its own 50 ms (+ 5 ms) (`infinite_loop_among_concurrent_requests_is_terminated_at_its_own_limit`; measured 50.6–51.2 ms). With one request in flight, `tests/limits.rs` shows termination at 50.7–50.8 ms for a 50 ms limit (B12 tolerance ± 5 ms). Under B12 on a dev host, tenant B had 0 requests ended in 4 sets, against 16 with the F1 accounting, which charged every request in flight the whole slice (`bench/results/2026-10-28-B12-cpu-accounting-renox-worker.md`, "Root cause"). The first version used the isolate-level `SetPromiseHook`; the context hooks with only `before`/`after` showed no measurable difference in B's p50.

**Cost.** Two threads per live isolate (the isolate and its watchdog), so per deployment two threads per pool member plus two for the spare, if any. The watchdog parks while no slice runs, so an idle isolate costs no wake-ups; a running slice costs one wake-up per millisecond. The promise hooks add two calls into Rust (`before`, `after`) per promise reaction.

## Outbound fetch

`src/ops/net_policy.rs` (policy, pure), `src/ops/fetch_connector.rs` (DNS, pinned connect, TLS, egress counting; no V8), and `src/ops/fetch.rs` (the ops and the redirect loop); issues #27 and #108, contract `ops.md` section 2. The policy and connector tests run without V8 (`cargo test -p renox-runtime --no-default-features`).

- **Order of checks, every hop:** (1) the URL's scheme, host, and port must match a `permissions.network[]` entry (`not_allowlisted`, `scheme`, `port`); `localhost`, `*.localhost`, and `metadata.google.internal` are refused whatever the list says (`blocked_address`). (2) DNS is resolved in Rust (hickory, without the hosts file, A and AAAA, no cache) and **every** address is checked against the blocked ranges; one blocked address refuses the set (`blocked_address`). (3) The connection goes to one of those checked addresses with the original `Host` and SNI, so DNS rebinding between check and connect is impossible. (4) Redirects are followed by the op, never by the client: at most 5 hops (`redirect_limit`), each hop runs (1)-(3) again, `307`/`308` keep the body, `Authorization`, `Cookie`, and `Proxy-Authorization` are dropped when the origin changes, and `https` → `http` is allowed only to a host declared `http://`.
- **Blocked ranges:** one table per address family in `net_policy.rs`, with a comment per range. IPv4-mapped, IPv4-compatible, NAT64 (`64:ff9b::/96`, `64:ff9b:1::/48`), and 6to4 addresses are checked as the IPv4 address they embed. The cell can add the node's own and the control plane's addresses (`FetchConfig::extra_blocked`).
- **DNS pinning (#108):** `net_policy::resolve_and_check` resolves once and returns the checked socket addresses; `fetch_connector::connect` takes only socket addresses (no host name), tries them in resolver order with no happy eyeballs, and hands the stream to hyper's connection-level client, which never resolves anything. `tests/fetch_rebinding.rs` proves it against a scripted DNS server whose second answer is private: the request completes against the first address and a listener on the private address sees no connection.
- **TLS:** rustls with the webpki roots plus `FetchConfig::extra_root_certs` (operator trust anchors only). There is no option in the op, the bootstrap, or the config that turns verification off; Deno's `client`/`createHttpClient` path is unreachable (`Deno` is removed and the `Request` constructor rejects a foreign `client`). A failed handshake is `RENOX_FETCH_FAILED` with `reason: "tls"`.
- **Deadline:** the whole fetch (DNS, connect, TLS, every hop, every body read) is bounded by the request deadline and cancelled when the request ends; the tenant sees `RENOX_DEADLINE`.
- **Egress limit:** every byte on the wire (below TLS, so handshakes count) is counted per request against `Limits::egress_bytes` (10 MB free / 100 MB paid). Reads and writes are capped at the bytes still allowed, so a large body stops exactly at the limit with `RENOX_FETCH_EGRESS_LIMIT`. The totals are the meter's `fetch_sent_bytes` and `fetch_received_bytes`.
- **Errors** reject with a `RenoxError` whose `code` and `details` (`{ host, reason, hop }`) follow the contract; the resolved address is never included. Every blocked attempt increments `fetch_blocked` and is logged with host and reason, caught or not.
- **Limits:** 16 fetches waiting for headers per request, 32 fetches including response bodies still open (an unread body holds its connection), 64 request headers / 16 KB, 3 s connect attempt per resolved address (sequential, still within the deadline). Null-body statuses (204, 205, 304) and `HEAD` return a `Response` with a null body.
- **Not done here (the cell's part):** the node's own public addresses and the control plane's addresses must be passed in `FetchConfig::extra_blocked` by `renox-cell`; the runtime only applies the list. `renox-cell` should refuse to start in production with an empty list.
- **Known limitations:** response bodies are not decompressed (the tenant sees `Content-Encoding` as sent); a `307`/`308` to another allowlisted origin keeps the body and custom headers (only `Authorization`, `Cookie`, `Proxy-Authorization` are dropped), as in browsers; the request body is buffered in the isolate (bounded by the heap limit) before it is sent. The blocked ranges are exactly the table of `ops.md` 1.1.0 section 2 (SIIT `::ffff:0:0:0/96`, `3fff::/20`, `5f00::/16`, `192.88.99.0/24`, `fec0::/10`); NAT64 network-specific prefixes come from `net_policy::Nat64Prefixes` (RFC 6052 positions).
- **Op name:** `deno_fetch` already registers an op called `op_fetch`, so ours is `op_renox_fetch`; `op_fetch_body_read` and `op_fetch_body_close` keep the contract's names. Ops are reached only through the bootstrap, so the name is internal.

## Hidden globals

Applied by the bootstrap's `harden()` after `deno_runtime` has bootstrapped the global scope and before any tenant module is evaluated (`ops.md` section 11, step 2). Upstream exposes much more than a request handler needs; every item was decided:

| Global or capability | Decision | Why |
| --- | --- | --- |
| `Deno` (and with it `Deno.core`, the op table, `Deno.exit`, file, net, env, subprocess APIs) | Deleted | Platform internals; permissions deny the I/O anyway |
| `__bootstrap`, `bootstrap` | Deleted by `deno_runtime`; `__renoxInternal` deleted by us before tenant code runs | Hold the platform's functions |
| `SharedArrayBuffer` | Absent: V8 flag `--enable-sharedarraybuffer-per-context`, never enabled, and the global deleted | Spectre-class timers |
| `new WebAssembly.Memory({ shared: true })` | Throws `TypeError` | Would return a `SharedArrayBuffer`. **Gap:** a wasm module that declares its own shared memory can still produce one; with no `Worker` there is no second thread to build a timer from it. `v8` 150 still has no Rust binding for the embedder hook; revisit when it does |
| `performance.now()`, `performance.timeOrigin` | Whole milliseconds: `op_now` and `op_time_origin` are replaced by op middleware | `deno_web` keeps full resolution |
| `Worker`, `BroadcastChannel` | Deleted | `deno_runtime` panics when a web worker is created without a factory; a deployment's isolates come only from its pool ("Isolate pool") |
| `close`, `closed`, `alert`, `confirm`, `prompt` | Deleted | `close()` ends the whole process; the others read stdin |
| `op_exit` | Replaced by a no-op through op middleware | Any path to it (`process.exit`, `Deno.exit`) would end the worker process with every tenant on it |
| `process` (Node global) | Deleted | `exit`, `env`, `stdin`, `cwd`, `memoryUsage`. npm code guards it with `typeof process` |
| `WebSocket`, `WebSocketStream`, `EventSource` | Deleted | Outbound connections that bypass `op_fetch` |
| `caches`, `localStorage`, `sessionStorage`, `indexedDB`, `Cache`, `CacheStorage`, `Storage` | Deleted | No persistence except `ctx.db` |
| `GPU*`, `navigator.gpu` | Deleted | Native GPU code paths |
| `navigator.platform`, `navigator.userAgentData` | Deleted | Host OS and architecture details |
| `navigator.hardwareConcurrency` | Always 1 | Do not reveal the host's CPU count |
| `Temporal`, `onload`, `onunload`, `onbeforeunload` | Deleted | Unstable or meaningless here |
| `node:` modules | Only `loader::NODE_ALLOWED` (compute-only) can be imported; `node:fs`, `net`, `http`, `https`, `dns`, `child_process`, `worker_threads`, `process`, `os`, `vm`, `v8`, `perf_hooks`, `inspector`, `tls`, `dgram`, `cluster`, `module`, ... are refused at resolution | Stricter than `ops.md` section 11 ("importable, every I/O call fails"): refusing at import fails closed even where a polyfill has an ungated op, and keeps `vm` (new contexts) and `perf_hooks` (timers) out |
| Deno permissions | `none_without_prompt()`: every permission denied | Defence in depth under the deletions above |
| Unhandled promise rejections | `preventDefault()` in an `unhandledrejection` listener | A stray promise in tenant code must not end the isolate's event loop |
| `eval`, `new Function`, `WebAssembly.compile` | Kept | npm packages need them; the code still runs under the isolate's limits |
| `fetch` | Replaced by the `op_renox_fetch`-backed implementation (same function as `ctx.fetch`); see "Outbound fetch" | Allowlist and blocked ranges |
| `console` | Replaced by an object whose every method (`log`, `info`, `debug`, `warn`, `error`, `trace`, `assert`, `table`, ...) formats its arguments and calls `op_log` | Nothing reaches stdout or stderr; redaction and the rate limit apply (see "Database, secrets, logs") |

## Database, secrets, logs

Issue #28; contract `ops.md` sections 1, 3, 4, 5. Code: `src/ops/db.rs`, `src/ops/secrets.rs`, `src/ops/log.rs`, `src/ops/deadline.rs`, and the `ctx.db` / `ctx.log` / `console` glue in `src/js/bootstrap.js`.

**DB thread.** `TenantDb` (`renox-data`) is `Send` but not `Sync` and its `transaction` takes a closure, while `db.transaction(async (tx) => ...)` runs JavaScript between statements. So the cell moves each tenant file onto its own thread with `DbHandle::spawn(db)` and puts the handle in `IsolateSpec.db` (one thread per tenant file, shared by every isolate of the tenant and surviving isolate recycles). Ops send a job and await the reply, so a statement never blocks the isolate thread. A transaction is the DB thread sitting inside `TenantDb::transaction`, serving that transaction's statements until its commit or rollback arrives. Meanwhile reads without a transaction run on a reader connection; writes without a transaction, another `begin`, and `DbHandle::call` jobs wait in a queue for at most `min(busy_timeout, deadline)` and then fail with `RENOX_DB_BUSY`. The thread rolls a transaction back by itself at its request's deadline, and when its `begin` reply finds the requester gone. `DbHandle::call(|db| ...)` runs migrations, checkpoints, and stats on the thread; `DbHandle::close()` rolls back, truncates the WAL, and closes the file.

| Rule | Where |
| --- | --- |
| Parameters: `null`, `boolean` (1/0), `number` (INTEGER when integral within ±(2^53 − 1), else REAL; `NaN`/`Infinity` refused), `bigint` (i64, else refused), `string` (lone surrogates refused), `Uint8Array` (copied); anything else `RENOX_DB_PARAM` with `details.index` | `db::convert_params`; the bootstrap only tags values |
| Results: INTEGER beyond ±(2^53 − 1) → `bigint`, BLOB → fresh `Uint8Array`, rows as plain objects in column order | `db::rows_out`, `toRows` in the bootstrap |
| SQL ≤ 100 KB, ≤ 1,000 parameters (`RENOX_DB_PARAM`); ≤ 10,000 rows and ≤ 8 MB per call (`RENOX_DB_RESULT_LIMIT`) | `db.rs` constants. The row and byte limits are checked after `renox-data` returns the rows, so a large result is materialised once in Rust before it is refused |
| Statement deadline: the request deadline goes into `QueryCtx` | every statement |
| Errors: `DbError::code()` as `code`; `details` `{ table, action }` for `RENOX_DB_AUTH`, `{ kind }` for `RENOX_DB_CONSTRAINT`; message redacted; `DbError::Open` becomes the fixed text "The database is not available." | `db::error_details`, `db::error_message`. `renox-data` messages never contain the file path (`tests/ops.rs`, `no_database_error_shows_a_path`) |
| One transaction per request (`RENOX_DB_TX_STATE` on nesting); every transaction is `immediate` (`mode: "deferred"` is accepted and treated as immediate) | `op_db_tx_begin` |
| A transaction still open when the request ends for any reason is rolled back, logged when the dispatch finished, and counted in `RuntimeMetrics::rolled_back_transactions`; the ones whose request was terminated (CPU, heap, deadline, throw, disposal) also in `rolled_back_on_termination` | `src/request_resources.rs` (#89), called by `end_request` on every end path |
| `db_ms`, `db_rows` per request: the `DbStats` difference around each statement on the DB thread | `InvocationMeter` |

**Secrets.** `IsolateSpec.secrets` holds what the tenant has set; only the names in `manifest.permissions.secrets` reach the isolate. A declared value under 8 bytes fails creation with `RENOX_INTERNAL` and a log line naming the secret. `harden()` calls `op_secrets_get_all` once (a second call is `RENOX_SECRETS_CONSUMED`) and keeps `Object.freeze` of the result for every `ctx`.

**Logs.** Every line for the tenant goes through `RedactingSink`, which replaces each secret value (any length ≥ 8, declared or not) in the message, the field keys and values, and the request id with `[redacted]`: `op_log` lines, the dispatch wrapper's lines for a throw (message and stack), and the fetch op's lines. `op_log` adds the tenant, deployment, and request (`null` at module top level), moves tenant fields named `ts`, `tenant_id`, `deployment_hash`, `request_id`, `module`, `level` to `user_<name>`, truncates messages at 8 KB and fields at 16 KB, and applies the per-tenant rate limit (`Limits::log_lines_per_min`, 1,000 free / 10,000 paid, per process): over it lines are dropped and counted in `logs_dropped`, and the first line of the next window is preceded by a `{"dropped": N}` summary. `NdjsonLogSink` writes one JSON object per line (`ts` in RFC 3339 UTC, `level`, `tenant_id`, `deployment_hash`, `request_id`, `module`, `message`, `fields`) to stdout or any writer; the control-plane sink is F3. Field values the bootstrap converts first: `bigint` → string, `Uint8Array` → `"[N bytes]"`, `Error` → `{ name, message, stack }`, cycles → `"[circular]"`, functions and symbols dropped.

### Release on termination (#89)

`src/request_resources.rs`: each request's `RequestResources` registers its open transaction and its open fetch bodies. `drain` runs on every path that ends a request (handler returned or threw, deadline, CPU limit, heap limit, event-loop error, isolate disposal), on the isolate thread, before the reply is sent and before a poisoned isolate is dropped: the rollback reaches the DB thread ahead of anything the next request sends. Fetches still waiting for headers are futures cancelled by the request's `CancelHandle` and dropped with the isolate, which closes their connections. The DB thread adds a second net: it rolls a transaction back by itself at its request's deadline. Tests: `tests/termination.rs`.

## Thread model

One OS thread per isolate (`renox-isolate-<hash>`), each with a single-threaded Tokio runtime that owns the `MainWorker`, plus its CPU watchdog thread (`renox-cpu-watchdog`). `IsolateHandle` is the deployment's handle: it owns the pool's members and talks to each over an unbounded channel; a dispatch is a message with a `oneshot` reply. The thread's loop polls the channel, the `deno_core` event loop, and the in-flight dispatch futures together, so many requests can be in flight on one isolate at once.

Why not upstream's worker pool: a V8 isolate is bound to the thread that runs it, `JsRuntime` is `!Send`, and the per-request CPU watchdog (#26) measures exactly this thread's CPU clock (`CLOCK_THREAD_CPUTIME_ID`); a pool that moves isolates between threads would break that accounting. Renox's own pool (below) keeps each isolate on its own thread. Disposal happens on the isolate's own thread when its handle is dropped or terminated, so dropping or recycling an isolate never blocks a dispatch. The cost is two threads (and their stacks) per live isolate; idle eviction (#29) bounds the count.

### Isolate pool (#156)

`src/isolate.rs`, "Pool". A deployment starts with **one isolate and no spare** (density, B2/B3; `tests/pool.rs`, `a_cold_deployment_keeps_one_isolate`). It grows only while requests wait on a busy isolate: a request goes to the least-loaded member, and when that member already has `POOL_GROW_AT_LOAD` (2) requests in flight and the pool is below `IsolateSpec::max_isolates`, the spare joins or a member is created in the background. From then on the deployment is hot and keeps **one spare** ready. `max_isolates` is set by the cell per tier (`crates/renox-cell/src/manager.rs`): one per core, up to 2 on the free tier and up to 8 on the paid tier; 0 and 1 mean one isolate and no spare. A hot deployment therefore runs at most `max_isolates` members plus one spare, each with its two threads.

- **Collateral rule** (`ops.md` section 10): a CPU or heap termination poisons only its member, so it ends only the requests on that member. The spare takes the member's place at once (no cold start), and the recycle is counted in `RuntimeMetrics::recycles`. `tests/pool.rs`, `a_cpu_kill_ends_only_the_requests_on_that_member`: two members (three isolates with the spare, six threads), six slow requests spread 3 + 3, a CPU hog on one member: 3 end with 503 `RENOX_CPU_LIMIT`, 3 finish with 200, and the next request is served by the two-member pool. The collateral requests' meter records carry `cpu_limit`/`oom` like the request that hit the limit; there is no marker that tells them apart.
- **Dying member:** a request sent to a member that was already poisoned, and that never started on it, is answered `Refused` by that member's thread and sent to another member, at most twice (`requests_queued_on_a_dying_member_run_elsewhere`).
- **Concurrency:** the semaphore stays per deployment, shared by every member (`the_concurrency_limit_is_shared_by_the_members`).
- `tests/limits.rs` and `tests/termination.rs` run per member with `RENOX_TEST_POOL=2` (`tests/support/mod.rs`, default 1).

## Measurements

Machine: 4 vCPU cloud container (x86_64, Linux 6.18), Rust 1.99.1, `deno_runtime` 0.268 / `v8` 150. Release profile. `tests/dispatch.rs`, `isolate_creation_time_and_memory_are_printed`, 30 isolates per format after one warm-up, each serving one request and kept alive.

| | `esm-dir` (`examples/hello` worked example) | `eszip` (same handler, two modules) |
| --- | --- | --- |
| Isolate creation p50 / p99, measured on the isolate thread (snapshot deserialisation, `deno_runtime` bootstrap, hardening, module evaluation, handler lookup) | 12.6 ms / 26.8 ms | 10.8 ms / 16.8 ms |
| Of which tenant module load + evaluation | 0.33 ms | 0.18 ms |
| `create_isolate` p50 / p99 (adds artifact verification: hash, schema) | 13.1 ms / 27.4 ms | 11.3 ms / 17.3 ms |
| V8 heap after the first request: used / total | 3.62 MB / 4.50 MB | 3.63 MB / 4.50 MB |
| Process RSS delta per live isolate (30 isolates) | 7.24 MB | 2.46 MB |

Platform snapshot: 2.1 MB, built in 0.55 s once per process. The RSS delta is noisy: the `esm-dir` series runs first and also pays for process-wide pages touched on first use (lazy extension sources, allocator arenas), so read the `eszip` figure as the closer per-isolate cost.

Reading against the targets (`docs/14-benchmarks.md`): B4 cold start p50 ≤ 20 ms is **met** (11–13 ms; the F0 spike measured 32.3 ms on Deno 2.1.4, and this crate measured 31–35 ms on `deno_runtime` 0.191 before the upgrade). Most of the gain is Deno's own: 0.268 keeps far less in the snapshot (2.1 MB against 7.6 MB) and loads the rest of the extension JavaScript on first use. The p99 (17–27 ms) is over 20 ms; pre-created isolates (#29) are the lever for the tail. Memory per hello isolate (2.5–7.2 MB RSS, 3.6 MB V8 heap) is within B1's 10 MB target for `hello`; the F1 gate condition (the `shop` eszip ≤ 20 MB) is #35's measurement.

Build times (4 vCPU, empty `target/`, prebuilt V8 downloaded):

| Build | Time |
| --- | --- |
| `make rust-check` (whole workspace, `cargo check` + clippy) | 4 min 56 s |
| `cargo test --release -p renox-runtime --test dispatch` (release build of all of `deno_runtime`, then the test) | 11 min 2 s |
