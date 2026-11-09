# B1 — The per-deployment state #340 added to the `shop` isolate (#641) — 2026-11-09

Hardware: dev-laptop (session container: Intel(R) Xeon(R) Processor @ 2.30GHz, 4 vCPU, 16 GB RAM, Linux 6.18.44-fc-v310), rustc 1.99.1, bun 1.4.4, glibc malloc, heaptrack 1.5.0.

Raw data: `bench/results/raw/2026-11-09-B1-per-module-state-641.json` (the host, the heaptrack site tables and both B1 summaries).

Scripts, in `bench/rss-bisect/`:
- `heaptrack.sh <commit> [app]`: builds a profiling worker of `<commit>`, runs it under heaptrack with 100 tenants and writes the live bytes per call site.
- `heaptrack-sites.py diff <a.sites> <b.sites> 100`: the per-tenant difference between two commits, by call site.
- `heaptrack-run.ts`: the run itself (one request per tenant, then `SIGKILL`).

**Provisional (D31).** Measured in a cloud session container, not on `node-small`. These are relative comparisons, never a gate. `main`'s 11.97 MB here matches #457's 11.96 MB for today's `main`.

## Result

| `main` (b866c13) | this change | Gain |
| --- | --- | --- |
| `shop` N = 100: **11.97 MB** RSS per isolate (runs: 11.96, 11.97, 11.97) | **10.71 MB** (10.71, 10.71, 10.71) | **−1.26 MB** per isolate |
| `hello` N = 100: 6.71 MB (6.71, 6.70, 6.71) | 6.71 MB (6.71, 6.71, 6.71) | 0 |
| V8 heap (meter): `shop` 4.51, `hello` 4.19 | 4.51, 4.19 | 0 |

The Definition of Done asks for at least −0.5 MB on `shop` and `hello` unchanged or lower: both hold.

## Method

**Heap profile (task 1):**
- Two workers, of 1664c60 (#340) and of f11fadd (its parent), built for profiling: release, line tables, not stripped, no LTO, 16 codegen units. The allocation sites are those of the shipped build.
- Each commit's CLI builds the same `shop` artifact (hash `c927216a…`, #457).
- `heaptrack.sh` starts the worker under heaptrack's `LD_PRELOAD` library with 100 `shop` tenants through `bench/scenarios/B11/harness.ts`, sends `GET /api/products` once per tenant, waits 8 s, and kills the worker with `SIGKILL`. Heaptrack's "leaked" bytes are then the allocations live at that moment, the warm state B1 measures.
- Each stack is attributed to its deepest frame in renox code (crate name or source file), and the two commits are compared per tenant.

**B1 (task 4):** the issue's command, on `shop` and `hello` at N = 100, median of 3 runs, `[tiers.free] cpu_ms = 1000`:
- `main`: a release worker of b866c13, built and run from a worktree of that commit.
- This change: the same build of this branch.

## Where #340's memory went

Live malloc per `shop` tenant: **4.99 MB at 1664c60, 3.86 MB at f11fadd: +1.12 MB.** B1 measured +0.92 MB of RSS for the same step (#457).

| Call site (deepest renox frame, its caller) | 1664c60 | f11fadd | Δ per tenant |
| --- | --- | --- | --- |
| `minijinja` `make_owned_template` ← `PageRenderer::load` ← **`render::pdf_templates`** (`renox-cell`, `manager.rs` cell creation) | 2.03 | 1.02 | **+1.02** |
| `PageRenderer::load` itself (sources, i18n catalogs) | 0.20 | 0.10 | **+0.10** |
| the cell-creation future that holds it (`manager.rs`) | 0.07 | 0.07 | 0 (moved) |
| `isolate.rs` (`create_worker` and the isolate thread) | 0.65 | 0.65 | 0.00 |
| everything else | 2.04 | 2.03 | +0.01 |

**What the +1.12 MB is.** #340 gave the isolate a template slot for `ctx.pdf` (#322), later also used by `ctx.render` (#577). `pdf_templates` filled it by loading the artifact's templates into a second `PageRenderer`, beside the one the cell builds for its pages. Every template of the deployment was parsed and compiled by `minijinja` twice. `shop`'s templates (the app's and its modules') cost 1.0 MB compiled, and they were held twice.

**Why it looked per module.** `hello` has no templates, so it has no second renderer: its +0.16 MB of #457 is the rest of the worker. `shop`'s templates grow with its installed modules, so the cost scaled with them.

**Why it was not on the isolate thread.** The renderer is compiled during cell creation on the Tokio threads. Their glibc arenas are the same 64 MiB-aligned mappings that #457's "arenas" column counted. It is live state, so `malloc_trim` cannot free it.

## The candidates the issue named

Measured with the same profile, at 1664c60, per isolate:
- **The module list re-serialised for `harden`, `StorageEnv.allowed`, `AiEnv`, `PdfEnv` (now `TemplateEnv`), `WebhookEnv` and the owner split of the event handlers:** together less than 0.01 MB. This falls inside the `isolate.rs` row, which does not move between the two commits. They are a few small strings and maps per isolate. None of them reaches the issue's 0.1 MB threshold, so they keep their place in `create_worker`, unchanged.
- **The per-module `ctx` members of `bootstrap.js`:** they would show up as V8 heap. The meter's V8 heap moved by +0.05 MB at #340 (#457), and the heap profile shows no malloc growth on the isolate thread. They are out of scope here (#642), and `bootstrap.js` is not touched (#633).

## The change

- **One `PageRenderer` per deployment** (`crates/renox-cell/src/manager.rs`, `load_renderer`):
  - It is loaded once during cell creation, before the isolate spec, with the deployment hash, the client script and the deployment's authz slot.
  - The cell's pages, its realtime hub (realtime fragments, #281) and the isolate's template slot (`ctx.pdf`, `ctx.render`) hold the same `Arc`.
  - `load_pages` now only builds the web layer around it: the page guard, the rate-limit buckets and the V25 template-action check.
- **`render::pdf_templates`** wraps that `Arc` instead of loading the templates again.
- **What the documents render with:** `render_document` and `render_partial` read neither the deployment hash nor the client script. Those fields only go into a full page's shell. So `ctx.pdf` and `ctx.render` output is unchanged.
- **One behaviour change: missing i18n keys.**
  - Before: a missing key found by `ctx.render` or `ctx.pdf` went to the second renderer's list, which nothing drained.
  - Now: it is reported as an `i18n_missing` log line with the deployment's next page render, as realtime fragments already were.
- **A template error now fails cell creation earlier.** It still fails with V14, but before the isolate is created, where the cell creation error path releases the database as before. The old `pdf_templates` swallowed the error, and `load_pages` refused the artifact right after the isolate was built.
- **Test:** `pages_and_ctx_render_share_one_renderer` (`crates/renox-cell/tests/pages.rs`) serves a page and a `ctx.render` loader. It then checks through `CellManager::page_renderer_holders` that the deployment's renderer has exactly three holders (pages, realtime hub, template slot). Before this change, the template slot held a renderer of its own, and the count was two.

## Note: per deployment, not per isolate

In B1 each tenant has one deployment with one isolate, so "per isolate" and "per deployment" are the same number. `Pool::new` already shares its router, allowlist and module registry across the isolates of one deployment. The state found here sat outside the pool, in the cell, and it was built twice for one deployment.
