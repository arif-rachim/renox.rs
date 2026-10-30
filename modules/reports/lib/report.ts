// What the page, the exports and the nightly job share (#333): a period's
// sales (from tax_gcc's documents) and cash (from the ledger), as rows,
// CSV, Excel or an accounting import file.
import { tax_gcc } from "renox:modules";

import { cash, type Db } from "./cash.ts";
import * as core from "./core.ts";
import { xlsx, type Cell } from "./xlsx.ts";

export const KINDS = ["sales", "cash", "xero", "quickbooks", "zoho"] as const;
export type Kind = (typeof KINDS)[number];

const aed = (fils: number): string => `${fils < 0 ? "-" : ""}${Math.floor(Math.abs(fils) / 100)}.${String(Math.abs(fils) % 100).padStart(2, "0")}`;

export async function period(db: Db, from: number, to: number) {
  const docs = (await tax_gcc.documents(from, to)) as core.Document[];
  const sales = core.sales(docs, from, to);
  const money = (await cash(db, from, to)).map((r) => ({ date: r.date, received: aed(r.received), refunded: aed(r.refunded), net: aed(r.net) }));
  return { docs, sales, cash: money };
}

/** One export: its bytes, content type and file name. */
export async function exported(db: Db, kind: Kind, format: "csv" | "xlsx", from: number, to: number): Promise<{ body: Uint8Array | string; type: string; name: string }> {
  const p = await period(db, from, to);
  const stamp = `${new Date(from).toISOString().slice(0, 10)}_${new Date(to).toISOString().slice(0, 10)}`;
  if (kind === "xero" || kind === "quickbooks" || kind === "zoho") return { body: core.accounting(kind, p.docs), type: "text/csv; charset=utf-8", name: `${kind}-${stamp}.csv` };
  const rows = (kind === "sales" ? p.sales : p.cash) as unknown as Record<string, unknown>[];
  if (format === "csv") return { body: core.csv(rows), type: "text/csv; charset=utf-8", name: `${kind}-${stamp}.csv` };
  const headers = rows[0] === undefined ? [] : Object.keys(rows[0]);
  const cells: Cell[][] = [headers, ...rows.map((r) => headers.map((h) => (typeof r[h] === "number" ? (r[h] as number) : String(r[h] ?? ""))))];
  return { body: xlsx(kind, cells), type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", name: `${kind}-${stamp}.xlsx` };
}
