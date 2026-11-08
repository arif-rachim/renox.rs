// GET /admin/branches: the company's branches. POST ?/create adds one (an
// `org` organisation, the branch row and the standard working hours) and
// ?/update changes its own fields: `settings.write`, sensitive (the owner with
// a recent second factor). An invalid form is a 422 naming the fields.
import type { ActionContext, LoaderContext } from "@renoxium/sdk";

import { allBranches, branchEmirates, branchSchema, createBranch, sensitive, updateBranch } from "../../lib/admin";
import { check } from "../../lib/forms";
import { shell } from "../../lib/page";
import { unprocessable } from "../../lib/problems";
import { branchOf, noBranch } from "../../lib/scope";

export const guard = { action: "settings.read" };

const redirect = (to: string): Response => new Response(null, { status: 303, headers: { location: to, "cache-control": "no-store" } });
const plain = (status: number, text: string): Response => new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

export async function load(ctx: LoaderContext) {
  const page = await shell(ctx);
  const branch = await branchOf(ctx);
  if (branch === null) return noBranch();
  const saved = ctx.url.searchParams.get("saved");
  const rows = await allBranches(ctx.db);
  return {
    ...page,
    created: saved === "created",
    updated: saved === "updated",
    emirates: branchEmirates(page.locale),
    branches: rows.map((b) => ({ ...b, name: page.locale === "ar" ? b.name_ar : b.name_en, current: b.id === branch.id })),
  };
}

export const actions = {
  async create(ctx: ActionContext) {
    const refused = await sensitive(ctx, "settings.write", "/admin/branches");
    if (refused !== null) return refused;
    const page = await shell(ctx);
    const branch = await branchOf(ctx);
    if (branch === null) return noBranch();
    const input = await check(ctx.form, branchSchema);
    if ("errors" in input) return unprocessable(page.locale, input.errors, "/admin/branches");
    const made = await createBranch(ctx, input.value, branch.org_id);
    if (!made.ok) return unprocessable(page.locale, { name_en: made.error }, "/admin/branches");
    return redirect("/admin/branches?saved=created");
  },

  async update(ctx: ActionContext) {
    const refused = await sensitive(ctx, "settings.write", "/admin/branches");
    if (refused !== null) return refused;
    const page = await shell(ctx);
    const id = ctx.form.get("branch_id");
    if (typeof id !== "string" || !/^[a-z0-9_]{1,64}$/u.test(id)) return plain(404, "Branch not found");
    const input = await check(ctx.form, branchSchema);
    if ("errors" in input) return unprocessable(page.locale, input.errors, "/admin/branches");
    if (!(await updateBranch(ctx, id, input.value))) return plain(404, "Branch not found");
    return redirect("/admin/branches?saved=updated");
  },
};
