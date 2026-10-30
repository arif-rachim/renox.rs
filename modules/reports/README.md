# reports (#333)

Reports for an app:
- **Sales per day**, from `tax_gcc`'s tax invoices and credit notes.
- **Cash per day**, from `billing`'s payment and refund events.
- **A page** with a period filter.
- **Exports:** CSV, Excel `.xlsx` (written in TypeScript, no dependency), and the invoice import files of Xero, QuickBooks Online and Zoho Books.
- **A nightly summary**, kept as a snapshot and emailed.

## Install

```sh
bunx renox add reports          # needs tax_gcc, email, auth and i18n
```

```toml
reports = { version = "^1.0", mount = "/reports", config = { email_to = "accounts@yourshop.ae" } }
```

## Pages and roles

| Page or action | Needs | What it does |
| --- | --- | --- |
| `<mount>?from=&to=` | `reports.view` | Daily sales (documents, net, VAT, total) and cash (received, refunded, net) for the period |
| **Export** form | `reports.export` (`r-can`) | Downloads `sales` or `cash` as CSV or `.xlsx`, or an accounting import file |

The default policy grants both actions to `admin` and `finance`. `reports.export` is sensitive, so every export is an audit row: a file carries customers and amounts out of the app.

## Importing into an accounting product

Each import file has one row per invoice line. Credit notes are negative quantities, amounts are in AED, and the UAE tax code is chosen by the line's rate.

| Product | Export `kind` | Tax codes used | Import steps (owner) |
| --- | --- | --- | --- |
| Xero | `xero` | Standard Rated Income (5%), Zero Rated Income, Exempt Income | Business → Invoices → Import. Map account code `200` (Sales) to your own if it differs. The tax rates must exist under these names (Xero's UAE defaults) |
| QuickBooks Online | `quickbooks` | `SR 5%`, `ZR`, `EX` | Settings → Import data → Invoices. Turn on custom transaction numbers so the `INV-` numbers are kept. Check the tax codes match your UAE VAT agency setup |
| Zoho Books | `zoho` | VAT 5%, Zero Rate, Exempt | Sales → Invoices → Import. Choose "Invoice Number" for duplicate handling, so a re-import does not double an invoice |

The CSV has a UTF-8 BOM, so Excel opens Arabic text correctly. A cell that starts with `=`, `+`, `-` or `@` is prefixed so it is never run as a formula. The `.xlsx` writes strings as inline text, never as formulas.

## The nightly report

`jobs/nightly.ts` runs at 03:00 UTC. It does the same as the `nightly(now_ms)` service, which can also be called directly:
- keeps yesterday's sales and cash totals in `reports__snapshots`;
- when `email_to` is set, sends them as CSV through `email.sendRaw`.

## Not built

- The bilingual PDF summary.
- Direct API pushes to the accounting products.
- A custom report builder.

## Tests

- `bun test` runs the unit tests:
  - daily sales with credit notes netted;
  - the CSV's BOM, quoting, Arabic and formula guard;
  - each accounting layout;
  - an `.xlsx` opened by the reader, with its CRCs checked, numbers as numbers and text as text;
  - the cash ledger counting a redelivered event once.
- With `RENOX_WORKER_PATH`, `tests/app.test.ts` runs in an app with billing, tax_gcc and email on the worker:
  - a PSP invoice issued and paid shows as the day's sales and cash;
  - the page is refused without `reports.view`;
  - the Excel export works;
  - the nightly report is kept as a snapshot and emailed.
