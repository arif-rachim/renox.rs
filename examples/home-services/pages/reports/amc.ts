// GET /reports/amc?from=&to=: the maintenance contracts of the active branch
// that end in the period (default: the next ninety days) with their renewal
// state: renewed (and by which contract), expired, reminded or due.
// `reports.view`: the owner and the accountant; a dispatcher gets 403.
//   POST ?/export  `reports.export`: the same rows as CSV or .xlsx, audited.
import type { ActionContext, LoaderContext } from "@renoxium/sdk";

import { amcReport, download, formatOf, nextNinetyDays, periodOf } from "../../lib/app-reports";
import { shell } from "../../lib/page";
import { branchOf, noBranch, scopedDb } from "../../lib/scope";

export const guard = { action: "reports.view" };

const plain = (status: number, text: string): Response => new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

export async function load(ctx: LoaderContext) {
  const page = await shell(ctx);
  const branch = await branchOf(ctx);
  if (branch === null) return noBranch();
  const p = periodOf((k) => ctx.url.searchParams.get(k), nextNinetyDays());
  const report = await amcReport(scopedDb(ctx.db, branch), p);
  return {
    ...page,
    ...p,
    rows: report.rows.map((r, i) => ({ id: report.ids[i], customer_id: report.customerIds[i], contract: r.contract, customer: r.customer, ends_on: r.ends_on, price: Number(r.price_fils) / 100, status: r.status, renewal: r.renewal, renewed_by: r.renewed_by })),
    can_export: await ctx.authz.can("reports.export"),
  };
}

export const actions = {
  async export(ctx: ActionContext) {
    try {
      await ctx.authz.require("reports.export");
    } catch (e) {
      if ((e as { code?: string }).code === "RENOX_FORBIDDEN") return plain(403, "Forbidden");
      throw e;
    }
    const branch = await branchOf(ctx);
    if (branch === null) return noBranch();
    const p = periodOf((k) => { const v = ctx.form.get(k); return typeof v === "string" ? v : null; }, nextNinetyDays());
    const report = await amcReport(scopedDb(ctx.db, branch), p);
    return download(ctx.principal?.id ?? "unknown", "amc", `${p.from}_${p.to}`, report, formatOf(ctx.form.get("format")));
  },
};
