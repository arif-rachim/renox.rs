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
