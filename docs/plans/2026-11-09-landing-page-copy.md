# renoxium.com: the copy deck (full replacement, 2026-11-09; issue #675)

Every word below is the page. Order is the pitch of the positioning canvas (`docs/plans/2026-11-09-positioning-home-services.md`, sections 8 and 9): insight, alternatives, perfect world, product, proof, price, ask. Nothing from the current page survives except the measured numbers and the plan table's source (`pricing.toml`).

Who reads it: anyone who needs a business app for a company and wants to own it: a developer, a small agency, or a business owner working with their AI assistant. The page speaks to all three in one voice because the differentiator (*yours*) is the same for all three (canvas section 14, opening observation).

---

## Top bar
Renoxium · Docs · Pricing · Modules · GitHub · **Sign in**

## 1. Hero
**H1 (two lines max):** A business app that is yours. Running this week.

**The value proposition, in one paragraph (Prof. Sembel's formula, under the H1, 18–20 px):**
For developers, agencies and business owners who need a company's app, with sign-in, teams, billing, invoices and a back office, and are tired of choosing between rigid software and an expensive build, Renoxium is a hosted platform for TypeScript apps where those parts come installed as modules, every app runs in its own isolate with its own database, and you, or the AI assistant you already use, change anything. Unlike Zoho, Odoo or a Next.js stack stitched on Vercel and Supabase, the app is yours: open source, one file per company, and you can take it with you.

**Buttons:** [Create a free account] [See the finished app]

**Picture:** the FixIt dispatch board, a real screen, large (half the first screen or more). Caption: FixIt, the home-services reference app, built from 16 modules.

## 2. The insight (one statement, 36 px or less, three lines)
Software for a business has always meant one of two things: rent something rigid, or pay someone to build something you do not own. AI made writing software cheap. That ends the dilemma, on two conditions: the app is already complete, and the parts that must not break are not the parts the AI writes.

## 3. The alternatives, honestly
Heading: **What you would do instead, and when you should.**

| Instead of Renoxium | What it costs you | Pick it if |
| --- | --- | --- |
| **WhatsApp, Excel and paper** | Hours a day of retyping, lost quotes, late renewals, invoices without a gapless number | You have one technician and a dozen customers. It is enough. |
| **Generic software** (Zoho, Odoo, Jobber-class tools) | Per user, often in dollars; every change is a feature request; Arabic and tax invoices are an afterthought | You want a known brand and a sales team, and your process fits theirs. |
| **An agency builds it** | AED 50,000 to 100,000 for a first version, then a retainer; every change is billed; the code may not be yours | You need something no module covers, and you can afford to wait. |
| **Build it yourself** (Next.js on Vercel plus Supabase, or an AI builder) | A stack to assemble and operate per app; logins, data and invoices are generated too, and they break or leak | You are a React team shipping one consumer product with a global edge footprint. |

Footnote: We wrote this table the way we would want a competitor to write about us. If a row is unfair, tell us.

## 4. The perfect world (a checklist, each line one claim)
Heading: **What the right answer would look like.**
- Complete for the business from the first day: quotes, scheduling, invoices, contracts, reports.
- Yours: open source, one database file per company, exportable with one command.
- Changeable by talking to it, in your words, with the assistant you already pay for.
- The critical parts (logins, invoices, VAT, backups, security) maintained by someone accountable.
- Made for here: AED, 5 % VAT and TRN on the invoice, English and Arabic, WhatsApp.
- A way out that is a feature, not a promise.

## 5. What you get (the three value themes and the AI)

### 5A. Running this week
Heading: **A finished app, then your changes.**
FixIt is a complete home-services company in one app: customers and sites, quotations with an approval link on WhatsApp, jobs and a live dispatch board, the technician's visit on a phone (photos, parts, signature) with a PDF report, FTA tax invoices with cash, transfer and cheque payments, annual maintenance contracts that renew themselves, reports, a branded back office. English and Arabic. Sixteen modules, a few hundred lines of app code per feature.
Pictures: four real screens in a row: the quotation approval link on a phone, the dispatch board, the technician's visit page, the Arabic tax invoice.
Code line: `renox new fixit --template home-services`
Link: Read the whole flow

### 5B. Yours
Heading: **Yours, in the way that can be checked.**
The whole platform is open source under Apache-2.0. Each company's data is one SQLite file, and a copy of it is one command away today (`renox db export`). A full export of the app, its files and its settings, and a guide to run it on your own server, are being built in the open (link: the epic). Until that ships we do not print the sentence we want to print; when it ships, it will read: if we disappear tomorrow, your app keeps running.

### 5C. The parts that must be right stay right
Heading: **What your AI is not allowed to break.**
Sign-in and two-step verification, organisations and roles, billing, tax invoices and VAT, WhatsApp, audit, backups: these are modules Renoxium maintains and updates, not code generated for you. Your app runs in its own V8 isolate with its own CPU, memory and clock limits, so one company's bug or traffic cannot touch another's. When the UAE e-invoicing mandate reaches small businesses in 2027, it is our update to ship, not your project.

### 5D. Change it with your own AI
Heading: **Tell it what to change. In your words.**
Every app ships `AGENTS.md` and a local MCP server with the docs, your routes and the results of `renox check` and `renox test`, so ChatGPT, Claude or any coding agent works on it as a colleague who has read the manual. The app can expose its own tools too (FixIt answers `next_free_slot`, `job_status`, `create_job`).
Example, shown as a real transcript: "Add a parts-warranty line to every quotation PDF, in Arabic too." Result: the line, in both languages, after one check and one deploy.
One sentence under it: the AI changes pages, flows, texts and reports; it does not change logins, invoices, VAT, payments or backups, and that is the point.

## 6. Proof (only measured things, each with its source)
Heading: **Measured, not promised.**
- An idle app holds 107 KB on the node, so ten apps cost about what one costs elsewhere, and the Free plan can be free. (B2, node-small, 500 tenants)
- First request of a cold app: 45 ms at the 99th percentile. (B4, provisional)
- One command to deploy: `renox deploy` builds, uploads, validates and activates; rollback in seconds.
- The code, the benchmarks and the issues are public. (links: GitHub, docs/14-benchmarks.md, the status page)
No customer logos, no quotes: the first named customer's numbers will stand here when there is one.

## 7. When not to use Renoxium
Heading: **When not to use Renoxium, and what to pick instead.**
- A large React team that hires for Next.js: use Next.js on Vercel or self-hosted.
- A write-heavy app that needs Postgres from day one: use Supabase or a managed Postgres with your framework.
- An app that needs the full React ecosystem on the client: Renoxium is HTML-first (templates and htmx); use a React meta-framework.
- Health data: we do not host it.

## 8. Price (three choices, the recommended one marked; from `pricing.toml`)
Heading: **Plans in dirhams, a tax invoice every month.** Monthly, excluding 5 % VAT.

| Free | **Starter, recommended** | Pro | Agency |
| --- | --- | --- | --- |
| AED 0 | **AED 79** | AED 299 | AED 499 |
| 2 apps, 100,000 requests, 100 MB database, no custom domain. Hand-onboarded: the first users are set up by us. | 5 apps, 3 custom domains, 2 million requests, 1 GB database, 10 GB files, 1 million AI tokens. | 20 apps, 20 custom domains, 20 million requests, 10 GB database, 50 GB files. | Unlimited apps and requests, 100 custom domains, client workspaces, white label. |

Stated plainly under the table: No online payments inside your app yet (staff record cash, transfer and cheque); the e-invoicing provider is on the roadmap for the 2027 mandate; one region behind Cloudflare, no data-residency promise. Link: every quota of every plan.

## 9. The ask
Heading: **Put your app online.**
It lives at `<app>.renoxium.app`. The Free plan is AED 0.00 a month. The first users are onboarded by hand: write to us and we set it up with you in an hour.
Buttons: [Create a free account] [Write to us on WhatsApp]

## Footer
Renoxium · Docs · Pricing · Modules · Status · GitHub · Privacy · DPA · © 2026 Renoxium
