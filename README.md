# Renoxium

**A multi-tenant hosting platform for TypeScript applications.**
Tenants deploy web apps and functions written in TypeScript; Renox runs them safely, densely, and cheaply in V8 isolates with one SQLite file per tenant.

> *"Assemble a SaaS from auth, billing, and admin modules, then deploy to hosting that charges only for what you use."*

> **Status (2026-11-08, `main` at `de8b136`).** The code of every phase F0 to F7 is on `main`: eight crates under `crates/`, the control plane under `control/`, the `renox` CLI and SDK, sixteen official modules, the examples (with the reference app `examples/home-services`, epic #554), the site. The platform is live on `node-small` behind Cloudflare since 2026-11-07 (`api.renoxium.com`, `dashboard.renoxium.com`, `renoxium.com`, `*.renoxium.app`; ADRs D25 and D26; #458), for users the owner onboards by hand on the free tier (D31). The CLI is released (`cli-v0.1.7`, signed, with a native Windows `renox.exe`, pinning `renox-worker` 0.4.0 with its `pdf` variant and a Windows build for development), the SDK `@renoxium/sdk`, `@renoxium/cli` and `create-renox` are on npm with provenance (D28, D30). Gates F0 and F1 passed (GO); gates F2 to F6 closed GO-with-gaps on 2026-11-06, each gap recorded in its review comment. Only gate F7 (#86) is open, on the first external user, not on code. The table below lists what each gate recorded; the open work and the running batches are in [`docs/25-execution.md`](docs/25-execution.md), "Where we are".
>
> | Phase | Built | Gate |
> | --- | --- | --- |
> | F0 Spike | The spike benchmarks under `bench/` against the unmodified Supabase Edge Runtime | #133, GO |
> | F1 Minimal data plane | Gateway, runtime (V8 isolates, CPU, memory, wall-clock and `fetch` limits in Rust), SQLite per tenant with the authorizer, meter, cell; two tenants on one node, an infinite loop terminated at its limit | #165, GO. B1 and B2 re-run on `node-small`; B4, B11, B12 deferred with the load-generator host (#456, #516) |
> | F2 SSR and templates | `renox-template`, pages (loaders, actions, layouts, partials, fragments), the `shop` example, streamed responses, the isolate pool, the macOS CPU clock | #49, GO-with-gaps (2026-11-06): B6 and B7 deferred with the load generator (#456); #342 closed as not planned, the host's vCPU stalls a known gap (#523); the `shop` RSS bisect (#457) open |
> | F3 Minimal control plane | Deploy API, the dashboard as a Renox app (password sign-in, second factor, `/device`, tokens), logs, secrets, custom domains through Cloudflare for SaaS, signed CLI and worker releases, the remote MCP | #61, GO-with-gaps (2026-11-06); checklists #99, #116 closed |
> | F4 Modules | Manifest, resolver and lock, forward-only migrations, services, events, hooks, slots, overrides; the modules under `modules/` | #68, GO-with-gaps (2026-11-06): the kill criterion waived under D31 (no booking product) |
> | F5 Authorization and realtime | Cedar policies and `guard`, `r-can`, `db.scoped()`, SSE and WebSocket with topics, `2fa`, App MCP on `/mcp` | #74, GO-with-gaps (2026-11-06): B14 on `node-small` moved to #522 |
> | F6 Reliability and security | seccomp and Landlock, process tiers, Litestream replication, failover, export and restore, the chaos harness, OpenTelemetry, audit, erasure | #79, GO-with-gaps (2026-11-06): the B18 two-host run and the pentest deferred (#516) |
> | F7 External customers | `billing` with Stripe UAE, `tax_gcc`, `admin`, `storage`, `email`, `booking`, `reports`, `whatsapp`, the registry, `isolate` mode, EN/AR, onboarding, the site and docs in the dot-matrix design (D27); the CLI releases 0.1.0 to 0.1.7 with the native Windows CLI and the CLI on npm (D28, D30), `renox-worker` 0.4.0 with the `pdf` variant and the Windows worker; the single host live behind Cloudflare (D25, D26; #458) with local backups (#517); the reference app `examples/home-services` (#554, 11 of 13) | #86 open: the first external user on the free tier for two weeks, the tutorial's owner steps (#485), the checklists #106 and #124; the GCC PSP adapters, the entity, the products, the second host, R2 and the pentest are deferred by D31 (#516) |

## Naming

- **Renoxium** is the product and the hosting: the name a person reads on the site, the dashboard, mails, invoices, passkey and authenticator labels, and the MCP resource.
- **`renox`** is the toolkit a developer types: the `renox` CLI, the crates, `renox.toml`, the `renox:modules` specifier, the `RENOX_*` error codes and variables. It is not renamed.
- **`@renoxium/sdk`** is the one exception: the npm package tenant code imports (`import type { Handler } from "@renoxium/sdk"`). npm refuses the unscoped name `renox` as too close to `redux` and `detox`, so the SDK lives in the `renoxium` npm organization (`docs/13-decisions.md`, D28).
- **Two domains, split on purpose** (`docs/contracts/README.md`, "Domains"): tenant apps live on `renoxium.app` (`<app>.renoxium.app`, previews `<app>-<hash>.renoxium.app`, custom domains CNAME to `renoxium.app` through Cloudflare for SaaS; on the Public Suffix List, `ops/psl/`), and the platform's own services on `renoxium.com` (the site at the apex, `dashboard.`, `api.`, `mcp.`, `docs.`, and mail such as `security@` and `abuse@`). A tenant's phishing page can then never cost the company domain its reputation, its mail deliverability or the dashboard's cookies. `renox.rs` is not used by the platform; it is only this repository's name. Both domains are operator configuration; these are the reference deployment's values.

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
import type { LoaderContext } from "@renoxium/sdk";

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

| Phase | Name | Done when | Status (2026-11-08) |
| --- | --- | --- | --- |
| F0 | Spike | Memory per isolate, cold start, npm compatibility, and marshaling numbers meet the targets. If not, re-evaluate before writing platform code | Done, gate GO (#133) |
| F1 | Minimal data plane | Two tenants on one node; an infinite loop in one does not affect the other; meters recorded | Done, gate GO (#165) |
| F2 | SSR and templates | The `shop` example runs | Built, gate #49 GO-with-gaps (2026-11-06) |
| F3 | Minimal control plane | `renox deploy` goes live in under 30 s; rollback works | Built, gate #61 GO-with-gaps (2026-11-06) |
| F4 | Modules | The first product uses `auth` and `org` with no auth code of its own | Built, gate #68 GO-with-gaps (2026-11-06), kill criterion waived (D31) |
| F5 | Authorization and realtime | Cedar guards and the chat room work | Built, gate #74 GO-with-gaps (2026-11-06); B14 on `node-small` is #522 |
| F6 | Production reliability and security | A node is killed and tenants recover elsewhere | Built, gate #79 GO-with-gaps (2026-11-06); the pentest deferred (#516) |
| F7 | External customers | The first external user on the free tier runs their own app for two weeks (D31) | Built but for the GCC PSP adapters; live on `node-small` behind Cloudflare since 2026-11-07; CLI 0.1.7 and worker 0.4.0 released; gate #86 waits for the first external user on the free tier; payments, the entity and the products are deferred (D31) |

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
| [`docs/13-decisions.md`](docs/13-decisions.md) | ADRs D1–D31. **Required reading before any architectural change** |
| [`docs/14-benchmarks.md`](docs/14-benchmarks.md) | Targets, scenarios, methodology |
| [`docs/20-ai-agents-mcp.md`](docs/20-ai-agents-mcp.md) | Platform MCP, app MCP per tenant, agent security |

## Repository layout

```
renox.rs/
├── docs/        this documentation; docs/contracts/ are the written interfaces between the parts
├── crates/      data plane (Rust workspace): renox-gateway, -runtime, -template, -data, -authz, -realtime, -meter, -cell (binary renox-worker)
├── control/     control plane (Bun + Hono): api, dashboard (a Renox app), billing
├── sdk/         the `@renoxium/sdk` npm package for tenant code; sdk/client is the browser script
├── cli/         the `renox` CLI (Bun, compiled to one binary per platform)
├── packages/    shared TypeScript: artifact-validate
├── modules/     official modules: auth, org, 2fa, billing, tax_gcc, admin, storage, email, booking, reports, whatsapp, notifications, audit, jobs, i18n, gcc
├── examples/    example apps: hello, shop, chat, evil (negative paths), npm-compat
├── www/         the public site renoxium.com (a Renox app): the docs, pricing, legal pages, llms.txt
├── ops/         units, scripts, locks and checksums a node and CI trust (code-owner reviewed)
└── bench/       benchmark scenarios, spikes, the chaos harness and the results
```

A folder that does not exist yet is not due yet.

## Development setup

| Tool | Version | Install |
| --- | --- | --- |
| Rust | pinned in `rust-toolchain.toml` (rustup installs it on first `cargo` call) | <https://rustup.rs> |
| Bun | 1.4.4 | <https://bun.sh> |
| Linker | `mold` if installed, else `lld` (bundled with Rust on x86_64 Linux) | see [`bench/README.md`](bench/README.md) |

```
bun install          # TypeScript workspaces (sdk, cli, control/*, modules/*, examples/*, bench)
make check           # cargo fmt --check + clippy -D warnings, bun run check
make test            # cargo test --workspace, bun test
make fmt             # cargo fmt
make bench ID=B0     # run one benchmark scenario (bench/run.sh)
```

CI (`.github/workflows/ci.yml`) runs the same targets; Rust jobs run only when Rust files change, TypeScript jobs only when TypeScript files change, and docs changes only run the link check.
The Rust job caches `target/` (`Swatinem/rust-cache`) and compiler outputs (`sccache` on the GitHub Actions cache); B20 tracks its time (`make bench ID=B20`, needs `gh` logged in).

### Prebuilt `renox-worker`

`renox dev` and `renox test` run a prebuilt worker, so tenant developers never build Rust (`docs/12-developer-experience.md`, rule 5). `.github/workflows/release-worker.yml` builds it on a `worker-v*` tag (or by hand from the Actions tab) and attaches `renox-worker-<version>-<target>` and its `.sha256` to the GitHub Release `worker-v<version>` for `x86_64-unknown-linux-gnu`, `aarch64-unknown-linux-gnu`, `aarch64-apple-darwin`, `x86_64-apple-darwin` and, from `worker-v0.5.0`, `x86_64-pc-windows-msvc` (development only, no pdf variant; `docs/12-developer-experience.md`). Each build runs natively on its own runner and links a V8 archive checked against `ops/v8-checksums.txt`. `worker-v0.1.0` carries the Linux x86_64 binary only and is unsigned; from `worker-v0.2.0` on, every release carries all four targets, each with a `.sha256` and a sigstore bundle, and is built without the `pdf` feature (`ctx.pdf.render` answers `pdf_unavailable` on the default worker; PR #380, #381); from `worker-v0.5.0` each Linux and macOS target also has a `pdf` variant, `renox-worker-<v>-<target>-pdf.gz` (PR #493). The CLI pins `worker-v0.5.0` (`WORKER_VERSION` in `cli/scripts/fetch-worker.ts`, the digests in `PINNED_WORKER`, and the pdf variant's in `PINNED_WORKER.pdf`). `install.sh` installs that worker beside `renox`; from a checkout, `bun cli/scripts/fetch-worker.ts` puts it in `cli/bin/<platform>-<arch>/`, where `renox dev` finds it.

```
gh release download worker-v0.5.0 --pattern 'renox-worker-0.5.0-x86_64-unknown-linux-gnu*'
sha256sum -c renox-worker-0.5.0-x86_64-unknown-linux-gnu.sha256
chmod +x renox-worker-0.5.0-x86_64-unknown-linux-gnu
export RENOX_WORKER_PATH=$PWD/renox-worker-0.5.0-x86_64-unknown-linux-gnu
```

`RENOX_WORKER_PATH` tells the CLI which worker binary to run instead of downloading one. Platform developers point it at their own build: `cargo build --release --bin renox-worker`, then `export RENOX_WORKER_PATH=$PWD/target/release/renox-worker`.

## Contributing

This repository is built with AI coding agents alongside a human maintainer. The rules in [`AGENTS.md`](AGENTS.md) apply to both:

- The decisions in `docs/13-decisions.md` are binding. Change them through a new ADR, never a silent edit.
- Per-tenant limits are enforced in Rust, never by convention in JavaScript.
- Performance claims without benchmark results do not go into the documentation.
- Security rules are non-negotiable: no raw secrets or file paths reach tenant code, tenant `fetch` blocks private addresses, module SQL passes the authorizer, secrets never appear in logs.
- One change = one small PR that references the relevant ADR or docs section.
- Everything is in English: documentation, comments, identifiers, commit messages, APIs.

## License

Apache License 2.0 for the whole repository: the data plane, the control plane, the CLI, the SDK, the modules, the examples, the site and the documentation (`LICENSE`; `docs/13-decisions.md`, D29). The npm package `@renoxium/sdk` is Apache-2.0 from version 0.1.4; versions 0.1.0 to 0.1.3 were published under MIT and stay so. The business is the hosting, not the code.
