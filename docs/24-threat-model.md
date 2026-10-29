# 24 — Threat model and security plan

`04-isolation-security.md` describes the isolation design and the controls that protect one tenant from another and the platform from a tenant. This document widens the view to every trust boundary the product has, lists the threats per boundary with the control that stops them and the test that proves it, and defines the security process (per-phase checklist, PR review, disclosure, incidents). It is the source for the `security checklist` issue that blocks every phase gate, next to the negative path checklist from `23-failure-modes.md`.

Rules:

1. A control without a test is not a control. Every row below names its proof; a row without one is `TODO` with the issue that owns it.
2. Security controls live in Rust or in the control plane, never as a convention tenant code is asked to follow. The SDK may offer helpers, but the platform must be safe when they are not used.
3. Fail closed. A missing policy, an unknown host, an unverified domain, an unsigned module, an unparseable header, a missing CSRF token: all of these deny.
4. Every security-relevant decision (what was allowed, what was denied, who did it) is logged with `tenant_id` and `request_id`, and the logs cannot be edited by the tenant.
5. No secret value ever leaves the process that needs it: not in logs, errors, bundles, responses, backups in clear, or CI output.

Columns: **Threat** · **Primary control** · **Secondary control** · **Proof** · **Phase**.

## Trust boundaries

```
 Internet ──(A)──► tenant application ──(B)──► platform (node, control plane)
 tenant X ──(C)──► tenant Y                  module publisher ──(D)──► tenant
 Internet ──(E)──► control plane (accounts, API, dashboard, MCP)
 upstream deps, CI, releases ──(F)──► us     operator / insider ──(G)──► tenant data
 AI agents ──(H)──► tenant app and platform
```

## A. End user → tenant application (web layer)

| Threat | Primary control | Secondary control | Proof | Phase |
| --- | --- | --- | --- | --- |
| XSS through template data | Auto-escape in minijinja; raw only via `r-html`; `javascript:` refused in `:href` | Strict CSP with per-request nonce | template tests; `renox check --security` | F2 |
| CSRF on actions | Token on every non-GET action, double-submit bound to the session | `SameSite=Lax`, `__Host-` cookie | pages tests (#41) | F2 |
| BREACH: CSRF token recovered through compressed responses | Token masked per response (random XOR mask), so the same secret never repeats in a compressed body | No compression for responses that embed tokens when masking is unavailable | `TODO` → #111 | F2 |
| Clickjacking, MIME sniffing, referrer leaks | Default header set (`frame-ancestors 'none'`, `nosniff`, `Referrer-Policy`) | `renox check --security` prints effective headers per route | gateway tests (#47) | F2 |
| Open redirect via `next`/`return_to` | `redirect.safe()` SDK helper: same-origin or allowlisted only; `auth` module uses it everywhere | `renox check` lint on `Response.redirect(url.searchParams…)` | `TODO` → #111; auth tests (#117) | F2/F4 |
| Login brute force, credential stuffing, enumeration | Stricter buckets on login/register/reset; identical responses for unknown and wrong password; argon2id | `2fa` module; lockout with notification | auth negative tests (#100) | F4 |
| Session fixation, token replay, reset-token reuse, OAuth `state`/PKCE | Session rotated on login; single-use tokens; `state` and PKCE verified | Session absolute and idle expiry | #100 | F4 |
| Cross-site WebSocket hijacking (CSWSH) | `Origin` must match the app's origins on upgrade; auth at connect from the session cookie | Per-topic `realtime.authorize` hook | `TODO` → #118 (`docs/contracts/ops.md` §18, "`Origin` and authentication at connect") | F5 |
| Subscribing to another user's topic | `realtime.authorize` hook, fail closed when absent | Topic names derived from the principal, never from input alone | #118 (`docs/contracts/ops.md` §18, "Authorization: topics as Cedar resources") | F5 |
| Mass assignment / unvalidated input | `validate(req, Schema)` before handler bodies | Lint warns on `await req.json()` without a schema | SDK tests (#44) | F2 |
| Timing attacks on signature or token comparison | Constant-time compare in `webhook.verify`, CSRF check, token check | Helper exported by the SDK | #111 | F2 |
| Payment widget needs third-party scripts | Module manifest declares CSP sources; tenant approves at install; gateway merges | `allow_unsafe` flagged in the dashboard | #47 | F2 |

## B. Tenant code → platform

| Threat | Primary control | Secondary control | Proof | Phase |
| --- | --- | --- | --- | --- |
| CPU, memory, wall-clock exhaustion | Watchdog, heap limit, deadline, semaphore (all in Rust) | cgroup per process | #26, B12 | F1 |
| SSRF to metadata, loopback, private ranges | Resolve DNS, check every IP, then connect to the checked IP (no second resolution); every redirect hop re-checked | Egress proxy with the same rules | #27; DNS pinning #108 (`crates/renox-runtime/tests/fetch_rebinding.rs`) | F1 |
| Tenant code reaches the control plane's node-facing endpoints (route tables, secret bundles, artifacts, certificates, ingestion), control-plane isolation | Two listeners (ADR D23): the public one 404s `/v1/nodes/*` and `/v1/ingest/*` before any handler runs, the node one serves only those (`control/api/src/app.ts`, `main.ts`); a controlled worker refuses to start when `[control] url` resolves to an address tenant `fetch` could reach (not private, not in `fetch_blocked_addresses`) | `renox_node_` token on every node endpoint; the public API address is neither blocked nor exempt, so internal tenants get no extra reach | #218 (`control/api/tests/node-surface.test.ts`, `crates/renox-cell/tests/controlled.rs` `control_url_reachable_by_tenant_fetch_refuses_to_start`) | F3 |
| DNS rebinding on `fetch` (TOCTOU between check and connect) | Connect to the already-validated socket address; happy-eyeballs disabled for tenant fetch | TTL ignored for policy purposes | #108 | F1 |
| TLS downgrade or invalid certificate on `fetch` | rustls with webpki roots; no `insecure` option for tenants; HTTP only when the host is explicitly declared with `http://` | — | #108 | F1 |
| Secrets in logs, errors, bundle, responses | Secrets injected as a frozen object by an op; redaction on every log and error path | Bundle hygiene (`docs/contracts/deploy-api.md` 0.1 section 4): `renox build` scans the sources before bundling and refuses on a finding; at upload the control plane refuses forbidden files anywhere (H1) and secrets in files stored as they are, `public/`, `migrations/`, `templates/` (H2). `code/` is scanned by the CLI only (bundling strips the allow markers, vendored SDKs give false positives, and `code/` is never served); a hand-built `code/` with a secret is an accepted residual risk | #28; #115 (`control/api/tests/bundle.test.ts`, `packages/artifact-validate/tests/hygiene.test.ts`) | F1/F3 |
| Cross-module table access | SQLite authorizer per module prefix at prepare time | `db.scoped` for module code | #19 | F1 |
| Code persisted without validation | Immutable, hash-addressed artifacts; validation in the control plane; no filesystem or npm at runtime | Worker verifies the hash before loading | #30, #52 | F1/F3 |
| Isolate escape (V8 bug) | Sandboxed process: the worker applies its own seccomp allowlist (traced, `crates/renox-cell/sandbox/syscalls.<arch>.txt`, kill on a miss) and Landlock rules (its own dirs only; TCP connect and bind by port with ABI 4) at start, `[sandbox]` required in controlled mode (#253); systemd units with `NoNewPrivileges`, `ProtectSystem=strict` and per-tier cgroup slices (`ops/systemd`, #252) | Tier separation; suspicious → microVM; V8 updates within days of a Deno release | #253 (`crates/renox-cell/tests/sandbox.rs`: `/etc/passwd` and 169.254.169.254 refused with the profile applied, a database tenant served under `enforce`; the suite under `RENOX_TEST_SANDBOX=enforce`); #254 (`crates/renox-cell/tests/supervisor.rs`: a paid tenant in a child process of its own, which refuses other tenants with 403, with its own cgroup limits and its data dir only); #75; pentest | F6 |
| Side channels between isolates | `SharedArrayBuffer` off, coarse timers | Paid tier: one process per tenant | runtime config test | F1/F6 |
| Realtime fan-out amplification | Per-connection and per-tenant limits, backpressure | Fan-out outside the isolate | B14 (`docs/contracts/ops.md` §18, "Limits" and "Metering") | F5 |
| Scheduled job runs as a privileged principal | Jobs run as `System::"app"` with explicit permissions only | Charged to the tenant quota | jobs tests | F6 |

## C. Tenant → tenant

| Threat | Primary control | Secondary control | Proof | Phase |
| --- | --- | --- | --- | --- |
| Reading another tenant's data | File per tenant; tenant id from routing, never from input | Authorizer; process isolation per tier | cross-tenant test | F1 |
| Host/SNI confusion: TLS for tenant A, `Host` for tenant B | Routing uses the `Host` header after TLS; SNI and `Host` must name the same tenant or the request is refused | Certificates per hostname only | `TODO` → #107 | F2 |
| HTTP request smuggling, `Transfer-Encoding` tricks, h2c upgrade | hyper strict parsing; `TE` with `Content-Length` refused; no cleartext upgrade; HTTP/1.1 pipelining limits | Gateway is the only process on the listener | #107 | F2 |
| HTTP/2 rapid reset and stream floods | Max concurrent streams, reset rate limit, per-connection budget | Per-IP connection limit | #107 | F2 |
| Cache poisoning of static assets | Cache key = tenant + hostname + path; unkeyed headers never influence the response | Immutable hashed asset paths | #107 | F2 |
| Path traversal or dotfiles under `public/` | Static files served only from the artifact's `public/manifest.json`, never from a filesystem path built from the request | CLI excludes dotfiles and symlinks at build | #22; #115 | F1/F3 |
| Custom domain takeover (dangling CNAME, re-claimed hostname) | Ownership record persists after removal; another tenant cannot claim a hostname while it is owned; periodic re-verification | Deleted `*.renox.app` slugs quarantined before reuse | `TODO` → #114 | F3 |
| Shared-domain reputation (one phishing tenant gets `*.renox.app` blocked) | `renox.app` registered on the Public Suffix List; cookies and Safe Browsing scoped per subdomain | Abuse takedown SLA | #114; #123 | F3/F7 |
| Cookie tossing between tenants: a tenant `Set-Cookie` with `Domain=renox.app` (or a parent, or another tenant's host) planted on every other tenant's host | Gateway removes any `Domain=` that is not the request host, so the cookie is host-only; malformed `Set-Cookie` dropped; log names the cookie, never the value | `renox.app` on the Public Suffix List (`ops/psl/README.md`); platform cookies are `__Host-` | `crates/renox-gateway/tests/cookies.rs` (#207) | F2 |
| Noisy neighbour | Per-tenant quotas enforced in Rust | Scheduler avoids busy workers | B12 | F1 |

## D. Module publisher → tenant

| Threat | Primary control | Secondary control | Proof | Phase |
| --- | --- | --- | --- | --- |
| Malicious or compromised marketplace module | Ed25519 signature verification; permission review at install; diff on upgrade | `isolate` mode; global disable by hash; tenant notification | #84 | F7 |
| Module calling a service or hook it did not declare | Broker checks the manifest on every call | Authorizer for tables | broker tests (#63) | F4 |
| Module migration touching another module's tables | Authorizer attached to migration connections too | Migration runner per module prefix | migration tests (#117) | F4 |
| Module reading secrets it did not declare | Secrets filtered per module at injection | Tenant approves the list at install | secrets tests | F4 |

## E. Internet → control plane (accounts, API, dashboard, MCP)

| Threat | Primary control | Secondary control | Proof | Phase |
| --- | --- | --- | --- | --- |
| Account takeover of a tenant developer | Passkeys/TOTP for the dashboard (via the `2fa` module); email verification; login buckets; sessions with absolute and idle expiry, revocable per device | New-device and new-token notifications | `TODO` → #113; MFA in F5 (#119) | F3/F5 |
| Leaked CLI or CI token | Tokens scoped (app, action), expiring, hashed at rest, `renox_pat_` prefix registered with GitHub secret scanning, last-used tracking, one-click revoke | Deploys from a new token are audit-logged and notified | #113 | F3 |
| Teammate with too much power | Roles per tenant: owner, admin, developer, viewer; explicit permission matrix (deploy, secrets, domains, billing, team) | Secrets write and team changes require admin; audit log | #113 | F3 |
| Tenant-scoping bug in the control-plane API (IDOR) | Every query carries the tenant id from the authenticated principal; repository layer refuses queries without it | Integration test per endpoint with a second tenant's ids | #113 | F3 |
| SQL injection, SSRF, deserialisation in the Bun API | Parameterised queries only (lint); no outbound fetch from user input except the domain verifier with fixed targets | Dependency scanning | #109; #116 | F3 |
| Deploy API abuse (huge uploads, bombs) | Size caps, decompression limits, rate limits per token | Validation shares code with `renox check` | #95, #52 | F3 |
| Remote MCP tool misuse by an agent | OAuth 2.1 scopes; confirmation token for mutating tools; audit | Dry-run mode | #62 | F3 |
| Operator console abuse | Separate identity provider, hardware MFA, break-glass with reason and logging; operator actions need `ops:write`, which only an account flagged `operator` can mint (a tenant token, a session or `*` never holds it), and carry a reason of 10 to 500 characters (deploy-api.md section 17) | Operator actions audited (operator, tenant, reason, result) and reviewed | `control/api/tests/ops-tenants.test.ts` "a non-operator cannot obtain ops:write…" (scope) and the audit assertions of the tier and move tests (#259); `crates/renox-cell/tests/move_hook.rs` (the node's move needs the callback token and a reason); MFA and break-glass review → #121 | F6 |

## F. Supply chain → us

| Threat | Primary control | Secondary control | Proof | Phase |
| --- | --- | --- | --- | --- |
| Vulnerable or malicious crate / npm package | `cargo deny` (advisories, sources, licences) and `bun audit` in CI; Dependabot or Renovate with grouped weekly PRs | Lockfiles committed; `--locked` / `--frozen-lockfile` in CI | #109: CI jobs `cargo-deny` and `bun-audit` (`.github/workflows/ci.yml`) | F1 |
| Tampered prebuilt `rusty_v8` binary | Pinned version; sha256 of the archive verified against a checksum committed to the repo (`RUSTY_V8_ARCHIVE` from a mirror we control) | Build fails on mismatch | #109 | F1 |
| Compromised GitHub Action | Every action pinned to a commit SHA; minimal `permissions:` per job; no secrets in PR builds from forks | Branch protection, required reviews, signed commits encouraged | #109 | F1 |
| Tampered release of `renox-worker` or the `renox` CLI (runs on every tenant laptop via `renox dev`) | Releases signed with sigstore/cosign with SLSA provenance; the CLI verifies the worker's signature and hash before executing it | Checksums published; reproducible build goal | #129 | F3 |
| Secret leaked through CI logs | Secrets masked; no `set -x` with secrets; tokens short-lived (OIDC to cloud) | — | #109 | F1 |
| Tenant dependencies frozen at deploy but vulnerable | SBOM per artifact; advisory scan at deploy with a dashboard warning | Future: block on critical | #123 (warning only) | F7 |

## G. Operator / insider → tenant data

| Threat | Primary control | Secondary control | Proof | Phase |
| --- | --- | --- | --- | --- |
| Tenant files or backups read from storage | Node disks encrypted at rest (cloud disk encryption or LUKS); Litestream and Postgres backups encrypted with SSE-KMS using a key separate from the secrets master key | Buckets private, access logged, no public ACLs possible; an export is readable only through a signed URL that expires within 15 minutes (deploy-api.md section 14) | `control/api/tests/backups.test.ts` "export answers a signed URL; the object is not readable without the signature" (bare path 404, forged or expired signature 403; #258); encryption at rest `TODO` → #120 | F6 |
| Key compromise | Key hierarchy documented: TLS keys, secrets master key, backup key, token signing key; rotation runbook per key with a tested procedure | HSM/KMS for the master key | #120 | F6 |
| Erasure incomplete (PDPL right to erasure) | Tenant delete removes the file, replicas, exports; backups expire within a documented window; the deletion is audited with the completion time | Export before delete offered | #120 | F6 |
| Operator reads tenant data | Break-glass only: reason, time-boxed, logged, reviewed | Tenant notified after the fact | #121 | F6 |
| Tenant export file mishandled | Exports encrypted at rest, expiring signed URL, audit row | — | #120 | F6 |

## H. AI agents → tenant application and platform

| Threat | Primary control | Secondary control | Proof | Phase |
| --- | --- | --- | --- | --- |
| Prompt injection through tenant content reaching `ctx.ai` or app MCP tools | Tool outputs treated as data; mutating tools require confirmation tokens; per-tool permissions in the manifest | Audit of every tool call | `20-ai-agents-mcp.md`; #62 | F3/F7 |
| Agent deploys malicious code with a leaked token | Same as E (scoped, expiring tokens; confirmation for mutations) | Notification on deploy from a new client | #113 | F3 |
| AI gateway secret or quota abuse | Provider keys held by the platform, never by the isolate; metered per tenant | Allowlisted providers | `ctx.ai` tests (#85) | F7 |

## Abuse of the platform (not a boundary, but a threat)

| Threat | Primary control | Secondary control | Proof | Phase |
| --- | --- | --- | --- | --- |
| Phishing or malware sites on `*.renox.app` | Public Suffix List entry; abuse report endpoint and `abuse@` contact; takedown SLA with suspension; Safe Browsing lookups on deployed hostnames | Free tier requires a verified email and has no custom domains until a payment method exists | `TODO` → #123 | F7 |
| Card testing through tenant checkouts | Billing module: rate limit on payment attempts per IP and session, 3DS by default, CAPTCHA signal hook | Provider-side fraud tools | #123 | F7 |
| Outbound spam through the `email` module | Per-tenant send rate and daily cap; SPF/DKIM per sending domain; suppression list; complaint feedback loop pauses the tenant | Shared sending domain only for transactional templates | #123 | F7 |
| Bot signups | Email verification, disposable-domain blocklist, signup rate per IP, delayed quota growth for new tenants | Manual review for free tier anomalies | #123 | F7 |
| Crypto mining, proxying | CPU and egress quotas; anomaly detection on meters; suspend | Move to microVM | #85 | F7 |

## Security process

1. **Security checklist per phase.** Each phase has a `security checklist` issue listing the rows above due in that phase; the gate review is blocked by it: F1 #110, F2 #112, F3 #116, F4 #117, F5 #119, F6 #122, F7 #124.
2. **Security section in every PR.** `.github/PULL_REQUEST_TEMPLATE.md` asks: new input from the network or from tenant code? new place a secret flows through? new table, op, header, or route? If yes, name the row in this document and the test.
3. **Early adversarial review.** The SSRF filter (#27, #108), the authorizer (#19), and the gateway parser (#107, F2) get a recorded adversarial review session when they merge, not at the F6 penetration test. The session's findings are issues.
4. **Penetration test** before F6 closes (#79), scope defined in #121; findings closed or accepted with a written reason.
5. **Disclosure and incidents.** `/.well-known/security.txt`, a disclosure policy, and an incident runbook (contain, rotate, notify within the PDPL window, post-mortem) exist before external customers (#121).
6. **Dependency cadence.** Dependabot/Renovate PRs reviewed weekly; a critical advisory in a runtime dependency is a same-week release (#109).
7. **V8 updates.** A new Deno/Supabase Edge Runtime release that carries a V8 security fix is picked up within the week; this is a standing task, not a phase item.
