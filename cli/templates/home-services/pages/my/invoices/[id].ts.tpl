// GET /my/invoices/<number>: one tax invoice of the signed-in customer (#777),
// as the customer's link /l/invoice/<token> shows it (lib/invoice-view.ts:
// the module's document, its lines and totals, the status, the balance and
// the due day), with "Download PDF" (/my/invoices/<number>/pdf) and, while it
// is open, the company's payment instructions (the settings
// payment_instructions_en/ar of /admin/settings; none hides the block: there
// is no online payment, D31). For a portal user only (lib/portal.ts
// requirePortal). The invoice is found through `customerDb` (its number, the
// customer and the branch bound); another customer's number, a malformed one
// or one that was never issued is a 404, never a 403. The document is then
// read from tax_gcc by that number.
import type { LoaderContext } from "@renoxium/sdk";

import { documentView, invoiceView } from "../../../lib/invoice-view";
import { documentOf, invoiceId } from "../../../lib/invoices";
import { shell } from "../../../lib/page";
import { requirePortal, signOut } from "../../../lib/portal";
import { instructionsIn, isOpen } from "../../../lib/portal-view";

const notFound = (): Response => new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

export async function load(ctx: LoaderContext) {
  const gate = await requirePortal(ctx);
  if (gate instanceof Response) return gate;
  const id = invoiceId(ctx.params.id);
  if (id === null) return notFound();
  const invoice = await gate.cdb.invoiceState(id);
  const doc = invoice === null ? null : await documentOf(invoice.invoice_id);
  if (invoice === null || doc === null) return notFound();
  const page = await shell(ctx);
  const lang = page.locale === "ar" ? "ar" : "en";
  return {
    ...page,
    invoice: invoiceView(invoice),
    document: documentView(doc, lang),
    open: isOpen(invoice.status),
    instructions: isOpen(invoice.status) ? instructionsIn(await gate.cdb.paymentInstructions(), lang) : [],
    pdf: `/my/invoices/${invoice.invoice_id}/pdf`,
  };
}

export const actions = {
  async signout() {
    return signOut();
  },
};
