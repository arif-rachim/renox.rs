# 01 — Business rationale

## The problem

Developers building business applications (small SaaS, client apps, internal tools) spend most of their time not on features but on reassembling the same things: auth, organizations and roles, billing, admin panels, email, job queues, deployment, and monitoring. In the PHP/Ruby/Python world this problem is solved (Laravel, Rails, Django, Odoo). In the TypeScript world nothing has won: Next.js is a UI layer, not a backend, and its best hosting is expensive.

On the hosting side, existing platforms force a choice: cheap but self-managed (a VPS), or easy but expensive and locked-in (Vercel). For a market like the UAE, where data is expected to stay in the country and customers expect bilingual, locally integrated software, neither is a fit.

## What we sell

**Hosting + modules.** A tenant gets:

1. Hosting billed by usage, with idle tenants costing almost nothing.
2. Ready-made modules installed in minutes: auth (+2FA, phone OTP, UAE PASS), organizations, billing (Stripe UAE, Checkout.com, Telr, PayTabs, Tabby/Tamara), FTA tax invoices, admin, storage, email, WhatsApp.
3. A simple application model: TypeScript, HTML, SQL; no build step, no Node, no Docker.
4. Deploy in seconds, rollback in seconds, per-tenant logs and metrics.

One-line pitch: *"Assemble a SaaS from auth, billing, and admin modules, then deploy to hosting that charges only for what you use."*

## Target market

The primary market is **SMEs in the United Arab Emirates**, reached through developers/agencies and through vertical SaaS products built on Renox. The full analysis, module list, unit economics, and compliance items are in `21-uae-gcc-strategy.md`. Other GCC markets (Saudi Arabia first) are designed for but not scheduled.

## Who the users are

| Segment | Need | Why Renox |
| --- | --- | --- |
| Solo developers / indie hackers | Launch many small products at a low fixed cost | Idle tenants are nearly free; modules cut weeks of work |
| Small agencies (2–10 people) | Client apps that look alike: auth, admin, reports | The same modules reused; one dashboard for all clients |
| Laravel/Rails developers moving to TS | Batteries-included completeness | The only hosted "Laravel for TypeScript" |
| UAE SMEs through vertical products (salons, clinics, F&B, services) | A finished bilingual app with local payments and data in the UAE | Our own vertical SaaS built on Renox; WhatsApp support |
| Agencies in the UAE serving many SMEs | Reusable modules, client workspaces, white-label, wholesale pricing | Agency tier (see pricing) |

Not targets: large companies (they choose Next.js/React for hiring), write-heavy applications (they need Postgres from day one), teams that need the full React ecosystem.

## Why now

- Fatigue with Next.js complexity and Vercel bills is visible in the community; HTMX, Astro, Rails 8, and Laravel are popular again.
- UAE SMEs pay for software, expect data to stay in the country, and are served today by generic suites (Zoho, Odoo) or by agencies building from scratch; there is no local-fit, modular, hosted application platform.
- The core components are mature and open source: Supabase Edge Runtime (V8 isolates for customer code), Deno (npm compatibility), minijinja, Cedar, libSQL/Litestream. Five years ago all of this had to be built from scratch.
- SQLite per tenant is proven in production (Cloudflare D1, Turso, Fly.io, PocketBase).

## Why we can win in this gap

| Advantage | Explanation | Hard to copy for |
| --- | --- | --- |
| Density | Isolates at 2–10 MB vs processes at 30–50 MB; idle tenants at 0 MB | Container/process-based platforms |
| Modules as the product | Auth/billing/admin that actually install, not sample code | Function-only platforms (Vercel, Supabase Functions) |
| Local fit | AED pricing, UAE PSPs and BNPL, FTA tax invoices, EN/AR with RTL, data in the UAE | Global platforms |
| HTML-first | Lightweight apps, no build, well suited to business apps | SPA frameworks |

The long-term moat is not Rust; it is the **module ecosystem** and **operational data** (running tenants are hard to move).

## Revenue model

Prices are in AED, billed by card, Apple Pay, or bank transfer, with VAT at 5% and the tenant's TRN on invoices.

| Tier | Contents | Price (initial hypothesis, tested in F7) |
| --- | --- | --- |
| Free | 1 app, shared process, CPU/request quota, 100 MB SQLite, no custom domain | AED 0 |
| Starter | Several apps, own process, custom domain, Litestream backup in the UAE, official modules | AED 49–99/month + usage |
| Pro | Synchronous replica, larger quotas, longer log retention, priority support | AED 199–399/month + usage |
| Agency | Client workspaces, white-label admin, `renox clone`, wholesale per-client pricing (for example AED 25–40 per active client app), billing passthrough option | From AED 499/month |
| Vertical products (booking, F&B ordering) | Finished apps sold to SMEs directly, built on Renox | AED 149–499/month per business |
| Pay-per-use | Requests + CPU-ms + egress + storage, following the meters | Modeled on Cloudflare Workers pricing |

Additional revenue: a module marketplace (revenue share with publishers), premium official modules, an in-country guarantee tier for regulated data, and a managed Postgres tier for large tenants.

Unit economics (target): one 8 GB / 4 vCPU node in a UAE cloud region at roughly $100–150/month hosts ≥ 1,000 idle tenants and ≥ 100 lightly active tenants. Break-even per node needs about 3% conversion to Starter or about 1% to a vertical product. These are hypotheses; validation is the density benchmark (`14-benchmarks.md`) and market pricing. Details in `21-uae-gcc-strategy.md`.

## Success metrics

| Horizon | Metric | Target |
| --- | --- | --- |
| F0–F2 | Benchmarks pass; two dogfooding products running | See `15-roadmap.md` |
| 6 months | Weekly active tenants (internal + friends) | ≥ 20 |
| 9–12 months | Paying external tenants | ≥ 10 |
| 12 months | Time from `renox new` to a live app with auth + billing | ≤ 1 day for a new developer |
| 12 months | Hosting gross margin | ≥ 70% |

## Kill criteria

Set before starting so the decision is not emotional:

1. After F0: memory per isolate > 20 MB, cold start p99 > 100 ms, or core npm packages (payment SDKs, OAuth, email) do not run → consider Bun process-per-tenant for paid tiers only, or stop.
2. After F4 (~4–5 months): no two real products running on Renox → stop the platform, keep the products.
3. After F7 (~9–12 months): no paying external tenant → Renox becomes an internal tool; no marketplace investment.

## Dogfooding products

Two real products are built alongside the platform and become its first customers: **booking for salons and clinics** and **QR ordering for F&B**, both for UAE SMEs. They need auth + organizations, local payments, bilingual UI, and business-app pages, and they compete in segments with proven demand. Rationale in `21-uae-gcc-strategy.md`.
