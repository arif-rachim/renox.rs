# 14 — Benchmarks and targets

Every performance number in this documentation is a **target** until a result under `bench/results/` proves it. Benchmarks are the gate for F0 and F2 (`15-roadmap.md`) and the evidence for ADRs D3, D5, and D7.

## Reference hardware

| Profile | Spec | Purpose |
| --- | --- | --- |
| `node-small` | 4 vCPU, 8 GB RAM, NVMe, Linux 6.x | The production node we price against |
| `dev-laptop` | Whatever the developer has | Relative comparisons only; never used for pass/fail |

Record CPU model, kernel, and Rust/Bun/Deno versions in every result file. Pass/fail is judged on `node-small` only.

## Targets (SLOs)

| ID | Metric | Scenario | Target | Fail threshold (kill-criteria input) |
| --- | --- | --- | --- | --- |
| B1 | Memory per warm isolate | Example shop app loaded, idle | ≤ 10 MB RSS delta | > 20 MB |
| B2 | Memory per idle tenant | Isolate evicted, file closed | ≈ 0 MB (bookkeeping only) | > 1 MB |
| B3 | Density | Idle tenants per `node-small` with 1 GB headroom | ≥ 1,000 registered, ≥ 300 warm | < 100 warm |
| B4 | Cold start | Snapshot + eszip load + first request (hello function) | p50 ≤ 20 ms, p99 ≤ 100 ms | p99 > 100 ms |
| B5 | Hello function latency | Warm, in-node, `Response.json({ok:true})` | p50 ≤ 0.3 ms, p99 ≤ 2 ms | p99 > 5 ms |
| B6 | SSR medium page | 25 KB, 100 items, 5 queries, warm | p50 ≤ 3 ms, p99 ≤ 15 ms | p99 > 30 ms |
| B7 | Fragment render | One block, 1 query, 20 items | p50 ≤ 1 ms, p99 ≤ 5 ms | p99 > 10 ms |
| B8 | Render path A vs B | Same page: Rust render + marshaling vs template compiled to JS in the isolate | Decides D7; report both | — |
| B9 | Marshaling cost | 100 items × 10 fields V8 → `minijinja::Value` | ≤ 300 µs | > 1 ms |
| B10 | SQLite query | Point lookup by primary key, warm | ≤ 20 µs; 100-row scan ≤ 200 µs | — |
| B11 | Throughput | Hello function, 4 vCPU, keep-alive | ≥ 40k req/s | < 15k req/s |
| B12 | Noisy neighbor | Tenant A infinite loop + unbounded allocation while tenant B serves B6 | B's p99 changes ≤ 10%; A terminated at its CPU limit ± 5 ms | B's p99 changes > 25% |
| B13 | Template DoS | Nested loops 10k × 10k | Stops at fuel within 50 ms; node unaffected | Render exceeds 500 ms |
| B14 | Realtime | 10,000 idle WebSocket connections on one tenant (`bench/scenarios/B14`, `examples/chat`; dev container, debug build: `bench/results/2026-10-29-B14-dev-container.md`; `node-small` is O3, #158) | ≤ 50 MB total; isolate heap unchanged | > 150 MB |
| B15 | Deploy | `renox deploy` of the example app to a local control plane | ≤ 30 s end-to-end; rollback ≤ 5 s | > 60 s |
| B16 | Dev loop | Edit one template, browser updated | ≤ 300 ms | > 1 s |
| B17 | npm compatibility | Payment SDKs (Stripe, Checkout.com, Telr, PayTabs, Tabby), OAuth (arctic/oslo), WhatsApp Cloud API client, email (resend/nodemailer), zod, date-fns, Arabic-aware date/number formatting (Intl) | All run in the isolate with declared network allowlist | Any core package fails |
| B18 | Node failover | Kill a node; tenant on base tier recovers from Litestream | RTO ≤ 60 s, RPO ≤ 10 s | RPO > 60 s |
| B19 | Litestream overhead | Write-heavy tenant with replication on | ≤ 10% throughput loss | > 25% |
| B20 | Build/binary | `renox-worker` release build size and CI time | ≤ 100 MB; CI ≤ 15 min with cache | — |

## Scenarios

### Example applications (in `examples/`)

| App | Used by | Contents |
| --- | --- | --- |
| `hello` | B4, B5, B11 | One function returning JSON |
| `shop` | B1, B6, B7, B8, B9, B12, B16 | Products list (100 items), detail, cart action, search fragment; `auth` module installed |
| `chat` | B14 | One WebSocket room, HTML fragment broadcast |
| `evil` | B12, B13 | Infinite loop function, unbounded allocation function, nested-loop template, SSRF attempts |
| `npm-compat` | B17 | Imports each package from the compatibility list and exercises one call |

### Methodology

- Load generator: `oha` or `wrk` from a separate machine or a pinned core; keep-alive on; 30 s warm-up, 60 s measurement, 3 runs, report median of runs and p50/p99 within runs.
- Memory: RSS and V8 heap statistics sampled every second; report the steady-state value after 60 s.
- Cold start: evict the isolate explicitly between samples; 200 samples.
- Density: register N tenants, warm each once, let them go idle, measure RSS; then keep M warm with a 1 req/s trickle each.
- Noisy neighbor: run B6 for tenant B alone (baseline), then with tenant A's `evil` functions hammered at 50 req/s.
- All scenarios are scripted under `bench/` and runnable with one command (`bench/run.sh <id>`), so results are reproducible by agents.
- How to add a scenario and the `run.sh` contract: [`bench/scenarios/README.md`](../bench/scenarios/README.md).

### Baselines to compare against

Run the same `hello` and `shop` scenarios on Bun + Hono (process per app) and on Node + Hono, on the same hardware. The point is not to "win" but to confirm that the isolate path is within the expected envelope and to quantify density differences for `02-comparison.md`.

## Recording results

One file per run: `bench/results/YYYY-MM-DD-<id>-<short-desc>.md`:

```
# B6 — SSR medium page — 2026-11-15
Hardware: node-small (AMD EPYC 7B13, kernel 6.8), renox-worker <git sha>, deno_runtime <ver>, rustc <ver>
Scenario: examples/shop, GET /products, warm, oha -c 64 -z 60s
Result: p50 2.4 ms, p99 11.8 ms, 18,200 req/s, RSS 142 MB (cell) 
Target: p50 ≤ 3 ms, p99 ≤ 15 ms → PASS
Notes: ...
Raw: bench/results/raw/2026-11-15-B6.json
```

After a run that changes a target or decides an ADR, update the numbers in `00-overview.md`, `02-comparison.md`, and `13-decisions.md` in the same PR.

## F0 results (2026-10-27)

Measured on the `dev-laptop` profile (i7-6700, 8 vCPU, 15 GB) against the unmodified Supabase Edge Runtime `v1.77.8` image, apps staged outside the monorepo, without snapshot or eszip. Every verdict is therefore provisional; the `node-small` run comes with the real worker in F1 (#35).

| ID | Target | Fail threshold | Measured | Verdict | Result file |
| --- | --- | --- | --- | --- | --- |
| B1 `hello`, N = 100 | ≤ 10 MB | > 20 MB | 9.77 MB RSS delta per worker (PSS 9.76, V8 heap 9.16) | PROVISIONAL PASS | [B1](../bench/results/2026-10-27-B1-edge-runtime-hello-and-npm-compat.md) |
| B1 `npm-compat`, N = 50 | ≤ 10 MB | > 20 MB | 74.3 MB per worker (V8 heap 23.8; the rest is module code and npm resolution state for 41 packages) | PROVISIONAL FAIL | same file |
| B4 | p50 ≤ 20 ms, p99 ≤ 100 ms | p99 > 100 ms | p50 32.3 ms, p99 38.7 ms (worker evicted after every request, `oneshot`) | PROVISIONAL FAIL on p50, p99 inside the limit | [B4](../bench/results/2026-10-27-B4-cold-start-edge-runtime.md) |
| B9 | ≤ 300 µs | > 1 ms | 517 µs on the generic path (`JSON.stringify` → `serde_json::Value` → `minijinja::Value`); 248 µs only with a static Rust type, which loader data does not have | PROVISIONAL FAIL on target, inside the limit | [B9](../bench/results/2026-10-27-B9-marshal-v8-minijinja.md) |
| B17 | all packages run | any core package fails | 13 / 13 inside the isolate; cold first request 644 ms, warm 13 ms | PROVISIONAL PASS | [B17](../bench/results/2026-10-27-B17-npm-compat-in-isolate.md) |
| B6 first cut (render stage) | render + marshal ≤ 1 ms (derived) | — | page render 176 µs, fragment 169 µs, render + marshal 424 µs | PROVISIONAL PASS | [B6](../bench/results/2026-10-27-B6-first-cut-render-stage.md) |
| B5 (informational) | in-node p50 ≤ 0.3 ms | — | p50 0.66 ms, p99 1.23 ms over HTTP through Docker | informational | [B5](../bench/results/2026-10-27-B5-hello-warm-latency.md) |
| BASE-HELLO (informational) | — | — | Bun + Hono: 23 MB per process, start p50 18 ms, 53.8k req/s; Node + Hono: 79 MB, 134 ms, 23.5k req/s | informational | [BASE-HELLO](../bench/results/2026-10-27-BASE-HELLO-bun-node-hono.md) |

Decision of the F0 gate (#14): **GO to F1**, with B1 judged on `hello`. No kill criterion is hit on the numbers the criteria name (memory per isolate for the example app, cold start p99, B17). The open risk is the per-worker cost of npm dependencies (74 MB with the full B17 set); it is carried into F1 as a gate condition: B1 measured on the `shop` skeleton with its real dependencies, bundled as eszip, must be ≤ 20 MB at the F1 gate (#37), otherwise ADR D21 (Bun process per tenant for paid tiers) is written then. Two more findings change F1 and F2 work: B4 must be re-measured with the platform snapshot and eszip (the gap to the target is 12 ms), and the render op (#40) must marshal through a JSON string, not through `serde_v8` per property, because crossing the V8 API per property is what costs the time in B9.

## F1 results (2026-10-27; gate decided 2026-10-28)

Measured on `renox-worker` (the real data plane: `deno_runtime` 0.268 / V8 150 with the platform snapshot, `esm-dir` artifacts with shared vendor chunks, SQLite per tenant) on one 4 vCPU / 16 GB cloud container with the Bun load generator on the same machine, not on `node-small`. Every verdict is therefore **PROVISIONAL** until the `node-small` re-run with a separate load generator (#158). Gate report and evidence: #37.

| ID | Target | Fail threshold | Measured | Verdict | Result file |
| --- | --- | --- | --- | --- | --- |
| B1 `shop`, N = 100 | ≤ 10 MB | > 20 MB | 11.09 MB RSS per warm isolate (V8 heap 7.3 MB) with shared vendor chunks; 22.96 MB before #143. `hello` 7.39 MB | PROVISIONAL FAIL on target, inside the limit | [B1 shared chunks](../bench/results/2026-10-27-B1-shop-shared-chunks-renox-worker.md), [B1 before](../bench/results/2026-10-27-B1-shop-and-hello-renox-worker.md) |
| B2 | ≈ 0 MB per idle tenant | > 1 MB | 0.059 MB per idle tenant after `malloc_trim` (#144); 3.0 MB before | PROVISIONAL PASS | [B2 trim](../bench/results/2026-10-27-B2-idle-tenants-trim-renox-worker.md), [B2 before](../bench/results/2026-10-27-B2-idle-tenants-renox-worker.md) |
| B3 | ≥ 1,000 registered, ≥ 300 warm | < 100 warm | 1,000 / 1,000 registered, 0 failed cold first requests in 3,000; 997 warm extrapolated to `node-small` at 7.13 MB per warm tenant | PROVISIONAL PASS | [B3 cold failures](../bench/results/2026-10-27-B3-density-cold-failures-renox-worker.md), [B3 trim](../bench/results/2026-10-27-B3-density-trim-renox-worker.md), [B3](../bench/results/2026-10-27-B3-density-renox-worker.md) |
| B4 | p50 ≤ 20 ms, p99 ≤ 100 ms | p99 > 100 ms | p50 22.3 ms, p99 45.4 ms, 0 / 600 failed, with the platform snapshot, no eszip (31.5 / 55.6 before #145) | PROVISIONAL FAIL on p50, p99 inside the limit | [B4 H2](../bench/results/2026-10-27-B4-cold-start-h2-renox-worker.md), [B4](../bench/results/2026-10-27-B4-cold-start-renox-worker.md) |
| B5 | p50 ≤ 0.3 ms, p99 ≤ 2 ms | p99 > 5 ms | sequential on one keep-alive connection: p50 0.284 ms, p99 1.274 ms (an upper bound on the in-node figure); at 64 connections 3.0 / 8.2 ms (queueing on one isolate) | PROVISIONAL PASS | [B5](../bench/results/2026-10-27-B5-hello-latency-renox-worker.md) |
| B11 | ≥ 40k req/s | < 15k req/s | 21.1k req/s (18.9k before H2) with the Bun generator on the same 4 vCPUs | PROVISIONAL FAIL on target, inside the limit | [B11 H2](../bench/results/2026-10-27-B11-hello-throughput-h2-renox-worker.md), [B11](../bench/results/2026-10-27-B11-hello-throughput-renox-worker.md) |
| B12 | B p99 ≤ +10 %, A terminated within ± 5 ms | B p99 > +25 % | B p99 +0.35 % (−3.3 % in the first run), 0 failures caused by A; A's termination error 13.2 ms at p99; 16 spurious failures of B's own `shop` isolate in 3 of 4 sets (#155) | isolation PASS (provisional); precision FAIL; regression open | [B12 H2](../bench/results/2026-10-27-B12-noisy-neighbour-h2-renox-worker.md), [B12](../bench/results/2026-10-27-B12-noisy-neighbour-renox-worker.md) |
| B20 | binary ≤ 100 MB; CI ≤ 15 min | — | CI warm 9.7 min; binary size not measured (no release yet, #154) | CI PASS; size open | [B20](../bench/results/2026-10-27-B20-ci-time-sccache.md) |

Decision of the F1 gate (#37): **GO to F2 and F3 (in parallel)**, with conditions that are recorded as issues #152 to #164. No kill criterion is hit: the F0 thresholds re-checked on the worker give 11.09 MB per `shop` isolate (limit 20), cold start p99 45.4 ms (limit 100), and no B17 failure. The three F1 done criteria are met: two tenants run on one node (`crates/renox-cell/tests/two_tenants.rs`), a tenant with an infinite loop does not affect the other (B12), and meters are recorded (one record per request in the meter file).

The F0 gate condition (B1 on `shop` with its real dependencies ≤ 20 MB) was met at 11.09 MB, so **ADR D21 (Bun process per tenant) was not written**. One deviation: the condition said "bundled as eszip" and the number is `esm-dir` with shared vendor chunks, the format `renox build` deploys today; eszip with a V8 code cache is re-evaluated in #157.

Findings carried into F2: termination lands 10–13 ms late at p99 under host CPU saturation, not GC (contract wording #153, `node-small` re-run #158); a well-behaved tenant was charged 85 ms of CPU across two concurrent requests and recycled, the most important open finding (#155); one bad request ends every in-flight request of its deployment by design, which an isolate pool shrinks (#156); B4 p50 and B1 `shop` miss their targets by 2.3 ms and 1.1 MB (#157); B11 is half the target with one isolate per deployment and a co-located load generator (#156, #158); the worker binary reads Deno's snapshot sources from the cargo registry at start, so there is no release yet (#154).

## What F0 must prove

F0 is only about B1, B4, B9, B17, and a first cut of B6 using Supabase Edge Runtime unmodified plus a minijinja prototype. If any fail threshold is crossed, see the kill criteria in `01-business.md` and `15-roadmap.md` before writing platform code.
