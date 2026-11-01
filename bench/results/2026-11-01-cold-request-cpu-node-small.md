# Cold first request CPU on `node-small` (#342) — 2026-11-01

Hardware: node-small (AMD EPYC Processor (with IBPB), 4 vCPU, 8 GB RAM (7,941 MB), SSD (QEMU virtual disk), Ubuntu 24.04.5, Linux 6.8.0-147-generic; a KVM VPS whose host reports no steal time: `steal` in `/proc/stat` is 0), rustc 1.99.1, bun 1.4.4, `deno_runtime` 0.268, prebuilt `rusty_v8` 150.4.0.

Workers (all `renox-worker` release, `CARGO_PROFILE_RELEASE_DEBUG=0 cargo build --release --locked -j 3 -p renox-cell --bin renox-worker`, one build at a time):
- **baseline**: `main` 7e84c8e, unchanged.
- **fix**: 7e84c8e plus this branch's `[F2-45]` commit (the request-path warm-up, the per-request CPU trace, the test changes).
- **rejected variant**: the same warm-up plus one timer round-trip (below, "What the warm-up does not cover").

Tests: debug build of `renox-runtime` (`cargo test -p renox-runtime`), V8 prebuilt release.

## 1. The CI failure: `lazy_routes.rs`, `a_lazy_modules_top_level_runs_inside_its_first_request`

CI's Linux runner reported "first request charged 29.464 ms" (main 7e84c8e) against `>= 30`. The lazy module's top level spun on `Date.now()` for 40 ms of **wall** time.

| Run (7e84c8e, debug) | Runs | Failed | Charged when failing |
| --- | --- | --- | --- |
| the test alone, quiet host | 50 | 0 | — |
| the whole `lazy_routes` binary (tests in parallel), quiet host | 30 | 0 | — |
| the test alone, 4 CPU-bound shell loops on the 4 vCPUs (CI-like contention) | 30 | **26** (87 %) | 21.6–29.9 ms |

The per-request trace (`RUST_LOG=renox_runtime::cpu=debug`, below) shows that the charge is the thread's CPU, not an under-count. In a failing run the request was charged 27.58 ms, while the thread's own `getrusage(RUSAGE_THREAD)` over the request was 27.68 ms (user 21.67 + system 6.01). The wall time was 59.0 ms, with 12 involuntary context switches. In every traced request, quiet or contended, the charge and the thread's rusage agree within about 1 ms. A 40 ms wall-clock spin on a busy machine gets less than 30 ms of CPU, and the meter is right to say so.

**Fix (test only):** the top level now does a fixed amount of work (7 M iterations of an integer loop, about 40 ms here). The reference is the same work run by the handler in three later requests, and the lowest of the three is taken, so one host stall counted as CPU (section 3) cannot raise it. The assertion is `first >= 0.8 × reference`. If the top level's CPU were not charged to its request, the first request would be about 5 ms against about 40 ms, and the test would fail.

| Run (fix, debug) | Runs | Failed |
| --- | --- | --- |
| the test alone, quiet host | 50 + 50 | 0 |
| the whole binary, quiet host | 20 | 0 |
| the test alone, 4 CPU-bound loops | 30 + 20 | 0 |

## 2. What the cold request is charged for

Traced per request and per slice, with the thread's rusage, GC time from V8's GC prologue and epilogue, page faults and context switches. A probe of two trivial eager routes `/a` and `/b`, debug build, three fresh isolates, gave these charges:

| Isolate | `/a` first (cold) | `/b` first | `/a` again | `/b` again | `/a` third |
| --- | --- | --- | --- | --- | --- |
| 1 | 6.12 ms | 1.48 | 1.67 | 0.79 | 1.30 |
| 2 | 5.55 ms | 1.08 | 1.14 | 0.86 | 0.88 |
| 3 | 6.25 ms | 2.26 | 1.69 | 0.82 | 2.60 |

The first call of a *different* handler costs about what a warm request does. So about 4.5 ms of the cold request belongs to the isolate, not to the handler: it is V8's first run of the platform's request path (the bootstrap's `dispatch`, `Request`, `URL`, `Response`, the response ops). That is platform work of cell creation that every isolate's first request paid. In the same traces:

- GC was 0–2 ms (one scavenge at most).
- Page faults were about 400 minor and 0 major.
- The glue outside the tenant's async context ("shared", split onto the request) was 4–5 ms on the cold request and 0.3 ms on later ones.
- The code cache is not involved: a deployment's first isolate never reads it (#157).

The steal-time finding of O4 (`bench/results/2026-10-31-cold-request-cpu-node-small.md`, branch `batch/o4-host-f2`, never pushed) holds here too. The host does not report steal time, so a vCPU stall is counted as CPU of the thread that was running. Nothing inside the guest tells it from a spinning tenant.

First use of other globals, measured the same way (lowest of 3 fresh isolates, first request against the second):

| First use | First | Second |
| --- | --- | --- |
| none | 1.04 ms | 0.58 |
| **`setTimeout`** | **17.62 ms** | 1.40 |
| blocked `fetch` | 2.99 | 1.12 |
| streamed `Response` body | 3.20 | 0.84 |
| `crypto.subtle.digest`, `Request.json()`, `Blob`, `atob`, `Headers`, `TextEncoder`, `structuredClone`, `console.log`, `AbortSignal.timeout` | 1.0–1.9 | 0.5–1.3 |

## 3. Fix

**`warm_request_path` (`crates/renox-runtime/src/isolate.rs`, creation step 3b)** runs one request of the platform's own through the bootstrap's `dispatch` at isolate creation, under the module-evaluation limits:
- The handler is compiled by the platform. The request has no body and no principal.
- It runs after `harden` and before the tenant's modules are evaluated (step 4). The `auth` service is registered after those (step 5). So no tenant code exists in the isolate while this request's token is live.
- Its result is checked (`KIND_OK`, 200) and discarded. Its request ends through `end_request` like any other (resources drained). It is not metered and not logged.
- If it fails, the isolate still serves, with a warning.

**The allowance of O4 is not used.** Every request runs under the plain per-request limit, the first included, and is charged all of its CPU. `crates/renox-runtime/tests/cold_request_cpu.rs` has two tests:
- An infinite loop on a cold **lazy** route is stopped at 50–55 ms on the free tier (`docs/24-threat-model.md` B).
- A cold request is charged at most `2 × warm + 1.5 ms` (lowest of three isolates on each side). Without the warm-up this fails: cold 6.03 ms against warm 0.46 ms.

`crates/renox-runtime/tests/limits.rs` is unchanged. The per-request trace (O4's, kept):
- With `RUST_LOG=renox_runtime::cpu=debug`, every request ends with a `request cpu trace` line: charge, own and shared CPU, slices, GC time, the thread's user and system CPU, faults, and context switches.
- `trace` level adds one line per slice.
- At the default level it costs nothing.

| B1 cold first requests (`--runs 3`, 966 per attempt) | Charge p50 | p90 | p99 |
| --- | --- | --- | --- |
| baseline 7e84c8e, 3 attempts | 8.67–9.15 ms | 12.65–14.33 | 21.39–22.23 |
| fix, 3 attempts | **3.65–4.47 ms** | 5.96–7.19 | 11.31–14.02 |

Per-isolate memory of the fix is the baseline's: `shop` at N = 100 is 11.91–11.93 MB against 11.89–11.90 MB, and `hello` is 6.68 against 6.63–6.66.

## What the warm-up does not cover

- **The first timer.** The global `setTimeout` is lazy-loaded from `node:timers` (`deno_runtime` 0.268, `js/98_global_scope_shared.js`: `core.createLazyLoader("node:timers")`). Its first use costs about 17 ms of CPU and **2.7 MB of RSS per isolate**. A per-isolate RSS probe (30 isolates, debug) gave:
  - no warm-up: 6.12–6.22 MB, V8 heap 4.13 MB;
  - request path: 6.32–6.33 MB, heap 4.16 MB;
  - request path and a timer: 8.97–8.98 MB, heap 4.78 MB.

  B1 on a release worker with the timer in the warm-up gave `shop` 13.36 MB and `hello` 9.14 MB. That would charge every isolate 2.7 MB for a module most never use, so the warm-up leaves timers alone. The request that sets an isolate's first timer still pays the load.
  - This is why `limits.rs` `meter_fields_are_populated` fails on this host, before and after this change. Its idle request only awaits a 50 ms timer and is charged 18–27 ms against `< 15`.
  - Loading `node:timers` cheaply (in the snapshot, or the global timers from `ext:deno_web/02_timers.js`) is a runtime-globals change outside this issue.
- **Host stalls.** A stall longer than the gap to the limit still kills a request. That gap is now 46 ms of headroom on a 4 ms cold request, instead of 41 ms on a 9 ms one.

## Acceptance run: B1 `shop,hello --runs 3`, three attempts in a row

`bench/run.sh B1 --profile node-small --runs 3` (N = 1, 10, 50, 100), `BENCH_KEEP=1` so every meter record was read. The runs were detached and guarded (MemAvailable and disk logged every 5 s; stop below 1 GB or above 80 %), one at a time, on an otherwise quiet host.

| Worker | Attempt | Cold requests | `RENOX_CPU_LIMIT` | Charge p50 / p99 / max | Completed |
| --- | --- | --- | --- | --- | --- |
| baseline 7e84c8e | 1 | 966 | 0 | 8.86 / 21.39 / 31.22 ms | yes |
| baseline 7e84c8e | 2 | 966 | 0 | 8.67 / 22.23 / 47.17 ms | yes |
| baseline 7e84c8e | 3 | 966 | 0 | 9.15 / 21.51 / 43.63 ms | yes |
| rejected variant | 1 | 966 | 0 | 3.62 / 13.73 / 22.69 ms | yes |
| rejected variant | 2 | 362 | **1** | 4.33 / 19.25 / 50.99 ms | no |
| rejected variant | 3 | 966 | 0 | 3.73 / 13.21 / 30.24 ms | yes |
| **fix** | 1 | 966 | 0 | 3.81 / 14.02 / 39.22 ms | yes |
| **fix** | 2 | 966 | 0 | 3.65 / 11.31 / 46.67 ms | yes |
| **fix** | 3 | 500 | **1** | 4.47 / 13.18 / **82.16 ms** | no |

**Not met: B1 did not complete three times in a row on the fix.** Both kills are host stalls on requests whose own work is about 4 ms:
- `t_shop_78`, `01M6B5X33N57P7J854V82E6BK1`: charged 50.99 ms, wall 284 ms.
- `t_hello_3`, `01M6B8MGE0Y0XX5W54AAQKK2K1`: charged 82.16 ms, wall 125 ms. This is an eager route, so O4's allowance would not have applied either. It is also past the watchdog's 55 ms bound, so the isolate's vCPU was stalled through the limit.

The baseline completed three attempts today with no kill, but with charges up to 47.17 ms on a 9 ms request. The B1 criterion is decided by the host's stalls, on either worker. The cure is outside the worker: a host that reports steal time and a guest kernel that subtracts it (`CONFIG_PARAVIRT_TIME_ACCOUNTING`; this kernel lacks it).

Raw: `bench/results/raw/2026-11-01-cold-request-cpu-b1-meters.json` (every meter record of the nine attempts: request id, tenant, `cpu_ms`, `wall_ms`, status, peak heap); the B1 result files of the completed attempts `bench/results/raw/2026-11-01-B1-342-{baseline-attempt3,fix-attempt1,fix-attempt2,timer-variant-attempt1}.json` (`bench/run.sh` writes one file per day, so earlier attempts of a worker were overwritten; their memory lines are in the table above) and `2026-11-01-B1-342.hw.json`.

## Method and raw command lines

```
# reproduce the CI failure (debug test binary of 7e84c8e)
cargo test -j 3 -p renox-runtime --test lazy_routes --no-run
for i in $(seq 50); do target/debug/deps/lazy_routes-<hash> --exact a_lazy_modules_top_level_runs_inside_its_first_request; done        # quiet
for i in $(seq 30); do target/debug/deps/lazy_routes-<hash>; done                                                                      # whole binary
for c in 1 2 3 4; do (while :; do :; done) & done; for i in $(seq 30); do target/debug/deps/lazy_routes-<hash> --exact a_lazy_modules_top_level_runs_inside_its_first_request; done   # contended
# per-request trace in tests: the `request cpu trace` fields printed to stderr (a temporary eprintln, not committed)
# release workers, one build at a time
CARGO_PROFILE_RELEASE_DEBUG=0 cargo build --release --locked -j 3 -p renox-cell --bin renox-worker
# B1, three attempts in a row per worker, detached and guarded
BENCH_KEEP=1 RENOX_WORKER_PATH=<worker> bench/run.sh B1 --profile node-small --runs 3      # then cat /tmp/renox-bench-*/meters/*
```
