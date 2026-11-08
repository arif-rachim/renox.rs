// GET /reports/technicians?from=&to=: jobs done, hours on site (check-in to
// check-out) and the value of the parts used, per technician of the active
// branch, for the visits that began in the period (default: the last thirty
// days). `reports.view`: the owner and the accountant; a dispatcher gets 403.
//   POST ?/export  `reports.export`: the same rows as CSV or .xlsx, audited.
import type { ActionContext, LoaderContext } from "@renoxium/sdk";

import { download, formatOf, lastThirtyDays, periodOf, technicianReport } from "../../lib/app-reports";
import { shell } from "../../lib/page";
import { branchOf, noBranch, scopedDb } from "../../lib/scope";

export const guard = { action: "reports.view" };

const plain = (status: number, text: string): Response => new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

export async function load(ctx: LoaderContext) {
  const page = await shell(ctx);
  const branch = await branchOf(ctx);
  if (branch === null) return noBranch();
  const p = periodOf((k) => ctx.url.searchParams.get(k), lastThirtyDays());
  const report = await technicianReport(scopedDb(ctx.db, branch), p);
  return {
    ...page,
    ...p,
    rows: report.rows.map((r) => ({ technician: r.technician, jobs_done: r.jobs_done, hours: r.hours, parts: Number(r.parts_fils) / 100 })),
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
    const p = periodOf((k) => { const v = ctx.form.get(k); return typeof v === "string" ? v : null; }, lastThirtyDays());
    const report = await technicianReport(scopedDb(ctx.db, branch), p);
    return download(ctx.principal?.id ?? "unknown", "technicians", `${p.from}_${p.to}`, report, formatOf(ctx.form.get("format")));
  },
};
