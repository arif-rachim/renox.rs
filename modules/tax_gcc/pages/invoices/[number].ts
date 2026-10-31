// GET <mount>/invoices/:number: the bilingual tax invoice or credit note
// (the same template the PDF is rendered from); POST ?/pdf: the PDF through
// ctx.pdf (ops.md 1.7.0 section 24). tax.manage.
import * as core from "../../lib/core.ts";
import { amount, guarded, hijri, localeOf, type Page } from "../../lib/page.ts";

type PdfPage = Page & { params: { number?: string }; pdf: { render(template: string, data: Record<string, unknown>, o?: { page?: string }): Promise<Uint8Array> } };

/** The deployment's id of this page's template (a module's templates are under modules/<name>/). */
export const TEMPLATE = "modules/tax_gcc/pages/invoices/[number]";

/**
 * The template's data: amounts in AED (the template formats them with
 * `number(2)`: fils as two decimals, the page's digits), the issue date for
 * the `date` filter (DD/MM/YYYY) and, when the page's tag asks for a Hijri
 * calendar, the Hijri date next to it (#336); both languages' labels.
 */
export async function documentData(ctx: core.TaxCtx, number: unknown) {
  const doc = await core.invoice(ctx, number);
  if (doc === null) return null;
  return {
    number: doc.number,
    title_en: doc.title.en,
    title_ar: doc.title.ar,
    issued_at: doc.issued_at,
    hijri: hijri(doc.issued_at, localeOf(ctx), (ctx as { utcOffsetMinutes?: number }).utcOffsetMinutes ?? 240),
    against: doc.against ?? null,
    seller: doc.seller,
    buyer: doc.buyer,
    lines: doc.lines.map((l: core.DocLine) => ({ description: l.description, quantity: l.quantity, net: amount(l.net_fils), rate: l.rate, vat: amount(l.vat_fils) })),
    totals: { standard: amount(doc.totals.standard), zero: amount(doc.totals.zero), exempt: amount(doc.totals.exempt), vat: amount(doc.totals.vat), total: amount(doc.totals.total) },
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
