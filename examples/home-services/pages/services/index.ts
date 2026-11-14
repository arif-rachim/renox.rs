// GET /services: the priced catalogue (the company's services and the active
// branch's own). POST ?/save changes a price or switches a service off:
// `settings.write`, a sensitive action (owner, with a recent second factor),
// so it is audited. app__services is not an owned table (branch_id null
// means every branch), so the statements name the branch themselves.
import type { ActionContext, LoaderContext } from "@renoxium/sdk";

import { syncCatalogue } from "../../lib/booking-sync";
import { check, serviceSchema } from "../../lib/forms";
import { shell } from "../../lib/page";
import { invalid } from "../../lib/invalid";
import { branchOf, noBranch, type Branch } from "../../lib/scope";

export const guard = { action: "customer.read" };

type ServiceRow = {
  id: number;
  branch_id: string | null;
  code: string;
  name_en: string;
  name_ar: string;
  unit: "visit" | "hour" | "unit";
  price_fils: number;
  vat_rate: number;
  active: number;
  self_booking: number;
}


async function catalogue(ctx: LoaderContext | ActionContext, branch: Branch, locale: string, error: string | null, saved: string | null) {
  const rows = await ctx.db.query<ServiceRow>("select id, branch_id, code, name_en, name_ar, unit, price_fils, vat_rate, active, self_booking from app__services where (branch_id is null or branch_id = ?) order by id", [branch.id]);
  return {
    services: rows.map((s) => ({
      id: s.id,
      code: s.code,
      name: locale === "ar" ? s.name_ar : s.name_en,
      unit: s.unit,
      price: s.price_fils / 100,
      price_input: (s.price_fils / 100).toFixed(2),
      vat_rate: s.vat_rate,
      active: s.active === 1,
      self_booking: s.self_booking === 1,
      branch_only: s.branch_id !== null,
    })),
    error,
    saved,
    values: {},
  };
}

export async function load(ctx: LoaderContext) {
  const page = await shell(ctx);
  const branch = await branchOf(ctx);
  if (branch === null) return noBranch();
  return { ...page, ...(await catalogue(ctx, branch, page.locale, null, null)) };
}

export const actions = {
  async save(ctx: ActionContext) {
    const page = await shell(ctx);
    const branch = await branchOf(ctx);
    if (branch === null) return noBranch();
    // Denied answers 403 and commits: the platform's audit row of a sensitive decision stays.
    try {
      await ctx.authz.require("settings.write");
    } catch (e) {
      if ((e as { code?: string }).code === "RENOX_FORBIDDEN") return new Response("Forbidden", { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } });
      throw e;
    }
    const input = await check(ctx.form, serviceSchema);
    if ("errors" in input) return invalid(page.locale, ctx.form, input.errors);
    const s = input.value;
    const row = await ctx.db.queryOne<{ code: string }>("select code from app__services where id = ? and (branch_id is null or branch_id = ?)", [s.id, branch.id]);
    if (row === null) return new Response("Service not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
    await ctx.db.execute("update app__services set price_fils = ?, active = ?, self_booking = ? where id = ?", [s.price_fils, s.active, s.self_booking, s.id]);
    // settings.write is the owner's, who holds booking.manage: /book offers the change at once.
    await syncCatalogue(ctx);
    return catalogue(ctx, branch, page.locale, null, row.code);
  },
};
