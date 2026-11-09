# Positioning canvas: the home-services product

Date: 2026-11-09. Status: draft for the owner; the owner decisions below are recorded, the rest is a hypothesis to test on the first five to ten customers. Method: April Dunford's five components (alternatives, unique attributes, value, best-fit customers, category) plus the four forces (Moesta), a positioning statement (Moore) and a hero draft. The research behind it (competitor pain points, hero taglines, UAE market data, the frameworks) was gathered on 2026-11-09; the sources are at the end.

## Owner decisions (2026-11-09)

1. **Renoxium is the company and the platform.** It never appears as a vertical product. Each vertical ships under its own product brand; the first one has no name yet (working name below: **[brand]**). Agencies keep the Agency tier's white label under their own names. Three layers, three names: Renoxium (platform, developers and agencies), [brand] (our product for home-services companies), the agency's label (their product for their clients). All three run on the same platform.
2. **The first vertical is home services and facility management in the UAE**, the app of `examples/home-services` ([Reference app](../reference-app.md), epic #554).
3. **The buyer is the business owner, not a developer.** They change the app by talking to the AI assistant they already pay for (ChatGPT, Claude), not by writing code.
4. **The price to test is AED 299 per business per month.**
5. **Self-hosting is an option and a guarantee**, not a headline: the whole repository is Apache-2.0 (D29), every company is one SQLite file, and the data plane is one binary.

## 1. Competitive alternatives, from the buyer's seat

What a home-services owner in Dubai or Sharjah does today when [brand] does not exist. Vercel, Next.js and Supabase never appear here; they belong to the platform's canvas (section 12).

| Alternative | What it costs them | Why they pick it | Why they leave it |
| --- | --- | --- | --- |
| **WhatsApp + Excel + paper** (the status quo, and the biggest competitor) | Nothing on an invoice; hours a day of retyping, lost quotes, late AMC renewals, invoices without a gapless number | It works, everyone knows it, zero onboarding | A VAT audit, a lost customer, the e-invoicing mandate, a second branch |
| **Generic SaaS** (Zoho FSM or Books, Odoo, Jobber, ServiceM8, ServiceTitan-class; verify current AED prices) | Roughly AED 150 to 700 a month, often per user, often in USD | A known name, a free trial, a sales team | Does not match how they work, every change is a feature request, USD billing, Arabic and FTA invoices are an afterthought |
| **An agency builds it** (Laravel, Next.js, React Native) | AED 50,000 to 100,000 for an MVP, AED 300 an hour, then a retainer of AED 1,000 to 3,000 a month | It is exactly what they asked for; "it is ours" | Slow, every change costs money, the agency disappears or holds the code |
| **Build it themselves with an AI builder** (Lovable, Bolt, ChatGPT and a VPS) | USD 25 to 100 a month plus their evenings | They already have ChatGPT; it feels free and fast | Login, data and invoices are generated too, and they break or leak (16,326 exposed Supabase databases, 170 of them Lovable apps); nobody to call |

The two decisions the buyer actually weighs: **rent something rigid, or pay someone to build something they do not own.** The position of [brand] is the third option between them.

## 2. Unique attributes (true on `main` today, and the gaps)

| Attribute | Evidence | Which alternative lacks it |
| --- | --- | --- |
| A complete app for the vertical: customers and sites, quotations with an approval link, jobs and a live dispatch board, the technician's visit (photos, parts, signature) with a PDF report, FTA tax invoices with cash, transfer and cheque payments, AMC contracts, reports, a branded back office, English and Arabic with RTL | `examples/home-services`, shipped (#566); 16 official modules | Agency (not built yet), AI builder (not built yet), spreadsheets |
| Changeable by the owner's own AI assistant: every app ships `AGENTS.md` and `renox mcp` (docs, routes, `renox check` and `renox test` results); the app exposes its own MCP tools (`next_free_slot`, `job_status`, `create_job`) | `docs/20-ai-agents-mcp.md`; `www` "Built for coding agents" | Generic SaaS (closed), agency (billable) |
| The parts that must stay right are modules Renoxium maintains: `auth`, `2fa`, `org`, `billing`, `tax_gcc`, `whatsapp`, `audit`, `storage`, `email`, `booking`, `jobs`, `reports`; the AI changes pages and glue, not these | `modules/`; module SQL goes through the SQLite authorizer, limits are enforced in Rust (`docs/24-threat-model.md`) | AI builder (everything generated), agency (bespoke, unmaintained) |
| Ownership that can be exercised: Apache-2.0 for the whole repository (D29), one SQLite file per company, `renox-worker` runs anywhere, `renox dev` runs the app locally | `LICENSE`, D29, D5 | Generic SaaS, agency (code held) |
| Local fit: AED with fils, 5 % VAT and TRN on a gapless tax invoice, credit notes, +971 and TRN checks, Emirates and areas, Hijri dates, Eastern Arabic digits, Arabic PDFs, WhatsApp notifications and approval links | `modules/tax_gcc`, `modules/gcc`, `modules/i18n`, `modules/whatsapp` | Every global alternative |
| Cheap to run, so it can be cheap to buy: 107 KB per idle company on the node, about 10 MB warm, a thousand registered companies per 8 GB node | `docs/14-benchmarks.md` (B1, B2, B3) | Agency hosting, per-user SaaS |
| Hand onboarding today (D31): the first customers are set up by us, with their data | D31 | AI builder, generic SaaS |

Gaps, to state honestly on the page and in the pitch, with their issue:

- No online payments; staff record cash, transfer and cheque (D31, #516).
- The e-invoicing provider interface exists, no live Accredited Service Provider yet (#331). The SME phase of the mandate is 2027, which makes this a 2026 roadmap item, not a launch blocker.
- The ChatGPT and Claude *connector* (the remote MCP as a one-click app the owner installs in ChatGPT) is new work; today the MCP is local (`renox mcp`) and the platform MCP is behind OAuth for the CLI's users.
- No mailbox hosting. The app sends transactional mail; `info@company.ae` inboxes are not our business (resell or integrate if asked).
- Arabic catalogs are machine-translated pending a native speaker's review (`docs/16-risks.md`).
- One region behind Cloudflare, no data-residency promise (D25); no health-data tenants.
- "Take it anywhere" is a licence and an architecture today, not yet a button: an export (app, SQLite file, stored files) and a tested self-host guide are needed before the guarantee is printed (section 13).

## 3. Value themes: so what

Three themes, each mapped to the alternative it beats. More than four dilutes; "saves money" alone is not a theme.

| Theme | The sentence for the buyer | Attributes behind it | Beats |
| --- | --- | --- | --- |
| **A. Running today** | "Your quotes, dispatch, visits, invoices and contracts, live with your company's name, this week, not in six months." | Complete app, hand onboarding, local fit | Agency (months), AI builder (evenings), spreadsheets (never finished) |
| **B. Yours** | "Change anything by telling your ChatGPT or Claude. Take it anywhere. If we disappear tomorrow, it keeps running." | AI-changeable, Apache-2.0, one file per company, self-host | Generic SaaS (rigid, closed), agency (holds the code, bills every change) |
| **C. The parts that must be right stay right** | "Logins, tax invoices, VAT, backups and security are ours to keep correct, including e-invoicing when the mandate reaches you." | Maintained modules, Rust-enforced limits, authorizer, backups | AI builder (generated auth and data leak), agency (no upkeep), spreadsheets (audit risk) |

Theme B is the one to own if only one is allowed (Jason Cohen's "pick one and own it"; Ries and Trout's one word). The word is **yours**.

## 4. Best-fit customers

The ones who care most about theme B and C, and can buy theme A this quarter.

| Dimension | Best fit | Signals of a great fit | Not a fit (say so on the page) |
| --- | --- | --- | --- |
| Business | Home services, AC and MEP maintenance, cleaning, pest control, facility management; UAE mainland or free zone | Already issues tax invoices (VAT-registered, turnover above AED 375,000); has AMC customers; runs two dispatchers or more | Single-technician handyman (the free tier, not a sales target); enterprise FM with procurement and SLAs; anything with health data |
| Size | 3 to 30 technicians, 1 to 3 branches | Hiring a second dispatcher; opening a second emirate | 100+ technicians (needs integrations we do not have) |
| Current state | WhatsApp + Excel, or a failed trial of a generic tool, or an agency quote in the drawer | Lost a quote to a competitor who answered faster; a VAT query they could not answer from the records | Happy on Zoho or Odoo with an implementation partner |
| The person | The owner or operations manager, already paying for ChatGPT or Claude, English-first, Arabic customers | Shows us something they built or changed with AI; asks "can I change the quote layout myself?" | Wants a vendor to own everything and never touch it (sell them the agency channel) |
| Money | Pays AED 200 to 1,000 a month for software today (strategy doc); has been quoted AED 50,000 by an agency | Asks about ownership and exit before price | Expects free forever |

## 5. Market category and the trend layer

**Frame:** head-to-head inside a known category, **home-services or field-service management software in the UAE**, where the buyer already has a budget line and search terms, differentiated by *yours* (theme B) and *kept right* (theme C). Not "AI app builder" (a crowded horizontal fight against Lovable, Bolt, Base44), not "hosting" (the buyer never shops for it), and not a new category (a one-person company cannot afford to teach one).

**Trend layer, used carefully:** AI assistants are already in the buyer's pocket (29 % of UAE SMEs pay for an AI tool, AED 268 a month on average, Pemo index; the OpenAI-UAE nationwide ChatGPT arrangement, verify its current status), and the UAE e-invoicing mandate reaches SMEs in 2027 with penalties of AED 5,000 a month. The first makes "change it with your own AI" plausible; the second gives the sale a date.

## 6. The four forces (Moesta), and which part of the page answers each

| Force | What the buyer feels | Page element |
| --- | --- | --- |
| **Push** (away from today) | Quotes lost in WhatsApp, invoices retyped, AMC renewals missed, an agency quote of AED 50,000, e-invoicing coming | The insight paragraph and the "alternatives" table |
| **Pull** (toward [brand]) | Live this week with my name on it; I can change it myself; it is mine | Hero, the three themes, the demo with their data |
| **Anxiety** | Who fixes it at 11 pm? Where is my data? Will this company exist in two years? Is Arabic real? | Theme C, the ownership guarantee (export and self-host), the support promise (WhatsApp, GST hours), the status page, the open repository |
| **Habit** | "WhatsApp works." "My dispatcher knows Excel." | Import from Excel, WhatsApp stays the customer channel (the app sends the links there), the technician's phone page needs no app store |

A switch happens when push plus pull exceed anxiety plus habit. The anxiety row is where [brand] wins or loses; it is also the row no competitor's page answers today.

## 7. Positioning statement (Moore)

For **home-services and facility-management companies in the UAE** who **run their operations on WhatsApp and spreadsheets and have been quoted a fortune by an agency**, **[brand]** is **a ready-made operations app (quotations, dispatch, visits, FTA tax invoices, maintenance contracts) that you change by talking to your own ChatGPT or Claude**. Unlike **Zoho, Odoo or an agency**, **it is yours: change it any afternoon, take it anywhere, and the parts that must stay right (logins, invoices, VAT, backups) are kept right for you.**

## 8. The insight and the spiky point of view (Dunford's Sales Pitch, Wes Kao)

**Insight:** Software for a small business has always meant choosing between renting something rigid and paying someone to build something you do not own. AI made *writing* software cheap. That ends the dilemma, but only if two things hold: the app is already complete, and the parts that must not break are not the parts the AI writes.

**Spiky point of view:** "You should own your operations app the way you own your shop, and your AI should be allowed to change everything in it except the parts that must be right." People can disagree with it (Zoho would; an agency would), it is rooted in evidence (the leaked Lovable apps; the agency retainers), and it explains why the product is built the way it is.

## 9. The hero and the page order

Page order follows the pitch: insight, alternatives, perfect world, product, proof, price, ask. It must pass the grunt test (what is it, how does it make my life better, how do I get it) in five seconds, in the buyer's words, with the dispatch board and an Arabic tax invoice visible, not architecture.

Hero draft (English; the Arabic version follows once a native speaker reviews the catalogs):

> **Your operations app. Yours.**
> Quotations, dispatch, technician visits, FTA tax invoices and maintenance contracts, running under your company's name this week. Change anything by telling your ChatGPT or Claude. Take it anywhere, any time.
> [See it with your company's data, in an hour] [How ownership works]

Alternative openers to test (one H1 at a time, held for 60 days unless the interviews say otherwise):

- "Stop choosing between rigid software and an expensive agency."
- "The operations app you own, and change by talking to it."
- "Built for AC, maintenance and cleaning companies in the UAE. Yours to change."

Below the hero, in order:

1. **The insight** in four sentences (section 8), then the honest alternatives table of section 1 with a "pick them if" line for each (PostHog's rule: credit what they do well).
2. **The perfect world**, as a checklist the buyer can agree with before seeing the product: already complete for my trade, in English and Arabic, with FTA invoices; mine; changeable without a developer; the critical parts maintained by someone accountable; a way out.
3. **The product**, in the order of their day: the WhatsApp request becomes a customer and a quote; the approval link; the dispatch board; the technician's phone; the invoice and the payment; the AMC renewal; the reports. Real screens with sample data (the FixIt seed).
4. **"Change it with your AI"**: one real transcript, for example "Add a 'parts warranty' line to every quotation PDF and show it in Arabic too", with the result. One sentence under it: what the AI may change (pages, flows, texts, reports) and what it may not (logins, invoices, VAT, payments, backups), and why.
5. **Proof**: the first customer's story in their words (the reference customer; FixIt until then, labelled as the demo), the open repository, the status page, the measured numbers kept to one line.
6. **Price** (section 10) and what is and is not included, the gaps of section 2 stated plainly with their roadmap dates.
7. **The ask**: a WhatsApp button and a calendar link for the one-hour setup with their data; the transitional CTA is the ownership page.
8. **"When [brand] is not for you"**: the not-a-fit column of section 4, in one paragraph. It is a trust feature.

## 10. Price: AED 299 per business per month (hypothesis)

**What AED 299 buys:** one company with its branches, every role, the complete app, English and Arabic, WhatsApp notifications, PDFs, hosting, backups, module upkeep and compliance updates, support on WhatsApp in GST hours. VAT 5 % added, a tax invoice every month in AED.

**What it does not buy (yet):** online payments, a live e-invoicing provider, an inbox, native apps. These are printed, with dates where there are issues.

**Anchors the buyer will use (verify the current numbers before printing any):** generic field-service tools at roughly AED 150 to 700 a month, often per user and in USD; an agency retainer of AED 1,000 to 3,000 a month on top of the build; the AED 268 a month the average AI-paying SME already spends. AED 299 sits above the cheap generic tier, which is right for theme B and C, and far below an agency.

**Our side of it:** an active company costs the platform about 10 MB of memory while warm and 107 KB while idle, so one `node-small` carries hundreds of paying companies; at AED 299 the hosting cost is a rounding error and the real costs are onboarding and support hours. The strategy doc's break-even needs about 1 % conversion to a vertical product per node; this price clears it with room. Internally a [brand] subscription maps to a Starter or Pro plan of `pricing.toml`; the buyer never sees requests or CPU-ms.

**How to test it:** sell it, do not survey it. Offer the first five to ten companies a hand-onboarded pilot at AED 299 with a written exit (their data, any time). Record every objection to the number and every "what else is included" question. Ask the four Van Westendorp questions at the end of each pilot conversation (too cheap to trust, a bargain, getting expensive, too expensive) and keep the price unless three of five answers cluster away from it. Decide later, with data: a per-branch add-on, an annual price, and whether a free tier for the single-technician handyman is a lead magnet or a support burden.

## 11. Proof plan (what turns this draft into positioning)

1. **Five to eight switch interviews** with the pilot companies and with two who declined: reconstruct the last time they tried to fix operations (the agency quote, the Zoho trial), map the four forces. Their sentences replace ours in the hero.
2. **The "very disappointed" survey** (Superhuman method) when about 40 companies have used it for a month; the "main benefit" of the very-disappointed group is the positioning, and the blockers named by the somewhat-disappointed are the roadmap.
3. **Comparison pages**, PostHog style, each with a table on the dimensions of section 1, a "pick them if" paragraph and our gaps: [brand] vs Zoho and Odoo; vs an agency build; vs building it yourself with Lovable or ChatGPT; vs WhatsApp and Excel (the honest one about when a spreadsheet is enough).
4. **The ownership page**, written only once the export and the self-host guide exist and have been run by someone outside the team.
5. **One reference customer** named, with numbers (quotes sent, days to first invoice, AMC renewals caught), before any paid acquisition.

## 12. What this means for renoxium.com

Renoxium stays the platform's name and the company. Its site speaks to developers and agencies, stays minimal and spends nothing on marketing while the vertical is proven. Its why is a different one, found in the same research: "stop rebuilding sign-in, roles, billing and backups for every client, on hosting that charges only for what runs", positioned as buy-vs-build for small agencies, with the comparison pages that belong there (vs Next.js on Vercel plus Supabase, vs a VPS with Coolify or Kamal, vs Laravel and Rails). The Heroku gap and the "Laravel for TypeScript" discourse are its tailwinds; AED 79 Starter against roughly AED 165 for Vercel Pro plus Supabase Pro is its number. One line on it names the vertical: "the platform behind [brand]". That page is a separate plan.

## 13. Open items for the owner

| # | Item | Why it blocks the page |
| --- | --- | --- |
| 1 | **The brand name.** Three directions: descriptive English (the trade in the name); an Arabic root that an English speaker can say, for example a word for maintenance or care (check `.ae` and `.com` availability and the UAE trademark register before falling in love); a neutral coined word with an Arabic wordmark. Must read well on an Arabic PDF and in a WhatsApp message | The hero, the domain, the PDFs, the WhatsApp sender name |
| 2 | **Export and self-host as a feature**: `renox export` (app, SQLite file, stored files, module versions) and a tested guide to run `renox-worker` on a VPS; file the issues | The ownership guarantee cannot be printed before it exists |
| 3 | **The ChatGPT and Claude connector scope**: a narrow set of safe tools for the owner's tier (services, texts, branches, flows, reports) versus full code access for developers; which store or directory to list in | Theme B's proof transcript, and the "what the AI may not change" sentence |
| 4 | **Per-branch pricing and an annual option** | The price section |
| 5 | **The pilot offer**: how many companies, what the written exit says, who does the one-hour setup | The ask |
| 6 | **The Arabic hero** after the native-speaker review | The RTL page |

## Sources used for this canvas

Competitor positioning and pain points, 2026-11-09: State of JS 2024 and 2025 meta-framework pain lists (2024.stateofjs.com, 2025.stateofjs.com); HN "Why is Vercel so expensive?" (news.ycombinator.com/item?id=39898391) and "Next.js 15.1 is unusable outside of Vercel" (item?id=44255911); InfoQ on the Cara.app Vercel bill (infoq.com/news/2024/06/vercel-serverless-scale-expenses); UpGuard on exposed Supabase databases (upguard.com/blog/everything-everywhere-systemic-data-exposure-in-supabase-apps); Heroku's "An Update on Heroku" (heroku.com/blog/an-update-on-heroku) and the HN thread (item?id=46913903); DHH, "The One Person Framework" (world.hey.com/dhh/the-one-person-framework-711e6318) and "Rails 8: No PaaS Required" (rubyonrails.org/2024/11/7/rails-8-no-paas-required); Wasp, "Why we don't have a Laravel for JavaScript yet" (dev.to/wasp); the hero pages of Vercel, Netlify, Laravel Cloud, Fly.io, Render, Supabase, Convex, PocketBase, Coolify, Cloudflare Workers, Heroku, Rails, Laravel, Astro and htmx.

UAE market: Pemo SME Spend Index via communicateonline.me ("UAE SME spending on AI rises fivefold"); UAE e-invoicing timelines (middleeastbriefing.com, abmagazine.accaglobal.com, fiscal-requirements.com); agency and freelance rates (squashapps.com, gmtasoftware.com, twine.net, ptolemay.com); SME counts (wam.ae, thenationalnews.com); `docs/21-uae-gcc-strategy.md`.

Frameworks: April Dunford, "Positioning" and "A guide to advanced B2B positioning" on Lenny's Newsletter, "A product positioning exercise" (aprildunford.com); Bob Moesta, the four forces (jobstobedone.org/the-four-forces); Geoffrey Moore's positioning template (as reproduced by Shortform); Andy Raskin, "The greatest sales deck I've ever seen" (Medium); Jason Cohen, "One benefit" and "Worse, but unique" (longform.asmartbear.com); Emily Kramer, MKT1 positioning guide (newsletter.mkt1.co/p/positioning-guide); Wes Kao, "Spiky point of view" (weskao.com); Rahul Vohra, the Superhuman PMF engine (First Round Review); PostHog, comparison content guide (posthog.com/blog/comparison-content-guide); Plausible vs Google Analytics (plausible.io/vs-google-analytics); Linear, "Switch" (linear.app/switch); Alex Hormozi, the value equation (as summarized on Medium and SuperSummary); Jeroen Coelen, "For the love of god, don't start with why" (doctormarket.fit).
