# 15 — Roadmap, kill criteria, and open questions

Each phase produces something runnable and has done criteria. Two real products are built alongside the platform from F1 and become its first customers. Dependencies and parallel tracks per component are in `18-build-plan.md`.

## Phases

| Phase | Name | Duration (est.) | Scope | Done when |
| --- | --- | --- | --- | --- |
| F0 | Spike | 2–3 weeks | Run Supabase Edge Runtime locally; deploy one TS function; measure memory per isolate and cold start; test required npm packages; prototype the attribute → minijinja transpiler; benchmark marshaling vs render (B1, B4, B9, B17, first B6) | Numbers meet targets in `14-benchmarks.md`. If not, re-evaluate direction before writing platform code |
| F1 | Minimal data plane | 4–6 weeks | Gateway, per-tenant routing, isolate per deployment, CPU/memory/wall-clock limits, `fetch` with allowlist and SSRF blocking, SQLite per tenant with authorizer, static serving, meter records. In parallel (non-engineering): start UAE free-zone incorporation and bank account | Two tenants run on one node; a tenant with an infinite loop does not affect the other (B12); meters are recorded |
| F2 | SSR and templates | 4–6 weeks | Attribute transpiler, loaders, actions, layouts, components, htmx fragments, render fuel and limits, render path A vs B benchmark | The `shop` example runs (list, detail, form, live search); D7 default decided by B8 |
| F3 | Minimal control plane (Bun) | 4–6 weeks | Deploy API, artifact store, route table with pub/sub, secrets, simple dashboard, logs, billing from meters | `renox deploy` from a laptop to a server goes live in < 30 s (B15); rollback works |
| F4 | Modules | 6–8 weeks | Manifest, resolver and lockfile, forward-only migrations, services, events (outbox + `update_hook`), hooks, slots, overrides; `auth` and `org` modules | The first product uses `auth` and `org` with no auth code of its own |
| F5 | Authorization and realtime | 4–6 weeks | Cedar, `guard`, `authz.require`, `r-can`, `db.scoped`; SSE/WebSocket with in-process pub/sub; `2fa` module via hooks | Refund is denied for users without the role or without 2FA; the chat room works (B14) |
| F6 | Production reliability and security | 6–8 weeks | Process sandbox (seccomp, cgroups), process tiers, Litestream, synchronous replica for the higher tier, OpenTelemetry, audit log, SSRF blocking verified, internal penetration test | A node is killed and tenants recover elsewhere within their tier's RPO (B18) |
| F7 | External customers | 6–8 weeks | `billing` with GCC payments and BNPL, `tax-gcc` (FTA tax invoices), `admin`, `storage`, `email`, `booking`, `reports` modules; complete EN/AR; module registry with signatures; `isolate` mode for marketplace modules; public docs; onboarding; AED pricing; PDPL DPA; booking and F&B ordering products launched | First paying external tenant (agency or vertical product customer) in the UAE |

Total estimate: 9–12 months for one experienced engineer plus agents, assuming the two dogfooding products are built in parallel by the same person.

## Kill criteria

| Checkpoint | Condition | Action |
| --- | --- | --- |
| After F0 | Memory per isolate > 20 MB, cold start p99 > 100 ms, or core npm packages fail (B17) | Consider Bun process-per-tenant for paid tiers only, or stop |
| After F4 (~4–5 months) | Fewer than two real products running on Renox | Stop the platform; keep the products on a conventional stack |
| After F7 (~9–12 months) | No paying external tenant | Renox becomes an internal tool; no marketplace investment |

## Milestone sequence (what unblocks what)

```
F0 spike ──► F1 data plane ──► F2 SSR/templates ──► F4 modules ──► F5 authz/realtime ──► F7 external
                    │                                    ▲
                    └──► F3 control plane ───────────────┘          F6 reliability runs alongside F4–F5
```

F3 (control plane) depends only on F1's artifact format and route table contract, so it can proceed in parallel with F2. F6 is mostly operations work and can start once F1 is stable.

## Open questions

| Question | Options | Decide by |
| --- | --- | --- |
| Target node size | 8 GB vs 16 GB; affects warm isolate count and tiers | After B3 |
| UAE region provider | AWS me-central-1 vs Azure UAE North vs local colocation; cost of reserved capacity and egress | F1 |
| Pricing model | Per request + CPU-ms (Cloudflare style), flat per tenant with quotas, or hybrid; AED tiers in `01-business.md` are hypotheses | F7, after unit-economics data from F3 meters |
| Bring-your-own Postgres | From the start, or only on the top tier | F6 |
| Second region (Saudi Arabia) | Requires in-country hosting and ZATCA e-invoicing; not before UAE traction | After first external customers |
| UAE PASS | Onboarding requirements for private providers; whether to ship in M16 or later (shipped behind config in M16, #291; owner steps in `modules/auth/README.md`, "UAE PASS") | F5 |
| E-invoicing | Phase timing for SMEs and the accredited-provider route for `tax-gcc` | F7 (verify, see `21-uae-gcc-strategy.md`) |
| Data-plane license | Open source (contributors, trust) vs closed (protect the hosting business) | Before F7 |
| Marketplace revenue share | Percentage and payout mechanism | F7 |

Decided (no longer open): dogfooding products are booking for salons/clinics and QR ordering for F&B; the first region is the UAE.
