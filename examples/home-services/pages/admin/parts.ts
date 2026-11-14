// GET /admin/parts: the company's parts (#812): SKU, name in the page's language, unit, cost, selling price, minimum
// stock and whether it is active; `?q=` searches the SKU and both names, 25 to a page (`?page=`). `part.read` opens
// the page; `part.write` adds the form: "Add a part", and `?edit=<id>` fills it with a part to change. POST ?/save
// adds (no `id`) or changes (`id`) a part, ?/active switches one on or off (a deactivated part is not offered on a
// visit or a purchase order and keeps its history). An invalid form is a 422 naming the fields; a SKU another part
// holds is a 422 that names that part. Every create, edit and switch writes an audit row (lib/parts.ts).
import type { ActionContext, LoaderContext } from "@renoxium/sdk";

import { check } from "../../lib/forms";
import { invalid, lookup } from "../../lib/invalid";
import { shell } from "../../lib/page";
import { getPart, isPartId, listParts, PART_UNITS, partSchema, createPart, setPartActive, updatePart, type PartRow } from "../../lib/parts";

export const guard = { action: "part.read" };

const redirect = (to: string): Response => new Response(null, { status: 303, headers: { location: to, "cache-control": "no-store" } });
const plain = (status: number, text: string): Response => new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

/** What the form holds when nothing was typed: a part's own values, or the defaults of a new one. */
const formOf = (p: PartRow | null) => ({
  id: p?.id ?? "",
  sku: p?.sku ?? "",
  name_en: p?.name_en ?? "",
  name_ar: p?.name_ar ?? "",
  unit: p?.unit ?? "piece",
  cost: ((p?.cost_fils ?? 0) / 100).toFixed(2),
  sell: ((p?.sell_fils ?? 0) / 100).toFixed(2),
  vat_rate: String(p?.vat_rate ?? 5),
  min_stock: String(p?.min_stock ?? 0),
});

export async function load(ctx: LoaderContext) {
  const page = await shell(ctx);
  const q = (ctx.url.searchParams.get("q") ?? "").trim().slice(0, 80);
  const listing = await listParts(ctx.db, { q, page: Number(ctx.url.searchParams.get("page") ?? "1") });
  const canWrite = await ctx.authz.can("part.write");
  const editing = canWrite ? await getPart(ctx.db, ctx.url.searchParams.get("edit")) : null;
  const saved = ctx.url.searchParams.get("saved");
  const href = (n: number): string => `/admin/parts?${new URLSearchParams({ ...(listing.q === "" ? {} : { q: listing.q }), page: String(n) })}`;
  return {
    ...page,
    q: listing.q,
    total: listing.total,
    page_no: listing.page,
    pages: listing.pages,
    prev_href: listing.page > 1 ? href(listing.page - 1) : "",
    next_href: listing.page < listing.pages ? href(listing.page + 1) : "",
    saved: saved === "created" || saved === "updated" || saved === "activated" || saved === "deactivated" ? saved : "",
    units: PART_UNITS.map((value) => ({ value })),
    form: formOf(editing),
    values: {},
    parts: listing.rows.map((p) => ({
      id: p.id,
      sku: p.sku,
      name: page.locale === "ar" ? p.name_ar : p.name_en,
      unit: p.unit,
      cost: p.cost_fils / 100,
      sell: p.sell_fils / 100,
      min_stock: p.min_stock,
      active: p.active === 1,
    })),
  };
}

/** 403 when the caller lacks `part.write`. */
async function denied(ctx: ActionContext): Promise<Response | null> {
  if (await ctx.authz.can("part.write")) return null;
  return plain(403, "Forbidden");
}

export const actions = {
  async save(ctx: ActionContext) {
    const refused = await denied(ctx);
    if (refused !== null) return refused;
    const page = await shell(ctx);
    const rawId = ctx.form.get("id");
    const id = typeof rawId === "string" ? rawId.trim() : "";
    if (id !== "" && !isPartId(id)) return plain(404, "Part not found");
    const input = await check(ctx.form, partSchema);
    if ("errors" in input) return invalid(page.locale, ctx.form, input.errors);
    const made = id === "" ? await createPart(ctx, input.value) : await updatePart(ctx, id, input.value);
    if (!made.ok) {
      if (made.taken === null) return plain(404, "Part not found");
      // The error names the part that holds the SKU, in the page's language.
      const bad = invalid(page.locale, ctx.form, { sku: "parts.err.sku_taken" });
      const message = (lookup(page.locale === "ar" ? "ar" : "en", "parts.err.sku_taken") ?? "").replace("{sku}", made.taken.sku).replace("{name}", page.locale === "ar" ? made.taken.name_ar : made.taken.name_en);
      bad.errors.sku = message;
      for (const p of bad.problems) if (p.field === "sku") p.message = message;
      return bad;
    }
    return redirect(`/admin/parts?saved=${id === "" ? "created" : "updated"}`);
  },

  async active(ctx: ActionContext) {
    const refused = await denied(ctx);
    if (refused !== null) return refused;
    const id = ctx.form.get("id");
    const on = ctx.form.get("active") === "1";
    if (!isPartId(id) || !(await setPartActive(ctx, id, on))) return plain(404, "Part not found");
    return redirect(`/admin/parts?saved=${on ? "activated" : "deactivated"}`);
  },
};
