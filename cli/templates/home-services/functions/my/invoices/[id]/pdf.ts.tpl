// GET /my/invoices/<number>/pdf: the signed-in customer's tax invoice as a PDF
// (#777), the same document the customer's link renders
// (functions/l/invoice/[token]/pdf.ts, lib/invoice-pdf.ts invoicePdf), in the
// language of the customer record the invoice is for, not the page's. For a
// portal user only, with the gate of the `/my` pages (lib/portal.ts
// requirePortal): signed out is a 303 to the phone sign-in and back, staff go
// to `/`. The invoice is found through `customerDb` (number, customer and
// branch bound): another customer's, a malformed or an unknown number is a
// 404. Served `private, no-store` as `<number>.pdf`.
import type { Handler } from "@renoxium/sdk";

import { invoicePdf } from "../../../../lib/invoice-pdf";
import { invoiceId } from "../../../../lib/invoices";
import { requirePortal } from "../../../../lib/portal";

const notFound = (): Response => new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "private, no-store" } });

export const GET: Handler = async (ctx) => {
  const gate = await requirePortal(ctx);
  if (gate instanceof Response) return gate;
  const id = invoiceId(ctx.params.id);
  const invoice = id === null ? null : await gate.cdb.invoiceState(id);
  if (invoice === null) return notFound();
  const customer = (await gate.cdb.customers()).find((c) => c.id === invoice.customer_id);
  const bytes = await invoicePdf(ctx, invoice, customer?.language === "ar" ? "ar" : "en");
  if (bytes === null) return notFound();
  return new Response(bytes as BodyInit, {
    headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="${invoice.invoice_id}.pdf"`, "cache-control": "private, no-store" },
  });
};
