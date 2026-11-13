// GET /my/visits/<job id>/report: the visit report of one of the signed-in
// customer's jobs as a PDF (#777), the same document the customer's link
// renders (functions/l/report/[token]/pdf.ts, lib/report.ts buildReport, the
// public view: the technician's name kept on the visit), in the language of
// the customer record, not the page's. For a portal user only, with the gate
// of the `/my` pages (lib/portal.ts requirePortal): signed out is a 303 to the
// phone sign-in and back, staff go to `/`. The job and its visit are found
// through `customerDb`: another customer's job, an unknown id, or a visit not
// checked out yet is a 404. Served `private, no-store` as
// `visit-report-<job number>.pdf`.
import type { Handler } from "@renoxium/sdk";

import { requirePortal } from "../../../../lib/portal";
import { buildReport } from "../../../../lib/report";

const notFound = (): Response => new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "private, no-store" } });

export const GET: Handler = async (ctx) => {
  const gate = await requirePortal(ctx);
  if (gate instanceof Response) return gate;
  const id = typeof ctx.params.id === "string" && /^[A-Za-z0-9_-]{1,64}$/u.test(ctx.params.id) ? ctx.params.id : null;
  const job = id === null ? null : await gate.cdb.job(id);
  const visit = id === null || job === null ? null : await gate.cdb.visitOfJob(id);
  if (job === null || visit === null || visit.checkout_at === null) return notFound();
  // The visit is the customer's (customerDb checked its job); the renderer reads the rest by its id, as the link does.
  const report = await buildReport(ctx, String(visit.id), undefined, true);
  if (report === null) return notFound();
  return new Response(report.bytes as BodyInit, {
    headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="visit-report-${String(job.number)}.pdf"`, "cache-control": "private, no-store" },
  });
};
