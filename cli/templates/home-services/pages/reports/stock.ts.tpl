// GET /reports/stock?from=&to=: the stock report (#816). `stock.read` (the owner, the manager, the dispatcher, the
// accountant): for each branch the viewer holds and may read stock in, the parts with quantity on hand, minimum,
// average cost and value with the branch's total, and a second table, "Moves in the period" (default the current
// month): received, used on visits, adjusted and transferred per part.
//   POST ?/export  the same rows as CSV or .xlsx, one sheet each: `report=stock` or `report=moves` (the period of
//                  the moves is the form's `from` and `to`). Audited, like the other reports. The branches are
//                  the ones the page shows: a branch the viewer does not hold is never in a download.
import type { ActionContext, LoaderContext } from "@renoxium/sdk";

import { download, formatOf, periodOf, today } from "../../lib/app-reports";
import { shell } from "../../lib/page";
import { heldBranches, qtyText } from "../../lib/stock";
import { moveRows, movesReport, type ReportBranch, stockReport, stockRows, sumValue, thisMonth } from "../../lib/stock-report";

export const guard = { action: "stock.read" };

/** The branches the viewer may read stock in, named in their language. */
async function readable(ctx: LoaderContext | ActionContext, ar: boolean): Promise<ReportBranch[]> {
  return (await heldBranches(ctx)).filter((b) => b.can_read).map((b) => ({ id: b.id, name: ar ? b.name_ar : b.name_en }));
}

export async function load(ctx: LoaderContext) {
  const page = await shell(ctx);
  const ar = page.locale === "ar";
  const lang = ar ? "ar" : "en";
  const p = periodOf((k) => ctx.url.searchParams.get(k), thisMonth());
  const branches = [];
  let value = 0;
  for (const b of await readable(ctx, ar)) {
    const stock = await stockRows(ctx.db, b.id, lang);
    const moves = await moveRows(ctx.db, b.id, p, lang);
    const total = sumValue(stock);
    value += total;
    branches.push({
      id: b.id,
      name: b.name,
      stock: stock.map((r) => ({ id: r.part_id, sku: r.sku, name: r.name, unit: r.unit, qty: qtyText(r.qty), min: qtyText(r.min_stock), avg: r.avg_cost_fils / 100, value: r.value_fils / 100, low: r.low, href: `/admin/stock/${r.part_id}?branch=${b.id}` })),
      total: total / 100,
      moves: moves.map((r) => ({ id: r.part_id, sku: r.sku, name: r.name, unit: r.unit, received: qtyText(r.received), used: qtyText(r.used), adjusted: qtyText(r.adjusted), transferred: qtyText(r.transferred), href: `/admin/stock/${r.part_id}?branch=${b.id}` })),
    });
  }
  return { ...page, ...p, branches, grand_total: value / 100, multi: branches.length > 1, as_of: today() };
}

export const actions = {
  async export(ctx: ActionContext) {
    const page = await shell(ctx);
    const lang = page.locale === "ar" ? "ar" : "en";
    const branches = await readable(ctx, lang === "ar");
    const format = formatOf(ctx.form.get("format"));
    const who = ctx.principal?.id ?? "unknown";
    if (ctx.form.get("report") === "moves") {
      const p = periodOf((k) => { const v = ctx.form.get(k); return typeof v === "string" ? v : null; }, thisMonth());
      return download(who, "moves", `${p.from}_${p.to}`, await movesReport(ctx.db, branches, p, lang), format);
    }
    return download(who, "stock", today(), await stockReport(ctx.db, branches, lang), format);
  },
};
