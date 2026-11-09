# B1 — Where the `shop` isolate RSS grew from 7.3 to 11.9 MB (#457) — 2026-11-09

Hardware: dev-laptop (session container: Intel(R) Xeon(R) Processor @ 2.30GHz, 4 vCPU, 16 GB RAM, Linux 6.18.44-fc-v310), rustc 1.99.1, bun 1.4.4, glibc malloc.

Raw data:
- `bench/results/raw/2026-11-09-B1-rss-bisect-457.json`: every B1 summary and every mapping breakdown, with the host.
- `bench/rss-bisect/steps.tsv`: one line per measured commit.

Scripts, in `bench/rss-bisect/`:
- `measure.sh`: one B1 step.
- `bisect.sh`: the value bisect.
- `regions.sh`: #343's mapping breakdown, plus the variants below.
- `trim.ts`: `malloc_trim` through gdb.

## Method

**Provisional (D31).** Every number here was measured in a cloud session container, not on `node-small`. RSS does not depend on the host: #343 measured dddd743 at 7.32 MB on `node-small`, and it gives 7.34 MB here. These are relative comparisons, never a gate.

**Per commit:**
- `measure.sh <commit>` builds that commit's worker: `CARGO_PROFILE_RELEASE_DEBUG=0 cargo build --release --locked -p renox-cell --bin renox-worker`, with the verified `rusty_v8` 150.4.0 archive and one target dir shared by every step.
- It runs B1 on `shop` at N = 100 (median of 3 runs) from a worktree of that commit, with HEAD's `bench/` copied over it.
- B1 builds the commit's own `shop` artifact with the commit's own CLI.
- `worker.toml` gets `[tiers.free] cpu_ms = 1000` through the new `BENCH_WORKER_EXTRA_TOML` hook (`bench/lib/worker.sh`). This keeps host stalls from refusing a cold request (#342). It does not change the heap cap.

**Bisect:**
- `bisect.sh dddd743 7e84c8e 12` works on the 32 first-parent commits.
- A range whose two ends differ by more than 0.5 MB is split at its midpoint, and both halves are queued, largest difference first.
- A range of one first-parent commit (one merged PR) is final.

**The upper anchor is 7e84c8e, the commit #343 measured at 11.89 MB.** It is not today's `main`. Today's `main` (58a4baf) was measured once as well, at 11.96 MB.

**Breakdown:** `regions.sh <commit>` runs the `regions.ts` script of #343 (stored in `bench/results/raw/2026-11-01-B1-node-small-rss-343.json`), with its harness import pointed at this repo's `bench/scenarios/B11/harness.ts`. It takes the median of 3 runs per kind of mapping. Two variants split the worker's share from the app's:
- `APP=hello`: the app with no modules.
- `APP_FROM=<older>`: a commit's worker and CLI serving the `shop` and `modules/` of an older commit.

## Steps

| Commit | First-parent # | PR | RSS / isolate | PSS | V8 heap |
| --- | --- | --- | --- | --- | --- |
| dddd743 | 0 | (anchor; known 7.32) | **7.34 MB** | 7.34 | 4.25 |
| 90bf182 | 4 | #298 | 7.30 | 7.30 | 4.25 |
| c9d63cc | 5 | #299 | 7.35 | 7.35 | 4.25 |
| f673ca8 | 6 | **#301** | 9.17 | 9.17 | 4.13 |
| 22c1873 | 8 | #313 | 9.15 | 9.15 | 4.13 |
| f11fadd | 12 | #339 | 9.16 | 9.16 | 4.12 |
| 1664c60 | 13 | **#340** | 10.09 | 10.09 | 4.17 |
| ea3695e | 14 | **#344** | 11.89 | 11.89 | 4.47 |
| 195ac6d | 16 | #341 | 11.89 | 11.89 | 4.47 |
| 7e84c8e | 32 | #369 (anchor; known 11.89) | **11.90 MB** | 11.90 | 4.47 |
| 58a4baf | (today's `main`, outside the bisect) | — | 11.96 | 11.96 | 4.50 |

**Anchors:** both are within ±0.3 MB of their known values (7.34 against 7.32; 11.90 against 11.89).

**Bisect:**
- 8 of the 12 budgeted measurements were used, and no range was left open.
- Every range without one of the three PRs below has ends within 0.05 MB of each other.
- The three PRs together add 4.55 MB of the 4.56 MB.

## Commits that add more than 0.5 MB

All values are MB per isolate. The shop numbers are `regions.sh` medians (their totals differ from B1 by at most 0.02 MB).

**How to read the columns:**
- "malloc side" is glibc arenas plus "other anonymous".
- #343 found that "other anonymous" also holds the V8 heap pages outside the cage reservation. The split between those two kinds moves by up to 0.5 MB between runs of the same build, but their sum is stable.
- The V8 heap column is the meter's `peak_heap_bytes`.

| PR (merge) | Adds | malloc side (arenas + other anon) | V8 cage | V8 heap (meter) | `hello` (no modules) | Worker or app |
| --- | --- | --- | --- | --- | --- | --- |
| #301 (f673ca8) | **+1.82** | +1.56 (arenas +1.01, anon +0.55) | +0.18 | −0.12 | +0.15 | **mostly the app** (see below) |
| #340 (1664c60) | **+0.92** | +0.94 (arenas +0.87, anon +0.07) | +0.07 | +0.05 | +0.16 | **the worker**: same artifact |
| #344 (ea3695e) | **+1.82** | +1.59 (arenas +0.88, anon +0.71) | +0.07 | +0.30 | −0.01 | **the app**: six more modules |

The other kinds of mapping (worker binary pages, `[heap]`, V8 code, thread stacks) move by less than 0.05 MB per step. The isolate still has 3 threads per tenant at every step.

### #301: batch F5-ALL (authorization, realtime, five F5 modules)

**What changed:**
- The platform gained Cedar authorization (`renox-authz`, `op_authz_*`, `ctx.authz`, the principal cache) and WebSocket/SSE realtime (`renox-realtime`, `op_realtime_*`).
- `examples/shop` installs three more modules: `twofa`, `audit` and `notifications`. Its `auth` is configured with `phone_login` and `passkeys`, which brings second-phase `auth` code. The shop also gained `[authz]` with ownership, entities and roles.

**What allocates:**
- **Platform part:** `hello`, which has no modules, grows only +0.15 MB. So the platform adds little per isolate.
- **Module part:** the remaining ≈ +1.7 MB sits on the malloc side (+1.56) and in the cage (+0.18). The V8 heap even shrinks (−0.12).
- **Why the module part is per module:** every installed module's `services` and `hooks` entries are evaluated eagerly in every isolate (`crates/renox-runtime/src/manifest.rs`, `is_eager`; `isolate.rs`, `load_modules`). Each one is parsed and compiled by V8 on the isolate thread. Its compiler and bytecode memory is allocated off the JS heap, so it shows up in that thread's malloc arena.
- **Live, not retained:** `malloc_trim(0)` called in the warm worker through gdb frees nothing, either at dddd743 (7.32 → 7.39 MB) or at ea3695e (11.89 → 11.92 MB).

**Not split exactly:** neither cross run works. F5's worker cannot build the pre-F5 `modules/` (their Cedar policies use the pre-namespace entity types the F5 CLI rejects). It cannot build the pre-F5 `shop` with F5's modules either (`MF12`: `renox.lock` approved other permissions).

**Verdict: avoidable for the most part.** The modules a `GET /api/products` does not touch (`twofa`, `audit`, `notifications`) are still evaluated in every isolate.

### #340: batch F67-ALL (F6 tail, F7 ops)

**What changed:**
- F7 added `op_storage_*` and `/_img`, `op_webhook_verify`, `op_ai_chat` and `op_render_pdf`.
- F7-13 added `isolate` mode for marketplace modules, and F6-24 the jobs scheduler. F6-22 added OTel spans.
- `bootstrap.js` grew by 553 lines.
- The `shop` app did not change: the CLIs of f11fadd and 1664c60 build the same artifact hash, `c927216a…`.

**What allocates:**
- **Worker only:** the 1664c60 worker serving f11fadd's `shop` and `modules/` gives 10.11 MB, the same as 1664c60 itself. So the +0.92 MB is the worker's.
- **Mostly per module:** `hello` grows only +0.16 MB, so ≈ +0.75 MB of the worker's growth scales with the modules of the app. It is live malloc memory on the isolate thread (arenas +0.87) and not V8 heap (+0.05).
- **Candidates, read from the diff and not measured one by one.** This PR added per-module work that runs once per isolate in `create_worker` (`crates/renox-runtime/src/isolate.rs`):
  - the module list re-serialised with a `local` flag for `harden`;
  - a `StorageEnv` with each module's allowed types;
  - `AiEnv`, `PdfEnv` and `WebhookEnv`;
  - the shared/isolated owner split of the event handlers.

  It also added the new `ctx` members (`storage`, `ai`, `pdf`, `jobs`) wired per registered module in `crates/renox-runtime/src/js/bootstrap.js` (+553 lines).
- **Unknown:** this file does not name the allocation site. A heap profile of the two workers (heaptrack, or `MALLOC_TRACE`) would.

**Verdict: avoidable.** These structures are per deployment by nature (the manifest and the module list do not change between isolates). Built once and shared through `Arc`, or built lazily on a module's first service call, they would not be paid per isolate.

### #344: batch F67-B (F7 remainder, modules installed on the shop)

**What changed:**
- The worker change is 37 lines in `crates/renox-runtime/src/manifest.rs`.
- `examples/shop/renox.toml` installs six more modules: `email`, `billing`, `tax_gcc`, `storage`, `reports` and `admin`.

**What allocates:**
- **App only:** the ea3695e worker serving 1664c60's `shop` and `modules/` gives 10.08 MB, the same as 1664c60. So all +1.82 MB comes from the app.
- **About 0.3 MB per installed module:** split between the malloc side (+1.59) and the V8 heap (+0.30). `hello` does not move (−0.01).
- **Mechanism:** the same as #301. Each module's eager `services` and `hooks` entries are evaluated in every isolate. `GET /api/products` uses none of the six.

**Verdict: avoidable.** It is per isolate by design today (ops 1.4.0 kept services and hooks eager, #265), but not by necessity.

## What this means for B1

- **Shop vs hello, by step:**
  - c9d63cc (B1 equal to dddd743): `shop` (3 modules) is 1.0 MB above `hello`.
  - ea3695e: `shop` (12 modules) is 5.25 MB above `hello`.
- **Where the rest goes:** the platform without modules adds 0.3 MB from c9d63cc to ea3695e (`hello` 6.35 → 6.64 MB).
- **The B1 target (≤ 10 MB) is missed because of the number of modules evaluated per isolate,** not because of a host or allocator effect (#343).

## Proposed fixes

One issue per fix is to be filed afterwards. None is implemented here: `crates/**` is out of scope.

1. **Evaluate a module's `services` and `hooks` entries lazily, on the first call into that module in the isolate.** Expected gain: most of the ≈ 4.2 MB that modules add over dddd743. Keep eager evaluation for modules whose hooks run on every request (`auth.principal`), or make "eager" a per-module manifest flag that defaults to lazy.
   - **Files:**
     - `crates/renox-runtime/src/manifest.rs` (`is_eager`);
     - `crates/renox-runtime/src/isolate.rs` (`create_worker`, `load_modules`, the service and hook dispatch);
     - `crates/renox-runtime/src/js/bootstrap.js` (registering a module before its code is evaluated);
     - `cli/` (`renox build`, the `eager` flags);
     - `docs/contracts/` (ops: when a module's code is evaluated).
   - **Tests:** the `lazy_routes` tests show the pattern, and the code cache already serves lazy entries.
2. **Find and share #340's per-module, per-isolate state (≈ 0.75 MB at 12 modules).**
   - **First step:** take a heap profile of the 1664c60 and f11fadd workers on the same artifact.
   - **Fix:** build the per-deployment parts once and share them through `Arc` in `Pool::new`: the module list text for `harden`, `StorageEnv.allowed`, the per-module `ctx` objects of `bootstrap.js`, and the AI, PDF and webhook envs.
   - **Files:** `crates/renox-runtime/src/isolate.rs` (`create_worker`, `Pool::new`), `crates/renox-runtime/src/js/bootstrap.js`, `crates/renox-runtime/src/ops/{storage,ai,pdf,webhook}.rs`.
3. **Optional: build the per-module `ctx` facades in `bootstrap.js` on first property access.** This covers the part of item 2 that is in JS. It also helps the V8 heap share of #344 (+0.30 MB). Files: `crates/renox-runtime/src/js/bootstrap.js`.

**Not causes:**
- the allocator: `malloc_trim` frees nothing here, and #343's arena and threshold settings changed nothing;
- the thread count: 3 per isolate at every step;
- the worker binary: +0.06 MB of touched pages from c9d63cc to ea3695e.

## Notes

- **The bench workers read their own source tree at run time.** A worker from a plain `cargo build --release` reads `crates/renox-runtime/src/js/bootstrap.js` by absolute path when it builds the platform snapshot, and panics with `ENOENT` once that checkout is gone. So `regions.sh` reuses `measure.sh`'s worktree path, and a cached worker only runs while its worktree exists. This affects only these bench builds: `release-worker.yml` builds with the `renox-runtime/packaged` feature, which embeds the snapshot sources.
- **What the per-step cost is:** each step is one release build, 9 to 12 minutes in this container with the shared target dir, plus a 1 to 2 minute run.
