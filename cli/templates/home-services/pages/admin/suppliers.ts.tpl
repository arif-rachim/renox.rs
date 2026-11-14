// GET /admin/suppliers: the suppliers the company buys from (#812). `purchase.read` opens the page; `purchase.write`
// adds the form: "Add a supplier", and `?edit=<id>` fills it with a supplier to change. POST ?/save adds (no `id`) or
// changes (`id`) one, ?/active switches one on or off (a deactivated supplier is not offered on a purchase order and
// keeps its history). Name 1 to 120 characters; phone, TRN and email are checked when present. An invalid form is a
// 422 naming the fields. Every create, edit and switch writes an audit row (lib/suppliers.ts).
import type { ActionContext, LoaderContext } from "@renoxium/sdk";

import { check } from "../../lib/forms";
import { invalid } from "../../lib/invalid";
import { shell } from "../../lib/page";
import { createSupplier, getSupplier, isSupplierId, listSuppliers, setSupplierActive, supplierSchema, updateSupplier, type SupplierRow } from "../../lib/suppliers";

export const guard = { action: "purchase.read" };

const redirect = (to: string): Response => new Response(null, { status: 303, headers: { location: to, "cache-control": "no-store" } });
const plain = (status: number, text: string): Response => new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

const formOf = (s: SupplierRow | null) => ({ id: s?.id ?? "", name: s?.name ?? "", trn: s?.trn ?? "", phone: s?.phone ?? "", email: s?.email ?? "", address: s?.address ?? "", notes: s?.notes ?? "" });

export async function load(ctx: LoaderContext) {
  const page = await shell(ctx);
  const canWrite = await ctx.authz.can("purchase.write");
  const editing = canWrite ? await getSupplier(ctx.db, ctx.url.searchParams.get("edit")) : null;
  const saved = ctx.url.searchParams.get("saved");
  return {
    ...page,
    saved: saved === "created" || saved === "updated" || saved === "activated" || saved === "deactivated" ? saved : "",
    form: formOf(editing),
    values: {},
    suppliers: (await listSuppliers(ctx.db)).map((s) => ({ id: s.id, name: s.name, trn: s.trn ?? "", phone: s.phone, email: s.email, active: s.active === 1 })),
  };
}

/** 403 when the caller lacks `purchase.write`. */
async function denied(ctx: ActionContext): Promise<Response | null> {
  if (await ctx.authz.can("purchase.write")) return null;
  return plain(403, "Forbidden");
}

export const actions = {
  async save(ctx: ActionContext) {
    const refused = await denied(ctx);
    if (refused !== null) return refused;
    const page = await shell(ctx);
    const rawId = ctx.form.get("id");
    const id = typeof rawId === "string" ? rawId.trim() : "";
    if (id !== "" && !isSupplierId(id)) return plain(404, "Supplier not found");
    const input = await check(ctx.form, supplierSchema);
    if ("errors" in input) return invalid(page.locale, ctx.form, input.errors);
    if (id === "") await createSupplier(ctx, input.value);
    else if (!(await updateSupplier(ctx, id, input.value))) return plain(404, "Supplier not found");
    return redirect(`/admin/suppliers?saved=${id === "" ? "created" : "updated"}`);
  },

  async active(ctx: ActionContext) {
    const refused = await denied(ctx);
    if (refused !== null) return refused;
    const id = ctx.form.get("id");
    const on = ctx.form.get("active") === "1";
    if (!isSupplierId(id) || !(await setSupplierActive(ctx, id, on))) return plain(404, "Supplier not found");
    return redirect(`/admin/suppliers?saved=${on ? "activated" : "deactivated"}`);
  },
};
