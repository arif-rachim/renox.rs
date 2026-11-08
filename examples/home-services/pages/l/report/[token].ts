// GET /l/report/:token: the customer's view of one visit report. Public on
// purpose, like /l/approve: no `guard`; the token (lib/links.ts, kind `report`:
// random, stored hashed, expiring, opens any number of times until then) names
// one visit and the page shows only what that visit's report holds. The PDF is
// at /l/report/:token/pdf (functions/l/report/[token]/pdf.ts). A tampered or
// unknown token is a 404, an expired one a 410.
import type { LoaderContext } from "@renoxium/sdk";

import { verifyLink } from "../../../lib/links";
import { shell } from "../../../lib/page";
import { reportData } from "../../../lib/report";

const plain = (status: number, text: string): Response => new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

export async function load(ctx: LoaderContext) {
  const page = await shell(ctx);
  const link = await verifyLink(ctx, "report", ctx.params.token);
  if (link.state === "invalid") return plain(404, "Not found");
  if (link.state !== "ok") return plain(410, "This link has expired.");
  const r = await reportData(ctx, link.refId, page.locale === "ar" ? "ar" : "en", true);
  if (r === null || r.visit.checkout_at === null) return plain(404, "Not found");
  const d = r.data;
  return {
    ...page,
    token: ctx.params.token,
    report: { job_number: d.job_number, service: d.service, branch: d.branch.name, technician: d.technician, checkin: d.checkin, checkout: d.checkout, summary: d.summary, notes: d.notes, signed_by: d.signed_by },
    customer_name: d.customer.name,
    parts: d.parts,
    has_parts: d.has_parts,
    parts_total: d.parts_total,
  };
}
