# Supabase Edge Runtime spike: notes (issue #3)

Status: **partial, not run.** The scripts are written. In the batch B session the
sandbox's permission policy refused to build and execute the upstream
checkout ("code from external"). So the build time, binary size, startup time,
and smoke result below are still open. Everything else here comes from reading
the pinned source.

## Location

The issue asks for `bench/spike/edge-runtime/`. That path cannot hold a
non-crate directory: the root `Cargo.toml` has `members = ["bench/spike/*"]`,
and a matched directory without a `Cargo.toml` breaks every `cargo` command
("failed to load manifest for workspace member"). The spike lives in
`bench/edge-runtime/` instead.

For the same reason, the upstream checkout and its `target/` live outside the
repository, in `$EDGE_RUNTIME_HOME` (default `~/.cache/renox/edge-runtime/<tag>`).
An in-tree Deno checkout would also be picked up by the bench `tsc` check
(`include: **/*.ts`) and by `bun test`.

## Pinned version

`VERSION`: `v1.77.8` = `9198a5179776a7ceb8deb40cc3ea415f5f92cacd`, the latest
release tag on 2026-10-27. `run.sh` refuses a checkout at any other commit.

| Item | Value (from upstream `Cargo.toml` / `rust-toolchain.toml`) |
| --- | --- |
| Rust toolchain | 1.98.0 (upstream's own `rust-toolchain.toml`; rustup installs it inside the checkout, independent of ours at 1.99.1) |
| `deno_core` | 0.324.0, patched to `supabase/deno_core` branch `324-supabase` |
| `v8` (rusty_v8) | `supabase/rusty_v8` tag `v130.0.7-patch.1` (crates.io `v8` 130.0.7 plus patches) |
| Prebuilt V8 | `.cargo/config.toml` sets `RUSTY_V8_MIRROR = https://github.com/supabase/rusty_v8/releases/download`; `run.sh` unsets `V8_FROM_SOURCE` |
| System packages (upstream Dockerfile) | `clang`, `libclang-dev`, `llvm-dev`, `cmake`, `libopenblas-dev`/`libblas-dev`/`liblapack-dev` (for the `ai` extension), `libssl-dev` |

## Build and run (to be measured)

| Measurement | Value |
| --- | --- |
| Cold build (`run.sh --build-only`, empty `target/`) | not measured |
| Warm build (no changes) | not measured |
| Release binary size (`target/release/edge-runtime`) | not measured |
| Startup to ready (`smoke.sh`, `startup_ms`) | not measured |
| Downloads V8 source? | expected no (prebuilt mirror above); not verified |

To fill in: `time bench/edge-runtime/run.sh --build-only` twice, `ls -l` the
binary, `bench/edge-runtime/smoke.sh` twice.

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
(`oneshot` terminates the worker after one request: the eviction mechanism for
B4), `--max-parallelism`, `--graceful-exit-timeout`,
`--dispatch-beforeunload-{wall-clock,cpu,memory}-ratio`.

## Observing worker memory

- `EdgeRuntime.userWorkers.memStats()` (main worker only): a map from worker UUID
  to V8 heap statistics plus the service path (`WorkerHeapStatisticsWithServicePath`).
- `EdgeRuntime.getRuntimeMetrics()`: main and event worker heap statistics, plus
  `activeUserWorkersCount`, `retiredUserWorkersCount`, `receivedRequestsCount`, `handledRequestsCount`.
- Both are exposed by `main/index.ts` at `GET /_renox/metrics`.
- Process level: all workers are threads of one `edge-runtime` process, so B1
  reads `VmRSS` from `/proc/<pid>/status` and `Pss` from `/proc/<pid>/smaps_rollup`
  of the PID that `run.sh --background` prints.

## Patches

None.
