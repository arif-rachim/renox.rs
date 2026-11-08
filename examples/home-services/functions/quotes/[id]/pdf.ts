// GET /quotes/:id/pdf?lang=en|ar: the quotation as a PDF (application/pdf),
// rendered by ctx.pdf from partials/pdf/quotation.<lang>.html with the brand
// from the settings. `quote.read`, the active branch's quotations only (the
// branch-scoped database finds no other). Without ?lang the customer's language.
import type { Handler } from "@renoxium/sdk";

import { findCustomer } from "../../../lib/customers";
import { aed } from "../../../lib/money";
import { day, expireDue, findQuote, linesOf, lineView } from "../../../lib/quotes";
import { branchOf, scopedDb } from "../../../lib/scope";
import { getSettings, pdfBrand } from "../../../lib/settings";

export const guard = { action: "quote.read" };

const plain = (status: number, text: string): Response => new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

export const GET: Handler = async (ctx) => {
  const branch = await branchOf(ctx);
  if (branch === null) return plain(403, "No branch is active for this account.");
  const scoped = scopedDb(ctx.db, branch);
  await expireDue(scoped);
  const quote = await findQuote(scoped, ctx.params.id);
  if (quote === null) return plain(404, "Quotation not found");
  const customer = await findCustomer(scoped, quote.customer_id);
  if (customer === null) return plain(404, "Customer not found");
  const site = await scoped.queryOne<{ label: string; area: string; address: string }>("select label, area, address from app__sites where id = ?", [quote.site_id]);
  const asked = ctx.url.searchParams.get("lang");
  const lang = asked === "ar" || asked === "en" ? asked : customer.language;
  const settings = await getSettings(ctx.db);
  const data = {
    number: quote.number,
    status: quote.status,
    created_at: day(quote.created_at),
    valid_until: day(quote.valid_until),
    notes: quote.notes,
    customer: { name: customer.name, trn: customer.trn, phone: customer.phone },
    site,
    branch: { name: lang === "ar" ? branch.name_ar : branch.name_en },
    brand: pdfBrand(settings, lang),
    lines: lineView(await linesOf(scoped, quote.id), lang),
    totals: { subtotal: quote.subtotal_fils / 100, vat: quote.vat_fils / 100, total: quote.total_fils / 100, total_text: aed(quote.total_fils) },
  };
  const bytes = await ctx.pdf.render(`partials/pdf/quotation.${lang}`, data, { page: "A4" });
  return new Response(bytes as BodyInit, { headers: { "content-type": "application/pdf", "content-disposition": `inline; filename="${quote.number}-${lang}.pdf"`, "cache-control": "no-store" } });
};
