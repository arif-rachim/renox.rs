// GET /l/invoice/:token: the customer's view of one tax invoice (the module's
// document, its status) with a link to the PDF at /l/invoice/:token/pdf. Public
// on purpose, like /l/approve: no `guard`; the token (lib/links.ts, kind
// `invoice`: random, stored hashed, expiring) names one invoice and the page
// shows only that. A tampered or unknown token is a 404, an expired one a 410.
import type { LoaderContext } from "@renoxium/sdk";

import { documentView, invoiceView } from "../../../lib/invoice-view";
import { documentOf, findInvoice, paymentsOf } from "../../../lib/invoices";
import { verifyLink } from "../../../lib/links";
import { shell } from "../../../lib/page";
import { fencedTo } from "../../../lib/scope";

const plain = (status: number, text: string): Response => new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

export async function load(ctx: LoaderContext) {
  const page = await shell(ctx);
  const link = await verifyLink(ctx, "invoice", ctx.params.token);
  if (link.state === "invalid") return plain(404, "Not found");
  if (link.state !== "ok") return plain(410, "This link has expired.");
  // The token names one invoice; from here every statement is fenced to its branch.
  const named = await ctx.db.queryOne<{ branch_id: string }>("select branch_id from app__job_invoices where invoice_id = ?", [link.refId]);
  if (named === null) return plain(404, "Not found");
  const sdb = fencedTo(ctx.db, named.branch_id);
  const invoice = await findInvoice(sdb, named.branch_id, link.refId);
  const doc = invoice === null ? null : await documentOf(invoice.invoice_id);
  if (invoice === null || doc === null) return plain(404, "Not found");
  const customer = await sdb.queryOne<{ name: string }>("select name from app__customers where id = ?", [invoice.customer_id]);
  return {
    ...page,
    token: ctx.params.token,
    invoice: invoiceView(invoice),
    document: documentView(doc, page.locale === "ar" ? "ar" : "en"),
    customer_name: customer?.name ?? "",
    payments: (await paymentsOf(sdb, invoice.invoice_id)).length,
  };
}
