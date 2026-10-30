// The tax_gcc module (#331): FTA tax invoices with standard, zero-rated and
// exempt lines, sequential numbers, credit notes, the VAT period report.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import * as core from "../lib/core.ts";

function ctx(config: core.TaxCtx["config"] = { seller_name: "Hello Trading LLC", seller_trn: "100123456700003", seller_address: "Dubai" }): core.TaxCtx {
  const db = new Database(":memory:");
  db.exec(readFileSync(join(import.meta.dir, "../migrations/001_init.sql"), "utf8"));
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
