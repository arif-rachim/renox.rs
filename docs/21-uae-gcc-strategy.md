# 21 — Market strategy: UAE SMEs (and the GCC later)

The primary market is small and medium businesses in the United Arab Emirates, reached through developers/agencies and through vertical SaaS products built on Renox. This document records what that choice changes in product, modules, infrastructure, pricing, and compliance. Regulatory details below reflect our understanding as of mid-2026 and are marked **verify** where they must be confirmed before they enter a roadmap commitment.

## 1. Why the UAE

| Factor | Implication |
| --- | --- |
| High SME density (SMEs are the large majority of registered companies, concentrated in Dubai, Abu Dhabi, Sharjah) | Large addressable base of retail, F&B, services, clinics, salons, fitness, real-estate brokers, tourism, consulting |
| High willingness to pay: SMEs commonly spend AED 200–1,000/month on SaaS | Direct vertical SaaS is viable, not only the agency channel; margins support UAE-region hosting costs |
| English-first business environment with Arabic as the official language | English product and docs work from day one; Arabic/RTL is required for customer-facing apps and legal documents |
| Premium devices (high iPhone share) and 5G | Offline/PWA is not a priority; polish, speed, Apple Pay, and passkeys are |
| Large agency ecosystem used to paid tooling | A partner program can start early (F4) |
| Strong expectation that data stays in the UAE | A UAE production region is both a compliance need and a selling point |

## 2. Distribution

| Route | Who pays Renox | What it requires | Decision |
| --- | --- | --- | --- |
| A. Developers and agencies building for SMEs | Agencies, freelancers | GCC modules, vertical starters, agency workspace, white-label, wholesale pricing | **Primary channel** |
| B. Vertical SaaS products on Renox | SMEs directly, through products we (or partners) run | Finished products, non-technical onboarding, WhatsApp support | **Second channel and the dogfooding products** |
| C. No-code builder for SMEs | SMEs directly | A different product | Not pursued |

Dogfooding products (replace the open question in `15-roadmap.md`): **booking for salons/clinics** (competes with Fresha-class products) and **QR ordering for F&B** (competes with Foodics-class ordering). Both have dense SME populations, clear payments, and proven demand.

Positioning: *the factory for custom SME applications in the UAE: bilingual, local payments, data kept in the country, built and hosted in days.* Real competitors are generic suites (Zoho, Odoo), website builders plus agencies, and "build from scratch", not the vertical incumbents.

## 3. Market realities and what they change

| Dimension | UAE reality | Adjustment |
| --- | --- | --- |
| Language | English dominant; Arabic official and expected by local customers and for some documents | EN/AR UI with full **RTL** in the template engine, admin module, emails, invoices; bilingual PDFs |
| Payments | Cards dominate; Apple Pay/Google Pay; BNPL (Tabby, Tamara) very popular; cash on delivery still present in e-commerce; bank transfers; new domestic rails (Aani instant payments, Jaywan card scheme) — **verify** current adoption | PSP adapters: Stripe UAE, Checkout.com, Telr, PayTabs, Network International (N-Genius), Mamo/Ziina for micro-merchants; BNPL as a checkout method; COD; transfer reconciliation |
| Messaging | WhatsApp Business for sales and support; SMS OTP; Instagram for retail | `whatsapp` module remains a priority; `email` stays fully supported |
| Identity | **UAE PASS** national digital identity with OAuth-style login for residents — **verify** onboarding requirements for private providers | Optional "Login with UAE PASS" provider in `auth`; strong differentiator for clinics, services, property |
| Marketplaces and delivery | Noon, Amazon.ae, Namshi; Talabat, Deliveroo, Careem for F&B; Aramex, Careem/Quiqup for parcels | `marketplace-sync` (Noon, Amazon.ae), `delivery-gcc` (Aramex, Careem; Talabat/Deliveroo order ingestion) |
| VAT | 5% VAT with TRN on tax invoices; corporate tax 9% with small-business relief; national e-invoicing (Peppol-based, accredited service providers) rolling out in phases from 2026 with SMEs in later phases — **verify** dates and thresholds | `tax-gcc` module: compliant tax invoices (TRN, VAT breakdown, AED), credit notes, VAT period reports, adapter interface for Peppol/ASP; ZATCA adapter later for Saudi |
| Data protection | Federal PDPL (Decree-Law 45/2021) plus separate regimes in DIFC and ADGM; health data must stay in-country; general expectation of in-country hosting | UAE production region; PDPL-aligned DPA; data classification per tenant; in-country guarantee tier for health data |
| Hosting | No low-cost VPS providers with UAE data centers; options are AWS me-central-1 (Dubai), Azure UAE North/Central, Oracle and Alibaba Dubai regions, or local colocation (Khazna, e&, du) | Node cost 2–3x the original assumption; unit economics recomputed in §6 |
| Addresses | No postal codes in common use; areas/communities, Makani numbers (Dubai), P.O. Boxes | Emirate/area address component; no postal-code validation |
| Calendar and formats | Saturday–Sunday weekend; Hijri calendar in some contexts; Ramadan hours; DD/MM/YYYY; AED with fils | `i18n`: optional Hijri display, seasonal opening hours in `booking`, AED formatting, Arabic plural rules |
| Business entities | Mainland vs free zones; trade license number and TRN appear on invoices | Trade license and TRN fields in `org`/`billing`; both printed on tax invoices |

## 4. Modules and starters for the UAE

These replace the generic "local market" placeholders. IDs continue `18-build-plan.md`.

| ID | Module | Contents | Phase |
| --- | --- | --- | --- |
| M15 | `whatsapp` | WhatsApp Cloud API: notifications, OTP, message templates, light inbox, chat-to-order button | F5 |
| M16 | `auth` phone-first + UAE PASS (extension of M1) | +971 OTP via WhatsApp/SMS, passkeys, UAE PASS OAuth provider | F4–F5 |
| M17 | `payments-gcc` (extension of `billing`) | Stripe UAE, Checkout.com, Telr, PayTabs, N-Genius; Apple/Google Pay; Tabby/Tamara; COD; bank-transfer reconciliation | F7 |
| M18 | `tax-gcc` | FTA-compliant tax invoices, TRN, 5% VAT with zero-rated/exempt handling, credit notes, VAT reports, Peppol/ASP adapter interface; ZATCA adapter later | F7 |
| M19 | `i18n` RTL (extension) | EN/AR for all official modules, RTL layout, Eastern Arabic digits optional, Hijri optional, AED/date formats, Arabic pluralization | F4 (core), F7 (complete) |
| M20 | `delivery-gcc` | Aramex and Careem/Quiqup shipments and tracking; Talabat/Deliveroo order ingestion for F&B | F7+ |
| M21 | `marketplace-sync` | Noon and Amazon.ae stock and order sync | F7+ |
| M22 | `reports` | Sales and cash reports, Excel/CSV export, Zoho Books / QuickBooks / Xero export | F7 |
| M23 | `gcc-data` | Emirates and areas, +971 validation, Emirates ID and TRN format checks, trade license field, Makani/P.O. Box | F4 (small) |
| M24 | `booking` | Schedules, slots, deposits, WhatsApp reminders; the base for salons, clinics, fitness, home services | F7 (as a module, used by the booking starter) |

Starters for `renox new`: `booking` (salon/clinic/fitness/home services), `restaurant-ordering` (QR menu, WhatsApp orders, Talabat ingestion), `shop` (with Tabby and Apple Pay), `real-estate-crm` (brokers), `tourism-booking` (tours, yachts, desert safaris), `invoice` (B2B services with FTA tax invoices), `membership` (gyms, communities), `company-profile` (bilingual). Every starter ships EN/AR and uses the GCC modules.

Dropped from earlier drafts: offline-first PWA for POS (optional later), Indonesian payment and logistics integrations.

## 5. Competitive landscape (UAE)

| Competitor | Strong at | Renox's opening |
| --- | --- | --- |
| Zoho (Dubai office, Zoho One) | Broad, cheap suite widely used by SMEs | Generic and rigid; custom flows, own domain, better customer-facing UX |
| Odoo (Dubai office, large partner network) | Modular ERP, agency ecosystem | Heavy and costly to implement; Renox is lighter for customer-facing apps |
| Shopify | Mature stores, AED supported | USD pricing, limited customization; custom stores with BNPL and WhatsApp via agencies |
| Fresha, Foodics, Posrocket, Loyverse | Finished verticals (salons, F&B, POS) | Not fought head-on in POS; custom apps and underserved verticals; our own booking/ordering products compete on price and local fit |
| Salla / Zid (Saudi-first, expanding) | Arabic-first e-commerce builders | Stronger in Saudi; in the UAE the gap is non-retail verticals |
| Wix/Squarespace + agencies, WordPress | Cheap websites | Slow, fragile, not modular; same argument as elsewhere |
| Build from scratch (Laravel/Next/React Native agencies) | Freedom | Slow and expensive for SMEs; starters plus GCC modules cut delivery time 5–10x |

See the matrices in `02-comparison.md` for the framework/platform view.

## 6. Unit economics (UAE)

| Factor | Earlier assumption | UAE |
| --- | --- | --- |
| 8 GB node cost | ~$40/month (budget VPS) | ~$100–150/month (AWS/Azure UAE region, reserved) |
| Starter tier | ~$4–7 | AED 49–99 (~$13–27) |
| Pro tier | ~$20–35 | AED 199–399 (~$54–108) |
| Vertical SaaS (booking, F&B ordering) | — | AED 149–499/month per business, in line with incumbents |
| Idle tenants per node | ≥ 1,000 | Unchanged; density does not depend on region |
| Conversion needed to break even per node | ~5% to Starter | ~3% to Starter, or ~1% to a vertical product |

Infrastructure costs rise 2–3x; prices rise 3–5x. Margins improve, provided no expensive operational components are added; SQLite per tenant remains the right call here.

## 7. Company, tax, and compliance for Renox itself

| Item | Action | When |
| --- | --- | --- |
| Legal entity | UAE free-zone technology license (for example DMCC, IFZA, DTEC) to invoice in AED, sign contracts, and open a local bank account; incorporation and banking can take 1–3 months | Start in parallel with F1 |
| VAT | Register with the FTA when turnover crosses the threshold; non-resident digital services to UAE consumers are also in scope — **verify** | Before first paid tenant |
| PDPL | DPA template, records of processing, data classification, breach procedure; DIFC/ADGM variants for tenants established there | F6 |
| Health data | In-country guarantee tier; no health-data tenants before it exists | F7 |
| Payments | Renox never holds funds; all through PSPs licensed by the Central Bank of the UAE | Always |
| E-invoicing | Design `tax-gcc` around an adapter so SME-phase obligations can be met through an accredited provider when the SME phase begins — **verify** timeline | F7 |
| Support | English first, Arabic available; WhatsApp Business support channel; working hours GST (UTC+4), Sat–Sun weekend | F7 |

## 8. Infrastructure adjustments

- Production region: UAE (AWS me-central-1 or Azure UAE North to start; local colocation when volume justifies). Documented as a hard requirement in `03-architecture.md` and `06-data.md`.
- Static assets and image variants behind a CDN with a UAE point of presence.
- Backups (Litestream) to object storage **in the UAE**; no cross-border replication by default.
- Saudi Arabia expansion later requires in-country hosting and ZATCA e-invoicing from day one; the region and tax modules are designed to allow it, but it is not scheduled.

## 9. Risks specific to the UAE

| Risk | Mitigation |
| --- | --- |
| Half-finished Arabic/RTL damages trust with local customers | Complete EN first; ship AR only where fully tested (core modules, invoices, booking, ordering) |
| Moving regulation (e-invoicing phases, payment rules, PDPL guidance) | Adapter interfaces, quarterly review, verify-flagged items tracked in the roadmap |
| Entity and banking delays | Start incorporation during F1 |
| Local incumbents with sales teams (Zoho, Odoo) | Win through vertical products and agencies, not generic direct sales |
| Temptation to enter Saudi early | Not before UAE traction; keep designs compatible only |

## 10. Items to verify before roadmap commitments

- Current status, phases, and SME thresholds of UAE e-invoicing.
- UAE PASS onboarding process and eligibility for private-sector service providers.
- Adoption and merchant availability of Aani and Jaywan.
- VAT obligations for a non-resident provider before the UAE entity exists.
- Data residency requirements by sector beyond health (for example education, financial services).
- Pricing of reserved capacity and egress in AWS me-central-1 vs Azure UAE North, and availability of local colocation for bare-metal nodes.
