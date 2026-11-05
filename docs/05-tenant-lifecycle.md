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
  │     (network, secrets, modules), templates and policies against schemas, route conflicts,
  │     bundle hygiene (forbidden files, secrets; below)
  │
  ├─ 4. Artifact stored in object storage, content-addressed: sha256(bundle). Never overwritten.
  │
  ├─ 5. Deployment recorded in Postgres: tenant, hash, approved permissions, secret version
  │
  └─ 6. Route table updated via pub/sub: tenant hostname → new hash.
        Rollback = move the pointer back to an old hash. No rebuild.
```

### Bundle hygiene

The same rules run in `renox build` and in the control plane's validation (`@renox/artifact-validate`, #115), so the artifact store never holds a known secret or a stray private file (`docs/24-threat-model.md` sections B and C):

- **Forbidden files** (H1): dotfiles and dot-directories (`.env*`, `.git/`, editor folders) except `public/.well-known/`; `node_modules/` outside the bundle; keys and certificates (`*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`); databases (`*.db`, `*.sqlite`); `*.log`; symbolic links; `public/` files over 5 MiB (those belong in storage). `renox build` leaves them out of `public/` and says so; an upload holding one is rejected.
- **Secrets** (H2): private key blocks, AWS access key ids, GitHub tokens, Stripe live keys, Slack tokens and webhooks, Google API keys, unsigned JWTs, and high-entropy strings assigned to names like `secret`, `token`, `key`, `password`. `renox build` and `renox check --secrets` scan the project's own bundled sources and the files copied as they are, and fail with file and line; the control plane scans the files stored as they are (`public/`, `migrations/`, `templates/`). A line that must keep such a string carries `renox-allow-secret: <reason>`. Findings name the pattern and a masked prefix, never the value.
- A rejected upload is never written to the artifact bucket.

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

Every app gets `<app>.renoxium.app` and per-deployment preview hosts (`<app>-<hash>.renoxium.app`); `renoxium.app` serves tenant apps only, and the platform's own services live on `renoxium.com` (`docs/contracts/README.md`, "Domains"). Tenants attach their own domains without transferring them; Renoxium never needs to be the registrar or DNS provider. Every custom domain is a **Cloudflare for SaaS** custom hostname on the platform domain's zone (ADR D25): Cloudflare proves ownership, issues and renews the certificate, terminates TLS and forwards the request through the tunnel to the worker, which routes by `Host`. A custom domain is one more row in the gateway's route table.

### Attaching a domain

| Step | Tenant | Renoxium |
| --- | --- | --- |
| 1. Add | Dashboard (the app's Domains page), `renox domains add www.example.com` (then `renox domains status www.example.com`), or the MCP tool `add_domain` (with `list_domains`, `domain_status`, `remove_domain`) | Creates the custom hostname at Cloudflare and shows the records to create (`verification`) and the CNAME target. Without Cloudflare configured: 503 |
| 2. Verify ownership and point traffic | Cloudflare's ownership TXT (`_cf-custom-hostname.www.example.com`), the certificate's DCV TXT, and `www` → `CNAME renoxium.app` | Reads the custom hostname every minute until Cloudflare reports it `active`. The hostname is **not served** before (prevents domain takeover) |
| 3. Certificate | Nothing | Cloudflare issues and renews the edge certificate |
| 4. Live | Opens `https://www.example.com` | Served through Cloudflare and the tunnel |

**Apex domains.** There is no address to give: the origin is behind the tunnel. Use `www.<domain>` and redirect the apex to it at the DNS provider or registrar; CNAME flattening (`ALIAS`/`ANAME`) works where the DNS provider offers it. No A record is offered.

### Supported cases

| Case | Support |
| --- | --- |
| Several domains per app | Yes; one canonical, others 301 |
| Domain whose own zone is proxied by Cloudflare | Through Cloudflare's Orange-to-Orange rules for SaaS; to verify per customer. The platform's own `renoxium.com` names use DNS-only CNAMEs to `renoxium.app` to stay on the plain path (D25, D26) |
| Wildcard (`*.example.com`) | Not offered: the contract's `Hostname` has no `*.` form |
| Domains owned by the tenant's own customers (Shopify-style `shopbudi.com` → tenant app) | Planned, via the **Domains API** from inside the app: `ctx.domains.add("shopbudi.com", { route: "/stores/budi" })`, the same custom hostname path; metered per domain |
| Other records (MX, unrelated subdomains) | Untouched; Renoxium only asks for records of registered hostnames |
| Buying domains through Renoxium | Not initially; possible later through a registrar partner |

### Security

- Not served before Cloudflare reports the custom hostname active; afterwards it is read every hour, and serving stops only after consecutive negative answers (`moved`, `deleted`, `blocked`) over a grace period. An API error is never taken as a negative answer. Serving resumes automatically when the hostname is active again.
- No certificate or private key is held by the platform: Cloudflare holds them. Cloudflare sees request content in clear and is a sub-processor (DPA).
- HSTS is sent on every response that came through the edge over HTTPS (D25); tenants may disable it on custom domains, not on `*.renoxium.app`.
- A released hostname's custom hostname is deleted at Cloudflare; one owner per hostname and a 30-day hold after removal prevent takeover.

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
