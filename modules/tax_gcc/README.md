# tax_gcc (#331)

UAE VAT for an app:
- FTA tax invoices and credit notes;
- the VAT return (VAT201) for a period;
- a bilingual invoice template, also rendered as a PDF;
- the interface to an e-invoicing provider.

The module name is `tax_gcc`, because module names allow no `-` (MF1).

## Install

```sh
bunx renox add tax_gcc        # needs auth and i18n; billing is optional (its invoices are stamped)
```

```toml
tax_gcc = { version = "^1.0", mount = "/tax", config = { seller_name = "Your Trading LLC", seller_trn = "100…", seller_address = "Dubai" } }
```

Nothing is issued until `seller_trn` holds the 15-digit TRN, which is an owner step.

## The FTA rules it applies

- **Numbers.** Tax invoice numbers are sequential with no gap per prefix (`INV-000001`; credit notes `CN-000001`). They are taken in one atomic update, and documents are immutable once issued.
- **The invoice.** It carries the seller's name, address and TRN, the buyer's TRN when given (B2B), the date and the lines, under a bilingual title: "Tax Invoice" / «فاتورة ضريبية». A credit note is «إشعار دائن ضريبي».
- **Rates.** VAT is 5 % on standard-rated lines only. Each line is rounded half up to the fil. Zero-rated and exempt lines are kept apart; out-of-scope items are left off the invoice.
- **Currency.** Amounts are in AED with fils, stored as integers.
- **Credit notes.** A credit note negates its lines and can never exceed its invoice.
- **Input VAT.** It is recoverable only for standard-rated purchases that carry the supplier's TRN (`recordPurchase`).

**The return** (`vatReturn`, the `/tax` page and its CSV) fills these VAT201 boxes:

| Box | Content |
| --- | --- |
| 1 | Standard-rated supplies and their VAT |
| 4 | Zero-rated supplies |
| 5 | Exempt supplies |
| 8 | Totals |
| 9 | Standard-rated expenses and their recoverable VAT |
| 12 | Due tax |
| 13 | Recoverable tax |
| 14 | Payable tax |

Not kept: imports, the reverse charge, the split of box 1 by emirate, and tourist refunds.

## With billing

`billing.invoice_issued` stamps one tax invoice per billing invoice. The amount is net, VAT is added on top, and the buyer is the user's display name. A redelivered event issues nothing twice (`tax_gcc__links`). Without a seller TRN, the handler fails and the outbox retries it.

## Pages

| Page | What it shows |
| --- | --- |
| `<mount>?from=&to=` | The VAT return boxes and the period's documents, with **Download CSV** |
| `<mount>/invoices/:number` | The bilingual document. **PDF** renders the same template through `ctx.pdf` |

Both need `tax.manage`, which the default policy grants to `admin` and `finance`. It is sensitive, so every decision is audited.

## E-invoicing (open item)

The UAE e-invoicing programme works through accredited service providers.
- `lib/einvoice.ts` defines `EInvoiceProvider` (`submit`, `status`, `cancel`) and a recording fake. `submitEInvoice` records each answer in `tax_gcc__einvoice`.
- No live provider is wired: the programme's phases and the choice of provider are a verify item (`docs/21` section 10).
- KSA ZATCA is out of scope.

## Tests

- `bun test` runs the unit tests:
  - the rates and the rounding;
  - the refusals (no seller TRN, a bad TRN, an over-credit);
  - the numbering under concurrency;
  - one stamp per billing invoice;
  - the VAT return against a seeded ledger, with the CSV snapshot;
  - the e-invoicing fake.
- With `RENOX_WORKER_PATH`, `tests/app.test.ts` runs in an app with billing on the worker:
  - a PSP's `invoice.finalized` stamps one tax invoice, even when redelivered;
  - the pages need `tax.manage`;
  - the template carries both languages;
  - `ctx.pdf` answers a PDF, and the CSV export works.
