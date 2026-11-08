// GET /customers/new: the form for a customer and the first site.
// POST ?/create: validated with the gcc module's checks (+971 phone, TRN,
// Makani, emirate); an invalid form is answered 422 with the fields named,
// a valid one is stored in the active branch and redirects to the customer.
import type { ActionContext, LoaderContext } from "@renoxium/sdk";

import { insertCustomer, insertSite } from "../../lib/customers";
import { check, customerSchema, emirateOptions, siteSchema } from "../../lib/forms";
import { shell } from "../../lib/page";
import { unprocessable } from "../../lib/problems";
import { branchOf, noBranch, scopedDb } from "../../lib/scope";

export const guard = { action: "customer.write" };

export async function load(ctx: LoaderContext) {
  const page = await shell(ctx);
  if ((await branchOf(ctx)) === null) return noBranch();
  return { ...page, emirates: emirateOptions(page.locale) };
}

export const actions = {
  async create(ctx: ActionContext) {
    const page = await shell(ctx);
    const branch = await branchOf(ctx);
    if (branch === null) return noBranch();
    const customer = await check(ctx.form, customerSchema);
    const site = await check(ctx.form, siteSchema);
    if ("errors" in customer || "errors" in site) {
      return unprocessable(page.locale, { ...("errors" in customer ? customer.errors : {}), ...("errors" in site ? site.errors : {}) }, "/customers/new");
    }
    const scoped = scopedDb(ctx.db, branch);
    const id = await insertCustomer(scoped, branch.id, customer.value, Math.floor(Date.now() / 1000));
    await insertSite(scoped, branch.id, id, site.value);
    return new Response(null, { status: 303, headers: { location: `/customers/${id}`, "cache-control": "no-store" } });
  },
};
