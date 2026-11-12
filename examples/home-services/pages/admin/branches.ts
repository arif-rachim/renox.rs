// GET /admin/branches: the company's branches. POST ?/create adds one (an
// `org` organisation, the branch row and the standard working hours) and
// ?/update changes its own fields: `settings.write`, sensitive (the owner with
// a recent second factor). ?/hours replaces one branch's weekly working hours
// (same guard) and hands them to `booking`. An invalid form is a 422 naming the fields.
import type { ActionContext, LoaderContext } from "@renoxium/sdk";

import { allBranches, branchEmirates, branchSchema, clockOf, createBranch, hoursFromForm, replaceHours, sensitive, updateBranch } from "../../lib/admin";
import { hoursOf, jobsOutsideHours, syncHours, WEEK_ORDER } from "../../lib/booking-sync";
import { check } from "../../lib/forms";
import { shell } from "../../lib/page";
import { invalid } from "../../lib/invalid";
import { branchDb, branchOf, findBranch, noBranch } from "../../lib/scope";
import { techniciansOf } from "../../lib/technicians";

export const guard = { action: "settings.read" };

const redirect = (to: string): Response => new Response(null, { status: 303, headers: { location: to, "cache-control": "no-store" } });
const plain = (status: number, text: string): Response => new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

export async function load(ctx: LoaderContext) {
  const page = await shell(ctx);
  const branch = await branchOf(ctx);
  if (branch === null) return noBranch();
  const saved = ctx.url.searchParams.get("saved");
  const rows = await allBranches(ctx.db);
  // After saving hours: the branch's scheduled jobs that fall outside them are not moved, only counted.
  const forId = ctx.url.searchParams.get("for") ?? "";
  const outside = saved === "hours" && rows.some((b) => b.id === forId) ? await jobsOutsideHours(ctx.db, branchDb(ctx.db, forId), forId, Math.floor(Date.now() / 1000)) : [];
  const week = new Map<string, { weekday: number; name_key: string; closed: boolean; open: string; close: string }[]>();
  for (const b of rows) {
    const hours = await hoursOf(ctx.db, b.id);
    week.set(
      b.id,
      WEEK_ORDER.map((wd) => {
        const h = hours.find((x) => x.weekday === wd);
        return { weekday: wd, name_key: `backoffice.hours.day.${wd}`, closed: h === undefined, open: clockOf(h?.open_min ?? 480), close: clockOf(h?.close_min ?? 1080) };
      }),
    );
  }
  return {
    outside_count: outside.length,
    outside_branch: outside.length > 0 ? forId : "",
    hours_saved: saved === "hours",
    hours_branch: rows.find((b) => b.id === forId)?.[page.locale === "ar" ? "name_ar" : "name_en"] ?? "",
    ...page,
    created: saved === "created",
    updated: saved === "updated",
    emirates: branchEmirates(page.locale),
    values: {},
    branches: rows.map((b) => ({ ...b, week: week.get(b.id) ?? [], name: page.locale === "ar" ? b.name_ar : b.name_en, current: b.id === branch.id })),
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
    if ("errors" in input) return invalid(page.locale, ctx.form, input.errors, "create");
    const made = await createBranch(ctx, input.value, branch.org_id);
    if (!made.ok) return invalid(page.locale, ctx.form, { name_en: made.error }, "create");
    return redirect("/admin/branches?saved=created");
  },

  /**
   * Replaces one branch's seven weekdays and hands them to `booking`. Every check comes before the first write: a
   * module service that throws ends the action's transaction (#734).
   */
  async hours(ctx: ActionContext) {
    const refused = await sensitive(ctx, "settings.write", "/admin/branches");
    if (refused !== null) return refused;
    const page = await shell(ctx);
    const id = ctx.form.get("branch_id");
    if (typeof id !== "string" || !/^[a-z0-9_]{1,64}$/u.test(id)) return plain(404, "Branch not found");
    const branch = await findBranch(ctx.db, id);
    if (branch === null) return plain(404, "Branch not found");
    const input = hoursFromForm(ctx.form);
    if ("errors" in input) {
      const bad = invalid(page.locale, ctx.form, input.errors, `hours-${id}`);
      const typed = (key: string): string => String(ctx.form.get(key) ?? "").trim();
      // The form shows again as typed, with each row's own error.
      const echo = WEEK_ORDER.map((wd) => ({ weekday: wd, name_key: `backoffice.hours.day.${wd}`, closed: typed(`closed_${wd}`) !== "", open: typed(`open_${wd}`), close: typed(`close_${wd}`), error: bad.errors[`hours_${wd}`] ?? "" }));
      return { ...bad, week_for: id, week_echo: echo, week_error: bad.errors.hours ?? "" };
    }
    const technicians = await techniciansOf(ctx, branch);
    await replaceHours(ctx, id, input.value);
    await syncHours(ctx.db, branch, technicians);
    return redirect(`/admin/branches?saved=hours&for=${id}`);
  },

  async update(ctx: ActionContext) {
    const refused = await sensitive(ctx, "settings.write", "/admin/branches");
    if (refused !== null) return refused;
    const page = await shell(ctx);
    const id = ctx.form.get("branch_id");
    if (typeof id !== "string" || !/^[a-z0-9_]{1,64}$/u.test(id)) return plain(404, "Branch not found");
    const input = await check(ctx.form, branchSchema);
    if ("errors" in input) return invalid(page.locale, ctx.form, input.errors);
    if (!(await updateBranch(ctx, id, input.value))) return plain(404, "Branch not found");
    return redirect("/admin/branches?saved=updated");
  },
};
