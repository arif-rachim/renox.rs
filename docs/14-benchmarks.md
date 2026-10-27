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
| B14 | Realtime | 10,000 idle WebSocket connections on one tenant | ≤ 50 MB total; isolate heap unchanged | > 150 MB |
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

## What F0 must prove

F0 is only about B1, B4, B9, B17, and a first cut of B6 using Supabase Edge Runtime unmodified plus a minijinja prototype. If any fail threshold is crossed, see the kill criteria in `01-business.md` and `15-roadmap.md` before writing platform code.
