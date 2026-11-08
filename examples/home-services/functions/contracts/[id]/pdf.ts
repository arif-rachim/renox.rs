// GET /contracts/:id/pdf?lang=en|ar: the contract as a PDF (application/pdf).
// `contract.read`, the active branch's contracts only. Without ?lang the
// customer's language.
import type { Handler } from "@renoxium/sdk";

import { contractPdf } from "../../../lib/contract-view";
import { findContract } from "../../../lib/contracts";
import { findCustomer } from "../../../lib/customers";
import { branchOf, scopedDb } from "../../../lib/scope";

export const guard = { action: "contract.read" };

const plain = (status: number, text: string): Response => new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

export const GET: Handler = async (ctx) => {
  const branch = await branchOf(ctx);
  if (branch === null) return plain(403, "No branch is active for this account.");
  const sdb = scopedDb(ctx.db, branch);
  const contract = await findContract(sdb, ctx.params.id);
  if (contract === null) return plain(404, "Contract not found");
  const customer = await findCustomer(sdb, contract.customer_id);
  const asked = ctx.url.searchParams.get("lang");
  const lang = asked === "ar" || asked === "en" ? asked : customer?.language === "ar" ? "ar" : "en";
  const bytes = await contractPdf(ctx, sdb, contract, lang);
  return new Response(bytes as BodyInit, { headers: { "content-type": "application/pdf", "content-disposition": `inline; filename="${contract.number}-${lang}.pdf"`, "cache-control": "no-store" } });
};
