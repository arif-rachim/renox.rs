# Plan: the home-services reference app (epic #554)

Date: 2026-11-07. Status: in progress; the skeleton is [F7-119] (#555).

## Why

Research of 2026-11-07 ranked facility management and home services first among ten UAE SME verticals. The daily workflow is WhatsApp intake, a scheduled visit, technician dispatch, a photo report, pay-after by cash, transfer or cheque, and yearly AMC (annual maintenance contract) renewals. It maps one-to-one onto the official modules `booking`, `jobs`, `storage`, `pdf` (`ctx.pdf`), `tax_gcc` and `whatsapp`. The reference app proves that a real company can be assembled from the modules with a small amount of app code, and it is the demo for the first free-tier users (D31).

## Scope v1

In: customers and sites; the service catalogue; quotations with VAT and an EN/AR PDF; jobs and scheduling per branch; the technician's visit (check-in, photos, parts, signature, check-out) and the visit report PDF; notifications (WhatsApp with email fallback); invoicing (tax invoice, credit note, cash, transfer and cheque payments); AMC contracts; reports; the back office; MCP tools; the template and docs.

Out: online payments (D31: no payments, no PSP configured; `billing` is installed only because `booking` depends on it); a customer login; native mobile apps; inventory and purchasing.

## Owner decisions (2026-11-07)

1. Scope v1 includes AMC contracts.
2. Customers get signed links (quote approval, visit report, invoice), no login.
3. One tenant is one company; its branches are `org` organisations.
4. Branding is per client inside the app: name, logo, colours, domain, PDFs, mails and WhatsApp messages come from the settings, not from the code.
5. No online payments (D31). Payments are recorded by staff as cash, transfer or cheque.
6. WhatsApp goes through the module's fake API in tests and a sandbox setting (`whatsapp_sandbox`) in dev.
7. `ctx.ai` goes through the platform gateway, and every AI feature has an "AI off" state in which the app works without it.

## Sub-issues and dependency chain

| # | Key | Issue | Blocked by |
| --- | --- | --- | --- |
| 1 | F7-119 | Skeleton: every module, core migration, branded layout with the AR switch, seeds, first test, `cli/tests/examples.test.ts` in CI | none |
| 2 | F7-120 | Customers, sites, service catalogue, `gcc` validation, branch scoping | 1 |
| 3 | F7-121 | Quotations: lines with VAT, EN/AR PDF, signed approval link, AI draft | 2 |
| 4 | F7-122 | Jobs and scheduling: states, `booking` technicians and slots per branch, live dispatch board | 3 |
| 5 | F7-123 | The technician's visit and the visit report PDF with the AI summary | 4 |
| 6 | F7-124 | Notifications: WhatsApp templates with email fallback, SSE badge, inbound webhook | 5 |
| 7 | F7-125 | Invoicing: tax invoice, credit note, cash/transfer/cheque payments, audit, statement PDF | 6 |
| 8 | F7-126 | AMC contracts: entity, visit generation by a scheduled job, renewal reminders, contract PDF | 7 |
| 9 | F7-127 | Reports: sales, jobs per technician, AMC renewals due, outstanding invoices, CSV and Excel | 8 |
| 10 | F7-128 | Back office: `admin` slots, branding settings page, users and roles per branch, `2fa`, audit coverage | 9 |
| 11 | F7-129 | MCP tools: `next_free_slot`, `job_status`, `create_job` with confirmation | 7 |
| 12 | F7-130 | The `home-services` template, the "Reference app" docs page, README owner steps, CHANGELOG | 10, 11 |
| 13 | F7-131 | Owner: the demo tenant on `renoxium.app`, the custom domain, screenshots | 12 |

The chain is linear up to 9; 11 may run beside 8 to 10.

## Shared conventions

- The app lives in `examples/home-services/`, an npm workspace like `examples/shop` (`@renox-examples/home-services`, `@renoxium/sdk` as `workspace:*`).
- Tests are `tests/*.test.ts`, run by `renox test --seed seeds/001_demo.sql` with `@renoxium/sdk/test`. Policy cases are `policies/tests/*.json`. The root `bunfig.toml` ignores the example's tests for the plain `bun test`, as it does for the tutorial.
- CI runs the example through `cli/tests/examples.test.ts` (build, `renox check` with types, `renox test`), which `make ts-test` picks up with `RENOX_WORKER_PATH`. A list in that file lets later examples join.
- App tables are `app__*`; every statement is parameterised; ids are text; money is integer fils; timestamps are integer seconds. Branch data carries the branch's `org_id` and is read through the active organisation.
- Settings live in `app__settings` and are read with `getSettings(db)` (`lib/settings.ts`); no brand string is hard-coded in a template, a PDF or a mail.
- Strings are in `i18n/en.json` and `i18n/ar.json` with the same keys; the Arabic catalog says it is machine translated until reviewed.
- Authorization: the actions and roles of `renox.toml` `[authz]`; `policies/app/base.cedar`; `invoice.issue`, `invoice.pay` and `settings.write` are sensitive and need `mfa_verified`.
- A platform gap (a module does not do what its README says) becomes its own issue. It is never worked around by copying module code into the example.
