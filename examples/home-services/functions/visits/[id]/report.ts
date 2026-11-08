// GET /visits/:id/report?lang=en|ar: the visit report as a PDF (application/pdf),
// rebuilt from the visit as it is now (lib/report.ts) and stored. `job.read` on
// the visit's job: a dispatcher, manager, owner or accountant of the active
// branch, or the technician whose job it is (the policy's `mine`); another
// branch's visit is a 404. `?format=json` answers the data the template is given. A visit that is not checked out has no report (409).
import type { Handler } from "@renoxium/sdk";

import { findJob, jobResource } from "../../../lib/jobs";
import { buildReport, reportData } from "../../../lib/report";
import { branchOf, scopedDb } from "../../../lib/scope";
import type { VisitRow } from "../../../lib/visit-data";

export const guard = { action: "job.read" };

const plain = (status: number, text: string): Response => new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

export const GET: Handler = async (ctx) => {
  const branch = await branchOf(ctx);
  if (branch === null) return plain(403, "No branch is active for this account.");
  const sdb = scopedDb(ctx.db, branch);
  const id = ctx.params.id;
  const visit = typeof id === "string" && /^[a-z0-9_]{1,40}$/u.test(id) ? await sdb.queryOne<VisitRow>("select id, branch_id, job_id, technician_user_id, checkin_at, checkin_lat, checkin_lng, checkout_at, notes, summary_en, summary_ar, signature_key, signed_by_name, report_key from app__visits where id = ?", [id]) : null;
  if (visit === null) return plain(404, "Visit not found");
  const job = await findJob(sdb, visit.job_id);
  if (job === null) return plain(404, "Visit not found");
  await ctx.authz.require("job.read", jobResource(job, ctx.principal?.id ?? null));
  if (visit.checkout_at === null) return plain(409, "The visit is not finished: there is no report yet.");
  const asked = ctx.url.searchParams.get("lang");
  const lang = asked === "ar" || asked === "en" ? asked : undefined;
  // `?format=json`: what the template is given (the signature as a flag, not its bytes).
  if (ctx.url.searchParams.get("format") === "json") {
    const r = await reportData(ctx, visit.id, lang);
    if (r === null) return plain(404, "Visit not found");
    return new Response(JSON.stringify({ ...r.data, signature: r.data.signature !== null }), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
  }
  const report = await buildReport(ctx, visit.id, lang);
  if (report === null) return plain(404, "Visit not found");
  return new Response(report.bytes as BodyInit, { headers: { "content-type": "application/pdf", "content-disposition": `inline; filename="${job.number}-visit-${report.lang}.pdf"`, "cache-control": "no-store" } });
};
