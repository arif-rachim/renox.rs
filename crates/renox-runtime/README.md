# renox-runtime

The data plane's JavaScript runtime (P1): V8 isolates on `deno_runtime`, one isolate per deployment, created from a platform snapshot; artifact loading (`docs/contracts/artifact.md`); request dispatch to the function handlers of the manifest; the `renox` op extension (`docs/contracts/ops.md`).

```
cargo test -p renox-runtime                          # everything, links V8
cargo test -p renox-runtime --no-default-features    # pure modules only, no V8
cargo test -p renox-runtime --test dispatch -- --nocapture   # prints creation time and memory
```

Public surface (issue #25):

```rust
let rt = Runtime::new(RuntimeConfig { log_sink });                       // once per process
let iso = rt.create_isolate(IsolateSpec { tenant_id, deployment_hash, artifact_dir, limits, secrets }).await?;
let Dispatched { response, meter } = iso.dispatch(RequestCtx { request_id, deadline }, http_request).await;
iso.terminate();
```

## Upstream consumption mode

**Decision: `deno_runtime` from crates.io as a library, with our own worker setup, not the `supabase/edge-runtime` crates.**

| | `supabase/edge-runtime` crates (`base`, `sb_*`) as git dependencies | `deno_runtime` directly (chosen) |
| --- | --- | --- |
| Library API | Built as a server binary; the public entry points start an HTTP server and a main/user worker supervisor, not "create an isolate, dispatch a request" | `MainWorker` with `WorkerOptions` / `WorkerServiceOptions`: extensions, snapshot, `CreateParams` (heap limit), module loader, permissions are all arguments |
| Our `renox` extension on user workers | Needs a patch (the user-worker extension list is fixed in `base`) | One entry in `WorkerOptions.extensions` |
| Patches to the V8 / `deno_core` forks | Their workspace `[patch.crates-io]` (Supabase's `deno_core` 0.324 branch and `rusty_v8` fork) does not apply to dependants; we would have to copy it into our root `Cargo.toml` and track it | None: crates.io `deno_core` 0.324 and `v8` 130.0.7 (the versions Supabase's forks are based on) |
| Build | Also pulls `ai` (onnxruntime, BLAS), S3 FS, their main-worker JS | `deno_runtime` and its extensions only |
| What we lose | Supabase's supervisor (per-worker CPU/memory accounting, pool policy) | Nothing we use: `ops.md` section 10 already rules out the per-worker cumulative limits; #26 implements per-request limits in Rust |

Versions are pinned to what the F0 spike ran (`bench/edge-runtime/NOTES.md`, Edge Runtime v1.77.8 = Deno 2.1.4): `deno_runtime = 0.191.0`, `deno_core = 0.324.0`, `v8 = 130.0.7`, `eszip = 0.80.0`. The `v8` crate downloads its prebuilt static library; nothing builds V8 from source (`docs/12-developer-experience.md`, rule 1).

Consequences recorded for the risk register (`docs/16-risks.md`, "Dependence on Supabase Edge Runtime"):

- **V8 130 is old** (Deno 2.1.4, December 2024). Supabase still ships it with their own patches; we use the crates.io build without those patches. Moving to a current `deno_runtime` is an upgrade of this crate only (the ops, the loader, and the bootstrap are ours) and is the first follow-up once F1 passes its gate.
- **Lockfile pins.** Current crates.io releases of some transitive dependencies no longer build against `deno_runtime` 0.191 (`serde` ≥ 1.0.220 removed `serde::__private`, which `swc_common` 0.37 uses; newer `deno_media_type`, `deno_graph`, `pem`). `Cargo.lock` was seeded from the `Cargo.lock` that `deno_runtime` 0.191.0 ships with, and `deno_media_type = 0.2.3`, `deno_graph = 0.86.3`, `pem = 3.0.4` were pinned. Do not run a bare `cargo update` on the workspace.
- **`v8` 130 and current rustc.** `v8` 130.0.7 builds a `&*ptr::null()` for an absent accessor setter; the debug-mode UB checks of rustc 1.99 abort on it during snapshot creation. The root `Cargo.toml` turns debug assertions off for the `v8` package only (`[profile.dev.package.v8]`). Release builds are unaffected.
- **Patches:** none.

## Platform snapshot

`Runtime::new` builds the V8 startup snapshot **once per process**: every `deno_runtime` extension plus the `renox` extension's ESM (`src/js/bootstrap.js`) are evaluated into it with `deno_runtime::snapshot::create_runtime_snapshot`, and every isolate starts from that blob, so isolate creation never re-evaluates the bootstrap JavaScript.

It is built at process start rather than in `build.rs` because a build-time snapshot needs `deno_runtime` as a build dependency as well, which compiles the whole Deno tree a second time for the host and roughly doubles a cold build (B20). The cost moves to process start (measured below, under one second) and is paid once per worker process, not per isolate. V8 is initialised in non-snapshotting mode before the snapshot is built, so the process does not run with `--predictable`.

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

The bootstrap's `dispatch` runs the handler with a frozen `ctx` (`req`, `url`, `params`, `headers`, `deadline`; `db`, `secrets`, `log` come with #28) inside a fresh async context carrying the request token. A handler that throws, or returns something that is not a `Response`, produces 500 `RENOX_INTERNAL` with the fixed message of `errors.md` and the request id; the error name, message, and stack go to the tenant log sink only.

**Request scope.** `ops.md` section 0 asks #25 to prove that the request token survives `await`, timers, and promise continuations (`tests/dispatch.rs`, `request_scope_follows_async_context`). It does: the token lives in a `deno_core` `AsyncVariable` (continuation-preserved embedder data), so concurrent requests on one isolate each see their own token, and the one-request-per-isolate fallback is not needed. A timer that fires after its request ended gets `RENOX_NO_REQUEST`. The bootstrap reads the token and passes it to each op as the first argument; the ops are captured in the bootstrap's closures and are unreachable from tenant code, so tenant code cannot supply a token of its own, and Rust refuses a token that is not live.

## Hidden globals

Applied by the bootstrap's `harden()` after `deno_runtime` has bootstrapped the global scope and before any tenant module is evaluated (`ops.md` section 11, step 2). Upstream exposes much more than a request handler needs; every item was decided:

| Global or capability | Decision | Why |
| --- | --- | --- |
| `Deno` (and with it `Deno.core`, the op table, `Deno.exit`, file, net, env, subprocess APIs) | Deleted | Platform internals; permissions deny the I/O anyway |
| `__bootstrap`, `bootstrap` | Deleted by `deno_runtime`; `__renoxInternal` deleted by us before tenant code runs | Hold the platform's functions |
| `SharedArrayBuffer` | Absent: V8 flag `--enable-sharedarraybuffer-per-context`, never enabled, and the global deleted | Spectre-class timers |
| `new WebAssembly.Memory({ shared: true })` | Throws `TypeError` | Would return a `SharedArrayBuffer`. **Gap:** a wasm module that declares its own shared memory can still produce one; with no `Worker` there is no second thread to build a timer from it. V8 130 has no embedder hook for this; revisit with the V8 upgrade |
| `performance.now()`, `performance.timeOrigin` | Whole milliseconds: `op_now` and `op_time_origin` are replaced by op middleware | `deno_web` keeps full resolution (`allow_hrtime` is always true in Deno 2.1) |
| `Worker`, `BroadcastChannel` | Deleted | `deno_runtime` panics when a web worker is created without a factory; one isolate per deployment |
| `close`, `closed`, `alert`, `confirm`, `prompt` | Deleted | `close()` ends the whole process; the others read stdin |
| `op_exit` | Replaced by a no-op through op middleware | Any path to it (`process.exit`, `Deno.exit`) would end the worker process with every tenant on it |
| `process` (Node global) | Deleted | `exit`, `env`, `stdin`, `cwd`, `memoryUsage`. npm code guards it with `typeof process` |
| `WebSocket`, `WebSocketStream`, `EventSource` | Deleted | Outbound connections that bypass `op_fetch` |
| `caches`, `localStorage`, `sessionStorage`, `indexedDB`, `Cache`, `CacheStorage`, `Storage` | Deleted | No persistence except `ctx.db` |
| `GPU*`, `navigator.gpu` | Deleted | Native GPU code paths |
| `navigator.hardwareConcurrency` | Always 1 | Do not reveal the host's CPU count |
| `Temporal`, `onload`, `onunload`, `onbeforeunload` | Deleted | Unstable or meaningless here |
| `node:` modules | Only `loader::NODE_ALLOWED` (compute-only) can be imported; `node:fs`, `net`, `http`, `https`, `dns`, `child_process`, `worker_threads`, `process`, `os`, `vm`, `v8`, `perf_hooks`, `inspector`, `tls`, `dgram`, `cluster`, `module`, ... are refused at resolution | Stricter than `ops.md` section 11 ("importable, every I/O call fails"): refusing at import fails closed even where a polyfill has an ungated op, and keeps `vm` (new contexts) and `perf_hooks` (timers) out |
| Deno permissions | `none_without_prompt()`: every permission denied | Defence in depth under the deletions above |
| Unhandled promise rejections | `preventDefault()` in an `unhandledrejection` listener | A stray promise in tenant code must not end the isolate's event loop |
| `eval`, `new Function`, `WebAssembly.compile` | Kept | npm packages need them; the code still runs under the isolate's limits |
| `fetch` | Deno's `fetch` (all network permissions denied) until #27 replaces it with `op_fetch` | — |
| `console` | Deno's console (stdout/stderr) until #28 replaces it with `op_log` | — |

## Thread model

One OS thread per isolate (`renox-isolate-<hash>`), each with a single-threaded Tokio runtime that owns the `MainWorker`. `IsolateHandle` talks to it over an unbounded channel; a dispatch is a message with a `oneshot` reply. The thread's loop polls the channel, the `deno_core` event loop, and the in-flight dispatch futures together, so many requests can be in flight on one isolate at once.

Why not upstream's worker pool: a V8 isolate is bound to the thread that runs it, `JsRuntime` is `!Send`, and the per-request CPU watchdog (#26) measures exactly this thread's CPU clock (`CLOCK_THREAD_CPUTIME_ID`); a pool that moves isolates between threads would break that accounting. Disposal happens on the isolate's own thread when its handle is dropped or terminated, so dropping or recycling an isolate never blocks a dispatch. The cost is one thread (and its stack) per live isolate; idle eviction (#29) bounds the count.

## Measurements

Machine: 4 vCPU cloud container (x86_64, Linux 6.18), Rust 1.99.1. Release profile unless noted. `tests/dispatch.rs`, `isolate_creation_time_and_memory_are_printed`, 30 isolates per format after one warm-up, each serving one request and kept alive.

| | `esm-dir` (`examples/hello` worked example) | `eszip` (same handler, two modules) |
| --- | --- | --- |
| Isolate creation p50 / p99, measured on the isolate thread (snapshot deserialisation, `deno_runtime` bootstrap, hardening, module evaluation, handler lookup) | 34.0 ms / 59.2 ms | 30.7 ms / 43.0 ms |
| Of which tenant module load + evaluation | 0.25 ms | 0.18 ms |
| `create_isolate` p50 / p99 (adds artifact verification: hash, schema) | 34.7 ms / 60.0 ms | 31.2 ms / 43.6 ms |
| V8 heap after the first request: used / total | 7.59 MB / 9.27 MB | 7.60 MB / 9.27 MB |
| Process RSS delta per live isolate (30 isolates) | 10.20 MB | 7.87 MB |

Platform snapshot: 7.6 MB, built in 0.73 s once per process (debug build: 10.0 MB, 0.87 s).

Reading against the targets (`docs/14-benchmarks.md`): B4 cold start p50 ≤ 20 ms is **missed** (about 31–35 ms, the same as the F0 spike's 32.3 ms for the upstream binary): the snapshot removes the bootstrap-JS evaluation, but most of the remaining time is `deno_runtime`'s per-worker setup (`MainWorker::bootstrap_from_options`: deserialising a 7.6 MB snapshot with every Deno extension, op registration, `bootstrapMainRuntime`). Module evaluation is under 0.3 ms, and an `eszip` loads slightly faster than an ESM directory. The obvious next levers are a smaller extension set in the snapshot (no WebGPU, KV, cron, FFI, NAPI, Node polyfills unless imported) and pre-created isolates (#29); they are left to the B4 benchmark and #29 rather than guessed here. Memory per hello isolate (8–10 MB RSS) is within B1's 10 MB target for `hello`; the F1 gate condition (the `shop` eszip ≤ 20 MB) is #35's measurement.

Build times (this crate with all of `deno_runtime`, `cargo build -p renox-runtime`, dev profile, 4 vCPU):

| Build | Time |
| --- | --- |
| Cold (empty `target/`, prebuilt V8 downloaded) | 8 min 25 s |
| Warm incremental (one source file of this crate touched) | 1.5 s for the library; 6.1 s including relinking the `dispatch` test binary |
