# 16 — Risks and mitigations

The biggest risks are not in Rust. They are sandbox security (because that is the product), npm compatibility, and the temptation to build the platform before there are products.

| Risk | Impact | Likelihood | Mitigation | Owner / phase |
| --- | --- | --- | --- | --- |
| Escape from an isolate (V8 bug, side channel) | Cross-tenant data leak; end of the business | Low but catastrophic | Layered isolation (D6), fast V8 updates via Deno releases, process tiers, bug bounty after launch | F6 |
| SSRF into internal infrastructure | Access to the control plane or cloud metadata | Medium | Block private and metadata ranges in the `fetch` op after DNS resolution; allowlist per tenant; egress proxy with the same rules | F1 |
| Tenant template as DoS on Rust threads | One tenant consumes a cell's CPU | Medium | Fuel, iteration and output limits, render timeout charged to the quota (B13) | F2 |
| npm libraries that do not run on Deno | Tenants leave | Medium | Public compatibility list, test popular packages from F0 (B17), platform APIs for images/PDF/email | F0 |
| V8→Rust marshaling erases the render advantage | Performance claim unproven | Medium | B8/B9 benchmark in F2 with path B as the alternative (D7) | F2 |
| Cell node dies | Tenants on that node are down | Medium | Litestream to S3 for the base tier (RPO seconds), synchronous replica for the higher tier, artifacts in object storage; failover restores before the route moves (`docs/contracts/deploy-api.md` FO1–FO6). B18: `bench/results/2026-10-29-B18-failover-dev-container.md` (not measured on the dev container; the `node-small` run is O3) | F6 |
| Single writer per SQLite file | Busy tenants hit a ceiling | Low–medium | Tier limits, lock-wait metrics, upgrade path to Postgres | F6 |
| Global state leaking between requests in `shared` mode | Mixed user data within one tenant | Medium | Per-request data through `ctx`, dev-mode warnings, module documentation, lint | F2 |
| Module contracts change without notice | Tenant apps break on upgrade | Medium | Semver, generated types, `renox check`, versioned views (D17) | F4 |
| Template overrides drift from module versions | Broken views after upgrade | Medium | Stored original hash and diff on upgrade | F4 |
| Binary size and V8 build times | Slow CI, 50–100 MB binary | High but low impact | Prebuilt `rusty_v8`; builds only when the platform changes (B20) | F1 |
| Outbox and logs grow unbounded | Cell disk fills | Medium | Periodic pruning, dead-letter tables, per-tenant log volume limits | F4 |
| Scope creep | The platform is never used | High | Phased roadmap, kill criteria, dogfooding, `AGENTS.md` rules | Ongoing |
| Bus factor of one | Project dies when the author is busy | High | This documentation, components from living ecosystems, small official modules, agent-friendly repo | Ongoing |
| Dependence on Supabase Edge Runtime's direction | Upstream changes break our fork | Medium | Pin versions, keep patches small and upstreamable, fall back to `deno_runtime` directly | F1 |
| Abuse (spam, crypto mining, phishing sites) | Reputation, IP blacklisting, costs | High once public | CPU/egress quotas, anomaly detection on meters, manual review for free tier, fast suspension, abuse contact | F7 |
| Pricing wrong | Margin or adoption fails | Medium | Meters from F3 give real unit costs; pricing decided with data in F7 | F7 |
| Regulatory (UAE PDPL, DIFC/ADGM regimes, sector data residency, e-invoicing phases) | Legal exposure, blocked sales to regulated tenants | Medium | UAE-region data by default, PDPL-aligned DPA, in-country guarantee tier for health data, adapter-based e-invoicing, quarterly regulatory review (`21-uae-gcc-strategy.md`) | F6–F7 |
| UAE entity and banking delays | Cannot invoice in AED or sign local contracts | Medium | Start free-zone incorporation and bank account during F1 | F1 |
| Incomplete Arabic/RTL | Lost trust with local customers | Medium | EN complete first; AR only where fully tested; RTL test suite for core modules; `renox check` fails on a key missing in a declared locale (`i18n-missing-key`, every module and example green in `cli/tests/lint.test.ts`) and the shared terms are in `modules/i18n/GLOSSARY.md` (#336) | F4–F7 |
| UAE cloud region costs 2–3x budget VPS | Thinner margins if pricing does not follow | Medium | AED pricing tiers, density benchmark, colocation when volume justifies | F3–F7 |
