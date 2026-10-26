# AGENTS.md — Guide for agents working in the Renox repository

This file is the entry point for AI coding agents (Claude Code, Codex, Cursor, etc.) and for new humans.
Read it first, then `docs/` in the order below. Do not write code before you have read `docs/13-decisions.md`.

## What Renox is

Renox is a **multi-tenant hosting platform** for web applications and functions written in TypeScript.
Tenants (customers) deploy their code; Renox runs it safely, densely, and cheaply on our infrastructure.
Revenue comes from hosting fees. Two numbers decide the business: **density** (tenants per server) and **isolation** (tenants cannot interfere with or read each other).

One-line pitch: *"Assemble a SaaS from auth, billing, and admin modules, then deploy to hosting that charges only for what you use."*

Two main parts:

| Part | Language | Role |
| --- | --- | --- |
| **Data plane** | Rust | Runs tenant code in V8 isolates (built on Supabase Edge Runtime), SQLite per tenant, template rendering, realtime, metering |
| **Control plane** | TypeScript (Bun) | Deploy API, dashboard, billing, module registry, Postgres |

## Project status

**Phase: F0 (spike).** There is no platform code yet. This repository contains architecture documentation, the benchmark plan, and the roadmap.
The first code allowed in this repo is whatever `docs/14-benchmarks.md` needs to prove the F0 assumptions.
See `docs/15-roadmap.md` for done criteria per phase and kill criteria.

## Reading order

1. `docs/00-overview.md` — summary, principles, expectations.
2. `docs/01-business.md` — why we build this, who the users are, revenue model, success metrics.
3. `docs/02-comparison.md` — comparison matrices against other frameworks and platforms.
4. `docs/03-architecture.md` — control plane, data plane, components, request path.
5. `docs/04-isolation-security.md` — isolation model, per-tenant limits, threat model.
6. `docs/05-tenant-lifecycle.md` — deploy, artifacts, routing, cold start, metering, marketplace.
7. `docs/06-data.md` — SQLite per tenant, Postgres control plane, authorizer, replication.
8. `docs/07-app-model.md` — tenant application structure, routing, loaders, actions, the `ctx` SDK.
9. `docs/08-template-engine.md` — attribute syntax → minijinja, performance, limits.
10. `docs/09-htmx-realtime.md` — fragments, morphing, SSE, WebSocket.
11. `docs/10-modules.md` — module system and inter-module communication.
12. `docs/11-authorization.md` — RBAC/ABAC/ReBAC with Cedar, `r-can`, `db.scoped`.
13. `docs/12-developer-experience.md` — CLI, dev loop, types, debugging.
14. `docs/13-decisions.md` — ADRs D1–D20. **Required reading before any architectural change.**
15. `docs/14-benchmarks.md` — target numbers, scenarios, methodology, how to record results.
16. `docs/15-roadmap.md` — phases, done criteria, kill criteria.
17. `docs/16-risks.md` — risks and mitigations.
18. `docs/17-glossary.md` — terms.
19. `docs/18-build-plan.md` — platform components and official modules: dependency graph, parallel tracks, build order.
20. `docs/19-platform-wireframes.md` — the hosting product's screens: tenant dashboard, CLI output, operator console.
21. `docs/20-ai-agents-mcp.md` — how agents work with Renox: platform MCP for developers, app MCP per tenant, `ctx.ai`, agent security.
22. `docs/21-uae-gcc-strategy.md` — target market (UAE SMEs): distribution, GCC modules and starters, unit economics, compliance, items to verify.
23. `docs/22-development-plan.md` — how work is tracked on GitHub (milestones, issue keys, labels), directory ownership per track, branch and session protocol for running several agents in parallel, phase gates.
24. `docs/23-failure-modes.md` — catalogue of failure modes and negative paths per component: what fails, who detects it, what the tenant sees, the proving test. Source of the per-phase negative path checklist.
25. `docs/24-threat-model.md` — threats per trust boundary (end user, tenant, module publisher, control plane, supply chain, operator, agents) with the control, the proving test, and the phase. Source of the per-phase security checklist and of the PR security section.
26. `docs/25-execution.md` — copy-paste prompts for agent sessions (find ready issues, work on one issue, review a PR) and the rules every session follows from start to finish.

## Repository layout (planned)

```
renox.rs/
├── AGENTS.md, CLAUDE.md
├── docs/                      this documentation
├── crates/                    data plane (Rust workspace)
│   ├── renox-gateway/         TLS, hostname→tenant→cell routing, rate limiting
│   ├── renox-runtime/         V8 isolates (Supabase Edge Runtime), ops, snapshots, watchdog
│   ├── renox-template/        attribute → minijinja transpiler, renderer, fuel
│   ├── renox-data/            SQLite per tenant, authorizer, migrations, outbox
│   ├── renox-authz/           Cedar, principal cache, r-can
│   ├── renox-realtime/        SSE, WebSocket, pub/sub
│   ├── renox-meter/           per-invocation records
│   └── renox-cell/            wires everything together per worker node (binary `renox-worker`)
├── control/                   control plane (Bun + Hono)
│   ├── api/                   deployments, artifacts, route table, secrets
│   ├── dashboard/             SSR built with Renox itself (dogfooding)
│   └── billing/               meter aggregation → invoices
├── sdk/                       the `renox` package for tenant code (types, ctx, helpers)
├── cli/                       the `renox` CLI (Bun, compiled to a single binary)
├── modules/                   official modules: auth, org, 2fa, billing, admin, storage, email, ...
├── examples/                  example apps: shop, chat, the dogfooding products
└── bench/                     benchmark scenarios and results (bench/results/YYYY-MM-DD-*.md)
```

A folder that does not exist yet is not due yet. Do not create crates or packages outside this list without a new ADR.

## Rules for agents

### Architecture
- The decisions in `docs/13-decisions.md` are binding. To change one, add a new ADR with status `proposed`; never silently edit an old ADR.
- Do not rebuild what already exists: the runtime (Supabase Edge Runtime / `deno_runtime`), the template engine (`minijinja`), the HTML parser (`html5ever`), the policy engine (`cedar-policy`), SQLite (`rusqlite`/libSQL). Renox's value is in assembly, conventions, and modules.
- Performance claims without benchmark results do not go into documentation. Write "target" or "estimate" and reference `docs/14-benchmarks.md`.
- Per-tenant limits (CPU, memory, wall-clock, network, render fuel) must be enforced in Rust, never by convention in JavaScript.

### Security (non-negotiable)
- Tenant code never receives file paths, connection strings, raw secrets, or network access without an allowlist.
- Tenant `fetch` must block private, loopback, link-local, and cloud metadata addresses.
- Every SQL statement from a module passes through a SQLite authorizer restricted to that module's table prefix.
- Secrets must never appear in logs, error messages, bundles, or responses.
- Templates are a DSL with no code execution. Do not add free function calls to the expression language.

### Code
- Rust: latest stable edition, `cargo clippy -D warnings`, `cargo fmt`. Avoid `unsafe` except in documented V8/SQLite wrappers.
- Compile discipline (see `docs/12-developer-experience.md`): never build V8 from source (prebuilt `rusty_v8` only); leaf crates must not depend on `renox-runtime` or on each other; tests that do not need V8 must not link it; TypeScript and docs changes must not trigger a Rust build.
- TypeScript (control plane, SDK, CLI, modules): Bun, strict mode, no `any` in public APIs.
- Module SQL: SQLite dialect, tables prefixed `<module>__`, forward-only migrations.
- Tests: every per-tenant limit has a test proving it works (infinite loop is terminated, SSRF is rejected, another module's table is rejected).
- Language: all documentation, comments, identifiers, commit messages, and APIs in English.

### Workflow
- Work is tracked as GitHub issues keyed `[Fx-nn]`, one issue = one branch = one PR = one agent session; see `docs/22-development-plan.md` for the session protocol and directory ownership.
- One change = one small PR whose description references the relevant ADR or docs section.
- Architectural changes update `docs/` in the same PR.
- Benchmark results are recorded under `bench/results/` in the format from `docs/14-benchmarks.md`; update target numbers in the docs if they change.

## Frequently used terms

| Term | Meaning |
| --- | --- |
| Tenant | A customer who deploys an application to Renox |
| Deployment | One version of a tenant's code, referenced by artifact hash |
| Cell | The execution unit of one tenant on one node: V8 isolate + SQLite file + realtime connections |
| Isolate | A V8 instance with its own heap; one per active deployment |
| Context | A JS global scope inside an isolate; one per module in `context`/`isolate` mode |
| Module | A mini app that can be installed into a tenant application (auth, billing, admin) |
| Fragment | A partial HTML render for an htmx request |
| Fuel | Execution-step budget for template rendering |

Full list in `docs/17-glossary.md`.
