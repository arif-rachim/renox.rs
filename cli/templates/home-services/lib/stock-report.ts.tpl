// The stock report (#816, wave D): /reports/stock. Two tables for each branch the viewer may read stock in: what is
// on hand now (quantity, minimum, average cost, value, with totals) and the moves of a period (received, used on
// visits, adjusted, transferred, per part). Each is also a download, one sheet each ("stock" and "moves"), through
// the same `download` as the app's other reports (CSV and .xlsx by the `reports` module: strings stay strings).
// Money is in fils, as in every export; quantities have at most three decimals. Days are Dubai days. Reads only.
import { type Period, type Report, today } from "./app-reports";
import { branchDb, type Scopable } from "./scope";
import { listStock, round3 } from "./stock";

export const STOCK_HEADERS = ["branch", "sku", "name", "unit", "qty", "min_stock", "avg_cost_fils", "value_fils"];
export const MOVES_HEADERS = ["branch", "sku", "name", "unit", "received", "used", "adjusted", "transferred"];

type Lang = "en" | "ar";
export type ReportBranch = { id: string; name: string };

export type StockRow = { part_id: string; sku: string; name: string; unit: string; qty: number; min_stock: number; avg_cost_fils: number; value_fils: number; low: boolean };
export type MoveRow = { part_id: string; sku: string; name: string; unit: string; received: number; used: number; adjusted: number; transferred: number };

/** The current month to today: what the moves table shows when no period is asked for. */
export const thisMonth = (): Period => ({ from: `${today().slice(0, 7)}-01`, to: today() });

/** Unix seconds of the start of a Dubai day (UTC+4). */
const dayStart = (d: string): number => Math.floor(Date.parse(`${d}T00:00:00Z`) / 1000) - 4 * 3600;

/** What the branch has on hand now: the parts it holds or has a minimum for, by SKU. */
export async function stockRows(db: Scopable, branchId: string, lang: Lang): Promise<StockRow[]> {
  const lines = await listStock(db, branchId);
  return lines.map((l) => ({ part_id: l.part.id, sku: l.part.sku, name: lang === "ar" ? l.part.name_ar : l.part.name_en, unit: l.part.unit, qty: l.qty, min_stock: l.part.min_stock, avg_cost_fils: l.avg_cost_fils, value_fils: l.value_fils, low: l.low }));
}

/**
 * The branch's moves in the period, summed per part: `received` is what came in (`in`), `used` what visits took out
 * (`out`), `adjusted` the net change of counts (an adjust has no sign of its own: it is the difference to the balance
 * before it, so the moves before the period are read too), `transferred` the net of transfers (in less out). Parts
 * with no move in the period are not listed. By SKU.
 */
export async function moveRows(db: Scopable, branchId: string, p: Period, lang: Lang): Promise<MoveRow[]> {
  const from = dayStart(p.from);
  const to = dayStart(p.to) + 86_400;
  const sdb = branchDb(db, branchId);
  const moves = await sdb.query<{ part_id: string; kind: string; qty: number; balance_after: number; created_at: number }>("select part_id, kind, qty, balance_after, created_at from app__stock_moves where created_at < ? order by part_id, created_at, rowid", [to]);
  const by = new Map<string, MoveRow>();
  const before = new Map<string, number>();
  for (const m of moves) {
    const earlier = before.get(m.part_id) ?? 0;
    before.set(m.part_id, m.balance_after);
    if (m.created_at < from) continue;
    const row = by.get(m.part_id) ?? { part_id: m.part_id, sku: "", name: "", unit: "", received: 0, used: 0, adjusted: 0, transferred: 0 };
    if (m.kind === "in") row.received = round3(row.received + m.qty);
    else if (m.kind === "out") row.used = round3(row.used + m.qty);
    else if (m.kind === "adjust") row.adjusted = round3(row.adjusted + (m.balance_after - earlier));
    else if (m.kind === "transfer_in") row.transferred = round3(row.transferred + m.qty);
    else row.transferred = round3(row.transferred - m.qty);
    by.set(m.part_id, row);
  }
  if (by.size === 0) return [];
  const parts = await db.query<{ id: string; sku: string; name_en: string; name_ar: string; unit: string }>("select id, sku, name_en, name_ar, unit from app__parts", []);
  const known = new Map(parts.map((x) => [x.id, x]));
  const rows: MoveRow[] = [];
  for (const row of by.values()) {
    const part = known.get(row.part_id);
    if (part === undefined) continue;
    rows.push({ ...row, sku: part.sku, name: lang === "ar" ? part.name_ar : part.name_en, unit: part.unit });
  }
  return rows.sort((a, b) => a.sku.localeCompare(b.sku));
}

export const sumValue = (rows: readonly StockRow[]): number => rows.reduce((n, r) => n + r.value_fils, 0);

/** The "stock" download of these branches: one row per branch and part. */
export async function stockReport(db: Scopable, branches: readonly ReportBranch[], lang: Lang): Promise<Report> {
  const rows: Report["rows"] = [];
  for (const b of branches) {
    for (const r of await stockRows(db, b.id, lang)) rows.push({ branch: b.name, sku: r.sku, name: r.name, unit: r.unit, qty: round3(r.qty), min_stock: round3(r.min_stock), avg_cost_fils: r.avg_cost_fils, value_fils: r.value_fils });
  }
  return { headers: STOCK_HEADERS, rows };
}

/** The "moves" download of these branches in the period: one row per branch and part that moved. */
export async function movesReport(db: Scopable, branches: readonly ReportBranch[], p: Period, lang: Lang): Promise<Report> {
  const rows: Report["rows"] = [];
  for (const b of branches) {
    for (const r of await moveRows(db, b.id, p, lang)) rows.push({ branch: b.name, sku: r.sku, name: r.name, unit: r.unit, received: r.received, used: r.used, adjusted: r.adjusted, transferred: r.transferred });
  }
  return { headers: MOVES_HEADERS, rows };
}
