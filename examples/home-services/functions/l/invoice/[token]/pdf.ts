// GET /l/invoice/:token/pdf?lang=en|ar: the tax invoice as a PDF for the
// customer's link (kind `invoice`, lib/links.ts). Public: the token is the only
// credential. Without `lang` the invoice is in the customer's own language.
import { branchDb } from "../../../../lib/scope";
import type { Handler } from "@renoxium/sdk";

import { invoicePdf } from "../../../../lib/invoice-pdf";
import { findInvoice } from "../../../../lib/invoices";
import { verifyLink } from "../../../../lib/links";

const plain = (status: number, text: string): Response => new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

export const GET: Handler = async (ctx) => {
  const link = await verifyLink(ctx, "invoice", ctx.params.token);
  if (link.state === "invalid") return plain(404, "Not found");
  if (link.state !== "ok") return plain(410, "This link has expired.");
  const named = await ctx.db.queryOne<{ branch_id: string }>("select branch_id from app__job_invoices where invoice_id = ?", [link.refId]);
  if (named === null) return plain(404, "Not found");
  const sdb = branchDb(ctx.db, named.branch_id);
  const invoice = await findInvoice(sdb, named.branch_id, link.refId);
  if (invoice === null) return plain(404, "Not found");
  const customer = await sdb.queryOne<{ language: string }>("select language from app__customers where id = ?", [invoice.customer_id]);
  const asked = ctx.url.searchParams.get("lang");
  const lang = asked === "ar" || asked === "en" ? asked : customer?.language === "ar" ? "ar" : "en";
  const bytes = await invoicePdf(ctx, invoice, lang);
  if (bytes === null) return plain(404, "Not found");
  return new Response(bytes as BodyInit, { headers: { "content-type": "application/pdf", "content-disposition": `inline; filename="${invoice.invoice_id}-${lang}.pdf"`, "cache-control": "no-store" } });
};
