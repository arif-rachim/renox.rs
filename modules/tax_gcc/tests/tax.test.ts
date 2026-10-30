// The tax_gcc module (#331): FTA tax invoices with standard, zero-rated and
// exempt lines, sequential numbers, credit notes, the VAT period report.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import * as core from "../lib/core.ts";

function ctx(config: core.TaxCtx["config"] = { seller_name: "Hello Trading LLC", seller_trn: "100123456700003", seller_address: "Dubai" }): core.TaxCtx {
  const db = new Database(":memory:");
  for (const f of ["001_init.sql", "002_links_purchases_einvoice.sql"]) db.exec(readFileSync(join(import.meta.dir, "../migrations", f), "utf8"));
  return {
    db: {
      async query<T>(sql: string, p: unknown[] = []) { return db.query(sql).all(...(p as never[])) as T[]; },
      async queryOne<T>(sql: string, p: unknown[] = []) { return (db.query(sql).get(...(p as never[])) ?? null) as T | null; },
      async execute(sql: string, p: unknown[] = []) { return { changes: db.query(sql).run(...(p as never[])).changes }; },
    },
    config,
  };
}

const lines = [
  { description: "Chair", quantity: 2, unit_fils: 15000, rate: "standard" },
  { description: "Export freight", quantity: 1, unit_fils: 5000, rate: "zero" },
  { description: "Residential rent", quantity: 1, unit_fils: 100000, rate: "exempt" },
];

test("an invoice: 5 % on standard lines only, fils exact, bilingual title, both TRNs, sequential numbers", async () => {
  const c = ctx();
  const inv = await core.issue(c, { buyer: { name: "Buyer FZE", trn: "100987654300003" }, lines }, 1_000);
  expect(inv.number).toBe("INV-000001");
  expect(inv.title).toEqual({ en: "Tax Invoice", ar: "فاتورة ضريبية" });
  expect(inv.totals).toMatchObject({ standard: 30000, zero: 5000, exempt: 100000, vat: 1500, total: 136500, currency: "AED" });
  expect(inv.totals.display).toEqual({ standard: "300.00", zero: "50.00", exempt: "1000.00", vat: "15.00", total: "1365.00" });
  expect(inv.seller.trn).toBe("100123456700003");
  expect(inv.buyer.trn).toBe("100987654300003");
  expect((await core.issue(c, { buyer: { name: "B" }, lines: [lines[0]] })).number).toBe("INV-000002");
  // Half-up rounding per line: 5 % of 1.01 AED is 5.05 fils -> 5.
  expect(core.vatOfLine(101, "standard")).toBe(5);
  expect(core.vatOfLine(110, "standard")).toBe(6);
});

test("refusals: no TRN configured, a bad buyer TRN, a bad rate", async () => {
  await expect(core.issue(ctx({}), { buyer: { name: "B" }, lines })).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
  await expect(core.issue(ctx(), { buyer: { name: "B", trn: "123" }, lines })).rejects.toMatchObject({ code: "INVALID" });
  await expect(core.issue(ctx(), { buyer: { name: "B" }, lines: [{ ...lines[0], rate: "reduced" }] })).rejects.toMatchObject({ code: "INVALID" });
});

test("a credit note negates the lines, numbers CN- apart, cannot exceed the invoice, and nets in the VAT report", async () => {
  const c = ctx();
  const inv = await core.issue(c, { buyer: { name: "B" }, lines }, 1_000);
  const cn = await core.creditNote(c, inv.number, [lines[0]], "returned goods", 2_000);
  expect(cn).toMatchObject({ number: "CN-000001", against: "INV-000001", kind: "credit_note" });
  expect(cn.totals).toMatchObject({ standard: -30000, vat: -1500 });
  await expect(core.creditNote(c, inv.number, [{ ...lines[2], quantity: 2 }], "too much")).rejects.toMatchObject({ code: "INVALID" });
  await expect(core.creditNote(c, "INV-999999", undefined, "x y z")).rejects.toMatchObject({ code: "NOT_FOUND" });
  const report = await core.vatReport(c, 0, 10_000);
  expect(report).toMatchObject({ standard: 0, zero: 5000, exempt: 100000, output_vat: 0, documents: 2 });
  expect(await core.vatReport(c, 0, 1_500)).toMatchObject({ standard: 30000, output_vat: 1500, documents: 1 });
});

// #331 F67-B: the numbering under concurrency, billing's invoices stamped once, the return, e-invoicing.
import { recordingProvider } from "../lib/einvoice.ts";

test("the numbering series under concurrency: 50 invoices at once take 50 numbers without a gap or a repeat", async () => {
  const c = ctx();
  const docs = await Promise.all(Array.from({ length: 50 }, (_, i) => core.issue(c, { buyer: { name: `B${i}` }, lines: [{ description: "x", quantity: 1, unit_fils: 100, rate: "standard" }] })));
  const numbers = docs.map((d) => d.number).sort();
  expect(numbers).toEqual(Array.from({ length: 50 }, (_, i) => `INV-${String(i + 1).padStart(6, "0")}`));
});

test("billing.invoice_issued stamps one tax invoice per billing invoice, even when the event comes twice", async () => {
  const c = ctx();
  const a = await core.stampFromBilling(c, { invoice_id: "in_1", customer_id: "u1", amount: 29900 }, { name: "Sara" });
  const b = await core.stampFromBilling(c, { invoice_id: "in_1", customer_id: "u1", amount: 29900 }, { name: "Sara" });
  expect(b.number).toBe(a.number);
  expect(a.totals).toMatchObject({ standard: 29900, vat: 1495, total: 31395 });
  expect((await c.db.query("select number from tax_gcc__documents")).length).toBe(1);
});

test("the VAT return against a seeded ledger: output by category, recoverable input VAT only with the supplier's TRN, the payable box; CSV", async () => {
  const c = ctx();
  const t0 = Date.UTC(2026, 9, 1);
  await core.issue(c, { buyer: { name: "A" }, lines }, t0 + 1000);
  const inv = await core.issue(c, { buyer: { name: "B", trn: "100999888700003" }, lines: [{ description: "Desk", quantity: 1, unit_fils: 40000, rate: "standard" }] }, t0 + 2000);
  await core.creditNote(c, inv.number, [{ description: "Desk", quantity: 1, unit_fils: 10000, rate: "standard" }], "damaged", t0 + 3000);
  await core.issue(c, { buyer: { name: "Late" }, lines }, Date.UTC(2027, 0, 1));
  await core.recordPurchase(c, { supplier: "Office supplier", supplier_trn: "100555444300003", net_fils: 20000, booked_at: t0 + 4000 });
  await core.recordPurchase(c, { supplier: "No TRN shop", net_fils: 8000, booked_at: t0 + 5000 });
  await core.recordPurchase(c, { supplier: "Exempt", supplier_trn: "100555444300003", net_fils: 3000, rate: "exempt", booked_at: t0 + 6000 });
  const r = await core.vatReturn(c, t0, Date.UTC(2027, 0, 1));
  // Supplies: 30,000 + 40,000 - 10,000 standard; 5,000 zero; 100,000 exempt.
  expect(r.boxes).toEqual({
    box1_standard_rated_supplies: { amount: 60000, vat: 3000 },
    box4_zero_rated_supplies: { amount: 5000 },
    box5_exempt_supplies: { amount: 100000 },
    box8_totals: { amount: 165000, vat: 3000 },
    box9_standard_rated_expenses: { amount: 28000, vat: 1000 },
    box12_total_value_of_due_tax: 3000,
    box13_total_value_of_recoverable_tax: 1000,
    box14_payable_tax: 2000,
  });
  expect(r.documents).toBe(3);
  expect(core.vatReturnCsv(r)).toMatchSnapshot();
  await expect(core.recordPurchase(c, { supplier: "x", supplier_trn: "123", net_fils: 1 })).rejects.toMatchObject({ code: "INVALID" });
});

test("e-invoicing through the provider interface: submitted, the answer recorded, a rejection kept", async () => {
  const c = ctx();
  const p = recordingProvider();
  const d = await core.issue(c, { buyer: { name: "B", trn: "100999888700003" }, lines });
  expect(await core.submitEInvoice(c, d.number, p)).toEqual({ id: "rec_1", status: "accepted" });
  expect(p.submitted[0]).toMatchObject({ number: d.number, seller_trn: "100123456700003", buyer_trn: "100999888700003", vat_fils: 1500 });
  p.reject = true;
  expect((await core.submitEInvoice(c, d.number, p)).status).toBe("rejected");
  expect(await c.db.queryOne("select status from tax_gcc__einvoice where number = ?", [d.number])).toEqual({ status: "rejected" });
  await expect(core.submitEInvoice(c, "INV-999999", p)).rejects.toMatchObject({ code: "NOT_FOUND" });
});
