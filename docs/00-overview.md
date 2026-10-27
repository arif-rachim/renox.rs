# 00 — Overview

## One paragraph

Renox is a multi-tenant hosting platform: tenants deploy web applications and functions written in TypeScript, and Renox runs them safely, densely, and cheaply. Tenant applications follow one model: HTML-first SSR (attribute templates + htmx), functions/APIs, modules assembled like Lego (auth, billing, admin), and data in SQLite, one file per tenant. The data plane is written in Rust because per-tenant sandboxing (V8 isolates with CPU, memory, and permission limits) is not available in any other runtime; the control plane is written in Bun because it is our own code, and development speed matters more there.

## What we expect from the platform

| Expectation | Measure | Target (see `14-benchmarks.md`) |
| --- | --- | --- |
| Density | Idle tenants per 8 GB node | ≥ 1,000 (isolate evicted, file closed) |
| Memory per active tenant | RSS of a warm isolate, example app | ≤ 10 MB (F0 measured 9.8 MB for a dependency-free app without snapshot; 74 MB with nine npm packages, to be fixed by bundling in F1) |
| Cold start | Snapshot → first request completed | p50 ≤ 20 ms, p99 ≤ 100 ms (F0 measured p50 32 ms, p99 39 ms without snapshot or eszip) |
| SSR latency | Medium page (25 KB, 100 items, 5 queries), warm | p50 ≤ 3 ms, p99 ≤ 15 ms inside the node |
| Fragment latency | One block, 1 query | p50 ≤ 1 ms |
| Isolation | A tenant with an infinite loop or unbounded allocation | Other tenants unaffected; the offending request is terminated at its limit |
| Deploy | `renox deploy` → live | ≤ 30 s; rollback ≤ 5 s |
| Dev loop | Save → browser updated | ≤ 300 ms |
| Reliability | Node dies | Tenants recover on another node; RPO ≤ 10 s (base tier), ≈ 0 (replica tier) |
| Billing | Per-request metering | 100% of requests recorded; hourly aggregation |

## What Renox is NOT

- Not a framework meant to be used without Renox hosting (although `renox dev` runs locally). The value is hosting + modules.
- Not a Next.js replacement for large React teams. Renox fills the gap "complete business apps, assembled from modules, run cheaply".
- Not a general-purpose JavaScript runtime. Only the supported application patterns (pages, functions, ws, modules).
- Not a multi-region managed database. One region (UAE) at the start; GCC expansion is designed for but not scheduled (`21-uae-gcc-strategy.md`).

## Design principles

1. **Density and isolation first.** Every decision is tested against these two numbers.
2. **Use what exists.** Runtime, template engine, parser, policy engine, and SQLite come from the ecosystem. Our value is assembly, conventions, and modules.
3. **Limits are enforced in Rust.** JavaScript conventions are not a safeguard.
4. **Convention over configuration.** Folder structure = URL structure; small manifests; configuration only as an escape hatch.
5. **HTML-first.** The server sends HTML; the browser swaps fragments. SPA is not the default.
6. **Claims must be measured.** Performance numbers without benchmarks are written as targets.
7. **Dogfooding.** The control plane dashboard and at least two real products run on Renox.

## Status and how to contribute

Phase F0 (spike). There is no platform code. See `15-roadmap.md` for the order of work and `14-benchmarks.md` for what must be proven first. Agent rules are in `AGENTS.md`.

## Document history

- v1 (Oct 2026): Rust framework + raw `deno_core` + Postgres schema per module + RLS. Stress-tested with a critical review.
- v2 (Oct 2026): goal clarified as a hosting platform; runtime on top of Supabase Edge Runtime; Bun control plane; SQLite per tenant; templates compiled to minijinja. This documentation set is v2, split by topic for agents.
