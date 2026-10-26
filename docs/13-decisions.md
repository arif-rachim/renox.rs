# 13 — Architecture decision records

Every decision serves density, isolation, and development speed. Decisions changed from v1 are marked so the reasoning can be revisited if conditions change. Status values: `accepted`, `proposed`, `superseded`.

To change a decision: add a new ADR (next number) with status `proposed`, reference the one it supersedes, state the evidence (benchmark, incident, user feedback), and update the old one's status after acceptance. Never edit an accepted ADR's reasoning in place.

| # | Status | Decision | Reasoning | Rejected alternatives |
| --- | --- | --- | --- | --- |
| D1 | accepted | Goal: a hosting platform for third-party code, not a framework for our own apps | Multi-tenant sandboxing is the core product and revenue source. This decision justifies every technical one below | A TS framework on Bun for our own products (cheaper, but no sandbox and no hosting business) |
| D2 | accepted | The data plane is written in Rust | Full control over V8 isolates: heap limits, CPU watchdog, op permissions, scheduling. Not available in Bun/Node | Bun process per tenant (30–50 MB per tenant, 5–10x less dense) |
| D3 | accepted (changed in v2) | The runtime is built on Supabase Edge Runtime / `deno_runtime`, not raw `deno_core` | Web APIs, `npm:`, `node:*`, source maps, per-worker memory/CPU limits already exist and were built to run customer functions. Cuts the largest piece of scope | Raw `deno_core` (rebuild Node compatibility), QuickJS (10–50x slower), Bun (no isolates) |
| D4 | accepted (new) | The control plane is written in Bun (TypeScript) | Our own code, no sandbox needed, development speed matters most there | Rust for everything (slow for CRUD and dashboards) |
| D5 | accepted (changed) | Tenant data in SQLite per tenant; control plane in Postgres | File-level isolation is stronger than RLS, idle tenant cost is zero, in-process queries take microseconds, backup and tenant moves are trivial. Used by Cloudflare D1, Turso, Fly.io, PocketBase | Postgres schema per tenant (catalog bloat, RLS as the only fence), Postgres DB per tenant (expensive connections, hard per-tenant restore) |
| D6 | accepted | Layered isolation: V8 isolate + sandboxed process (seccomp, namespaces, cgroups) + process tiers | Isolates alone are not enough for untrusted code (side channels, V8 bugs) | Isolates only (even Cloudflare does not), microVMs for everyone (too expensive for the long tail) |
| D7 | accepted | HTML rendered in Rust (minijinja), JS returns data only; a template-to-JS path is provided and the default is chosen by benchmark | Rendering outside the tenant quota, small tenant heaps, templates as a DSL without code execution. V8→Rust marshaling cost is real and must be measured | JS-only SSR as the single path |
| D8 | accepted (changed) | Attribute-based HTML template syntax, transpiled to minijinja at deploy | Templates stay valid HTML and integrate with htmx/Alpine; performance, escaping, filters, and per-block render come from proven minijinja. The custom part is only a syntax translator | A custom render engine (bugs, missing features), Jinja syntax directly (block syntax rejected by the author) |
| D9 | accepted | Interactivity via HTML fragments + htmx + idiomorph + View Transitions | Partial updates without an SPA, DOM state and animations preserved, small client JS | React/SPA |
| D10 | accepted | Convention over configuration for routing | No router boilerplate; folder structure = URL structure | Manual router configuration |
| D11 | accepted | A module is a mini app with the same folder structure; official modules (auth, billing, admin) are the product | One concept to learn; modules are the main reason tenants choose Renox | A separate plugin API |
| D12 | accepted (changed) | Module isolation modes: `shared` for the tenant's own and official modules, `isolate` for marketplace modules | Own modules need no serialization between contexts; other people's modules must not touch the tenant heap | `context` as the default for all (serialization overhead without a real security benefit) |
| D13 | accepted (changed) | Tables per module use a prefix (`billing__invoices`) in one file per tenant; module permissions via the SQLite authorizer | Cross-module transactions stay atomic (ATTACH across files is not atomic in WAL mode); the authorizer checks table access when SQLite compiles the statement | One file per module via ATTACH, SQL parsing in Rust |
| D14 | accepted (changed) | Durable events via an outbox in the tenant file; the worker is woken by `update_hook` | Event and data in one transaction; no polling across thousands of files | Kafka/NATS, Postgres LISTEN/NOTIFY |
| D15 | accepted | User authorization with Cedar (`cedar-policy`): RBAC + ABAC + relations | Native Rust, policies loaded at runtime, schema-validated, `forbid` wins over `permit` | OPA/Rego (Go sidecar), Casbin, TS predicates |
| D16 | accepted (changed) | No RLS; row-level safety via `db.scoped()` + Cedar + mandatory authorization tests | SQLite has no RLS; tenant isolation is handled by file per tenant. Losing the row-level fence is acknowledged as a trade-off | Keeping Postgres only for RLS |
| D17 | accepted (new) | Forward-only migrations with expand/contract; public views are versioned | Cross-module `down` rollbacks break view dependencies; compatible forward migrations are safer | Classic up/down migrations |
| D18 | accepted (new) | One SQL dialect for the module ecosystem: SQLite | Dual-dialect modules are tested twice and third-party authors will support only one | Dual dialect |
| D19 | accepted (new) | Dev hot reload discards the isolate and creates a new one | Simpler and leak-free compared with hot-swapping contexts; tens of ms are acceptable in dev | Per-module context hot swap |
| D20 | accepted (new) | Trimmed MVP: F0–F2 + the auth module + two real products, with kill criteria | A framework built without products is almost always wasted | Building the whole roadmap before there are users |

## ADR template

```
### D<n> — <title>
Status: proposed | accepted | superseded by D<m>
Date: YYYY-MM-DD
Context: what forces are at play (benchmark numbers, incidents, user feedback)
Decision: what we do
Consequences: what becomes easier, what becomes harder, what we give up
Alternatives considered: each with the reason it was rejected
Evidence: links to bench/results/, issues, discussions
```
