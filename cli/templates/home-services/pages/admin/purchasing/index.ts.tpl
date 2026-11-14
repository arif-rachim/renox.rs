// GET /admin/purchasing: the active branch's purchase orders (#815), newest first, 25 to a page (`?page=`), filtered by
// status (`?status=`) and supplier (`?supplier=`). `purchase.read` opens it (owner, branch manager, accountant);
// `purchase.write` adds "New purchase order": supplier (an active one), language of the document, expected date and
// notes. POST ?/create stores a draft with the next number `PO-000001` in the active branch and goes to it; an invalid
// form is a 422 naming the fields. The branch-scoped database shows no other branch's orders.
import type { ActionContext, LoaderContext } from "@renoxium/sdk";

import { check } from "../../../lib/forms";
import { invalid } from "../../../lib/invalid";
import { shell } from "../../../lib/page";
import { createPo, dayOf, listPos, PO_STATUSES, poSchema } from "../../../lib/purchasing";
import { branchOf, noBranch, scopedDb } from "../../../lib/scope";
import { getSupplier, listSuppliers } from "../../../lib/suppliers";

export const guard = { action: "purchase.read" };

const plain = (status: number, text: string): Response => new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

async function view(ctx: LoaderContext | ActionContext) {
  const page = await shell(ctx);
  const branch = await branchOf(ctx);
  if (branch === null) return null;
  const sdb = scopedDb(ctx.db, branch);
  const status = (ctx.url.searchParams.get("status") ?? "").trim();
  const supplierId = (ctx.url.searchParams.get("supplier") ?? "").trim();
  const suppliers = await listSuppliers(ctx.db);
  const names = new Map(suppliers.map((s) => [s.id, s.name]));
  const listing = await listPos(sdb, ctx.db, { status, supplier: supplierId, page: Number(ctx.url.searchParams.get("page") ?? "1") });
  const filter = { status: (PO_STATUSES as readonly string[]).includes(status) ? status : "", supplier: names.has(supplierId) ? supplierId : "" };
  const href = (n: number): string => `/admin/purchasing?${new URLSearchParams({ ...(filter.status === "" ? {} : { status: filter.status }), ...(filter.supplier === "" ? {} : { supplier: filter.supplier }), page: String(n) })}`;
  return {
    ...page,
    branch_name: page.locale === "ar" ? branch.name_ar : branch.name_en,
    filter,
    statuses: PO_STATUSES.map((value) => ({ value, current: value === filter.status })),
    suppliers: suppliers.map((s) => ({ id: s.id, name: s.name, current: s.id === filter.supplier })),
    pickable: suppliers.filter((s) => s.active === 1).map((s) => ({ id: s.id, name: s.name })),
    orders: listing.rows.map((p) => ({ id: p.id, number: p.number, status: p.status, supplier: names.get(p.supplier_id) ?? "", created_at: dayOf(p.created_at), expected_on: p.expected_on ?? "", total: p.total_fils / 100 })),
    total: listing.total,
    page_no: listing.page,
    pages: listing.pages,
    prev_href: listing.page > 1 ? href(listing.page - 1) : "",
    next_href: listing.page < listing.pages ? href(listing.page + 1) : "",
    values: {},
  };
}

export async function load(ctx: LoaderContext) {
  return (await view(ctx)) ?? noBranch();
}

export const actions = {
  async create(ctx: ActionContext) {
    if (!(await ctx.authz.can("purchase.write"))) return plain(403, "Forbidden");
    const branch = await branchOf(ctx);
    if (branch === null) return noBranch();
    const shown = await view(ctx);
    if (shown === null) return noBranch();
    const input = await check(ctx.form, poSchema);
    if ("errors" in input) return { ...shown, ...invalid(shown.locale, ctx.form, input.errors) };
    const supplier = await getSupplier(ctx.db, input.value.supplier);
    if (supplier === null || supplier.active !== 1) return { ...shown, ...invalid(shown.locale, ctx.form, { supplier: "purchasing.err.supplier" }) };
    const id = await createPo(ctx, branch.id, input.value);
    return new Response(null, { status: 303, headers: { location: `/admin/purchasing/${id}?saved=created`, "cache-control": "no-store" } });
  },
};
