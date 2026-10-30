// The reports module (#333): daily sales from tax_gcc documents, CSV with
// formula injection neutralised, and the accounting import files.
import { expect, test } from "bun:test";

import * as core from "../lib/core.ts";

const inv = (number: string, at: number, net: number, kind: core.Document["kind"] = "invoice"): core.Document => ({
  kind,
  number,
  issued_at: at,
  buyer: { name: "Buyer, FZE", trn: "100987654300003" },
  lines: [{ description: "Chair", quantity: 1, unit_fils: Math.abs(net), rate: "standard", net_fils: net, vat_fils: Math.round(net * 0.05) }],
  totals: { standard: net, zero: 0, exempt: 0, vat: Math.round(net * 0.05), total: Math.round(net * 1.05) },
});

const D1 = Date.UTC(2026, 9, 1, 9);
const D2 = Date.UTC(2026, 9, 2, 9);

test("sales per day net credit notes", () => {
  const rows = core.sales([inv("INV-1", D1, 10000), inv("INV-2", D1, 20000), inv("CN-1", D2, -10000, "credit_note")], D1 - 1, D2 + 1);
  expect(rows).toEqual([
    { date: "2026-10-01", documents: 2, net: "300.00", vat: "15.00", total: "315.00" },
    { date: "2026-10-02", documents: 1, net: "-100.00", vat: "-5.00", total: "-105.00" },
  ]);
});

test("CSV: BOM, quoting, Arabic kept, a formula cell neutralised", () => {
  const out = core.csv([{ name: "شركة, هلا", note: "=HYPERLINK(\"x\")", amount: "-5.00" }]);
  expect(out.startsWith("﻿name,note,amount\r\n")).toBe(true);
  expect(out).toContain('"شركة, هلا"');
  expect(out).toContain("\"'=HYPERLINK(\"\"x\"\")\"");
  expect(out).toContain(",-5.00\r\n");
});

test("accounting import files name each system's columns and tax codes", () => {
  const docs = [inv("INV-1", D1, 10000), inv("CN-1", D2, -10000, "credit_note")];
  const xero = core.accounting("xero", docs);
  expect(xero).toContain("*ContactName,*InvoiceNumber");
  expect(xero).toContain("Standard Rated Income (5%)");
  expect(xero).toContain("CN-1,2026-10-02,2026-10-02,Chair,-1,100.00");
  expect(core.accounting("quickbooks", docs)).toContain("SR 5%");
  expect(core.accounting("zoho", docs)).toContain("100987654300003");
  expect(() => core.accounting("sage", docs)).toThrow("system");
});
