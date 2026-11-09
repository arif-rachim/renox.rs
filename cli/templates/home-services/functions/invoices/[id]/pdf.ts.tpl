// GET /invoices/:id/pdf?lang=en|ar: the tax invoice as a PDF (application/pdf),
// the module's document in the app's template. `invoice.read`, the active
// branch's invoices only. Without ?lang the customer's language.
import type { Handler } from "@renoxium/sdk";

import { findCustomer } from "../../../lib/customers";
import { invoicePdf } from "../../../lib/invoice-pdf";
import { findInvoice } from "../../../lib/invoices";
import { branchOf, scopedDb } from "../../../lib/scope";

export const guard = { action: "invoice.read" };

const plain = (status: number, text: string): Response => new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

export const GET: Handler = async (ctx) => {
  const branch = await branchOf(ctx);
  if (branch === null) return plain(403, "No branch is active for this account.");
  const sdb = scopedDb(ctx.db, branch);
  const invoice = await findInvoice(sdb, branch.id, ctx.params.id);
  if (invoice === null) return plain(404, "Invoice not found");
  const customer = await findCustomer(sdb, invoice.customer_id);
  const asked = ctx.url.searchParams.get("lang");
  const lang = asked === "ar" || asked === "en" ? asked : customer?.language === "ar" ? "ar" : "en";
  const bytes = await invoicePdf(ctx, invoice, lang);
  if (bytes === null) return plain(404, "Invoice not found");
  return new Response(bytes as BodyInit, { headers: { "content-type": "application/pdf", "content-disposition": `inline; filename="${invoice.invoice_id}-${lang}.pdf"`, "cache-control": "no-store" } });
};
