// GET /customers/:id/statement.pdf?lang=en|ar: the customer's statement, their
// open and paid invoices and the payments against them, as a PDF. `invoice.read`,
// the active branch's customers only. Without ?lang the customer's language.
// `?format=json` answers the data the template is given.
import type { Handler } from "@renoxium/sdk";

import { findCustomer } from "../../../lib/customers";
import { statementData, statementPdf } from "../../../lib/invoice-pdf";
import { branchOf, scopedDb } from "../../../lib/scope";

export const guard = { action: "invoice.read" };

const plain = (status: number, text: string): Response => new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

export const GET: Handler = async (ctx) => {
  const branch = await branchOf(ctx);
  if (branch === null) return plain(403, "No branch is active for this account.");
  const sdb = scopedDb(ctx.db, branch);
  const customer = await findCustomer(sdb, ctx.params.id);
  if (customer === null) return plain(404, "Customer not found");
  const asked = ctx.url.searchParams.get("lang");
  const lang = asked === "ar" || asked === "en" ? asked : customer.language === "ar" ? "ar" : "en";
  // `?format=json`: what the template is given.
  if (ctx.url.searchParams.get("format") === "json") return new Response(JSON.stringify(await statementData(ctx, sdb, branch.id, customer, lang)), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
  const bytes = await statementPdf(ctx, sdb, branch.id, customer, lang);
  return new Response(bytes as BodyInit, { headers: { "content-type": "application/pdf", "content-disposition": `inline; filename="statement-${customer.name.replace(/[^A-Za-z0-9]+/gu, "-")}-${lang}.pdf"`, "cache-control": "no-store" } });
};
