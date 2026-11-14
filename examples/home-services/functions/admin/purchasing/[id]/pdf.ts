// GET /admin/purchasing/:id/pdf?lang=en|ar: the purchase order as a PDF (application/pdf), rendered by ctx.pdf from
// partials/pdf/purchase-order.<lang>.html with the brand from the settings (#815). `purchase.read`, the active
// branch's orders only (the branch-scoped database finds no other). Without ?lang the order's own language.
// Served `private, no-store`: it is a business document, not for a shared cache.
import type { Handler } from "@renoxium/sdk";

import { lookup } from "../../../../lib/invalid";
import { aed } from "../../../../lib/money";
import { dayOf, findPo, linesOf, priced, totalsOf } from "../../../../lib/purchasing";
import { branchOf, scopedDb } from "../../../../lib/scope";
import { getSettings, pdfBrand } from "../../../../lib/settings";
import { qtyText } from "../../../../lib/stock";
import { getSupplier } from "../../../../lib/suppliers";

export const guard = { action: "purchase.read" };

const plain = (status: number, text: string): Response => new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "private, no-store" } });

export const GET: Handler = async (ctx) => {
  const branch = await branchOf(ctx);
  if (branch === null) return plain(403, "No branch is active for this account.");
  const sdb = scopedDb(ctx.db, branch);
  const po = await findPo(sdb, ctx.params.id);
  if (po === null) return plain(404, "Purchase order not found");
  const supplier = await getSupplier(ctx.db, po.supplier_id);
  if (supplier === null) return plain(404, "Supplier not found");
  const asked = ctx.url.searchParams.get("lang");
  const lang = asked === "ar" || asked === "en" ? asked : po.language;
  const settings = await getSettings(ctx.db);
  const lines = await priced(ctx.db, await linesOf(sdb, po.id));
  const sum = totalsOf(lines);
  const data = {
    number: po.number,
    status: po.status,
    created_at: dayOf(po.created_at),
    expected_on: po.expected_on ?? "",
    notes: po.notes,
    brand: pdfBrand(settings, lang),
    // The company's TRN is configured on tax_gcc (seller_trn), which an app cannot read yet (#842): the line stays
    // out of the PDF until it can.
    company: { trn: "" },
    supplier: { name: supplier.name, trn: supplier.trn ?? "", address: supplier.address, phone: supplier.phone },
    branch: { name: lang === "ar" ? branch.name_ar : branch.name_en, area: branch.area },
    lines: lines.map((l) => ({
      sku: l.part?.sku ?? "",
      name: l.part === null ? "" : lang === "ar" ? l.part.name_ar : l.part.name_en,
      qty: qtyText(l.qty),
      unit: lookup(lang, `parts.unit.${l.part?.unit ?? "piece"}`) ?? "",
      unit_cost: l.unit_cost_fils / 100,
      amount: l.net_fils / 100,
    })),
    totals: { net: sum.net_fils / 100, vat: sum.vat_fils / 100, total: sum.total_fils / 100, total_text: aed(sum.total_fils) },
  };
  const bytes = await ctx.pdf.render(`partials/pdf/purchase-order.${lang}`, data, { page: "A4" });
  return new Response(bytes as BodyInit, { headers: { "content-type": "application/pdf", "content-disposition": `inline; filename="${po.number}-${lang}.pdf"`, "cache-control": "private, no-store" } });
};
