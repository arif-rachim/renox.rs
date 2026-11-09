// The reports module (#333): daily sales from tax_gcc documents, CSV with
// formula injection neutralised, and the accounting import files.
import { expect, mock, test } from "bun:test";

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

// The nightly report: where the mail goes (the hook, else email_to, else nowhere).
const sent: { to: string; subject: string }[] = [];
mock.module("renox:modules", () => ({ tax_gcc: { documents: async () => [] }, auth: {}, i18n: {}, email: { sendRaw: async (m: { to: string; subject: string }) => void sent.push(m) } }));
const { nightly } = await import("../jobs/nightly.ts");

async function nightlyCtx(email_to: string, fill?: string[]) {
  const { Database } = await import("bun:sqlite");
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const db = new Database(":memory:");
  db.exec(readFileSync(join(import.meta.dir, "../migrations/001_init.sql"), "utf8"));
  return {
    db: {
      async query<T>(sql: string, p: unknown[] = []) { return db.query(sql).all(...(p as never[])) as T[]; },
      async execute(sql: string, p: unknown[] = []) { return { changes: db.query(sql).run(...(p as never[])).changes }; },
    },
    config: { email_to },
    hooks: fill === undefined ? undefined : { run: async (_n: string, args: { to: string[] }) => { args.to.push(...fill); return { halt: false }; } },
    snapshot: () => db.query("select day, sent_to from reports__snapshots").all(),
  };
}

test("nightly: a filler of reports.nightly_to wins; else email_to; with neither no mail, the snapshot kept", async () => {
  const now = Date.UTC(2026, 9, 31, 3);
  sent.length = 0;
  const a = await nightlyCtx("owner@x.test", ["accounts@x.test"]);
  expect(await nightly(a, now)).toEqual({ day: "2026-10-30", sent_to: "accounts@x.test" });
  expect(sent.map((m) => m.to)).toEqual(["accounts@x.test"]);
  expect(a.snapshot()).toEqual([{ day: "2026-10-30", sent_to: "accounts@x.test" }]);

  sent.length = 0;
  const b = await nightlyCtx("owner@x.test", []);
  expect(await nightly(b, now)).toEqual({ day: "2026-10-30", sent_to: "owner@x.test" });
  expect(sent.map((m) => m.to)).toEqual(["owner@x.test"]);

  sent.length = 0;
  const c = await nightlyCtx("owner@x.test");
  expect((await nightly(c, now)).sent_to).toBe("owner@x.test");

  sent.length = 0;
  const d = await nightlyCtx("", []);
  expect(await nightly(d, now)).toEqual({ day: "2026-10-30", sent_to: null });
  expect(sent).toEqual([]);
  expect(d.snapshot()).toEqual([{ day: "2026-10-30", sent_to: null }]);
});
