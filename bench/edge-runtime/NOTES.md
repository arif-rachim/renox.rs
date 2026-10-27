# Supabase Edge Runtime spike: notes (issue #3)

Status: **run.** The runtime serves `examples/hello` and `examples/npm-compat`
through `bench/edge-runtime/main`, and B1, B4, B5 and B17 ran against it
(`bench/results/2026-10-27-B*.md`). Two modes exist: `--mode docker` (the
pinned upstream image; what every measurement in this repository used so far)
and `--mode source` (clone and build upstream; the build itself could not be
finished on the machine used, see "Build").

## Location

The issue asks for `bench/spike/edge-runtime/`. That path cannot hold a
non-crate directory: the root `Cargo.toml` has `members = ["bench/spike/*"]`,
and a matched directory without a `Cargo.toml` breaks every `cargo` command
("failed to load manifest for workspace member"). The spike lives in
`bench/edge-runtime/` instead.

The upstream checkout, its `target/`, the pulled image's containers, and the
staged apps live outside the repository, in `$EDGE_RUNTIME_HOME` (default
`~/.cache/renox/edge-runtime/<tag>`). An in-tree Deno checkout would be picked
up by the bench `tsc` check (`include: **/*.ts`) and by `bun test`.

## The root `package.json` trap

Serving an example app straight from `examples/<app>/_spike` makes Deno find
the repository's root `package.json` (Bun workspaces) above it and initialise
npm and workspace resolution for **every** user worker. Measured with the
hello worker (Docker mode, VmRSS of the runtime process, 5 s settle):

| App layout | RSS per hello worker | Cold start per fresh worker (HTTP) |
| --- | --- | --- |
| Served from inside the monorepo | ~56 MB | p50 ~310 ms |
| Served from a staged copy with no `package.json` above it | ~9.6–10.2 MB | p50 ~27 ms |

So `run.sh` stages every app that has a `_spike/` into `$EDGE_RUNTIME_HOME/apps/<app>`
(no monorepo files above it) and installs the app's own dependencies there
(`bun install`, or `npm install` when Bun is absent), on every start and with
`--stage`. Benchmarks must never point the runtime at `examples/` directly. A
production tenant bundle (eszip, D19) will not carry a `package.json`, so this
is a layout artefact of the monorepo, not a runtime property, but it is a
real trap for anyone running the spike by hand.

## Pinned version

`VERSION`: `v1.77.8` = `9198a5179776a7ceb8deb40cc3ea415f5f92cacd`, the latest
release tag on 2026-10-27. `run.sh` refuses a source checkout at any other
commit; Docker mode pulls `public.ecr.aws/supabase/edge-runtime:v1.77.8`.

| Item | Value (from upstream `Cargo.toml` / `rust-toolchain.toml` / the image) |
| --- | --- |
| Rust toolchain | 1.98.0 (upstream's own `rust-toolchain.toml`; rustup installs it inside the checkout, independent of ours at 1.99.1) |
| `deno_core` | 0.324.0, patched to `supabase/deno_core` branch `324-supabase` |
| `v8` (rusty_v8) | `supabase/rusty_v8` tag `v130.0.7-patch.1` (crates.io `v8` 130.0.7 plus patches) |
| Deno in the image | `deno 2.1.4` (`edge-runtime --version`) |
| Prebuilt V8 | `.cargo/config.toml` sets `RUSTY_V8_MIRROR = https://github.com/supabase/rusty_v8/releases/download`; `run.sh` unsets `V8_FROM_SOURCE` |
| System packages (upstream Dockerfile) | `cmake`, `clang`, `libclang-dev`, `llvm-dev`, `libssl-dev`, and `libopenblas-dev`/`libblas-dev`/`liblapack-dev` for the `ai` extension |
| Image | 1.14 GB; `/usr/local/bin/edge-runtime` 159 MiB (166,840,560 bytes); runs as root inside the container |

## Build

| Measurement | Value |
| --- | --- |
| Cold build, attempt 1 (`run.sh --mode source --build-only`, no `cmake` on the machine) | failed after 2 min 16 s in `libz-sys` ("is `cmake` not installed?") |
| Cold build, attempt 2 (prebuilt `cmake` 3.31.6 on `PATH`) | failed after 1 min 17 s in `openssl-sys` (no OpenSSL headers: `libssl-dev`) |
| Downloads V8 source? | **No.** `v8 v130.0.7` compiled in both attempts within seconds (180 crates in 77 s in attempt 2), which is only possible with the prebuilt static library from the mirror; a source build of V8 takes 30–60 minutes |
| Warm build | not measured (no successful cold build) |
| Release binary size (own build) | not measured; the upstream image's binary is 159 MiB |
| Docker image pull | 1.14 GB, already cached on the measurement machine |

The machine used has no `sudo`, so the system packages from the upstream
Dockerfile could not be installed, and the source build stops at the first
`-sys` crate that needs them. On a clean machine with those packages the same
`run.sh --mode source` is expected to finish; that remains **unverified**.
Everything measured in this repository so far used `--mode docker`, which is
the same tag, built by upstream's CI from the same `Dockerfile`.

## Startup

`smoke.sh --mode docker`, startup to `/_renox/health` ready, then `GET /` →
`{"ok":true}` from `examples/hello`:

| Run | `startup_ms` |
| --- | --- |
| 1 (staging `bun install` of npm-compat included, image cached) | 7,404 |
| 2 | 1,805 |

The first request to a cold user worker takes ~1.3 s (module graph of the
app); later requests to the same worker 2–3 ms through Docker's port mapping.

## Per-worker limit options

`EdgeRuntime.userWorkers.create(options)`, from `ext/workers/lib.rs`
`UserWorkerCreateOptions` (serde camelCase) and `ext/workers/user_workers.js`:

| Option | Meaning | Used in `main/index.ts` |
| --- | --- | --- |
| `memoryLimitMb` | V8 heap limit for the worker | 128 |
| `lowMemoryMultiplier` | When V8 nears the heap limit, the limit is raised by this factor while the supervisor terminates the worker, so a V8 OOM does not kill the whole process | 5 |
| `workerTimeoutMs` | Wall-clock lifetime of the worker | 300000 |
| `cpuTimeSoftLimitMs` | CPU time after which the worker is retired (no new requests) | 1000 |
| `cpuTimeHardLimitMs` | CPU time after which the worker is terminated | 2000 |
| `forceCreate` | Create a new worker even if one exists for the service path | true when `__worker` is given |
| `poolKey` | Key that groups workers in the pool | not used |
| `servicePath`, `maybeEszip`, `maybeEntrypoint`, `maybeModuleCode` | Where the code comes from | `servicePath` |
| `envVars` | Environment visible to the worker | `[]` (no host env, no secrets) |
| `noModuleCache`, `noNpm`, `allowRemoteModules`, `customModuleRoot` | Module loading | defaults |
| `permissions` | Deno permissions: `allowNet`/`denyNet`, `allowRead`, `allowEnv`, ... | not used yet (F1 `fetch` allowlist) |
| `s3FsConfig`, `tmpFsConfig`, `staticPatterns` | File system | not used |
| `otelConfig`, `traceRateLimitOptions`, `context` | Telemetry and misc | not used |

Not available as a per-worker option: a network egress byte limit, a per-request
deadline separate from `workerTimeoutMs`, and a request-count limit. Request
idle timeouts are process-wide flags (`--user-worker-request-idle-timeout`,
`--request-wait-timeout`), not per worker.

Process-wide pool flags of `edge-runtime start`: `--policy per_worker|per_request|oneshot`
(`oneshot` terminates the worker after one request: the eviction mechanism B4
uses; verified through `retiredUserWorkersCount`), `--max-parallelism`,
`--graceful-exit-timeout`, `--dispatch-beforeunload-{wall-clock,cpu,memory}-ratio`.

## Main service

`main/index.ts` follows upstream `examples/main/index.ts`. Two things learned
by running it:

- A request cloned with `new Request(url, req)` must be tagged with
  `EdgeRuntime.applySupabaseTag(req, cloned)` before `worker.fetch()`, or the
  worker fails with `TypeError: Cannot read properties of undefined (reading
  'streamRid')` and the runtime logs "Unable to find the supabase tag".
- Apps are addressed by `RENOX_APPS_DIR/<app>/_spike` (the staging directory),
  never by a path from the request. `__app` is checked against an allowlist.

## Observing worker memory

- `EdgeRuntime.userWorkers.memStats()` (main worker only): a map from worker UUID
  to V8 heap statistics plus the service path (`WorkerHeapStatisticsWithServicePath`).
- `EdgeRuntime.getRuntimeMetrics()`: main and event worker heap statistics, plus
  `activeUserWorkersCount`, `retiredUserWorkersCount`, `receivedRequestsCount`, `handledRequestsCount`.
- Both are exposed by `main/index.ts` at `GET /_renox/metrics`.
- Process level: all workers are threads of one `edge-runtime` process, so B1
  reads `VmRSS` from `/proc/<pid>/status` and `Pss` from `/proc/<pid>/smaps_rollup`.
  `run.sh --background` prints the host PID in both modes (`docker inspect` for
  the container); in Docker mode `smaps_rollup` is read through `docker exec`
  because the container process is root-owned. Helpers: `lib.ts`.

## Patches

None.
