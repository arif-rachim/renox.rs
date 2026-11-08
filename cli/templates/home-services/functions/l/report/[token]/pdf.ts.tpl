// GET /l/report/:token/pdf?lang=en|ar: the visit report as a PDF for the
// customer's link (kind `report`, lib/links.ts). Public: the token is the only
// credential. Without `lang` the report is in the customer's own language.
import type { Handler } from "@renoxium/sdk";

import { verifyLink } from "../../../../lib/links";
import { buildReport, reportData } from "../../../../lib/report";

const plain = (status: number, text: string): Response => new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

export const GET: Handler = async (ctx) => {
  const link = await verifyLink(ctx, "report", ctx.params.token);
  if (link.state === "invalid") return plain(404, "Not found");
  if (link.state !== "ok") return plain(410, "This link has expired.");
  const asked = ctx.url.searchParams.get("lang");
  const lang = asked === "ar" || asked === "en" ? asked : undefined;
  const r = await reportData(ctx, link.refId, lang, true);
  if (r === null || r.visit.checkout_at === null) return plain(404, "Not found");
  const report = await buildReport(ctx, link.refId, lang, true);
  if (report === null) return plain(404, "Not found");
  return new Response(report.bytes as BodyInit, { headers: { "content-type": "application/pdf", "content-disposition": `inline; filename="${r.data.job_number}-visit-${report.lang}.pdf"`, "cache-control": "no-store" } });
};
