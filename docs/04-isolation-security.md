# 04 — Isolation and security

The full threat model per trust boundary, with the proving test for each control and the per-phase security checklist, is `24-threat-model.md`; this document describes the isolation design.

Security is the product. A tenant must not be able to read another tenant's data, exhaust another tenant's resources, reach our internal infrastructure, or persist code we did not validate. Every layer below assumes the layer above it will eventually fail.

## Isolation hierarchy

```
Node worker (one Rust process tree per node)
└── Sandboxed process per tier             OS limits: cgroups (CPU, RAM, pids), namespaces, seccomp/Landlock
    ├── free tier: many tenants share a process
    └── paid tier: one process per tenant
        └── V8 isolate per deployment      V8 limits: heap limit, CPU watchdog, op permissions
            ├── context: shared (app + own modules)
            ├── isolate: marketplace module (own heap limit, own permissions)
            └── SQLite file per tenant     authorizer per module connection
```

| Layer | Created when | Approximate cost | Limits enforced |
| --- | --- | --- | --- |
| Sandboxed process | Per tier (free: shared; paid: per tenant) | Tens of MB per process | cgroup CPU/RAM/pids, seccomp, namespaces, no network except through the gateway proxy |
| V8 isolate | Per tenant per deployment, on first request | Target 2–10 MB idle, created from snapshot in ms | Heap limit, CPU watchdog, op permissions (`fetch`, `db`, `secret`, `render`, `realtime`) |
| Module context | `shared` mode: one; `isolate` mode: separate isolate | Hundreds of KB | Table authorizer, network allowlist per module |
| Request | Every request | Function call | Deadline, concurrency semaphore per deployment |
| SQLite file | Opened with the isolate, closed on idle | Page cache as configured | Authorizer, `busy_timeout`, statement time limit, file size quota |

## Per-tenant limits

| Limit | Mechanism | Default (free / paid) |
| --- | --- | --- |
| CPU per request | Watchdog thread → `TerminateExecution`; isolate recycled afterwards | 50 ms / 500 ms |
| Wall-clock per request | Deadline in context; I/O cancelled | 30 s / 60 s |
| Memory | V8 heap limit per isolate + cgroup per process | 128 MB / 512 MB |
| Concurrent requests | Semaphore per deployment | 50 / 500 |
| Gateway input (per client, before any tenant code) | hyper header limits, body limit before dispatch, header read and idle timeouts, connection cap per client IP (`crates/renox-gateway`, `limits.rs`) | Headers 16 KB and 100 per request (431); body 1 MB, webhooks 5 MB (413 `RENOX_BODY_TOO_LARGE`); request head and TLS handshake 10 s; idle connection 60 s; 100 connections per IP (503) |
| Outbound network | Allowlist in the `fetch` op; private/loopback/link-local/metadata ranges blocked; egress byte limit | Declared hosts only |
| Filesystem | None; only the platform storage API | — |
| Bundle size and versions | Validated at deploy | 20 MB, 50 versions retained |
| Database | Small connection pool per tenant, `busy_timeout`, statement time limit, file size quota | 100 MB / 10 GB |
| Render | minijinja fuel, iteration limit, output size limit, include depth, render timeout | Charged to the tenant quota |
| Realtime | Connections per tenant and per user, message size, backpressure | 100 / 10,000 connections |
| Logs | Volume per tenant per minute | Rate limited, then sampled |
| Client events (`/__renox/events`) | Body size, events per batch, requests per IP, events per tenant per minute and per day | Dropped and counted; the endpoint always answers 204 and never reaches the isolate (`docs/contracts/client-events.md` section 7) |

All limits are measured per request and recorded for billing (`05-tenant-lifecycle.md`).

## Defense in depth

| Layer | Protects against |
| --- | --- |
| Isolate + heap limit + watchdog | A tenant consuming another tenant's CPU or memory |
| `SharedArrayBuffer` disabled, timers coarsened | Side-channel attacks (Spectre-class) between isolates |
| Sandboxed process (seccomp/Landlock, namespaces, cgroups) | A V8 bug allowing escape from an isolate |
| Process tiers: free shared, paid per tenant, suspicious → microVM (Firecracker) | Blast radius when one layer fails |
| SQLite file per tenant + authorizer | Queries crossing tenants or modules |
| Immutable bundles, no npm or filesystem access at runtime | Supply-chain changes after deploy |
| Private-address and metadata-endpoint blocking in `fetch` | SSRF into our infrastructure |
| Secrets injected per deployment as frozen objects via an op | Secrets leaking through bundles, logs, or errors |
| Append-only audit log | Forensics after an incident |

## Threat model (summary)

| Threat | Actor | Primary control | Secondary control | Test |
| --- | --- | --- | --- | --- |
| Read another tenant's data | Malicious tenant | File per tenant; tenant id from routing, never from input | Authorizer; process isolation per tier | Attempt cross-tenant query → rejected |
| Exhaust CPU | Malicious or buggy tenant | Watchdog + terminate | cgroup per process; scheduler avoids busy workers | Infinite loop → terminated at limit, neighbor latency unchanged |
| Exhaust memory | Same | Heap limit | cgroup; isolate recycled | Unbounded allocation → OOM in isolate only |
| SSRF to metadata / internal services | Malicious tenant | `fetch` blocks private ranges and resolves DNS before checking | Egress through a proxy with the same rules | `fetch("http://169.254.169.254")` → rejected |
| Template DoS | Malicious tenant | Fuel, iteration and output limits | Render timeout charged to quota | Nested 10k×10k loop → stops at fuel |
| Escape from V8 | Sophisticated attacker | Process sandbox (seccomp, namespaces) | Tier separation; fast V8 updates via Deno releases | Periodic review; bug bounty after launch |
| Malicious marketplace module | Module publisher | Signature verification; permission review at install; `isolate` mode | Global disable by hash; tenant notification | Install unsigned module → rejected |
| Secret exfiltration | Malicious tenant code | Secrets only injected when declared; never serialized to logs | Allowlisted egress hosts | Secret in `console.log` → redacted |
| Supply chain | Compromised npm package | Dependencies frozen into the artifact at deploy; hash-addressed | Future: SBOM and advisory scanning at deploy | Artifact hash mismatch → refused |
| Abuse of the platform (spam, mining) | Malicious tenant | CPU quotas, egress quotas, rate limits | Abuse detection on meters; move to microVM; suspend | Meter anomalies → alert |

## Secrets

- Stored encrypted with envelope encryption (a per-tenant data key wrapped by a KMS or master key), versioned, rotatable.
- Injected into the isolate as a frozen object through a Rust op at isolate creation; never part of the bundle.
- Redaction: any string equal to a known secret value is masked in logs and error messages.
- Marketplace modules see only the secrets they declare and the tenant approved.

## Web-layer protections (for tenant applications)

Browser-facing protections are enforced by the gateway and the template engine, configured in `renox.toml`, never hand-written as middleware by tenants. Modules declare what they need (for example a CSP source for a payment widget) in their manifest; the tenant approves it at install and the gateway merges it.

| Protection | Default | Configuration |
| --- | --- | --- |
| CORS | Closed: only the app's own origins. SSR + htmx pages need no CORS at all | `[security.cors] origins = ["https://partner.example"]`, `methods`, `headers`, `credentials`; overridable per function via `export const cors = {...}` |
| CSP | Strict: `default-src 'self'`; scripts and styles from `'self'` plus a per-request nonce that the template engine injects into every `<script>`/`<style>` it emits; htmx, Alpine, and islands bundles are allowed; `frame-ancestors 'none'`; `object-src 'none'`; `upgrade-insecure-requests` | `[security.csp] script_src += ["https://js.stripe.com", "https://checkout.tabby.ai"]` and the same for `img_src`, `connect_src`, `frame_src`, `font_src`. `unsafe-inline` and `unsafe-eval` are refused unless `allow_unsafe = true` is set explicitly and is flagged in the dashboard. Report-only mode is available; violation reports go to `/__renox/events?kind=csp` on the app's own origin, under the client-event limits and privacy rules (`docs/contracts/client-events.md` sections 6–8) |
| HSTS | On, `max-age=31536000; includeSubDomains`; preload on request | Cannot be disabled on `*.renox.app` |
| Clickjacking | `X-Frame-Options: DENY` + `frame-ancestors 'none'` | Per page: `export const frame = { ancestors: ["https://host.example"] }` for embeddable widgets |
| Other headers | `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` denying camera/microphone/geolocation by default, `Cross-Origin-Opener-Policy: same-origin` | `[security.headers]` |
| CSRF | Token required for every non-GET action; htmx sends it automatically via a header; double-submit cookie pattern bound to the session | Webhook routes and API-key/JWT-authenticated functions are exempt automatically |
| BREACH | Compression stays on for HTML (#159): every CSRF token written into a response body is masked per response, `base64url(mask \|\| mask XOR token)` with 32 fresh random bytes, so compressed pages never repeat the secret; the cell unmasks the submitted token before the constant-time check (#111). Open redirects: `redirect.safe(target, { allow })` from `renox` redirects only to the app's own paths or allowlisted origins, and `renox check` fails on a redirect to a target taken from the request (`no-unsafe-redirect`). Secret comparisons in tenant code use `timingSafeEqual` | — |
| Cookies | `HttpOnly`, `Secure`, `SameSite=Lax`, `__Host-` prefix on the session cookie | `SameSite=None` only when CORS with credentials is enabled |
| Rate limiting | Per IP, per user, and per route at the gateway; stricter buckets for login, registration, password reset, and webhooks | `[security.ratelimit]` per route |
| Input validation | `validate(req, Schema)` (zod/valibot) before handler bodies; file uploads limited by size and type | Per handler |
| Output escaping | Templates auto-escape; raw HTML only via explicit `r-html`; URLs in `:href` are checked for `javascript:` | — |
| TLS | Automatic certificates (ACME) for `*.renox.app` and custom domains; TLS 1.2+; OCSP stapling | — |

All of these are measured by `renox check --security`, which reports the effective headers for each route and fails on `unsafe-inline` without an explicit opt-in.

## Operational security

- Deploy, secret changes, permission grants, and role changes are audit-logged in the control plane.
- Platform operators access tenant data only through break-glass procedures that are logged.
- Node images are immutable; the data plane runs as an unprivileged user; tenant files are owned by that user and not world-readable.
