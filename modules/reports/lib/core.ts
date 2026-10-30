// The reports module (#333): pure transforms of tax_gcc documents (#331)
// into daily sales rows, CSV, and the invoice import files of Xero,
// QuickBooks Online and Zoho Books. Amounts stay in fils until the last
// step, which prints AED with two decimals.

export interface DocLine {
  description: string;
  quantity: number;
  unit_fils: number;
  rate: "standard" | "zero" | "exempt";
  net_fils: number;
  vat_fils: number;
}

export interface Document {
  kind: "invoice" | "credit_note";
  number: string;
  issued_at: number;
  buyer: { name: string; trn: string | null };
  lines: DocLine[];
  totals: { standard: number; zero: number; exempt: number; vat: number; total: number };
}

const aed = (fils: number): string => `${fils < 0 ? "-" : ""}${Math.floor(Math.abs(fils) / 100)}.${String(Math.abs(fils) % 100).padStart(2, "0")}`;
const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export interface SalesRow {
  date: string;
  documents: number;
  net: string;
  vat: string;
  total: string;
}

export function sales(docs: readonly Document[], from: number, to: number): SalesRow[] {
  const by = new Map<string, { n: number; net: number; vat: number; total: number }>();
  for (const d of docs) {
    if (d.issued_at < from || d.issued_at >= to) continue;
    const k = day(d.issued_at);
    const e = by.get(k) ?? { n: 0, net: 0, vat: 0, total: 0 };
    e.n++;
    e.net += d.totals.standard + d.totals.zero + d.totals.exempt;
    e.vat += d.totals.vat;
    e.total += d.totals.total;
    by.set(k, e);
  }
  return [...by.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, e]) => ({ date, documents: e.n, net: aed(e.net), vat: aed(e.vat), total: aed(e.total) }));
}

const cell = (v: unknown): string => {
  let s = v === null || v === undefined ? "" : String(v);
  // Formula injection: a cell that would start a formula in a spreadsheet is quoted as text.
  if (/^[=+\-@\t\r]/u.test(s) && !/^-?\d+(\.\d+)?$/u.test(s)) s = `'${s}`;
  return /[",\r\n]/u.test(s) ? `"${s.replace(/"/gu, '""')}"` : s;
};

/** RFC 4180 CSV with a UTF-8 BOM; headers from the first row's keys. */
export function csv(rows: readonly Record<string, unknown>[], headers?: string[]): string {
  const h = headers ?? (rows[0] ? Object.keys(rows[0]) : []);
  return `﻿${[h.map(cell).join(","), ...rows.map((r) => h.map((k) => cell(r[k])).join(","))].join("\r\n")}\r\n`;
}

const TAX: Record<string, Record<DocLine["rate"], string>> = {
  xero: { standard: "Standard Rated Income (5%)", zero: "Zero Rated Income", exempt: "Exempt Income" },
  quickbooks: { standard: "SR 5%", zero: "ZR", exempt: "EX" },
  zoho: { standard: "VAT 5%", zero: "Zero Rate", exempt: "Exempt" },
};

/** One line per invoice line, in the column names each system's invoice import expects. */
export function accounting(system: string, docs: readonly Document[]): string {
  const tax = TAX[system];
  if (tax === undefined) throw new Error("system: xero, quickbooks or zoho");
  const rows: Record<string, unknown>[] = [];
  for (const d of docs) {
    for (const l of d.lines) {
      const date = day(d.issued_at);
      const qty = d.kind === "credit_note" ? -Math.abs(l.quantity) : l.quantity;
      if (system === "xero") rows.push({ "*ContactName": d.buyer.name, "*InvoiceNumber": d.number, "*InvoiceDate": date, "*DueDate": date, "*Description": l.description, "*Quantity": qty, "*UnitAmount": aed(l.unit_fils), "*AccountCode": "200", "*TaxType": tax[l.rate], Currency: "AED" });
      else if (system === "quickbooks") rows.push({ InvoiceNo: d.number, Customer: d.buyer.name, InvoiceDate: date, DueDate: date, ItemDescription: l.description, ItemQuantity: qty, ItemRate: aed(l.unit_fils), ItemAmount: aed(l.net_fils), ItemTaxCode: tax[l.rate], Currency: "AED" });
      else rows.push({ "Invoice Number": d.number, "Customer Name": d.buyer.name, "Invoice Date": date, "Item Name": l.description, Quantity: qty, "Item Price": aed(l.unit_fils), "Item Tax": tax[l.rate], "Customer TRN": d.buyer.trn ?? "", Currency: "AED" });
    }
  }
  return csv(rows);
}
