// GET /contracts/:id: one maintenance contract of the active branch: its term,
// price, items, the visits made for it and the upfront invoice. `contract.read`;
// a contract of another branch is a 404. Actions (`contract.write`; a refusal of
// the policy is a 403):
//   POST ?/item      add a service at a site of the customer (a draft only)
//   POST ?/remove    remove an item (a draft only)
//   POST ?/activate  a draft with at least one item (422 without) becomes
//                    active and, for a priced contract, issues the upfront tax
//                    invoice: that is `invoice.issue`, sensitive (a recent
//                    second factor), so the owner or the accountant's rights are
//                    needed too; a dispatcher or a branch manager is refused.
//   POST ?/cancel    a draft or an active contract
//   POST ?/renew     the next year as a new draft
import type { ActionContext, LoaderContext } from "@renoxium/sdk";

import { stepUp } from "../../lib/admin";
import { itemSchema, itemIdSchema } from "../../lib/contract-forms";
import { itemViews, priceView, visitViews } from "../../lib/contract-view";
import { activate, addItem, cancelContract, findContract, readyToActivate, removeItem, renewContract } from "../../lib/contracts";
import { findCustomer } from "../../lib/customers";
import { check } from "../../lib/forms";
import { shell } from "../../lib/page";
import { invalid } from "../../lib/invalid";
import { catalogueOf } from "../../lib/quotes";
import { branchOf, noBranch, scopedDb } from "../../lib/scope";

export const guard = { action: "contract.read" };

const plain = (status: number, text: string): Response => new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
const redirect = (to: string): Response => new Response(null, { status: 303, headers: { location: to, "cache-control": "no-store" } });

/** The 403 of a refused policy decision, or null when allowed. */
async function allowed(ctx: ActionContext, action: "contract.write" | "invoice.issue"): Promise<Response | null> {
  try {
    await ctx.authz.require(action);
  } catch (e) {
    if ((e as { code?: string }).code === "RENOX_FORBIDDEN") return plain(403, "Forbidden");
    throw e;
  }
  return null;
}

export async function load(ctx: LoaderContext) {
  const page = await shell(ctx);
  const branch = await branchOf(ctx);
  if (branch === null) return noBranch();
  const sdb = scopedDb(ctx.db, branch);
  const contract = await findContract(sdb, ctx.params.id);
  if (contract === null) return plain(404, "Contract not found");
  const customer = await findCustomer(sdb, contract.customer_id);
  const language = page.locale === "ar" ? "ar" : "en";
  const draft = contract.status === "draft";
  const write = await ctx.authz.can("contract.write");
  const sites = draft && write ? await sdb.query<{ id: string; label: string }>("select id, label from app__sites where customer_id = ? order by label, id", [contract.customer_id]) : [];
  const catalogue = draft && write ? await catalogueOf(ctx.db, branch.id) : [];
  const renewal = await sdb.queryOne<{ id: string; number: string }>("select id, number from app__contracts where renewed_from = ? and status != 'cancelled'", [contract.id]);
  const origin = contract.renewed_from === null ? null : await sdb.queryOne<{ id: string; number: string }>("select id, number from app__contracts where id = ?", [contract.renewed_from]);
  return {
    ...page,
    values: {},
    contract: { id: contract.id, number: contract.number, status: contract.status, starts_on: contract.starts_on, ends_on: contract.ends_on, notes: contract.notes, invoice_id: contract.invoice_id, ...priceView(contract) },
    customer: customer === null ? null : { id: customer.id, name: customer.name },
    items: await itemViews(ctx, sdb, contract.id, language),
    visits: await visitViews(ctx, sdb, contract.id, language),
    renewal,
    renewed_from: origin,
    can_edit: draft && write,
    can_activate: draft && write,
    can_cancel: (draft || contract.status === "active") && write,
    can_renew: (contract.status === "active" || contract.status === "expired") && write && renewal === null,
    sites: sites.map((s) => ({ id: s.id, name: s.label })),
    catalogue: catalogue.map((s) => ({ sid: String(s.id), name: language === "ar" ? s.name_ar : s.name_en })),
    pdf_lang: customer?.language === "ar" ? "ar" : "en",
  };
}

export const actions = {
  async item(ctx: ActionContext) {
    const page = await shell(ctx);
    const refused = await allowed(ctx, "contract.write");
    if (refused !== null) return refused;
    const back = `/contracts/${ctx.params.id}`;
    const input = await check(ctx.form, itemSchema);
    if ("errors" in input) return invalid(page.locale, ctx.form, input.errors);
    const r = await addItem(ctx, ctx.params.id, input.value);
    return r.ok ? redirect(back) : plain(r.status, r.message);
  },

  async remove(ctx: ActionContext) {
    const page = await shell(ctx);
    const refused = await allowed(ctx, "contract.write");
    if (refused !== null) return refused;
    const back = `/contracts/${ctx.params.id}`;
    const input = await check(ctx.form, itemIdSchema);
    if ("errors" in input) return invalid(page.locale, ctx.form, input.errors);
    const r = await removeItem(ctx, ctx.params.id, input.value.item);
    return r.ok ? redirect(back) : plain(r.status, r.message);
  },

  async activate(ctx: ActionContext) {
    const page = await shell(ctx);
    const refused = await allowed(ctx, "contract.write");
    if (refused !== null) return refused;
    const back = `/contracts/${ctx.params.id}`;
    const ready = await readyToActivate(ctx, ctx.params.id);
    if (!ready.ok) return ready.status === 422 ? invalid(page.locale, ctx.form, { items: "contracts.err.no_items" }) : plain(ready.status, ready.message);
    // The upfront invoice is a tax invoice: the same sensitive action as issuing one from a job.
    if (ready.value.price_fils > 0) {
      const issuer = await allowed(ctx, "invoice.issue");
      if (issuer !== null) return issuer;
      const step = await stepUp(back);
      if (step !== null) return step;
    }
    const r = await activate(ctx, ctx.params.id);
    return r.ok ? redirect(back) : plain(r.status, r.message);
  },

  async cancel(ctx: ActionContext) {
    await shell(ctx);
    const refused = await allowed(ctx, "contract.write");
    if (refused !== null) return refused;
    const r = await cancelContract(ctx, ctx.params.id);
    return r.ok ? redirect(`/contracts/${ctx.params.id}`) : plain(r.status, r.message);
  },

  async renew(ctx: ActionContext) {
    await shell(ctx);
    const refused = await allowed(ctx, "contract.write");
    if (refused !== null) return refused;
    const r = await renewContract(ctx, ctx.params.id);
    return r.ok ? redirect(`/contracts/${r.value.id}`) : plain(r.status, r.message);
  },
};
