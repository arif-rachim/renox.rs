// GET /reports/outstanding: the open invoices (issued or part-paid) of the
// active branch by customer and age since issue: 0 to 30 days, 31 to 60, over
// 60. `reports.view`: the owner and the accountant; a dispatcher gets 403.
//   POST ?/export  `reports.export`: the same rows as CSV or .xlsx, audited.
import type { ActionContext, LoaderContext } from "@renoxium/sdk";

import { download, formatOf, outstandingReport, today } from "../../lib/app-reports";
import { shell } from "../../lib/page";
import { branchOf, noBranch, scopedDb } from "../../lib/scope";

export const guard = { action: "reports.view" };

const plain = (status: number, text: string): Response => new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

export async function load(ctx: LoaderContext) {
  const page = await shell(ctx);
  const branch = await branchOf(ctx);
  if (branch === null) return noBranch();
  const report = await outstandingReport(scopedDb(ctx.db, branch), branch.id);
  const sum = (key: string): number => report.rows.reduce((n, r) => n + Number(r[key]), 0) / 100;
  return {
    ...page,
    rows: report.rows.map((r, i) => ({ customer_id: report.customerIds[i], customer: r.customer, a: Number(r.days_0_30_fils) / 100, b: Number(r.days_31_60_fils) / 100, c: Number(r.days_over_60_fils) / 100, balance: Number(r.balance_fils) / 100 })),
    totals: { a: sum("days_0_30_fils"), b: sum("days_31_60_fils"), c: sum("days_over_60_fils"), balance: sum("balance_fils") },
    as_of: today(),
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
    const report = await outstandingReport(scopedDb(ctx.db, branch), branch.id);
    return download(ctx.principal?.id ?? "unknown", "outstanding", today(), report, formatOf(ctx.form.get("format")));
  },
};
