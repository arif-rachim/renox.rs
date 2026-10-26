# 05 — Tenant code lifecycle

Tenant code becomes an immutable artifact referenced by hash. There is no build, npm install, or filesystem access at runtime; all dependencies are frozen at deploy time.

## Deploy pipeline

```
renox deploy
  │
  ├─ 1. CLI bundles the code: TS → JS (swc), npm: and node: imports resolved,
  │     output = one eszip archive + manifest + templates transpiled to minijinja + Cedar policies
  │
  ├─ 2. Upload to the control plane (POST /v1/deployments) with the tenant token
  │
  ├─ 3. Control plane validates: bundle size, manifest, requested permissions
  │     (network, secrets, modules), templates and policies against schemas, route conflicts
  │
  ├─ 4. Artifact stored in object storage, content-addressed: sha256(bundle). Never overwritten.
  │
  ├─ 5. Deployment recorded in Postgres: tenant, hash, approved permissions, secret version
  │
  └─ 6. Route table updated via pub/sub: tenant hostname → new hash.
        Rollback = move the pointer back to an old hash. No rebuild.
```

### Artifact contents

| Part | Format | Produced by |
| --- | --- | --- |
| Code | eszip (Deno's module archive) with V8 code cache | CLI (swc, deno bundler) |
| Templates | minijinja source per page/partial/layout, plus a fragment map | CLI (`renox-template` transpiler, compiled to Wasm for the CLI or invoked via the embedded worker) |
| Policies | Cedar policy set + schema | CLI |
| Manifest | `renox.toml` resolved + `renox.lock` + route table + permission requests | CLI |
| Migrations | SQL files per module with checksums | Copied verbatim |
| Public assets | `public/` tree with content hashes | Copied verbatim; served by the gateway |

## Routing and cold start

1. The gateway maps hostname → tenant → deployment hash (in-memory cache, invalidated via pub/sub).
2. The request is routed to the worker node that owns the tenant's cell (consistent hashing), so the isolate stays warm and the SQLite file is local.
3. On a cold start, the worker fetches the artifact from its disk cache or object storage, verifies the hash, creates an isolate from the platform snapshot, and loads the tenant module from eszip with the V8 code cache. Target: single-digit to tens of milliseconds.
4. The isolate stays warm. After an idle timeout (default 10 minutes), the isolate is evicted and the SQLite file closed. This is per-tenant scale-to-zero.

Deployment switch: the new isolate is created alongside the old one; new requests go to the new deployment; in-flight requests finish on the old one; the old isolate is evicted after they drain.

## Custom domains and DNS

Every app gets `<app>.renox.app` and per-deployment preview hosts (`<app>-<hash>.renox.app`). Tenants attach their own domains without transferring them; Renox never needs to be the registrar or DNS provider. Routing is by hostname (SNI and `Host`), so a custom domain is one more row in the gateway's route table.

### Attaching a domain

| Step | Tenant | Renox |
| --- | --- | --- |
| 1. Add | Dashboard, `renox domains add www.example.com`, or the MCP tool `add_domain` | Creates a verification token and shows DNS instructions |
| 2. Verify ownership | `TXT _renox-verify.example.com = rnx-verify-<token>` | Polls until it matches. The hostname is **not served** before verification (prevents domain takeover) |
| 3. Point traffic | `www` → `CNAME edge.renox.app`; apex (`example.com`) → `ALIAS`/`ANAME` where the DNS provider supports it, otherwise `A`/`AAAA` records to Renox anycast IPs | Watches propagation; shows "DNS: ok / pending" |
| 4. Certificate | Nothing | ACME (Let's Encrypt): HTTP-01 for hostnames, DNS-01 for wildcards; renewal 30 days before expiry; issuance queued to respect rate limits |
| 5. Live | Opens `https://www.example.com` | Serves with the right certificate; apex ↔ `www` redirect per the tenant's canonical choice |

### Supported cases

| Case | Support |
| --- | --- |
| Several domains per app | Yes; one canonical, others 301 |
| Domain proxied by Cloudflare | Yes; certificates still issued; Cloudflare connects to Renox over TLS |
| Wildcard (`*.example.com`) for tenants building their own multi-tenant SaaS | Yes; requires DNS-01 via a one-time `CNAME _acme-challenge.example.com → acme.renox.app`; one certificate covers all subdomains |
| Domains owned by the tenant's own customers (Shopify-style `shopbudi.com` → tenant app) | Yes, via the **Domains API** from inside the app: `ctx.domains.add("shopbudi.com", { route: "/stores/budi" })`; the tenant app shows the DNS instructions to its customer; verification and certificates work the same way; metered per domain |
| Other records (MX, unrelated subdomains) | Untouched; Renox only asks for records of registered hostnames |
| Buying domains through Renox | Not initially; possible later through a registrar partner |

### Security

- Verification before serving; the verification record must stay in place (re-checked periodically) or serving stops after a grace period.
- Certificates and private keys are stored encrypted in the control plane and pushed to gateways; keys never enter a tenant cell.
- CAA guidance in the instructions (`0 issue "letsencrypt.org"`).
- HSTS is enabled after the first certificate; tenants may disable it on custom domains (not on `*.renox.app`).
- Domains that stop pointing at Renox are flagged and their renewals paused; serving resumes automatically when DNS points back.

## Secrets and data access

- Secrets are injected as frozen objects via a Rust op at isolate creation (`04-isolation-security.md`).
- The tenant receives only a `db` handle bound to its own file. There are no raw paths or connection strings on the tenant side.

## Metering and billing

Each invocation emits one record:

```
tenant_id, deployment_hash, route_or_function, started_at,
cpu_ms, wall_ms, peak_heap_bytes, egress_bytes, db_ms, db_rows, render_fuel, status
```

Records are batched per cell and shipped to the control plane, where they are aggregated hourly into billing tables. Realtime connections are metered by connection-seconds and messages. Storage is metered by file size at the end of each hour.

Tenant `console.log` output is streamed to a per-tenant sink with a volume limit; it is visible in the dashboard and through `renox logs --follow`.

## Marketplace modules

- Publishers sign modules (Ed25519); the registry stores hash and signature; tenants can only install modules whose verification passes.
- Permissions are reviewed at install ("requests access to `api.stripe.com`, tables `billing__*`, slot `admin.sidebar`"), and permission diffs must be approved again on upgrade.
- Marketplace modules run in `isolate` mode and see no tenant secrets except those declared and approved.
- A module hash proven malicious can be disabled globally; tenants using it are notified.

## Lifecycle states

| State | Meaning | Transition |
| --- | --- | --- |
| `uploaded` | Bundle received, not yet validated | → `validated` or `rejected` |
| `validated` | Passed validation, artifact stored | → `active` on activation |
| `active` | Route table points here | → `superseded` when a newer deployment is activated |
| `superseded` | Retained for rollback | → `active` on rollback; → `pruned` after the retention limit |
| `suspended` | Tenant suspended (billing, abuse) | → `active` on reinstatement |

## What we build vs what exists

| Component | Status |
| --- | --- |
| Isolates, snapshots, heap/CPU limits, eszip, `npm:`/`node:` | **Exists** in Supabase Edge Runtime / `deno_runtime` |
| Process sandbox (seccomp, cgroups), process tiers, microVM | OS configuration + orchestration; examples from Cloudflare and Fly.io, but must be assembled |
| Control plane: deploy API, artifact store, route table, secrets, billing | **Must be built.** This is the largest part of our work and the part that differentiates the product |
| Module registry, signatures, permission review | Must be built, later phase |
