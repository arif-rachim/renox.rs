// GET /customers/:id: one customer of the active branch with their sites.
// POST ?/addSite adds a site (`customer.write`; 422 with the fields named when
// the form is invalid). A customer of another branch is a 404: the branch-scoped
// database does not find it.
import type { ActionContext, LoaderContext } from "@renoxium/sdk";

import { findCustomer, insertSite, sitesOf } from "../../lib/customers";
import { check, emirateOptions, siteSchema } from "../../lib/forms";
import { shell } from "../../lib/page";
import { invalid } from "../../lib/invalid";
import { branchOf, noBranch, scopedDb } from "../../lib/scope";

export const guard = { action: "customer.read" };

const notFound = (): Response => new Response("Customer not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });

export async function load(ctx: LoaderContext) {
  const page = await shell(ctx);
  const branch = await branchOf(ctx);
  if (branch === null) return noBranch();
  const scoped = scopedDb(ctx.db, branch);
  const customer = await findCustomer(scoped, ctx.params.id);
  if (customer === null) return notFound();
  const emirates = emirateOptions(page.locale);
  const names = new Map(emirates.map((e) => [e.code, e.name]));
  const sites = await sitesOf(scoped, customer.id);
  return {
    ...page,
    values: {},
    customer: { id: customer.id, name: customer.name, kind: customer.kind, trn: customer.trn, phone: customer.phone, email: customer.email, language: customer.language },
    sites: sites.map((s) => ({ ...s, emirate_name: names.get(s.emirate) ?? s.emirate })),
    emirates,
  };
}

export const actions = {
  async addSite(ctx: ActionContext) {
    const page = await shell(ctx);
    const branch = await branchOf(ctx);
    if (branch === null) return noBranch();
    const scoped = scopedDb(ctx.db, branch);
    const customer = await findCustomer(scoped, ctx.params.id);
    if (customer === null) return notFound();
    try {
      await ctx.authz.require("customer.write");
    } catch (e) {
      if ((e as { code?: string }).code === "RENOX_FORBIDDEN") return new Response("Forbidden", { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } });
      throw e;
    }
    const site = await check(ctx.form, siteSchema);
    if ("errors" in site) return invalid(page.locale, ctx.form, site.errors);
    await insertSite(scoped, branch.id, customer.id, site.value);
    return new Response(null, { status: 303, headers: { location: `/customers/${customer.id}`, "cache-control": "no-store" } });
  },
};
