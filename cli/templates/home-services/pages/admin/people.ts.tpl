// GET /admin/people: the people of the active branch with their app roles and
// whether they have a second factor. It is not the `admin` module's users page
// (/admin/users), which grants that module's own `admin` role to any user: the
// roles here are the app's five, per branch, and the invitation goes through
// `org`. POST ?/invite (email and role: an `org` invitation as a member, the
// role waits for the person and is applied when they join, by the
// `org.member_added` handler in hooks.ts), ?/role (one of the
// five roles, replacing the others in this branch) and ?/remove (out of the
// branch): `user.manage`, sensitive (the owner with a recent second factor).
// An owner and an accountant need a second factor before any sensitive action
// (policies/app/base.cedar); the page shows who has none yet. POST ?/reset_2fa
// (#735): `twofa.reset`, the owner's only, on a person of this branch who has
// a second factor and is not the caller; the first POST (no `confirm=1`) shows
// the confirmation block, the confirmed one calls the `twofa` module's `reset`
// (it checks the permission and a recent second factor itself, but a module call
// that throws ends the transaction, so the page asks first), tells the person
// through `notifications` and goes back with `?saved=twofa_reset`.
import type { ActionContext, LoaderContext } from "@renoxium/sdk";
import { twofa } from "renox:modules";

import { syncCatalogue } from "../../lib/booking-sync";
import { inviteStaff, isStaffRole, notifyTwofaReset, pendingInvites, removeStaff, sensitive, setStaffRole, staffOf, STAFF_ROLES } from "../../lib/admin";
import { shell } from "../../lib/page";
import { invalid } from "../../lib/invalid";
import { day } from "../../lib/quotes";
import { branchOf, noBranch, scopedDb } from "../../lib/scope";

export const guard = { action: "settings.read" };

const redirect = (to: string): Response => new Response(null, { status: 303, headers: { location: to, "cache-control": "no-store" } });

/** Roles that need a second factor before a sensitive action. */
const NEEDS_FACTOR = new Set(["owner", "accountant"]);

export async function load(ctx: LoaderContext) {
  const page = await shell(ctx);
  const branch = await branchOf(ctx);
  if (branch === null) return noBranch();
  const sdb = scopedDb(ctx.db, branch);
  const staff = await staffOf(ctx, branch);
  const pending = await pendingInvites(sdb, branch.id);
  const saved = ctx.url.searchParams.get("saved");
  return {
    ...page,
    confirm_reset: null as { user_id: string; name: string } | null,
    branch_name: page.locale === "ar" ? branch.name_ar : branch.name_en,
    values: {},
    saved,
    roles: STAFF_ROLES.map((value) => ({ value })),
    staff: staff.map((s) => ({ ...s, role: s.roles[0] ?? "", no_role: s.roles.length === 0, needs_factor: !s.twofa && s.roles.some((r) => NEEDS_FACTOR.has(r)) })),
    pending: pending.map((p) => ({ email: p.email, role: p.role, sent: day(p.created_at) })),
  };
}

const back = "/admin/people";

/** The page rendered again (200) with the confirmation block of `target`; the loader's data comes with it, the action's keys win. */
const confirming = (target: { user_id: string; name: string }) => ({ status: 200 as const, confirm_reset: { user_id: target.user_id, name: target.name } });

export const actions = {
  async invite(ctx: ActionContext) {
    const refused = await sensitive(ctx, "user.manage", back);
    if (refused !== null) return refused;
    const page = await shell(ctx);
    const branch = await branchOf(ctx);
    if (branch === null) return noBranch();
    const email = String(ctx.form.get("email") ?? "").trim().slice(0, 254);
    const role = ctx.form.get("role");
    if (!isStaffRole(role)) return invalid(page.locale, ctx.form, { role: "backoffice.err.role" });
    const r = await inviteStaff(ctx, scopedDb(ctx.db, branch), branch, email, role);
    if (!r.ok) return invalid(page.locale, ctx.form, { email: r.error });
    if (r.applied) await syncCatalogue(ctx, branch.id);
    return redirect(`${back}?saved=invited`);
  },

  async role(ctx: ActionContext) {
    const refused = await sensitive(ctx, "user.manage", back);
    if (refused !== null) return refused;
    const page = await shell(ctx);
    const branch = await branchOf(ctx);
    if (branch === null) return noBranch();
    const role = ctx.form.get("role");
    if (!isStaffRole(role)) return invalid(page.locale, ctx.form, { role: "backoffice.err.role" });
    const target = String(ctx.form.get("user_id") ?? "");
    const staff = await staffOf(ctx, branch);
    const member = staff.find((s) => s.user_id === target);
    if (member === undefined) return invalid(page.locale, ctx.form, { user_id: "backoffice.err.member" });
    if (member.self) return invalid(page.locale, ctx.form, { user_id: "backoffice.err.self" });
    await setStaffRole(ctx, branch, target, role);
    await syncCatalogue(ctx, branch.id);
    return redirect(`${back}?saved=role`);
  },

  async remove(ctx: ActionContext) {
    const refused = await sensitive(ctx, "user.manage", back);
    if (refused !== null) return refused;
    const page = await shell(ctx);
    const branch = await branchOf(ctx);
    if (branch === null) return noBranch();
    const target = String(ctx.form.get("user_id") ?? "");
    const staff = await staffOf(ctx, branch);
    const member = staff.find((s) => s.user_id === target);
    if (member === undefined) return invalid(page.locale, ctx.form, { user_id: "backoffice.err.member" });
    if (member.self) return invalid(page.locale, ctx.form, { user_id: "backoffice.err.self" });
    const r = await removeStaff(ctx, branch, target);
    if (!r.ok) return invalid(page.locale, ctx.form, { user_id: r.error });
    await syncCatalogue(ctx, branch.id);
    return redirect(`${back}?saved=removed`);
  },

  async reset_2fa(ctx: ActionContext) {
    const target = String(ctx.form.get("user_id") ?? "");
    // Both checks come before anything is written (and before the module is called).
    const refused = await sensitive(ctx, "twofa.reset", back, { type: "twofa:User", id: target });
    if (refused !== null) return refused;
    const page = await shell(ctx);
    const branch = await branchOf(ctx);
    if (branch === null) return noBranch();
    const staff = await staffOf(ctx, branch);
    const member = staff.find((s) => s.user_id === target);
    if (member === undefined) return invalid(page.locale, ctx.form, { user_id: "backoffice.err.member" });
    if (member.self) return invalid(page.locale, ctx.form, { user_id: "backoffice.err.self" });
    if (!member.twofa) return invalid(page.locale, ctx.form, { user_id: "backoffice.err.no_twofa" });
    if (ctx.form.get("confirm") !== "1") return confirming(member);
    const done = await twofa.reset(target);
    if (done.reset) await notifyTwofaReset(target, staff.find((s) => s.self)?.name ?? "");
    return redirect(`${back}?saved=twofa_reset`);
  },
};
