// GET /customers: the active branch's customers, searched by name or phone.
// With `HX-Target: customer-list` (the search box) only the customer_list
// fragment is rendered. The guard is `customer.read`; the rows come through
// the branch-scoped database, so another branch's customers never appear.
import type { LoaderContext } from "@renoxium/sdk";

import { listCustomers, siteCounts } from "../../lib/customers";
import { shell } from "../../lib/page";
import { branchOf, noBranch, scopedDb } from "../../lib/scope";

export const guard = { action: "customer.read" };

export async function load(ctx: LoaderContext) {
  const page = await shell(ctx);
  const branch = await branchOf(ctx);
  if (branch === null) return noBranch();
  const q = (ctx.url.searchParams.get("q") ?? "").trim().slice(0, 100);
  const scoped = scopedDb(ctx.db, branch);
  const [rows, sites] = await Promise.all([listCustomers(scoped, q), siteCounts(scoped)]);
  return {
    ...page,
    q,
    branch_name: page.locale === "ar" ? branch.name_ar : branch.name_en,
    customers: rows.map((c) => ({ id: c.id, name: c.name, kind: c.kind, phone: c.phone, trn: c.trn, sites: sites.get(c.id) ?? 0 })),
  };
}
