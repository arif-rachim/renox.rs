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
| Owner | Everything, across branches: settings, users, invoices, payments, reports. Sensitive actions (`invoice.issue`, `invoice.pay`, `settings.write`, `user.manage`) need a recent second factor (`twofa`). |
| Branch manager | Customers, quotations, jobs, dispatch and contracts of the branch; reads its invoices and reports. |
| Dispatcher | Customers, quotations, jobs and the live dispatch board of the branch; contracts. |
| Technician | Today's visits at `/me` on a phone, only their own jobs. |
| Accountant | Issues tax invoices and credit notes, records payments, reads and exports the reports. |
| Customer | No login: signed links to approve a quotation, read the visit report and the invoice. |

## The flow, end to end

1. **Request.** A customer writes on WhatsApp or calls; the dispatcher finds or adds the customer and the site (`/customers`; `gcc` checks the +971 number and the TRN).
2. **Quotation.** The dispatcher prices the work from the service catalogue (`/quotes/new`; 5 % VAT, an optional AI draft of the lines) and sends it. The customer gets a WhatsApp message (or an email) with a signed link, `/l/approve/<token>`, and approves or rejects it there, with the PDF in English or Arabic.

   _Screenshot: the quotation page and the approval link on a phone._

3. **Job and scheduling.** An approved quotation becomes a job (`/jobs/new`); the dispatcher picks a slot of a technician (`booking`) on the job page or on `/dispatch`, the board two dispatchers of a branch share live over a WebSocket. The customer is told the time.

   _Screenshot: the dispatch board._

4. **Visit.** The technician opens `/me` on the phone (installable to the home screen), checks in, adds photos before and after (sent straight to the store through a signed upload URL), the parts used and a note, takes the customer's signature and checks out. The visit report PDF is built at check-out with a two-sentence summary in English and Arabic (`ctx.ai`, empty when no AI is configured), and the customer gets the link.

   _Screenshot: the visit page on a phone and the visit report._

5. **Invoice and payment.** The accountant issues the FTA tax invoice of the done job (`tax_gcc`: a gapless number, the customer's TRN), the customer gets a signed link to it, and staff record cash, bank transfer or cheque payments against it (`/invoices/<number>`). There are no online payments (D31). A credit note cancels a whole invoice. Each customer has a statement PDF.

   _Screenshot: the invoice list and an invoice with a payment._

6. **Contracts.** An annual maintenance contract lists services at the customer's sites with a number of visits a year. A daily scheduled job makes the next visits as jobs 14 days ahead, and another reminds the customer 30 days before the end and expires the contract after its last day; renewing copies it for the next year.
7. **Reports.** The owner and the accountant see sales per day, jobs and hours per technician, contracts due for renewal and outstanding invoices by age, and export each as CSV or Excel.

   _Screenshot: the reports page._

The back office at `/admin` holds the branding settings, the branches, the users and their roles per branch, and the audit log. An AI agent can use three MCP tools of the app: `next_free_slot`, `job_status` and `create_job` (with a confirmation step).

## Which module does what

| Module | In this app |
| --- | --- |
| `i18n` | English and Arabic strings (`i18n/en.json`, `i18n/ar.json`), the right-to-left layout, the language switch. |
| `auth` | Staff sign-in by email or phone, sessions, the CSRF token. |
| `org` | One organisation per branch; the active branch of a user; members. |
| `twofa` | The second factor that sensitive actions (invoice, payment, settings, users) require. |
| `audit` | One row per sensitive or important action; the audit page of the back office. |
| `notifications` | The in-app badge and the WhatsApp or email fallback of every customer message. |
| `email` | Email messages and the nightly report summary. |
| `whatsapp` | WhatsApp Cloud API templates, the webhook, the inbox the app sweeps for "cancel" and "reschedule" replies. |
| `billing` | Installed because `booking` needs it; no payment provider is configured. |
| `booking` | Technicians as resources, their slots and holds per branch. |
| `jobs` | The scheduled jobs: AMC visits, renewal reminders, the inbox sweep. |
| `storage` | Photos of a visit in the visit's folder, uploaded through signed URLs (`uploadUrl`), and signed links to show them. |
| `tax_gcc` | FTA tax invoices and credit notes, 5 % VAT, the seller's TRN. |
| `reports` | Sales per day, CSV export, the nightly summary by email. |
| `admin` | The operator's back office (`/system/admin`); the app's own back office is `/admin`. |
| `gcc` | Emirates, +971 numbers, TRN and trade licence checks. |

The PDFs (quotation, visit report, invoice, statement, contract) are `ctx.pdf` templates under `partials/pdf/`; the PDF engine renders text only, so photos are listed by caption and the signature by the signer's name.

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

`/admin/branches`: one row per branch with its name in both languages, phone, emirate, area and address. Adding a branch creates it with the standard working hours; the booking module reads those hours when a dispatcher offers a slot.

### 4. People

`/admin/people`: for each person enter the email, choose the role (owner, manager, dispatcher, technician or accountant) and press "Send invitation". You should see "Invitation sent." and the person under "Pending invitations" with the date. The invitation is a mail with one link, `/org/accept/<token>`, valid for 7 days, usable once and only by the invited address; after sign-in or sign-up the person lands in the app with the role you chose. A pending invitation that expired is sent again the same way. Owners, managers and accountants who act on money need the second factor too: the "Second factor" column shows "Off" and a warning until they have set it on `/auth/account`.

A technician opens `/me` on the phone and chooses "Add to Home Screen" (Chrome: Install app; Safari: Share, Add to Home Screen). The app then opens full screen with the company's name, colour and icon, on today's visits. The README's "Install on a phone" has the details.

### 5. Import the existing data

`/admin/import` (the owner, with a recent second factor). Upload the four files **in this order**, because each one refers to the one before:

1. `customers`: the people and companies, by branch.
2. `sites`: the addresses of those customers (found by the customer's phone).
3. `services`: the price list.
4. `contracts`: the running yearly contracts (they need the customer, the site and the service to exist).

Download the template of each kind from the page, or directly: `/admin/import/template/customers`, `/admin/import/template/sites`, `/admin/import/template/services` and `/admin/import/template/contracts`. Each is a one-sheet `.xlsx` with the header row and two example rows. Header names are not case-sensitive and extra columns are ignored; only the first sheet is read; a file is at most 10 MiB and 10,000 data rows.

The columns of each file, as `lib/import.ts` checks them (required columns in bold):

| Kind | Columns | Rules |
| --- | --- | --- |
| `customers` | **branch**, **kind**, **name**, **phone**, email, trn, language | `branch` is a branch's English name, Arabic name or slug, case-insensitive. `kind` is `company` or `household`. `phone`, `trn`, `email`, `name` and `language` are checked by the customer form's own rules (a TRN is not required for a company). The phone is stored normalised. `language` is `en` or `ar`, default `en`. A customer with the same branch and phone, in the app or earlier in the file, is `exists`. |
| `sites` | **customer_phone**, **label**, **emirate**, **area**, **address**, makani, access_notes | `customer_phone` finds the customer by normalised phone in any branch: none is `unknown_customer`, more than one is `ambiguous_customer`. `emirate` is a code (`AE-DU`) or the emirate's English or Arabic name. `area`, `address`, `makani` and `access_notes` are checked by the site form's rules. The site takes the customer's branch. The same customer and label (case-insensitive) is `exists`. |
| `services` | **code**, **name_en**, **name_ar**, **unit**, **price_aed**, vat_rate, branch | `code` is 1 to 32 characters `[A-Z0-9-]`, upper-cased. `unit` is `visit`, `hour` or `unit`. `price_aed` is ≥ 0 with at most two decimals, stored in fils (12.5 becomes 1250). `vat_rate` is 0 or 5, default 5. An empty `branch` means every branch. An existing `code` is `updated`. |
| `contracts` | **number**, **customer_phone**, **starts_on**, **ends_on**, **price_aed**, **site_label**, **service_code**, **visits_per_year**, next_visit_on, notes | One row per contract item. Rows with the same `number` must agree on customer, dates and price (else `inconsistent_contract`). Dates are `YYYY-MM-DD` or an Excel date. `ends_on` ≥ `starts_on`. `visits_per_year` is 1 to 52. `site_label` must be a site of that customer, and `service_code` an active service of the customer's branch. `next_visit_on` must lie within the term. A contract is created as a draft. An existing `number` is `exists`. |

A file can hold 10,000 data rows, but one check runs within one request's CPU limit: on the free tier about 1,000 customer rows is the most one check reads, and a bigger file answers 503. Split a long list into files of 1,000 rows and import them one after another.

The flow for each file: choose the kind, pick the file and press "Check the file". Nothing is written yet. The report shows the totals (rows, to insert, to update, already there, errors) and, for every wrong row, the sheet row, the column and the message. Fix the spreadsheet and check it again; the "Import <n> rows" button appears only when there are no errors. Pressing it writes the whole file in one transaction (the owner confirms with the second factor) and links to the result.

- `exists`: the row is already in the app (same branch and phone for a customer, same customer and label for a site, same number for a contract), so it is skipped and is not an error. Checking and committing the same file twice inserts nothing the second time.
- `updated`: only services are updated: a row whose `code` already exists changes that service's name, unit, price and VAT. Customers, sites and contracts are never changed by an import.

The three most common errors:

| Message code | Meaning | Fix |
| --- | --- | --- |
| `bad_phone` | The phone is not a valid UAE number | Write it as `+971 50 123 4567` or `050 123 4567` (spaces are fine, letters are not); set the column's format to Text in Excel so the leading `0` or `+` survives |
| `unknown_branch` | The `branch` is not a branch name on `/admin/branches` | Copy the name from `/admin/branches` exactly, or add the branch first |
| `unknown_customer` | A `customer_phone` matches no customer | Import the `customers` file first, and write the phone in the same way in both files |

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

3. Register the six message templates of `i18n/whatsapp.*.json` in English and Arabic (`quote_sent`, `visit_scheduled`, `technician_on_the_way`, `report_ready`, `invoice_due`, `amc_renewal`) and wait for Meta's approval; see "WhatsApp (from the `whatsapp` module's README)" in the app's `README.md`.
4. In `renox.toml` change the module's config to `sandbox = false`, set `public_url` to the app's address, and run `renox deploy`.
5. Test with one number first: a customer whose phone is the owner's own, a quotation sent to it, and the message arriving on that phone. Only then tell the staff.

### 8. The company's own domain

```sh
renox domains add www.acme-fm.example
renox domains status www.acme-fm.example
```

`add` prints the CNAME record and the two TXT records to create (use `www.<domain>`, not the apex). Enter them at the company's DNS provider, where they bought the domain. `status` shows `pending` and then `verified`; the time depends on the provider's DNS, from a few minutes to a few hours. When it is verified, set `public_url` to the new address (`app__settings`) and deploy again.

### 9. First-week checklist

- [ ] Day 1: one real job from quotation to paid invoice, with the company's own customer.
- [ ] The owner and every manager have the second factor on and the recovery codes stored.
- [ ] Every invited person signed in at least once (`/admin/people`: no pending invitation left).
- [ ] A technician completed a visit on their own phone, with photos and the signature.
- [ ] The nightly summary mail reached the accounts email.
- [ ] The owner keeps a database copy: `renox db export --out acme-fm.db`, then once a week.
- [ ] A contract was activated and its invoice reached the customer.
- [ ] A WhatsApp message to one real number arrived (or the sandbox is still on, on purpose).
- [ ] The company knows who to call: you, and the address for support requests.
- [ ] A date for the one-week review is in both calendars.

### 10. The written exit

The company's data is theirs: at any time `renox db export` downloads the whole SQLite database (checked by sha256), and `renox export` downloads a runnable copy of the app (database, stored files and the deployed artifact) that `renox-worker --config worker.toml` serves on any host; the self-hosting steps are in `docs/self-host.md`. Secret values are not exported; their names are listed in `secrets.txt`.
