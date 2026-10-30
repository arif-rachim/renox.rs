# 19 — Platform wireframes: Renox as a hosting product

This document describes the user-facing surface of the hosting platform: the control-plane dashboard (`control/dashboard`, itself a Renox app), the CLI touchpoints, and the operator console. Wireframes are low-fidelity ASCII; they define information architecture and primary actions, not visual design.

Two audiences use the platform:

| Audience | Enters through | Main jobs |
| --- | --- | --- |
| Tenant developer | `app.renox.dev` + `renox` CLI | Create apps, deploy, install modules, read logs, manage data, secrets, domains, billing, team |
| Platform operator (us) | `ops.renox.dev` | Tenants, nodes, cells, abuse, incidents, revenue |

End users of tenant applications never see the Renox UI; they see the tenant's app on the tenant's domain.

## 1. Tenant journey

```
Sign up ──► Create app (template) ──► renox dev locally ──► renox deploy ──► Install modules
   │              │                                              │                 │
   │              └── or: import from git                        └── custom domain └── configure billing module
   ▼
First app live on <app>.renox.app within ~10 minutes
```

Activation metric: time from sign-up to first successful deploy (target ≤ 10 minutes with the `shop` template). Measured from the control plane by the funnel report (`control/api/src/signup/funnel.ts`, #326); the scripted run is `bench/results/2026-10-30-activation.md`.

## 2. Information architecture (tenant dashboard)

```
Top bar:   [Renox]  Org switcher ▾   Search ⌘K            Docs   Status   Notifications 🔔   Avatar ▾

Sidebar (org level)                 Sidebar (inside an app)
├── Overview                        ├── Overview
├── Apps                            ├── Deployments
├── Modules (installed/registry)    ├── Logs
├── Usage & billing                 ├── Metrics
├── Team                            ├── Modules
└── Settings                        ├── Database
                                    ├── Secrets & config
                                    ├── Domains
                                    ├── Realtime
                                    ├── Jobs
                                    └── Settings
```

URL scheme: `/o/<org>/apps/<app>/<section>`; every screen is linkable and htmx-driven (the dashboard is dogfooding the platform).

## 3. Screens

### 3.1 Org overview

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Acme Studio ▾                                             [ + New app ]      │
├──────────────────────────────────────────────────────────────────────────────┤
│ This month           Requests 1.2M   CPU 38 min   Egress 9.1 GB   Est. $11.40│
│ Plan: Starter · 3 apps · renews Nov 26                      [ Usage & billing]│
├──────────────────────────────────────────────────────────────────────────────┤
│ Apps                                                                         │
│ ┌────────────────────────┬────────────┬───────────┬──────────┬─────────────┐ │
│ │ shop                   │ ● healthy  │ v a1b2c3  │ 2m ago   │ shop.acme.id│ │
│ │ internal-crm           │ ● healthy  │ v 9f8e7d  │ 3d ago   │ crm.renox.app│
│ │ landing                │ ○ idle     │ v 44aa21  │ 12d ago  │ acme.id     │ │
│ └────────────────────────┴────────────┴───────────┴──────────┴─────────────┘ │
│ Recent activity                                                              │
│ • shop deployed a1b2c3 by alice (2m)   • billing module upgraded 1.2→1.3 (1d)│
└──────────────────────────────────────────────────────────────────────────────┘
```

Primary action: **New app**. Secondary: open an app, go to billing.

### 3.2 New app

```
┌──────────────── New app ────────────────┐
│ Name        [ shop                     ] │
│ Template    (•) Shop   ( ) SaaS   ( ) Blank   ( ) Import from Git │
│ Region      [ UAE (me-central) ▾ ]       │
│ Modules     [x] auth  [x] org  [ ] billing  [ ] admin  [ ] storage │
│                                          │
│ We will create shop.renox.app and show   │
│ you the CLI commands to run locally.     │
│                          [ Create app ]  │
└──────────────────────────────────────────┘
          │
          ▼
┌──────── shop created ────────────────────────────────────────┐
│ 1. bunx renox new shop --from acme/shop   (or: renox link)    │
│ 2. renox dev                                                   │
│ 3. renox deploy                                                │
│ Token: rnx_live_••••••••  [ Copy ]   (shown once)              │
└────────────────────────────────────────────────────────────────┘
```

### 3.3 App overview

```
┌ shop ───────────────────────────────────────────────── [ Open ↗ ] [ Deploy ▾ ] ┐
│ ● healthy · v a1b2c3 · deployed 2m ago by alice · shop.acme.id, shop.renox.app │
├──────────────────────────────────────────────────────────────────────────────┤
│ Last 24h    p50 2.1 ms   p99 14 ms   errors 0.02%   req 41k   cpu 1.9 min    │
│ [▁▂▃▅▂▁▂▃▇▅▃▂▁▂▃]  requests          [▁▁▂▁▁▁▁▂▁▁]  errors                   │
├──────────────────────────────────────────────────────────────────────────────┤
│ Cell          node-jkt-03 · isolate warm · SQLite 38 MB · 12 WS connections  │
│ Tier          Starter (own process) · limits: 500 ms CPU, 512 MB, 500 conc.  │
│ Modules       auth 1.4 · org 1.1 · billing 1.3 ↑1.4 available · admin 0.9    │
│ Alerts        none                                                            │
├──────────────────────────────────────────────────────────────────────────────┤
│ Recent deployments                                   Recent logs             │
│ a1b2c3  2m   alice   ✓ live        [Rollback]        12:01 GET /products 200 │
│ 9f8e7d  1d   alice   superseded    [Promote]         12:01 POST ?/addToCart  │
│ 44aa21  3d   bob     superseded                      11:59 WARN rate limit   │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 3.4 Deployments

```
┌ Deployments ──────────────────────────────────────── [ Deploy from Git ▾ ] ┐
│ Hash     When    By     Status       Size   Modules changed   Actions       │
│ a1b2c3   2m      alice  ● live       3.1 MB  —                [Logs][Rollback]│
│ 9f8e7d   1d      alice  superseded   3.0 MB  billing 1.2→1.3  [Promote][Diff]│
│ 44aa21   3d      bob    superseded   2.9 MB  —                [Promote]      │
│ 7c7c7c   5d      ci     ✗ rejected   —       route conflict   [Details]      │
├──────────────────────────────────────────────────────────────────────────────┤
│ Deployment a1b2c3                                                            │
│ Validation ✓ manifest ✓ templates (42) ✓ policies (7) ✓ routes (31) ✓ perms │
│ Permissions: network secure.telr.com; secrets BILLING_PROVIDER_KEY          │
│ Migrations applied: billing 004_add_coupon (12 ms)                           │
│ Artifact sha256:… [Download]      Rollback is a pointer switch (< 5 s)       │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 3.5 Logs

```
┌ Logs ───────── [ Live ● ] [ Level ▾ ] [ Route ▾ ] [ Search ________ ] [ 15m ▾ ] ┐
│ 12:01:33.120  INFO  req_7f3a  GET /products?q=shoe  200  2.3ms  cpu 0.4ms      │
│ 12:01:33.118  INFO  req_7f3a  [loader] 2 queries, 1.1ms                        │
│ 12:01:31.002  WARN  req_7e11  rate limit: /login from 103.x.x.x               │
│ 12:01:29.550  ERROR req_7d90  POST ?/refund  403  authz: invoice.refund denied │
│              ↳ forbid policy "refund-large-requires-manager"  [Explain]        │
│ 12:01:20.000  INFO  job     nightly-report finished in 840ms                   │
└───────────────────────────────────────────────────────────────────────────────┘
```

Each line expands to the trace (loader → queries → render) from OpenTelemetry. `[Explain]` opens the policy explanation (`renox authz explain` in the UI).

### 3.6 Metrics

```
┌ Metrics ───────────────────────────────── [ 1h ] [ 24h ] [ 7d ] [ 30d ] ┐
│ Requests/s      [line]        Latency p50/p99 [line]      Errors % [line] │
│ CPU ms/req      [line]        Isolate heap MB [line]      Egress   [bars] │
│ By route (24h)                                                            │
│  /products          18k   p50 2.0   p99 11    cpu 0.5   err 0.0%          │
│  /products/[id]     12k   p50 1.6   p99 9     cpu 0.3   err 0.1%          │
│  POST ?/addToCart    3k   p50 3.4   p99 19    cpu 1.1   err 0.3%          │
│ Quota usage:  CPU 38% ▓▓▓▓░░░░  Storage 38 MB / 1 GB  Connections 12/1000 │
└───────────────────────────────────────────────────────────────────────────┘
```

### 3.7 Modules (installed + registry)

An app's own back office (not the platform's) is the `admin` module: `modules/admin` (#335), with the sidebar and dashboard slots the other modules fill.

```
┌ Modules ─────────────────────────────────────────────── [ Browse registry ] ┐
│ Installed                                                                    │
│ auth     1.4.0   official   ✓ up to date            [Config] [Overrides: 2]  │
│ org      1.1.2   official   ✓ up to date            [Config]                 │
│ billing  1.3.0   official   ↑ 1.4.0 available       [Review upgrade]         │
│ reports  0.4.1   acme/reports  isolate mode         [Config] [Permissions]   │
├──────────────────────────────────────────────────────────────────────────────┤
│ Review upgrade: billing 1.3.0 → 1.4.0                                        │
│ Permission changes   + network checkout.tabby.ai (new)                       │
│ Migrations           005_usage_records (expand only, no data rewrite)        │
│ Contract changes     + service createCheckout(opts)   = no removals          │
│ Your overrides       pages/invoices/index.html changed upstream [View diff]  │
│                                        [ Cancel ]  [ Approve & deploy ]      │
└──────────────────────────────────────────────────────────────────────────────┘

┌ Registry ──────────── [ Search ______ ] [ Official ] [ Community ] [ Paid ] ┐
│ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐          │
│ │ billing      │ │ storage      │ │ cms          │ │ reports      │          │
│ │ official ✓   │ │ official ✓   │ │ community    │ │ acme · $5/mo │          │
│ │ Stripe, Telr,│ │ S3 uploads,  │ │ content      │ │ PDF reports  │          │
│ │ Tabby, VAT   │ │ images       │ │ types        │ │ signed ✓     │          │
│ │ [ Install ]  │ │ [ Install ]  │ │ [ Install ]  │ │ [ Install ]  │          │
│ └──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘          │
└──────────────────────────────────────────────────────────────────────────────┘
```

Install flow shows the permission review (network, tables, secrets, slots) before anything is written.

### 3.8 Database

```
┌ Database ──────── SQLite · 38 MB / 1 GB · WAL · Litestream ✓ (last 4s ago) ┐
│ [ Tables ] [ Query ] [ Migrations ] [ Backups ] [ Export ]                   │
│ Tables                                                                       │
│  auth__users (1,204)   auth__sessions (310)   org__orgs (41)                 │
│  billing__invoices (2,980)   shop__products (118)   shop__orders (4,301)      │
│  ▸ renox__outbox (3 pending)   renox__migrations                             │
├──────────────────────────────────────────────────────────────────────────────┤
│ Query (read-only by default)                               [ Allow writes ] │
│ > select id, name, stock from shop__products order by stock limit 5;        │
│ id        name              stock                                            │
│ p_1021    Running shoe 42   0                                                │
│ …                                                      12 ms · 5 rows        │
├──────────────────────────────────────────────────────────────────────────────┤
│ Backups: point-in-time restore to [ 2026-11-15 11:40 ▾ ]  [ Restore to new app ]│
│ Export: [ Download .db ] (full file)   Upgrade: [ Move to Postgres… ]        │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 3.9 Secrets & config

```
┌ Secrets & config ─────────────────────────────────────── [ + Add secret ] ┐
│ Name                    Used by          Version   Updated      Actions    │
│ BILLING_PROVIDER_KEY    billing          v3        2d ago       [Rotate]   │
│ RESEND_API_KEY          email            v1        30d ago      [Rotate]   │
│ Config (renox.toml, read-only here)                                        │
│  billing.provider = "telr"   app.timezone = "Asia/Dubai"                   │
│ Secrets are encrypted at rest, injected per deployment, never shown again. │
└────────────────────────────────────────────────────────────────────────────┘
```

### 3.10 Domains

```
┌ Domains ────────────────────────────────────────────── [ + Add domain ] ┐
│ shop.renox.app      default   ✓ TLS                                       │
│ shop.acme.id        custom    ✓ TLS (Let's Encrypt, renews Dec 10)        │
│ www.acme.id         custom    ⚠ DNS: add CNAME → edge.renox.app  [Recheck]│
└───────────────────────────────────────────────────────────────────────────┘
```

### 3.11 Realtime

```
┌ Realtime ───────────────────────────────────────────────────────────────┐
│ Connections now 12 (WS 9, SSE 3)   Messages/min 240   Topics 7           │
│ Topic              Subscribers   msg/min                                 │
│ room:general       6             180                                     │
│ user:u_1021        1             2                                       │
│ Limits: 1,000 connections, 64 KB/message, backpressure 1 MB/conn         │
└──────────────────────────────────────────────────────────────────────────┘
```

### 3.12 Jobs

```
┌ Jobs ────────────────────────────────────────────────────────────────────┐
│ Scheduled                                                                 │
│  nightly-report   0 2 * * *   last ✓ 840ms   next in 13h   [Run now]      │
│ Durable events (outbox)   pending 3   retrying 1   dead-letter 0          │
│  billing.invoice_paid → email  retry 2/8 in 4m  "connect timeout" [Retry] │
└───────────────────────────────────────────────────────────────────────────┘
```

### 3.13 Usage & billing (org level)

```
┌ Usage & billing ───────────────────────────── Plan: Starter [ Change plan ] ┐
│ Nov 1–15          Included          Used            Overage        Cost     │
│ Requests          1,000,000         1,214,000       214,000        $0.43    │
│ CPU time          30 min            38 min          8 min          $0.80    │
│ Egress            10 GB             9.1 GB          —              $0.00    │
│ Storage           1 GB              0.4 GB          —              $0.00    │
│ Realtime          100k conn-min     41k             —              $0.00    │
│ Base plan                                                          $5.00    │
│ Estimated total                                                    $6.23    │
│ By app: shop $5.10 · internal-crm $0.90 · landing $0.23                     │
│ Payment method: •••• 4242 [Change]   Invoices: [Oct] [Sep] …                │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 3.14 Team

```
┌ Team ──────────────────────────────────────────────────── [ + Invite ] ┐
│ alice@acme.id     Owner      2FA ✓     all apps                           │
│ bob@acme.id       Developer  2FA ✓     shop, internal-crm     [Edit]     │
│ ci@acme.id        Deploy token         shop                   [Revoke]   │
└──────────────────────────────────────────────────────────────────────────┘
```

Roles: Owner, Admin, Developer, Viewer, plus deploy tokens scoped per app. The dashboard uses the same `auth`, `org`, and `2fa` modules it ships to tenants.

### 3.15 App settings

Tier selection, region, idle timeout, limits (within tier), delete app (with export prompt), transfer to another org, danger zone.

## 4. CLI touchpoints (what the terminal shows)

```
$ renox deploy
  Bundling… 312 modules, 42 templates, 7 policies            1.9s
  Uploading 3.1 MB → app.renox.dev                            0.8s
  Validating… ✓ manifest ✓ templates ✓ policies ✓ routes ✓ permissions
  Migrations: billing 004_add_coupon ✓                        12ms
  Live: https://shop.acme.id  (a1b2c3)                        total 6.4s
  Rollback: renox deploy --rollback 9f8e7d

$ renox logs --follow
$ renox authz explain --user alice --action invoice.refund --resource inv_123
$ renox db export > shop.db
```

## 5. Operator console (`ops.renox.dev`)

```
┌ Fleet ───────────────────────────────────────────────────────────────────────┐
│ Nodes 6 · Cells warm 1,840 · Tenants 4,120 · req/s 3,200 · errors 0.03%       │
│ Node          CPU   RAM        Warm cells   Disk     Tier mix       Status    │
│ node-jkt-01   41%   5.1/8 GB   310          44%      free 280/paid 30 ● ok    │
│ node-jkt-02   77%   6.9/8 GB   402          61%      free 360/paid 42 ⚠ hot   │
│ node-jkt-03   22%   3.0/8 GB   188          30%      paid 188        ● ok     │
│ [Drain node] [Rebalance] [Cordon]                                             │
├──────────────────────────────────────────────────────────────────────────────┤
│ Tenants  [ Search ] [ Tier ▾ ] [ Flags: abuse, over-quota, failing ]          │
│ acme     Starter   3 apps   $6.23 MTD   ok                                     │
│ zzz-mine Free      1 app    CPU 100% of quota, egress spike   🚩 [Review]      │
├──────────────────────────────────────────────────────────────────────────────┤
│ Incidents  · Deploy failures (24h) 3  · Isolate terminations 41  · OOM 2       │
│ Revenue    MRR $1,820 · paying tenants 212 · churn 2.1%                        │
└──────────────────────────────────────────────────────────────────────────────┘
```

Operator actions: move a tenant to another node, change tier, suspend, move to microVM, disable a module hash globally, impersonate (break-glass, logged), issue credits.

## 6. Design rules for the dashboard

- Built with Renox itself: templates, htmx fragments, SSE for live logs and metrics. If it feels slow to us, it will feel slow to tenants.
- Every table is a fragment with server-side paging; every live number is an SSE stream.
- Every destructive action shows what will happen (rollback target, permission diff, export before delete) and is audit-logged.
- Mobile-usable: deploy status, logs, and rollback must work from a phone.
- Public status page and per-app health endpoint for tenants' own monitoring.
