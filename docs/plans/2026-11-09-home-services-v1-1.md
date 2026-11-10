# Home services v1.1: pilot readiness, customer portal, offline technician PWA, parts inventory

**Goal:** turn `examples/home-services` from a complete reference app into the app a real UAE facility-management company runs for two weeks (gate F7, #86): the data they already have gets in, their customers book and follow jobs themselves, their technicians work through bad signal, and their parts are tracked; every step keeps the app the platform's own integration test and the `home-services` template.
**Done when:**
- Wave A: a pilot company's customers, sites, catalogue and open contracts are imported from an Excel/CSV export in under an hour by the owner following `docs/reference-app.md` "Onboarding a pilot"; the app scores ≥ 90 Lighthouse accessibility and ≥ 80 performance on the dispatch board and the technician visit page (phone profile), in EN and AR.
- Wave B: a customer books a service on the company's public page with their WhatsApp number (OTP, no password), sees their upcoming visit, invoices and reports in a portal, and can cancel or reschedule within the company's rules; the dispatcher sees the booking live.
- Wave C: a technician completes check-in, photos, parts, signature and check-out with the phone offline; the actions sync when back online; a conflict (the job was cancelled meanwhile) is refused by the server and shown to the technician, never applied silently.
- Wave D: parts have stock per branch; a visit's "parts used" decrements it; a purchase order to a supplier restocks it; low stock shows on the admin tile; a stock report exports to Excel.
- Each wave ships as 4–6 `ready` issues in one or two batches, each batch 3+ issues, with the template re-synced and `cli/tests/examples.test.ts` green.

## Decisions
- Scope v1.1 → all four features (owner, 2026-11-09): customer portal + self-booking, offline-first technician PWA, parts inventory + purchase orders, hardening (a11y, Lighthouse, Arabic typography, Excel import).
- Pilot → yes, a home-services company is the first external user of #86; the backlog includes import, an onboarding page, a go-live checklist and a support runbook.
- Detail level → issues specify pages, fields, validations and EN/AR texts; batches take no product decisions.
- Customer identity → WhatsApp number + OTP through the `auth` module (`phone_login`, `whatsapp.sendOtp`), no password; a light customer session separate from staff accounts; staff keep email/password/2FA.
- Inventory → app tables (`app__parts`, `app__stock`, `app__stock_moves`, `app__purchase_orders`) in the example; promoted to a module only if a second vertical needs it.
- Offline sync → an idempotent action queue on the device; the server validates each action against the current state and refuses conflicts; refused actions appear in a "needs attention" list on `/me`; nothing is overwritten silently.
- Order → pilot-first: A hardening + import → B portal → C PWA → D inventory. One session at a time in `examples/home-services`; the four waves are sequential, each wave's issues are parallel-safe only inside its own batch (different pages).

## Assumptions (not asked, simplest option taken — change here if wrong)
- Import format: one `.xlsx` with sheets `customers`, `sites`, `services`, `contracts` (columns documented in `docs/reference-app.md`), uploaded on `/admin/import` by the owner; dry-run with a validation report before commit; `reports.xlsx`'s reader (`readXlsx`) is reused through the module or a small `lib/xlsx-read.ts` if the module exports no reader (then an issue on `reports`).
- Lighthouse runs in CI through Playwright's bundled Chromium against `renox dev` of the example, in `journey.yml`-style nightly (not on PRs) or a `make lighthouse` target; thresholds are asserted, numbers recorded in `bench/results/`.
- Arabic typography: Noto Naskh Arabic / Noto Sans Arabic from `public/` (no CDN), `font-feature-settings`, numerals in EN digits with `lang="ar"` `dir="rtl"`, line-height per script; tested by snapshot and one Playwright screenshot per key page.
- Public booking page lives at `/book` (company-level) and `/book/<branch>`; it uses `booking` for slots and `app__jobs` for the resulting job (status `new`, source `self_booking`); the dispatcher confirms or the job auto-confirms per a setting.
- Customer portal lives at `/my` (sessions of kind `customer` through `auth` phone login; role `customer` in `[authz.default_roles]` with `customer.self` actions only; `db.scoped` by `customer_id`); portal pages: upcoming visits, history, invoices (PDF), reports, contracts, cancel/reschedule within the company's cut-off hours.
- Offline PWA builds on #568: the service worker caches the `/me` shell; a `lib/offline-queue.js` in `public/` stores actions in IndexedDB with a client-generated `action_id`; the actions post to the existing page actions with an `Idempotency-Key`-style field `action_id` that the server stores in `app__action_log` to drop replays; conflicts answer 409 with a reason the queue shows.
- Photos offline: stored as blobs in IndexedDB and uploaded through the signed-URL flow (#581) when online; the visit's `photo` action then runs; cap 20 photos pending per device.
- Inventory: parts have `sku`, `name_en/ar`, `unit`, `cost_fils`, `min_stock`; stock per branch with moves (`in`, `out`, `adjust`, `transfer`); a visit's part line references a `part_id` (free-text parts stay allowed as `misc`); purchase orders `draft → sent → received (partial)`; supplier is a simple table; PO PDF through `ctx.pdf`.
- Pilot support: a one-page `docs/reference-app.md` section "Onboarding a pilot" (accounts, roles, import, WhatsApp go-live, domain, first week checklist) and `ops/runbooks/pilot-support.md` (who answers what, how to read tenant logs, how to restore); no new tooling.
- Everything stays in the example and its template; a platform gap becomes its own issue (the tutorial rule).

## Scope
### In (v1.1)
- Wave A, pilot readiness (6 issues): Excel import with dry-run (customers, sites, services, contracts); accessibility pass (labels, focus order, contrast, `aria-live` for the live board) with Lighthouse ≥ 90; performance pass (fragment loading on the board, image sizes, `<x-image>` widths) with Lighthouse ≥ 80 on phone; Arabic typography and RTL audit of every page; onboarding and support docs; a `make lighthouse` target and the nightly run.
- Wave B, customer portal (6 issues): customer identity (phone OTP, `customer` role, `/my` session); public booking page `/book` with slot picker and address; portal home + history; invoices and reports in the portal (PDF links); cancel/reschedule with cut-off rules and WhatsApp confirmation; dispatcher side: a "self-booked" badge on the board, auto-confirm setting, tests EN/AR.
- Wave C, offline PWA (5 issues): action queue + `action_id` idempotency on the server; offline photo capture and deferred upload; conflict handling and the "needs attention" list; shell caching extended to today's visits data (read-only snapshot); Playwright offline test (`context.setOffline(true)`).
- Wave D, inventory (5 issues): parts and stock tables + admin pages; parts picker in the visit's part form and automatic stock move; purchase orders with PDF and receiving; low-stock tile and stock report (`reports.xlsx`); seeds and tests.

### Out (later or never)
- Online payments, deposits (D31). A supplier portal. Multi-company (agency) dashboards. Barcode scanning. Route optimisation. Native apps.
- Promoting inventory to an official module (decide after a second vertical exists).

## Approach
Each wave is broken down by `issues-breakdown` into 5–6 issues, then run as **one batch per wave** (two batches for wave A: docs-only issues can run beside the code issues). Waves are sequential because they share `examples/home-services` (layout, i18n, migrations, template sync).
1. Wave A (after #636 lands): `issues-breakdown` of the six pilot-readiness issues; batch A1 (import, a11y, perf, typography: code) and batch A2 (onboarding docs, support runbook, `make lighthouse` + nightly).
2. Wave B: breakdown of the six portal issues; one batch (pages are disjoint: `/book`, `/my`, dispatcher badge).
3. Wave C: breakdown of the five PWA issues; one batch.
4. Wave D: breakdown of the five inventory issues; one batch.
5. After each wave: template re-sync, `docs/reference-app.md` updated, screenshots for #567 refreshed, CHANGELOG line under the next CLI version.

## Risks and how we handle them
- Four waves in one directory tempt parallel sessions → the rule "one session in `examples/home-services`" is written in every issue; a wave's batch runs its issues in parallel worktrees but merges onto one branch.
- Customer sessions through `auth` phone login may expose staff-only pages → the `customer` role has only `customer.self` actions, every `/my` loader uses `db.scoped({ customer_id })`, and a policy test per page asserts a customer cannot open `/dispatch`, `/admin`, `/jobs` → mitigated by tests in wave B.
- Offline queue replays or duplicates → `action_id` stored server-side (`app__action_log`, unique), replays answer the stored result; a Playwright test replays a queue twice → mitigated.
- Lighthouse thresholds flaky in CI → nightly only, three runs, median; thresholds with 5-point slack recorded in the result file → accept.
- Import of dirty data → dry-run report with per-row errors, nothing written until "commit"; a 10 MB / 10,000-row cap → mitigated.
- Platform gaps (e.g. `auth` phone login for a second account kind, `booking` per-branch catalogue #572's deferred part) → each becomes a `ready` platform issue, the example never works around with module code → the tutorial rule.

## Verification
- Automated: every wave's `renox test --seed seeds/001_demo.sql` suite; `cli/tests/examples.test.ts`; Playwright tests for the portal booking flow, the offline queue (`setOffline`) and the Lighthouse run (nightly).
- Manual: the owner imports the pilot's spreadsheet on `fixit-demo`, books a service from a phone as a customer, completes a visit with the phone in airplane mode, receives the invoice link on WhatsApp, and sees the stock move; then the same on the pilot's own tenant.

## Open questions deferred
- Auto-confirm of self-bookings by default (implementer: off; the dispatcher confirms; a setting turns it on).
- Cut-off for customer cancellation (implementer: 12 hours before the slot; a setting).
- Whether the public booking page is per branch or company-wide with branch chosen by emirate (implementer: company-wide, branch from the site's emirate).
- Parts cost valuation (implementer: average cost per branch; FIFO later).
- Whether `reports` should export a reader for `.xlsx` (implementer: use it if present, else a small reader in the app and an issue on `reports`).
