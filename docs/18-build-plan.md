# 18 — Build plan: components, dependencies, and parallel tracks

This document lists everything we build, in two groups: **platform components** (crates and packages) and **official modules** (installable into tenant apps). For each it states what it depends on, so agents and people can see what can proceed in parallel and what must wait.

## Part A — Platform components

### Catalog

| ID | Component | Location | Language | Depends on | Phase |
| --- | --- | --- | --- | --- | --- |
| P1 | `renox-runtime` | `crates/renox-runtime` | Rust | Supabase Edge Runtime / `deno_runtime` (external) | F0–F1 |
| P2 | `renox-data` | `crates/renox-data` | Rust | `rusqlite`/libSQL (external); `sqlx` for external datasources (F6+) | F1 |
| P2b | SDK query-builder drivers (`renox/kysely`, `renox/drizzle`) and schema → `db.d.ts` generation | `sdk/`, `cli/` | TypeScript | P2 op contract, P10, P11 | F2 (types), F4+ (drivers) |
| P2c | External datasource connectors (Postgres/MySQL pool in the cell, `ctx.datasource`) and `renox db migrate-to postgres` | `crates/renox-data`, `cli/` | Rust + TypeScript | P2, secrets (P12), network allowlist (P1) | F6–F7 |
| P3 | `renox-gateway` | `crates/renox-gateway` | Rust | `hyper`, `axum`, `rustls` (external) | F1 |
| P4 | `renox-meter` | `crates/renox-meter` | Rust | — | F1 |
| P5 | `renox-cell` (binary `renox-worker`) | `crates/renox-cell` | Rust | P1, P2, P3, P4; later P6, P7, P8 | F1 |
| P6 | `renox-template` | `crates/renox-template` | Rust | `html5ever`, `minijinja` (external); P8 for `can()` | F0 (prototype), F2 |
| P7 | `renox-realtime` | `crates/renox-realtime` | Rust | — (integrates with P5) | F5 |
| P8 | `renox-authz` | `crates/renox-authz` | Rust | `cedar-policy` (external); P2 for role storage | F5 |
| P9 | Module Broker | inside `crates/renox-runtime` (ops) + `crates/renox-data` (outbox) | Rust | P1, P2 | F4 |
| P10 | SDK (`renox` package) | `sdk/` | TypeScript | Op contracts from P1 (types only) | F1 onward, grows per phase |
| P11 | CLI (`renox`) | `cli/` | TypeScript (Bun) | P10; P6 transpiler (as a Wasm build or via the embedded worker); P5 for `renox dev` | F1 onward |
| P12 | Control plane API | `control/api` | TypeScript (Bun, Hono) | Artifact format and route-table contract from P5/P11; Postgres; object storage | F3 |
| P13 | Control plane dashboard | `control/dashboard` | Renox app (dogfooding) | P12; P6, P10 | F3 (basic), F7 (full) |
| P14 | Billing | `control/billing` | TypeScript | P12; meter format from P4 | F3 |
| P15 | Process sandbox and tiers | `ops/` (systemd units, cgroup/seccomp profiles), P5 integration | Rust + ops | P5 | F6 |
| P16 | Replication and backup | P2 (Litestream sidecar / libSQL replica), control plane failover logic in P12 | Rust + TS | P2, P12 | F6 |
| P17 | Observability | tracing in all crates; collector config | Rust + ops | All | F6 |
| P18 | Module registry and signatures | `control/api` (registry endpoints), P11 (`renox publish`) | TypeScript | P12, P11 | F7 |
| P19 | Benchmarks | `bench/` | Shell + TS + Rust harness | P1 (F0), then everything | F0 onward |
| P21 | Platform MCP server (`renox mcp` local via stdio; `mcp.renox.dev` remote with OAuth 2.1 scopes, confirmation tokens, audit) | `cli/` (local), `control/api` (remote) | TypeScript | P11, P12; docs as resources | F2–F3 (local), F3–F4 (remote) |
| P23 | Domain and certificate manager: verification (TXT), DNS checks, ACME (HTTP-01, DNS-01 wildcard), certificate store and distribution to gateways, Domains API (`ctx.domains`) | `control/api` (manager), `crates/renox-gateway` (SNI + cert reload) | TypeScript + Rust | P3, P12; object storage/KMS for keys | F3 (basic custom domains), F7 (wildcard, Domains API) |
| P22 | App MCP (`functions/tools/`, module `[[tools]]`, `/mcp` per app with OAuth from `auth`, Cedar actions, metering) and `ctx.ai` (provider access, optional AI gateway, durable agent jobs) | `crates/renox-runtime` (ops), `sdk/`, `control/` (gateway) | Rust + TypeScript | P8 authz, M1 auth (OAuth server), P9 outbox, P4 metering | F5 (App MCP), F7 (`ctx.ai`) |
| P20 | Example apps | `examples/` | Renox apps | P10, P11 | F0 onward |

### Dependency graph

```
                 external: Supabase Edge Runtime / deno_runtime, rusqlite, minijinja, cedar-policy
                                   │
   ┌──────────┬──────────┬─────────┼─────────┬──────────┐
   ▼          ▼          ▼         ▼         ▼          ▼
  P1        P2         P3        P4        P6*        P8*          * leaf crates: can start on day one
runtime    data      gateway    meter    template    authz         (P6 prototype in F0; P8 in F5)
   │          │          │         │         │          │
   └──────────┴──────────┴────┬────┴─────────┴──────────┘
                              ▼
                        P5 renox-cell (worker binary)          P7 realtime plugs into P5 later
                              │
            ┌─────────────────┼─────────────────┐
            ▼                 ▼                 ▼
      P10 SDK           P19 bench          P11 CLI (dev = embedded worker)
            │                                   │
            └──────────────┬────────────────────┘
                           ▼
                  P12 control plane API ──► P13 dashboard, P14 billing, P18 registry
                           │
                     P15 sandbox/tiers, P16 replication, P17 observability (ops track)
```

### Parallel tracks

Work is organized into tracks that touch disjoint code. Within a track, items are sequential; across tracks, items at the same row can run at the same time.

| Row | Track R (Rust data plane) | Track T (TypeScript: SDK, CLI, control plane) | Track M (modules and examples) | Track O (ops, bench) |
| --- | --- | --- | --- | --- |
| 0 (F0) | P1 spike: run Edge Runtime, measure B1/B4; P6 transpiler prototype | P10 type sketch of `ctx` and ops | P20 `hello`, `npm-compat` examples | P19 harness for B1, B4, B9, B17 |
| 1 (F1) | P2 data (authorizer, pool), P3 gateway, P4 meter — **all three in parallel** (leaf crates) | P10 SDK v0 (`db`, `fetch`, `secrets`, `log`) | P20 `evil` example | P19 B5, B11, B12 scripts |
| 2 (F1) | P5 cell: wire P1–P4; eviction; limits | P11 CLI: `new`, `dev` (embedded worker), `check` (lint) | P20 `shop` skeleton (functions only) | B12 noisy-neighbor run |
| 3 (F2) | P6 template: transpiler, renderer, fuel, fragment map; render path B prototype | P11 CLI: template transpile step, `.renox/types` generation | P20 `shop` pages and partials | B6, B7, B8, B9, B13 |
| 4 (F3) | P5 hardening from F2 findings; artifact loader from object storage | P12 API, P14 billing, P13 basic dashboard — **parallel with Track R row 4** | P20 `shop` deployed through the real control plane | B15 deploy benchmark |
| 5 (F4) | P9 broker ops: service call, events/outbox, hooks, slots; migration runner in P2 | P11 `add`, `migrate`; lockfile; P10 `renox:modules` types | M1 `auth`, M2 `org` (see Part B) | B19 Litestream overhead prep |
| 6 (F5) | P8 authz; P6 `r-can`; P7 realtime; P2 `scoped` rewriter | P10 `authz`, `realtime` APIs; P11 `authz explain`, `test` | M3 `2fa`, M9 `notifications` (realtime); `chat` example | B14 realtime |
| 7 (F6) | P15 sandbox/tiers integration; P16 replication hooks | P12 failover logic; P17 dashboards | — | P15/P16/P17 rollout; B18 failover |
| 8 (F7) | P1 `isolate` mode for marketplace modules | P18 registry, `renox publish`; pricing in P14 | M4 `billing`, M5 `admin`, M6 `storage`, M7 `email`; public docs | Pen test, abuse controls |

Rules for parallel work:

- A track may only consume another track's output through a **written contract** committed first: op signatures (P1↔P10), artifact format and route table (P5/P11↔P12), meter record schema (P4↔P14), manifest schema (P9↔P11↔M*). Contracts live under `docs/contracts/` once they exist.
- Leaf crates (P2, P3, P4, P6, P7, P8) must not depend on each other; integration happens only in P5. This keeps them independently buildable and testable by separate agents.
- Modules (Part B) depend on the SDK version in which their required APIs exist; a module PR that needs a missing SDK API first lands the SDK change.

## Part B — Official modules

### Catalog

| ID | Module | What it provides | Tables (prefix) | Depends on | Requires platform | Phase |
| --- | --- | --- | --- | --- | --- | --- |
| M1 | `auth` | Users, password (argon2id), sessions, magic links, OAuth/OIDC (Google, GitHub, Microsoft), password reset, hook points `auth.after_login`, `auth.before_register`; `ctx.auth` | `auth__users`, `auth__sessions`, `auth__identities`, `auth__tokens` | — | P9 broker (services, hooks), P2 migrations | F4 |
| M2 | `org` | Organizations/workspaces, memberships, invitations, roles per org, org switcher; feeds `scope` into authz | `org__orgs`, `org__members`, `org__invites` | M1 | P9 | F4 |
| M3 | `2fa` | TOTP, WebAuthn/passkeys, recovery codes; sets `context.mfa_verified`; fills `auth.after_login` | `twofa__totp`, `twofa__webauthn`, `twofa__recovery` | M1 | P8 authz (context attribute), P9 hooks | F5 |
| M4 | `billing` | Plans, subscriptions, invoices, usage records, checkout and webhooks for Stripe, Checkout.com, Telr, PayTabs, N-Genius, Tabby/Tamara (see M17); public view `billing__public_user_plans_v1`; events `billing.*` | `billing__plans`, `billing__subscriptions`, `billing__invoices`, `billing__usage`, `billing__webhook_events` | M1, M2 | P9 events/outbox, `fetch` allowlist, secrets | F7 |
| M5 | `admin` | Admin layout, CRUD scaffolding from table metadata, user and org management, audit viewer, slot `admin.sidebar` | `admin__settings` | M1, M2 | P6 slots, P8 `r-can` | F7 |
| M6 | `storage` | File uploads to object storage, signed URLs, per-tenant quotas, and the **image pipeline** (see below) | `storage__files`, `storage__variants` | M1 | Platform storage API (P1 op), image op in Rust (`image`/libvips), P4 metering | F7 |
| M7 | `email` | Transactional email via Resend/SES/SMTP, templates rendered with the template engine, outbox-backed sending, suppression list | `email__messages`, `email__suppressions` | — (listens to `auth.*`, `billing.*` events) | P9 events, P6 `render`, `fetch` allowlist | F7 |
| M8 | `audit` | Append-only audit trail for sensitive actions, viewer in admin | `audit__events` | M1 | P8 (sensitive action hook) | F5 (lib), F7 (UI) |
| M9 | `notifications` | In-app notifications, SSE live badge, preferences; bridges events to email (M7) | `notif__items`, `notif__prefs` | M1 | P7 realtime, P9 events | F5 |
| M10 | `jobs` | Scheduled and queued jobs UI, retries, dead-letter viewer (thin UI over the platform outbox/scheduler) | `jobs__runs` | — | P9 outbox, scheduler in P5 | F6 |
| M11 | `search` | Full-text search over declared tables using SQLite FTS5, search box partial | `search__index_*` | — | P2 (FTS5 enabled), P6 partials | F7+ |
| M12 | `i18n` | Locale detection, translation catalogs, `t` filter, currency/date filters | `i18n__catalogs` | — | P6 filters | F7+ |
| M13 | `analytics` | Privacy-friendly page and event analytics per tenant app, dashboard partial | `analytics__events_*` | — | P4 or dedicated op, P7 for live | F7+ |
| M14 | `cms` | Content types, markdown/rich text, media via M6, public pages | `cms__*` | M1, M6 | P6 | Later |
| M15 | `whatsapp` | WhatsApp Cloud API: notifications, OTP, templates, light inbox, chat-to-order | `wa__messages`, `wa__templates` | — (listens to events) | P9 events, `fetch` allowlist | F5 |
| M16 | `auth` phone-first + UAE PASS (extension of M1) | +971 OTP via WhatsApp/SMS, passkeys, UAE PASS OAuth provider | in `auth__*` | M1, M15 (OTP transport) | P8 | F4–F5 |
| M17 | `payments-gcc` (extension of M4) | Stripe UAE, Checkout.com, Telr, PayTabs, N-Genius adapters; Apple/Google Pay; Tabby/Tamara BNPL; COD; bank-transfer reconciliation | in `billing__*` | M4 | `fetch` allowlist, secrets | F7 |
| M18 | `tax-gcc` | FTA tax invoices (TRN, 5% VAT, zero-rated/exempt), credit notes, VAT period reports, Peppol/ASP adapter interface; ZATCA adapter later | `tax__invoices`, `tax__periods` | M2, M4 | P6 (PDF render) | F7 |
| M19 | `i18n` RTL (extension of M12) | EN/AR for all official modules, RTL layout, Eastern Arabic digits and Hijri optional, AED/date formats, Arabic plural rules | in `i18n__*` | M12 | P6 RTL support | F4 (core), F7 (complete) |
| M20 | `delivery-gcc` | Aramex, Careem/Quiqup shipments and tracking; Talabat/Deliveroo order ingestion | `delivery__shipments` | M4 | `fetch` allowlist | F7+ |
| M21 | `marketplace-sync` | Noon and Amazon.ae stock and order sync | `mkt__listings`, `mkt__orders` | — | P9, `fetch` allowlist | F7+ |
| M22 | `reports` | Sales/cash reports, Excel/CSV export, Zoho Books / QuickBooks / Xero export | `reports__snapshots` | M4 | P6 | F7 |
| M23 | `gcc-data` | Emirates and areas, +971 validation, Emirates ID and TRN format checks, trade license field, Makani/P.O. Box address component | `gcc__areas` | — | P6 components | F4 (small) |
| M24 | `booking` | Schedules, slots, deposits, WhatsApp reminders; base for salons, clinics, fitness, home services | `booking__*` | M1, M15, M4 | P7 realtime | F7 |

Market rationale, starters (`booking`, `restaurant-ordering`, `shop`, `real-estate-crm`, `tourism-booking`, `invoice`, `membership`, `company-profile`), and verification items are in `21-uae-gcc-strategy.md`. M15–M24 join the waves as follows: M23 and M19 core in W2; M15 and M16 in W3; M17, M18, M22, M24 in W4–W5; M20 and M21 in W6.

#### M6 image pipeline

Originals are stored once; variants are produced on demand, cached, and served like static files. The tenant writes one tag (`<x-image>`, `08-template-engine.md`); the browser receives a small, correctly sized image in the best format it supports.

| Step | Behavior |
| --- | --- |
| Upload | Original stored in object storage; width, height, hash, and MIME recorded in `storage__files`; size and type limits enforced; EXIF/GPS stripped for privacy; SVG sanitized or rejected |
| Request `/_img/<id>?w=400&f=auto` | Gateway checks the variant cache. On a miss, a Rust op (`image` crate or libvips via FFI, decided in F7 by quality/speed) resizes, crops (`fit`, `focus`), and encodes: `f=auto` picks AVIF or WebP from `Accept`, else JPEG/PNG. The variant is stored as `<hash>-w400-avif` in object storage and recorded in `storage__variants` |
| Subsequent requests | Served from the variant cache with `Cache-Control: public, max-age=31536000, immutable` (URLs are content-addressed); never touches the tenant isolate |
| Allowed sizes | Only widths declared in `[storage.images] widths = [200, 400, 800, 1600]`; other values round to the nearest, which bounds the number of variants per original |
| `<x-image>` output | `src`, `srcset` for 1x/2x, `width`/`height` from metadata (no layout shift), `loading="lazy"`, `decoding="async"`, optional blur placeholder (tiny inline data URI) |
| Metering | Transform CPU is platform time; variant count and storage bytes are billed to the tenant; a per-tenant transform rate limit prevents abuse |
| Private images | Signed URLs with expiry for files not marked public; the same pipeline applies |
| Later | Focus-point cropping, watermarks, animated formats, video thumbnails |

### Module dependency graph

```
            M1 auth
          ┌───┼──────────┬───────────┬──────────┐
          ▼   ▼          ▼           ▼          ▼
       M2 org  M3 2fa   M6 storage  M8 audit   M9 notifications
          │                                        │
     ┌────┴────┐                                   │
     ▼         ▼                                   │
  M4 billing  M5 admin ◄── slots from M4, M6, M8, M9, M10
                                                   │
  M7 email ◄── events from M1, M4, M9 (no hard dependency; event subscriptions only)

  Independent of auth: M7 email, M10 jobs, M11 search, M12 i18n, M13 analytics
```

### Build order and parallelism

| Wave | Modules | Why together | Blocked by |
| --- | --- | --- | --- |
| W1 | **M1 `auth`** | Everything user-facing depends on it; also the first real test of services, hooks, migrations | P9 broker, P2 migrations, P11 `add` (F4) |
| W2 (parallel) | **M2 `org`**, **M7 `email`**, **M10 `jobs`** | M2 needs only M1; M7 and M10 need no other module, only platform events/outbox | W1 for M2; P9 events for M7/M10 |
| W3 (parallel) | **M3 `2fa`**, **M8 `audit`**, **M9 `notifications`** | All need M1 and platform authz/realtime; none needs each other | P8 authz, P7 realtime (F5) |
| W4 (parallel) | **M4 `billing`**, **M6 `storage`** | M4 needs M1+M2; M6 needs M1 and the storage op; they do not touch each other | W2 for M4; P1 storage op for M6 |
| W5 | **M5 `admin`** | Consumes slots from most modules; best built once M4/M6/M8/M9 exist to fill it | W3, W4 |
| W6 (parallel, optional) | M11 `search`, M12 `i18n`, M13 `analytics`, M14 `cms` | Independent, demand-driven | Platform features as listed |

### Definition of done for a module

1. `module.toml` with declared tables, permissions, config, services, events, hooks, slots, and authz actions.
2. Forward-only migrations with checksums; at least one versioned public view if other modules need its data.
3. Services with generated types; events documented with payload schemas.
4. Default Cedar policies and a policy test file.
5. Pages/partials use `r-can` for UI and `guard`/`authz.require` for enforcement; user-owned tables accessed via `db.scoped`.
6. Tests: unit (services), authorization (per role), template snapshots (per role), and an install/upgrade test against the `shop` example.
7. Documentation page under `modules/<name>/README.md`: install, config, permissions, services, events, hooks, slots, overrides.
8. Metered and within default quotas on the `shop` example (no regression on B6).

## Part C — Suggested agent assignment

When several agents work at once, assign by track and keep each PR inside one component:

| Agent | Scope | Must not touch |
| --- | --- | --- |
| Agent R1 | P1 runtime, P5 cell | `control/`, `modules/` |
| Agent R2 | P2 data, P6 template (leaf crates) | P1, P5 integration (hand over via contracts) |
| Agent R3 | P3 gateway, P4 meter, P7 realtime, P8 authz (leaf crates) | P1, P5 integration |
| Agent T1 | P10 SDK, P11 CLI | `crates/` internals beyond op contracts |
| Agent T2 | P12 API, P13 dashboard, P14 billing, P18 registry | `crates/`, `cli/` |
| Agent M1 | Official modules in the current wave | Platform crates; SDK changes go through Agent T1 |
| Agent O1 | P15–P17 ops, P19 benchmarks, P20 examples | Product code except test fixtures |

Hand-offs happen only through committed contracts and passing tests; see `AGENTS.md` for the PR rules.
