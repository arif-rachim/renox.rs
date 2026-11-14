# Reference app: home services

`examples/home-services` is a complete app for a UAE home-services or facility-management company: one company with several branches that takes requests, quotes them, sends technicians, reports the visit with photos, issues FTA tax invoices, records payments and renews yearly maintenance contracts, in English and Arabic. Research of 2026-11-07 ranked facility management and home services first among ten UAE SME verticals: the daily work is WhatsApp intake, a scheduled visit, technician dispatch, a photo report, payment after the visit by cash, transfer or cheque, and annual maintenance contract (AMC) renewals. Each of those steps maps onto an official module, so the app is mostly configuration, pages and a few hundred lines of glue per feature. It is the demo for the first free-tier users and a starting point for an agency that builds such an app for a client.

Start a copy of it:

```sh
renox new fixit --template home-services
cd fixit
bun install
renox check
renox test --seed seeds/001_demo.sql
renox db seed
renox dev
```

**On the platform, with your own company** (#689): the dashboard's first-app page and the platform MCP tool `create_app_from_template` create a live copy in one call, `POST /v1/apps/from-template` with `template: "home-services"` and a `setup` (`deploy-api.md` section 21): the company (name, optional TRN, phone, emirate), 1 to 5 branches, 1 to 50 services and 0 to 20 people to invite. The app starts with that data and **without the demo seed**; the signed-in account's verified email becomes its first user, with the role `owner`, and each person listed is invited through `org`. The platform does this by calling the app's `POST /api/setup` once, with a one-time token (`deploy-api.md` section 21); that route is `functions/api/setup.ts` and answers 409 when the settings already exist.

`renox db seed` loads `seeds/001_demo.sql` into the local database, so `renox dev` shows the demo company "FixIt Services" with two branches (Dubai and Sharjah), customers, quotations, jobs and invoices. Every demo user signs in with the password written in the seed's comments (for example `owner@fixit.example`, `dispatcher.dubai@fixit.example`, `ali.dubai@fixit.example`).

## Roles

Roles are the `[authz.default_roles]` of `renox.toml`; branches are `org` organisations, and every branch-owned row is read through the active branch.

| Role | Does |
| --- | --- |
| Owner | Everything, across branches: settings, users, invoices, payments, reports. Sensitive actions (`invoice.issue`, `invoice.pay`, `settings.write`, `user.manage`, and `twofa.reset`, the owner's alone) need a recent second factor (`twofa`). |
| Branch manager | Customers, quotations, jobs, dispatch and contracts of the branch; reads its invoices and reports. |
| Dispatcher | Customers, quotations, jobs and the live dispatch board of the branch; contracts. |
| Technician | Today's visits at `/me` on a phone, only their own jobs. |
| Accountant | Issues tax invoices and credit notes, records payments, reads and exports the reports. |
| Customer | No login: signed links to approve a quotation, read the visit report and the invoice. |

Inventory follows the same roles. The owner and the branch manager keep the parts and the suppliers (`part.write`), move stock (`stock.move`) and raise purchase orders (`purchase.write`); the dispatcher reads the parts and the stock (`part.read`, `stock.read`); the accountant reads those and the suppliers and purchase orders too (`purchase.read`); a technician sees the parts list and picks a part on a visit, and nothing of the stock. The stock report and the low-stock tile need `stock.read`.

## The flow, end to end

1. **Request.** A customer writes on WhatsApp or calls; the dispatcher finds or adds the customer and the site (`/customers`; `gcc` checks the +971 number and the TRN).
2. **Quotation.** The dispatcher prices the work from the service catalogue (`/quotes/new`; 5 % VAT, an optional AI draft of the lines) and sends it. The customer gets a WhatsApp message (or an email) with a signed link, `/l/approve/<token>`, and approves or rejects it there, with the PDF in English or Arabic.

   _Screenshot: the quotation page and the approval link on a phone._

3. **Job and scheduling.** An approved quotation becomes a job (`/jobs/new`); the dispatcher picks a slot of a technician (`booking`) on the job page or on `/dispatch`, the board two dispatchers of a branch share live over a WebSocket. The customer is told the time, and reminded on WhatsApp, in their language, 24 hours and 2 hours before the visit (the app fills the `booking.remind` hook of `booking`; a cancelled or moved visit sends nothing).

   _Screenshot: the dispatch board._

4. **Visit.** The technician opens `/me` on the phone (installable to the home screen), checks in, adds photos before and after (sent straight to the store through a signed upload URL), the parts used and a note, takes the customer's signature and checks out. The visit report PDF is built at check-out with a two-sentence summary in English and Arabic (`ctx.ai`, empty when no AI is configured), and the customer gets the link.

   _Screenshot: the visit page on a phone and the visit report._

5. **Invoice and payment.** The accountant issues the FTA tax invoice of the done job (`tax_gcc`: a gapless number, the customer's TRN), the customer gets a signed link to it, and staff record cash, bank transfer or cheque payments against it (`/invoices/<number>`). There are no online payments (D31). A credit note cancels a whole invoice. Each customer has a statement PDF.

   _Screenshot: the invoice list and an invoice with a payment._

6. **Contracts.** An annual maintenance contract lists services at the customer's sites with a number of visits a year. A daily scheduled job makes the next visits as jobs 14 days ahead, and another reminds the customer 30 days before the end and expires the contract after its last day; renewing copies it for the next year.
7. **The customer's own path.** The customer can also do it alone, from a phone, with no account and no call:
   - **Book.** `/book` (the link the owner shares): the service, the emirate, the area and the address, then a free time of the next 7 days across the branch's technicians, then the name and the WhatsApp number. A one-time code on WhatsApp signs the customer in, and "Confirm booking" makes the customer, the site and the job (`source = self_booking`).
   - **Confirm.** With "Confirm online bookings automatically" on (`/admin/settings`, "Customer portal"), the job is scheduled at once with the technician of the chosen time. Off (the default), the job waits in the board's New column with a "Booked online" badge and the time it wants; the board's header counts these and links to `/jobs?source=self_booking`. On the job page the dispatcher presses **Confirm** with one of the technicians free at that time, or, when nobody is, uses the schedule form below ("Propose another time"). The customer gets `visit_scheduled` or `booking_moved` on WhatsApp.
   - **Follow.** `/my` lists the customer's visits; `/my/visits/<id>` shows the time, the technician and, after the visit, the report and its photos.
   - **Change.** On the same page the customer moves the visit to another free time or cancels it, until the cut-off before the slot (default 12 hours) and up to the number of moves a visit allows (default 2); after that the page shows the branch's phone.
   - **Invoice.** `/my/invoices` lists the customer's tax invoices with what is still to pay, and `/my/invoices/<number>` shows one with its PDF and the payment instructions while it is open.

   _Screenshot: `/book` step 2 and the job page's "Requested time" on a phone._

8. **Reports.** The owner and the accountant see sales per day, jobs and hours per technician, contracts due for renewal and outstanding invoices by age, and export each as CSV or Excel.

   _Screenshot: the reports page._

9. **Parts and stock.** The company knows what it has in each branch (`/admin/parts`, `/admin/stock`, `/admin/suppliers`, `/admin/purchasing`). The path of a part:
   - **Buy.** The owner or the branch manager adds the part (SKU, names in English and Arabic, unit, cost, selling price, VAT, minimum stock) and the supplier, then raises a purchase order for the active branch (`/admin/purchasing`: a draft with lines, each a part, a quantity and a unit cost). **Send** marks it sent and offers its PDF in English or Arabic (`/admin/purchasing/<id>/pdf`); the platform's `email` module cannot attach a file yet, so the office downloads the PDF and sends it to the supplier.
   - **Receive.** When the goods arrive, the order's page takes what came, in part or in full, with the cost really paid: each line is one `in` move into the order's branch, the branch's average cost follows, and the order becomes *partly received* and then *received*. Stock that arrives without an order is received on `/admin/stock`.
   - **Use on a visit.** On the visit page the technician picks the part from the list (the quantity on hand is shown) or types a free-text part as before. A picked part takes its name and selling price from the list and the same save takes the quantity out of the branch's stock: one `out` move that names the visit. A phone that sends the same action twice moves stock once (the offline queue's `action_id`). A visit may take the balance below zero (the technician used what the books did not have): the move shows as negative and the branch's dispatchers are told once for that part and day.
   - **Count.** `/admin/stock` shows each branch's parts with the quantity, minimum, average cost and value. The owner or the manager records what was counted on the shelf (one `adjust` move with the difference and the count in its reason; it asks for the second factor), or transfers stock to another branch (a pair of moves). A part's page, `/admin/stock/<part>`, is its move history: who, why, and the balance after each move. The quantity is never edited, only moved.
   - **Low stock.** A part is low when what a branch has is under its minimum. The admin tile shows "Parts low on stock" (over the branches the owner holds) and links to `/admin/stock?low=1`; every day at 08:00 (Dubai) a job tells each branch's managers and the owner in the app, with up to ten parts (SKU, name, on hand, minimum), unless the list is the one told yesterday. The owner's connector answers "what are we running out of?" with the tool `list_low_stock`.
   - **Report.** `/reports/stock` lists, for each branch the viewer holds, the stock with its value at average cost and its total, and the moves of a period (the current month unless `?from=&to=`): received, used on visits, adjusted and transferred per part. Each table downloads as CSV or Excel (`stock` and `moves`, one sheet each; names are text, never formulas).

   _Screenshot: the stock page with a low part, and the purchase order's PDF._

The back office at `/admin` holds the branding settings, the branches, the users and their roles per branch, and the audit log. An AI agent can use three MCP tools of the app: `next_free_slot`, `job_status` and `create_job` (with a confirmation step).

### Working without signal

A technician in a basement or a lift lobby can finish a visit with no signal. This is the part of `/me` that the PWA of the visit page adds (`public/offline-queue.js`, `public/me.js`, `public/sw.js`; the server half is `lib/action-log.ts`).

- **What works.** On a visit page that is open, the forms for check-in, parts, notes, the signature, the summary and check-out keep working, and so do the photo forms. Each action is kept on the phone (IndexedDB `hs-offline`), the page shows it as done but "not sent yet", and a status line says how many actions wait. A photo is made at most 1600 px on its long side, kept on the phone as a blob and listed under its phase with Remove. When the phone is online again (the script asks `GET /me/ping`; it also retries every 30 s while something waits) the actions go to the server one at a time in the order they were made, each with its own `action_id` and the time it was done on the phone (`performed_at`, used when it is not in the future and not older than 72 hours), so a retry or a second send changes nothing. A photo goes through its three requests (a signed URL, the PUT, the `photo` action) at the place its time gives it among the actions. "All sent" shows when the queue is empty.
- **What does not.** Nothing is sent while the phone is offline, so the office sees the visit only when it arrives. The limits are 20 photos and 200 actions waiting on one phone (the form says so and keeps nothing more), a photo of at most 10 MiB, 20 MB of free space on the phone, and 72 hours (an older action is still sent, marked "saved more than 72 hours ago", with the server's time). Reading: the day's `/me` and visit pages are saved for offline reading only when the page carries `x-hs-offline-ok: 1`, which a page loader cannot set yet (#832). Until that is fixed, production stores no page, so a visit page that was not already open when the signal went cannot be opened offline; a page already open keeps working and queues its actions. The pilot's offline reading needs #832 before pages are stored in production.
- **When the server says no.** The office may have cancelled the job, given it to another technician, or closed the visit meanwhile. The server then refuses that action with its reason (`job_cancelled`, `job_reassigned`, `already_checked_out`, `not_checked_in`; a form that is wrong is a 422) and changes nothing; the later steps of that visit are not sent. They are listed on `/me` under **Needs attention**: the job's number and customer, each step (Check-out, "Part: filter × 2", "Photo (after)"), when it was done on the phone and the reason in plain words. **Discard** removes them from the phone after a question in the page, **Call the office** dials the branch's phone, and **Try again** (only when the job was given to someone else, which the office may have undone, or a form was wrong) sends them again with the same ids. There is no way to force an action in; a cancelled or closed visit can only be discarded.
- **The office is told.** A replayed action that is refused adds a job event `offline_action_refused` (the action, the reason, the technician, when it was done on the phone) that the job's timeline shows, and tells the branch's dispatchers in the app once for each job and reason ("Ali Hassan's check-out for J-1042, done offline at 10:14, was refused: the job was cancelled").
- **Signing out.** While something is saved on the phone and not sent, the account link in the header opens a page that says how many actions wait and asks "Sign out anyway?". What is saved stays on the phone for that user after signing out and is sent when the same user signs in again.

## Which module does what

| Module | In this app |
| --- | --- |
| `i18n` | English and Arabic strings (`i18n/en.json`, `i18n/ar.json`), the right-to-left layout, the language switch. |
| `auth` | Staff sign-in by email or phone, sessions, the CSRF token. |
| `org` | One organisation per branch; the active branch of a user; members. |
| `twofa` | The second factor that sensitive actions (invoice, payment, settings, users) require. |
| `audit` | One row per sensitive or important action; its audit page in the back office at `/admin`. |
| `notifications` | The in-app badge and the WhatsApp or email fallback of every customer message. |
| `email` | Email messages and the nightly report summary, sent to the address the app's `hooks.ts` gives through the `reports.nightly_to` filler (the accounts email of the settings). |
| `whatsapp` | WhatsApp Cloud API templates and the webhook; a customer's "cancel" or "reschedule" reply reaches the app's `hooks.ts` on `whatsapp.message_received` and becomes the dispatcher's task. |
| `billing` | Installed because `booking` needs it; no payment provider is configured. |
| `booking` | Technicians as resources, their slots and holds per branch. |
| `jobs` | The scheduled jobs: AMC visits and renewal reminders. |
| `storage` | Photos of a visit in the visit's folder, uploaded through signed URLs (`uploadUrl`), and signed links to show them. |
| `tax_gcc` | FTA tax invoices and credit notes, 5 % VAT, the seller's TRN. |
| `reports` | Sales per day, CSV export, the nightly summary by email. |
| `admin` | The back office, mounted at `/admin`; the app fills its `admin.sidebar` and `admin.dashboard` slots through `[[slots]]` in `renox.toml`, and its users page is `/admin/people`. An invited person's pending role is applied by `hooks.ts` on `org.member_added`, which emits the app's own `app.member_ready`. |
| `gcc` | Emirates, +971 numbers, TRN and trade licence checks. |

Inventory is not a module. Parts, stock, stock moves, suppliers and purchase orders are tables of the app (`app__parts`, `app__stock`, `app__stock_moves`, `app__suppliers`, `app__purchase_orders` and their lines), because the owner's decision of 2026-11-09 was to keep them in the example and promote them to an official module only when a second vertical needs them (`docs/plans/2026-11-09-home-services-v1-1.md`, "Decisions"). One file, `lib/stock.ts`, writes the stock tables, so the number on hand is always the result of moves; the branch fence is the same `[authz.ownership]` as for jobs.

The PDFs (quotation, visit report, invoice, statement, contract, purchase order) are `ctx.pdf` templates under `partials/pdf/`; the PDF engine renders text only, so photos are listed by caption and the signature by the signer's name.

## Arabic and right-to-left

Every page is audited in Arabic. The typeface is Noto Sans Arabic (SIL Open Font License), the Arabic subset in weights 400 and 700, copied unchanged from the npm package `@fontsource/noto-sans-arabic` into `public/fonts/` and served from the app's own origin, because the content security policy allows no CDN; `app.css` names the package version and the SHA-256 of each file, and `tests/typography.test.ts` compares them with `node_modules`. The layout preloads the regular weight only on an Arabic page, and `unicode-range` keeps the files from loading when a page holds no Arabic. In Arabic the line height is 1.8 (1.5 in headings), there is no italic, no letter spacing and no upper-casing, and digits stay Western. `app.css` uses logical properties only, so the layout mirrors with `dir="rtl"`; a table wider than a phone scrolls inside its own focusable box. Job, quote, invoice and contract numbers, phones, TRNs, Makani numbers and email addresses sit in an element with `dir="ltr"`, and names and notes typed by users take `dir="auto"` from the template engine. In `i18n/ar.json` a placeholder inside a sentence is wrapped in the Unicode isolates so that a Latin code does not reorder the sentence.

`bun bench/lighthouse/rtl-audit.ts` opens every route under `pages/` with `?lang=ar` at 390 and 1280 px and fails when a page scrolls sideways, is not `lang="ar" dir="rtl"` or does not use the Arabic face; `--screens` rewrites the twelve screenshots of the six key pages (the board, a job, the technician's list and visit, a customer, an invoice). The platform's own error pages (`pages/_404.html`, `pages/_error.html`) are rendered with the default locale and ignore `?lang`, so they stay English.

| Page | 390 px | 1280 px |
| --- | --- | --- |
| Dispatch board | [dispatch-390.png](reference-app/screens/ar/dispatch-390.png) | [dispatch-1280.png](reference-app/screens/ar/dispatch-1280.png) |
| A job | [job-390.png](reference-app/screens/ar/job-390.png) | [job-1280.png](reference-app/screens/ar/job-1280.png) |
| The technician's day (`/me`) | [me-390.png](reference-app/screens/ar/me-390.png) | [me-1280.png](reference-app/screens/ar/me-1280.png) |
| A visit (`/me/visits/<id>`) | [visit-390.png](reference-app/screens/ar/visit-390.png) | [visit-1280.png](reference-app/screens/ar/visit-1280.png) |
| A customer | [customer-390.png](reference-app/screens/ar/customer-390.png) | [customer-1280.png](reference-app/screens/ar/customer-1280.png) |
| An invoice | [invoice-390.png](reference-app/screens/ar/invoice-390.png) | [invoice-1280.png](reference-app/screens/ar/invoice-1280.png) |

## Adapt it for a client

- **Branding.** Name (English and Arabic), colour, logo, PDF footers, the sender name of emails and the accounts email are settings, edited at `/admin/settings` (stored in `app__settings`); no template, PDF or message hard-codes them. The installed phone app takes its name and colour from the same settings.
- **Catalogue.** The services and their prices are rows of `app__services` (`/services`); a service for every branch has no branch. Replace the demo rows of `seeds/001_demo.sql` with the client's.
- **Policies.** Who may do what is `[authz]` in `renox.toml` (actions, roles, sensitive actions) plus `policies/app/base.cedar` (for example, a technician performs only their own visits). Change a role there, add a case to `policies/tests/*.json`, and `renox test` checks it.
- **WhatsApp go-live.** The app starts in sandbox mode (`whatsapp_sandbox` on: messages are written to a preview table, emails still go). The steps to go live are below.
- **Custom domain.** `renox domains add www.client.ae`, then create the records it prints (`renox domains status www.client.ae` shows the state); see [Tenant lifecycle](05-tenant-lifecycle.md). Set `public_url` in the settings to the new address, since scheduled jobs have no request to take it from.
- **Seller details.** Set `seller_name`, `seller_trn` (15 digits) and `seller_address` in the `tax_gcc` config of `renox.toml` before the first real invoice: the demo's TRN is a placeholder.

## Owner steps to go live

1. `renox login` and `renox deploy` from the app's folder.
2. Set the `tax_gcc` seller name, TRN and address in `renox.toml`, and deploy again.
3. Email: set `from` in the `email` module's config, verify the sending domain with the provider (Resend), and set the accounts email in `/admin/settings`.
4. WhatsApp (Meta): create a Business app with the WhatsApp product, verify the business number, note the Phone number ID, create a system user with `whatsapp_business_messaging` and a permanent token, note the App Secret and choose a verify token; `renox secrets set` `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID`, `WHATSAPP_VERIFY_TOKEN` and `WHATSAPP_APP_SECRET`; set the callback URL to `https://<host>/whatsapp/webhook/whatsapp` and subscribe to `messages`; submit the six templates of `i18n/whatsapp.*.json` in English and Arabic and wait for approval; then turn `whatsapp_sandbox` off in `/admin/settings`.
5. The second factor: `renox secrets set TWOFA_KEY` (32 random bytes, base64; see the `2fa` module's README) before the first sign-in.
6. The domain: add it as above and set `public_url`.
7. Replace the demo data: the catalogue, the branches, the users and their roles (`/admin`).

The README of the app (`README.md` in the new folder) has the same steps with every page and table they touch.

## Onboarding a pilot

This is the path from "yes" to "their staff use it on Monday" for one pilot company. Each step names the page or command and what you should see. The support side (logs, restore, escalation) is `ops/runbooks/pilot-support.md`.

### 1. Before the visit

Ask the company for:

- their customer list, their sites, their price list and their running contracts, each as a spreadsheet (`.xlsx`; step 5 gives the columns);
- if they keep parts: the parts list (SKU, names, unit, cost, selling price, minimum) and **a count of what each branch holds on the shelf today**: count your opening stock first, before the first visit that uses a part, so the books start true;
- the logo as a PNG and the brand colour as a hex value (`#1f6f5c`);
- the branch names and the emirate of each;
- who is owner, manager, dispatcher, technician and accountant, with each person's email;
- the WhatsApp Business number, if they have one (step 7 works without it).

### 2. Create the app and sign in

Dashboard path: on the first-app page choose the `home-services` template, fill in the company (name, optional TRN, phone, emirate), the branches, the services and the people to invite. The app starts without the demo seed, and your verified email becomes its first user with the role `owner` (#689, `deploy-api.md` section 21).

CLI path, from a folder of your choice:

```sh
renox new acme-fm --template home-services
cd acme-fm
bun install
renox login
renox secrets set TWOFA_KEY    # 32 random bytes, base64; before the first sign-in
renox deploy
```

Open the app's address, sign in as the owner and set the second factor on `/auth/account` (the "Set up second factor" link of `/admin/people` leads there): scan the QR code, enter the first code, and keep the recovery codes the page shows once. You should land back in the app signed in; without the second factor the owner cannot save settings, issue invoices or invite people.

### 3. Branding and branches

`/admin/settings`: the company name (English and Arabic), the brand colour, the logo (PNG, JPEG or WebP), the sender name that customers see on mail and WhatsApp, the accounts email (the nightly summary goes there) and the footers of quotations and invoices. Save; the top bar and the sign-in page take the new name, colour and logo.

`/admin/branches`: one row per branch with its name in both languages, phone, emirate, area and address, and its working hours. Adding a branch creates it with the standard working hours. Under "Working hours" set each day from Monday to Sunday as closed or open from–to, on the half hour (at least one day open; a closing time before the opening is refused with the day named) and save: the booking module follows at once, so a dispatcher is offered slots only within those hours. Jobs already scheduled outside the new hours are not moved: the page says how many there are and links to them on `/jobs`.

### 4. People

`/admin/people`: for each person enter the email, choose the role (owner, manager, dispatcher, technician or accountant) and press "Send invitation". You should see "Invitation sent." and the person under "Pending invitations" with the date. The invitation is a mail with one link, `/org/accept/<token>`, valid for 7 days, usable once and only by the invited address; after sign-in or sign-up the person lands in the app with the role you chose. A pending invitation that expired is sent again the same way. Owners, managers and accountants who act on money need the second factor too: the "Second factor" column shows "Off" and a warning until they have set it on `/auth/account`. When someone loses their phone and their recovery codes, the owner presses "Reset second factor" on that person's row and confirms: the person is told, and sets it up again at their next sign-in (the owner needs a recent second factor of their own, and the reset is in `/admin/audit`).

A technician opens `/me` on the phone and chooses "Add to Home Screen" (Chrome: Install app; Safari: Share, Add to Home Screen). The app then opens full screen with the company's name, colour and icon, on today's visits. The README's "Install on a phone" has the details.

### 5. Import the existing data

`/admin/import` (the owner, with a recent second factor). Upload the six files **in this order**, because each one refers to the ones before:

1. `customers`: the people and companies, by branch.
2. `sites`: the addresses of those customers (found by the customer's phone).
3. `services`: the price list.
4. `parts`: the parts the company stocks (skip it when it stocks none).
5. `stock`: the opening balances, one row per branch and part, from the shelf count of step 1 (it needs the parts and the branches to exist).
6. `contracts`: the running yearly contracts (they need the customer, the site and the service to exist).

Download the template of each kind from the page, or directly: `/admin/import/template/customers`, `/admin/import/template/sites`, `/admin/import/template/services`, `/admin/import/template/parts`, `/admin/import/template/stock` and `/admin/import/template/contracts`. Each is a one-sheet `.xlsx` with the header row and two example rows. Header names are not case-sensitive and extra columns are ignored; only the first sheet is read; a file is at most 10 MiB and 10,000 data rows.

The columns of each file, as `lib/import.ts` checks them (required columns in bold):

| Kind | Columns | Rules |
| --- | --- | --- |
| `customers` | **branch**, **kind**, **name**, **phone**, email, trn, language | `branch` is a branch's English name, Arabic name or slug, case-insensitive. `kind` is `company` or `household`. `phone`, `trn`, `email`, `name` and `language` are checked by the customer form's own rules (a TRN is not required for a company). The phone is stored normalised. `language` is `en` or `ar`, default `en`. A customer with the same branch and phone, in the app or earlier in the file, is `exists`. |
| `sites` | **customer_phone**, **label**, **emirate**, **area**, **address**, makani, access_notes | `customer_phone` finds the customer by normalised phone in any branch: none is `unknown_customer`, more than one is `ambiguous_customer`. `emirate` is a code (`AE-DU`) or the emirate's English or Arabic name. `area`, `address`, `makani` and `access_notes` are checked by the site form's rules. The site takes the customer's branch. The same customer and label (case-insensitive) is `exists`. |
| `services` | **code**, **name_en**, **name_ar**, **unit**, **price_aed**, vat_rate, branch | `code` is 1 to 32 characters `[A-Z0-9-]`, upper-cased. `unit` is `visit`, `hour` or `unit`. `price_aed` is ≥ 0 with at most two decimals, stored in fils (12.5 becomes 1250). `vat_rate` is 0 or 5, default 5. An empty `branch` means every branch. An existing `code` is `updated`. |
| `parts` | **sku**, **name_en**, **name_ar**, **unit**, cost_aed, sell_aed, vat_rate, min_stock | `sku` is 1 to 32 characters `[A-Z0-9-]`, upper-cased (`bad_sku`). `unit` is `piece`, `metre`, `litre`, `kg` or `box` (`bad_part_unit`). `cost_aed` and `sell_aed` are ≥ 0 with at most two decimals, stored in fils; both default to 0. `vat_rate` is 0 or 5, default 5. `min_stock` has at most three decimals, default 0 (`bad_qty`). An existing `sku` is `updated` (names, unit, prices, VAT and minimum; the part's id and its active flag stay). The import writes no stock. |
| `stock` | **branch**, **sku**, **qty**, unit_cost_aed, reason | `branch` as in `customers`. `sku` must be a part (`unknown_part`: import the parts first). `qty` is more than 0 with at most three decimals (`bad_qty`). `unit_cost_aed` is the cost per unit; blank takes the part's cost. Each row becomes one `in` move with the reference `manual` and the reason "opening balance" unless `reason` says another. A branch and part that already have any move are refused with `stock_exists`, and so is a second row of the same pair in the file: an opening balance is imported once. Afterwards use Receive and Count on `/admin/stock`. |
| `contracts` | **number**, **customer_phone**, **starts_on**, **ends_on**, **price_aed**, **site_label**, **service_code**, **visits_per_year**, next_visit_on, notes | One row per contract item. Rows with the same `number` must agree on customer, dates and price (else `inconsistent_contract`). Dates are `YYYY-MM-DD` or an Excel date. `ends_on` ≥ `starts_on`. `visits_per_year` is 1 to 52. `site_label` must be a site of that customer, and `service_code` an active service of the customer's branch. `next_visit_on` must lie within the term. A contract is created as a draft. An existing `number` is `exists`. |

A file can hold 10,000 data rows. The check and the import each run as one background job, and a job attempt has a CPU budget of its own (2,000 ms on the free tier, 10,000 ms on a paid plan, #768), so a whole file of 10,000 rows is checked and imported in one go on the free tier, the import in one transaction. A run that goes past the budget does not break anything: it ends as "Failed" with "too large to check on the current plan".

The flow for each file: choose the kind, pick the file and press "Check the file". Nothing is written yet. The import's page says "Checking the file…" and reloads itself every few seconds until the check is done (usually within a second; a file that fails is retried once, about 10 seconds later). The report then shows the totals (rows, to insert, to update, already there, errors) and, for every wrong row, the sheet row, the column and the message. Fix the spreadsheet and check it again; the "Import <n> rows" button appears only when there are no errors. Pressing it writes the whole file in one transaction (the owner confirms with the second factor): the page says "Importing…" until it is done, then shows the result. A file that is not a workbook, or one too large for the plan, ends as "Failed" with the reason and an "Upload again" link, and stays in the list of last imports; nothing of it is written.

- `exists`: the row is already in the app (same branch and phone for a customer, same customer and label for a site, same number for a contract), so it is skipped and is not an error. Checking and committing the same file twice inserts nothing the second time.
- `updated`: only services and parts are updated: a row whose `code` (or `sku`) already exists changes that service's name, unit, price and VAT (or that part's names, unit, prices, VAT and minimum). Customers, sites, stock and contracts are never changed by an import.

The three most common errors:

| Message code | Meaning | Fix |
| --- | --- | --- |
| `bad_phone` | The phone is not a valid UAE number | Write it as `+971 50 123 4567` or `050 123 4567` (spaces are fine, letters are not); set the column's format to Text in Excel so the leading `0` or `+` survives |
| `unknown_branch` | The `branch` is not a branch name on `/admin/branches` | Copy the name from `/admin/branches` exactly, or add the branch first |
| `unknown_customer` | A `customer_phone` matches no customer | Import the `customers` file first, and write the phone in the same way in both files |
| `stock_exists` | The branch already has stock moves for that part | The opening balance was imported before, or a visit or a delivery moved the part: do not import it again; use Count on `/admin/stock` to correct the number |

An import cannot be undone from the app: if a wrong file was committed, restore the database to the minute before it (see `ops/runbooks/pilot-support.md`, "A wrong import").

### 6. Contracts

Imported contracts are **drafts**: nothing is invoiced and no visit is scheduled by the import. Open `/contracts`, check each draft with the customer (items, dates, yearly price), and activate it on `/contracts/<id>`. Activating a contract with a yearly price issues its upfront tax invoice through `tax_gcc`, which needs the owner with a recent second factor, so activate a contract only when the company really means to bill it now: for a contract that started months ago, activate it on the day the invoice should be dated, not earlier. A contract without items cannot be activated.

### 7. WhatsApp

The `whatsapp` module runs in its sandbox by default (`sandbox = true` in `renox.toml`): every message is recorded as sent, no API is called and no secret is needed, so the staff can practise safely. To go live:

1. Create the Meta Business app and register the number as in "Owner steps to go live" above (and the README's "WhatsApp" section).
2. Set the four secrets, one command each (the value is read from stdin):

```sh
renox secrets set WHATSAPP_TOKEN
renox secrets set WHATSAPP_PHONE_ID
renox secrets set WHATSAPP_VERIFY_TOKEN
renox secrets set WHATSAPP_APP_SECRET
```

3. Register the ten message templates of `i18n/whatsapp.*.json` in English and Arabic (`quote_sent`, `visit_scheduled`, `technician_on_the_way`, `report_ready`, `invoice_due`, `amc_renewal`, `booking_received`, `visit_moved`, `visit_cancelled`, `booking_moved`) and wait for Meta's approval; see "WhatsApp (from the `whatsapp` module's README)" in the app's `README.md`.
4. In `renox.toml` change the module's config to `sandbox = false`, set `public_url` to the app's address, and run `renox deploy`.
5. Test with one number first: a customer whose phone is the owner's own, a quotation sent to it, and the message arriving on that phone. Only then tell the staff.

`/admin/whatsapp` (the owner) lists the last 50 messages the app sent, newest first: the time, the recipient (only the last four digits show), the template or the start of the text, and the status (queued, sent, delivered, read or failed). Filter by status (`?status=failed`) or by phone. Codes of sign-in messages are never shown, and there is no resend button.

### 8. Open online booking

1. `/admin/settings`, section "Customer portal": decide with the owner whether online bookings are confirmed automatically ("Confirm online bookings automatically"; off by default, so a dispatcher confirms each one on the job page), until how many hours before a visit a customer may still change it (0 to 168, default 12), how often one visit may be moved (0 to 5, default 2), and the payment instructions in English and Arabic. Save: a number out of range is refused with the field named, and the change is a `settings.update` row in `/admin/audit`.
2. `/services`: untick "Bookable online" for any service the company does not want booked without a call. A new service, a new technician or changed branch hours is bookable at once, without a dispatcher scheduling a job first (a technician who has just accepted an invitation, and services written by the setup or the import, appear at the next staff page).
3. Copy "The booking link to share" from the same section (`https://<the app's address>/book`) and give it to the company: their WhatsApp profile, their website, their next message to customers.
4. A test booking. With the WhatsApp sandbox still on (step 7), the sign-in code is recorded as sent but never delivered (the `whatsapp` module's README, "Sandbox"), so the test stops at the code: open the link on a phone, check that step 1 offers the company's services and emirates and step 2 their free times, give the owner's own number in step 3, and see the `otp` row for that number on `/admin/whatsapp` (`?phone=`; the code itself is never shown). Once WhatsApp is live, run it to the end with the same number: enter the code, press "Confirm booking", and you should land on `/my` with "We received your booking". On `/dispatch` the job is in New with "Booked online" and the requested time; open it and press Confirm with a free technician, and the `visit_scheduled` message arrives on the owner's phone. Then cancel the test job.

### 9. The company's own domain

```sh
renox domains add www.acme-fm.example
renox domains status www.acme-fm.example
```

`add` prints the CNAME record and the two TXT records to create (use `www.<domain>`, not the apex). Enter them at the company's DNS provider, where they bought the domain. `status` shows `pending` and then `verified`; the time depends on the provider's DNS, from a few minutes to a few hours. When it is verified, set `public_url` to the new address (`app__settings`) and deploy again.

### 10. First-week checklist

- [ ] Day 1: one real job from quotation to paid invoice, with the company's own customer.
- [ ] The owner and every manager have the second factor on and the recovery codes stored.
- [ ] Every invited person signed in at least once (`/admin/people`: no pending invitation left).
- [ ] A technician completed a visit on their own phone, with photos and the signature.
- [ ] The nightly summary mail reached the accounts email.
- [ ] The owner keeps a database copy: `renox db export --out acme-fm.db`, then once a week.
- [ ] A contract was activated and its invoice reached the customer.
- [ ] A WhatsApp message to one real number arrived (or the sandbox is still on, on purpose).
- [ ] The company knows who to call: you, and the address for support requests.
- [ ] A test booking on `/book` reached the board and was confirmed (or the owner chose to confirm automatically).
- [ ] A date for the one-week review is in both calendars.

### 11. The written exit

The company's data is theirs: at any time `renox db export` downloads the whole SQLite database (checked by sha256), and `renox export` downloads a runnable copy of the app (database, stored files and the deployed artifact) that `renox-worker --config worker.toml` serves on any host; the self-hosting steps are in `docs/self-host.md`. Secret values are not exported; their names are listed in `secrets.txt`.
