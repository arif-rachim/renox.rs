# Renox

**A multi-tenant hosting platform for TypeScript applications.**
Tenants deploy web apps and functions written in TypeScript; Renox runs them safely, densely, and cheaply in V8 isolates with one SQLite file per tenant.

> *"Assemble a SaaS from auth, billing, and admin modules, then deploy to hosting that charges only for what you use."*

> **Status: Phase F0 (spike).** There is no platform code in this repository yet. It contains the architecture documentation, the architecture decision records, the benchmark plan, and the roadmap. The first code allowed here is the benchmarks that prove or kill the F0 assumptions (see [Roadmap](#roadmap)).

## Why

Developers building business applications in TypeScript keep rebuilding the same things: auth, organizations and roles, billing, admin panels, email, jobs, deployment, monitoring. The PHP/Ruby/Python world solved this years ago (Laravel, Rails, Django). In TypeScript nothing has won, and the best hosting for it is expensive.

Renox sells **hosting + modules**:

- Usage-based hosting where idle tenants cost almost nothing.
- Ready-made modules installed in minutes: auth (+2FA, phone OTP), organizations, billing, tax invoices, admin, storage, email, WhatsApp.
- One simple application model: TypeScript, HTML, SQL. No build step, no Node, no Docker.
- Deploy in seconds, rollback in seconds, per-tenant logs and metrics.

The first target market is SMEs in the United Arab Emirates, reached through agencies and through vertical SaaS products built on Renox itself. Details in [`docs/01-business.md`](docs/01-business.md) and [`docs/21-uae-gcc-strategy.md`](docs/21-uae-gcc-strategy.md).

## How it works

Two numbers decide the business: **density** (tenants per server) and **isolation** (tenants cannot interfere with or read each other). Every design decision is tested against them.

| Part | Language | Role |
| --- | --- | --- |
| **Data plane** | Rust | Runs tenant code in V8 isolates (built on Supabase Edge Runtime), SQLite per tenant, template rendering, realtime, metering |
| **Control plane** | TypeScript (Bun) | Deploy API, dashboard, billing, module registry, Postgres |

```
                     ┌──────────────────── Control plane (Bun) ────────────────────┐
 Tenant developer    │  Deploy API        Dashboard           Postgres               │
 (renox CLI) ──────► │  validate, store   billing, logs,      tenants, deployments,  │
                     │  artifact, route   module registry     permissions, meters    │
                     │        │                                                      │
                     │        ▼                                                      │
                     │  Object storage (S3-compatible): immutable artifacts (hash),  │
                     │  Litestream backups per tenant                                │
                     └──────────────────────────────┬───────────────────────────────┘
                                                    │ fetch artifact / route updates (pub/sub)
                     ┌──────────────────── Data plane (Rust) ──────────────────────┐
 End user (browser)  │  Gateway: TLS, hostname → tenant → cell, rate limit          │
 HTTP/SSE/WS ──────► │        │                              │                      │
                     │  ┌─────▼──── Node worker A ──┐  ┌─────▼──── Node worker B ──┐│
                     │  │ Cell tenant 1              │  │ Cell tenant 3              ││
                     │  │  isolate V8 + tenant-1.db  │  │  isolate V8 + tenant-3.db  ││
                     │  │ Cell tenant 2              │  │ thousands of idle tenants: ││
                     │  │  isolate V8 + tenant-2.db  │  │  isolate evicted, 0 MB     ││
                     │  └────────────────────────────┘  └────────────────────────────┘│
                     │  meters + logs ──────────────────────────────► control plane   │
                     └──────────────────────────────────────────────────────────────┘
```

Key building blocks, all reused from the ecosystem rather than rebuilt:

- **Runtime:** V8 isolates via Supabase Edge Runtime / `deno_runtime`, with per-tenant CPU, memory, wall-clock, and network limits enforced in Rust.
- **Data:** one SQLite file per tenant (`rusqlite` / libSQL). Module tables are prefixed and every statement passes through the SQLite authorizer. Litestream for backups and failover.
- **Templates:** HTML-first attribute syntax, transpiled to `minijinja` at deploy time and rendered in Rust with an execution-fuel budget. Templates are a DSL with no code execution.
- **Interactivity:** HTML fragments + htmx + idiomorph + View Transitions. SSE and WebSocket for realtime. No SPA by default.
- **Authorization:** Cedar policies (RBAC + ABAC + relations), route guards, and `db.scoped()`.
- **Modules:** a module is a mini app with the same folder structure as a tenant app. Official modules (auth, org, billing, admin, ...) are the product.

### What a tenant app looks like

Folder structure is the URL structure. Configuration is only an escape hatch.

```
my-app/
├── renox.toml              app config + module list
├── public/                 static files, served outside the tenant quota
├── pages/                  SSR: pages/products/[id].html + [id].ts -> /products/:id
│   ├── _layouts/main.html
│   └── index.html          /
├── partials/               template components (<x-name>)
├── functions/              functions/api/checkout.ts -> /api/checkout
│   ├── ws/                 WebSocket handlers
│   ├── webhooks/           inbound webhooks
│   └── tools/              MCP tools exposed at /mcp
├── migrations/             SQL owned by the app
├── policies/               Cedar policies owned by the app
├── jobs/                   scheduled jobs
└── overrides/<module>/     override module templates without forking
```

```ts
// pages/products/[id].ts
import type { LoaderContext } from "renox";

export const guard = { action: "product.read" };

export async function load({ params, db }: LoaderContext) {
  const product = await db.queryOne("select * from shop__products where id = ?", [params.id]);
  if (!product) return new Response(null, { status: 404 });
  return { product, inStock: product.stock > 0 };
}
```

Full model in [`docs/07-app-model.md`](docs/07-app-model.md).

## Targets

Every performance number in this repository is a **target** until a result under `bench/results/` proves it.

| Expectation | Measure | Target |
| --- | --- | --- |
| Density | Idle tenants per 8 GB node | ≥ 1,000 |
| Memory per active tenant | RSS of a warm isolate, example app | ≤ 10 MB |
| Cold start | Snapshot → first request completed | p50 ≤ 20 ms, p99 ≤ 100 ms |
| SSR latency | Medium page (25 KB, 100 items, 5 queries), warm | p50 ≤ 3 ms, p99 ≤ 15 ms |
| Isolation | A tenant with an infinite loop or unbounded allocation | Other tenants unaffected; the request is terminated at its limit |
| Deploy | `renox deploy` → live | ≤ 30 s; rollback ≤ 5 s |

Full list, scenarios, and methodology in [`docs/14-benchmarks.md`](docs/14-benchmarks.md).

## Roadmap

| Phase | Name | Done when |
| --- | --- | --- |
| **F0** | Spike (current) | Memory per isolate, cold start, npm compatibility, and marshaling numbers meet the targets. If not, re-evaluate before writing platform code |
| F1 | Minimal data plane | Two tenants on one node; an infinite loop in one does not affect the other; meters recorded |
| F2 | SSR and templates | The `shop` example runs |
| F3 | Minimal control plane | `renox deploy` goes live in under 30 s; rollback works |
| F4 | Modules | The first product uses `auth` and `org` with no auth code of its own |
| F5 | Authorization and realtime | Cedar guards and the chat room work |
| F6 | Production reliability and security | A node is killed and tenants recover elsewhere |
| F7 | External customers | First paying external tenant |

Each phase has kill criteria. See [`docs/15-roadmap.md`](docs/15-roadmap.md) and [`docs/18-build-plan.md`](docs/18-build-plan.md).

## Documentation

Start with [`AGENTS.md`](AGENTS.md), which holds the rules and the full reading order. The most important documents:

| Document | Contents |
| --- | --- |
| [`docs/00-overview.md`](docs/00-overview.md) | Summary, principles, expectations |
| [`docs/03-architecture.md`](docs/03-architecture.md) | Control plane, data plane, components, request path |
| [`docs/04-isolation-security.md`](docs/04-isolation-security.md) | Isolation model, per-tenant limits, threat model |
| [`docs/06-data.md`](docs/06-data.md) | SQLite per tenant, authorizer, replication |
| [`docs/10-modules.md`](docs/10-modules.md) | Module system |
| [`docs/13-decisions.md`](docs/13-decisions.md) | ADRs D1–D20. **Required reading before any architectural change** |
| [`docs/14-benchmarks.md`](docs/14-benchmarks.md) | Targets, scenarios, methodology |
| [`docs/20-ai-agents-mcp.md`](docs/20-ai-agents-mcp.md) | Platform MCP, app MCP per tenant, agent security |

## Planned repository layout

```
renox.rs/
├── docs/        this documentation
├── crates/      data plane (Rust workspace): gateway, runtime, template, data, authz, realtime, meter, cell
├── control/     control plane (Bun + Hono): api, dashboard, billing
├── sdk/         the `renox` package for tenant code
├── cli/         the `renox` CLI
├── modules/     official modules: auth, org, 2fa, billing, admin, storage, email, ...
├── examples/    example apps: shop, chat, the dogfooding products
└── bench/       benchmark scenarios and results
```

A folder that does not exist yet is not due yet.

## Contributing

This repository is built with AI coding agents alongside a human maintainer. The rules in [`AGENTS.md`](AGENTS.md) apply to both:

- The decisions in `docs/13-decisions.md` are binding. Change them through a new ADR, never a silent edit.
- Per-tenant limits are enforced in Rust, never by convention in JavaScript.
- Performance claims without benchmark results do not go into the documentation.
- Security rules are non-negotiable: no raw secrets or file paths reach tenant code, tenant `fetch` blocks private addresses, module SQL passes the authorizer, secrets never appear in logs.
- One change = one small PR that references the relevant ADR or docs section.
- Everything is in English: documentation, comments, identifiers, commit messages, APIs.

## License

Not yet decided. Whether the data plane is open source or closed is an open question to be resolved before phase F7 (see `docs/15-roadmap.md`).
