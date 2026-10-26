# 03 — System architecture

The platform is split into a control plane (manages) and a data plane (executes). They share only two things: the control-plane Postgres as the source of truth, and object storage for artifacts and backups.

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

Tenant developers talk to the control plane; end users talk to the data plane. Worker nodes pull artifacts from object storage and push meters and logs back to the control plane.

## Components

| Component | Responsibility | Technology | Repo location |
| --- | --- | --- | --- |
| Deploy API | Accept bundles, validate, store artifacts, activate routes | Bun, Hono | `control/api` |
| Dashboard | Tenants, deployments, logs, billing, module registry | Bun; SSR built with Renox itself (dogfooding) | `control/dashboard` |
| Billing | Meter aggregation → invoices, tier enforcement | Bun | `control/billing` |
| Control-plane Postgres | Tenants, deployments, permissions, encrypted secrets, meters, audit | Postgres | — |
| Object storage | Immutable artifacts per hash, Litestream backups per tenant | S3-compatible | — |
| Gateway | TLS, hostname → tenant → cell routing, rate limiting, in-memory route table | Rust: `hyper`, `axum`, `rustls` | `crates/renox-gateway` |
| Runtime | V8 isolate per deployment, snapshots, ops (`fetch`, `db`, `secret`, `render`), watchdog | Rust: Supabase Edge Runtime / `deno_runtime` | `crates/renox-runtime` |
| Data | SQLite per tenant, authorizer, migrations, outbox, Litestream/replication hooks | Rust: `rusqlite` / libSQL | `crates/renox-data` |
| Template | Attribute → minijinja transpiler (deploy time), renderer with fuel (request time) | Rust: `html5ever`, `minijinja` | `crates/renox-template` |
| Authz | Cedar evaluation, principal cache, `r-can`, `guard` | Rust: `cedar-policy` | `crates/renox-authz` |
| Realtime | SSE, WebSocket, pub/sub topics, backpressure | Rust: `axum::extract::ws`, `tokio::sync::broadcast` | `crates/renox-realtime` |
| Meter | One record per invocation → batched to the control plane | Rust | `crates/renox-meter` |
| Cell | Wires the above into one worker binary; isolate lifecycle, scheduling, eviction | Rust | `crates/renox-cell` |
| SDK | `renox` package: `ctx` types, `db`, `authz`, `realtime`, helpers | TypeScript | `sdk/` |
| CLI | `renox new/dev/deploy/...`, local data plane for dev | TypeScript (Bun), compiled binary; embeds the Rust worker for `renox dev` | `cli/` |

## Request path (SSR)

1. The gateway matches hostname and path against the deployment's route table.
2. The request is routed to the tenant's cell (consistent hashing on tenant id). If the isolate does not exist, it is created from the platform snapshot plus the artifact.
3. The route `guard` is evaluated by the policy engine (principal loaded once per request, cached).
4. The loader runs in the isolate. Database queries go through a Rust op into SQLite with the module's authorizer attached.
5. The loader result is marshaled to Rust (`serde_v8` → `minijinja::Value`); the template is rendered (full page or fragment) outside the tenant's CPU quota; the response is streamed.
6. A meter record is written: CPU ms, wall ms, peak heap, egress bytes, db ms, render fuel.

## Request path (function / API)

Same as above through step 4; the handler returns a `Response`, which is streamed directly. No template step.

## Request path (WebSocket / SSE)

1. Gateway upgrades the connection and hands it to the cell's realtime component.
2. The `open` handler runs in the isolate once (auth, subscribe). The connection itself is owned by tokio.
3. Incoming messages invoke the `message` handler; outgoing messages are fanned out by the pub/sub component without touching the isolate.

## Region and data residency

Production runs in a UAE cloud region (AWS me-central-1 or Azure UAE North to start; local colocation later). Tenant files, backups, artifacts, logs, and the control-plane Postgres all stay in the UAE by default. Cross-border replication is opt-in per tenant and off for regulated data. Static assets and image variants are served through a CDN with a UAE point of presence. Rationale and compliance details: `21-uae-gcc-strategy.md`.

## Cross-cutting concerns

| Concern | Where it lives | Notes |
| --- | --- | --- |
| Tenant identity | Gateway (hostname) → propagated in every op and log | Never derived from tenant-controlled input after routing |
| Principal (end-user identity) | Session cookie → `renox-authz` | Loaded once per request, cached per cell with pub/sub invalidation |
| Deadlines | Set at the gateway, propagated to ops, queries, fetches, render | One clock per request |
| Tracing | OpenTelemetry spans: request, loader, service call, query, render, fetch | `tenant_id`, `request_id`, module name on every span and log line |
| Configuration | Platform config in environment/files; tenant config in the deployment manifest | No tenant config is read from the tenant's own database at request time |

## Planned Rust workspace dependencies

```
renox-cell ──► renox-gateway (local listener), renox-runtime, renox-data, renox-template,
               renox-authz, renox-realtime, renox-meter
renox-runtime ──► renox-data (db op), renox-template (render op), renox-authz (authz op),
                  renox-realtime (publish op), renox-meter
renox-template ──► renox-authz (can() in templates)
renox-data, renox-authz, renox-realtime, renox-meter: leaf crates (no dependency on each other)
```

Leaf crates can be developed in parallel; see `18-build-plan.md`.
