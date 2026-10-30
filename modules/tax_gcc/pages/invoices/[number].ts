// GET <mount>/invoices/:number: the bilingual tax invoice or credit note
// (the same template the PDF is rendered from); POST ?/pdf: the PDF through
// ctx.pdf (ops.md 1.7.0 section 24). tax.manage.
import * as core from "../../lib/core.ts";
import { day, guarded, type Page } from "../../lib/page.ts";

type PdfPage = Page & { params: { number?: string }; pdf: { render(template: string, data: Record<string, unknown>, o?: { page?: string }): Promise<Uint8Array> } };

/** The deployment's id of this page's template (a module's templates are under modules/<name>/). */
export const TEMPLATE = "modules/tax_gcc/pages/invoices/[number]";

/** The template's data: every amount formatted, both languages' labels. */
export async function documentData(ctx: core.TaxCtx, number: unknown) {
  const doc = await core.invoice(ctx, number);
  if (doc === null) return null;
  return {
    number: doc.number,
    title_en: doc.title.en,
    title_ar: doc.title.ar,
    date: day(doc.issued_at),
    against: doc.against ?? null,
    seller: doc.seller,
    buyer: doc.buyer,
    lines: doc.lines.map((l: core.DocLine) => ({ description: l.description, quantity: l.quantity, net: core.aed(l.net_fils), rate: l.rate, vat: core.aed(l.vat_fils) })),
    totals: { standard: core.aed(doc.totals.standard), zero: core.aed(doc.totals.zero), exempt: core.aed(doc.totals.exempt), vat: core.aed(doc.totals.vat), total: core.aed(doc.totals.total) },
  };
}

export const guard = { action: "tax.manage" };

export const load = guarded(async (ctx) => {
  await ctx.authz.require("tax.manage");
  const data = await documentData(ctx, (ctx as PdfPage).params.number);
  return data ?? new Response("Not found", { status: 404 });
});

export const actions = {
  pdf: guarded(async (ctx) => {
    await ctx.authz.require("tax.manage");
    const c = ctx as PdfPage;
    const data = await documentData(ctx, c.params.number);
    if (data === null) return new Response("Not found", { status: 404 });
    const bytes = await c.pdf.render(TEMPLATE, data, { page: "A4" });
    return new Response(bytes as BodyInit, { headers: { "content-type": "application/pdf", "content-disposition": `inline; filename="${data.number}.pdf"`, "cache-control": "no-store" } });
  }),
};
