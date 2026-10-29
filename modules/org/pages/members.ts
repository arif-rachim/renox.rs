// GET <mount>/members: the active organisation's members with their roles;
// admins and owners also see the pending invitations, invite, change roles
// and remove members (an admin never touches an owner). Every member may
// leave; the last owner stays (lib/core.ts).
import * as core from "../lib/core.ts";
import { guarded, type Page, redirect, toLogin } from "../lib/page.ts";

async function view(ctx: Page, notice: string | null, error: string | null) {
  const s = await core.session();
  if (s === null) return toLogin(ctx);
  const org = await core.currentOrg(ctx);
  if (org === null) return redirect(core.basePath(ctx));
  const admin = core.atLeast(org.role, "admin");
  const owner = org.role === "owner";
  const members = (await core.members(ctx, org.id)).map((m) => ({
    ...m,
    self: m.user_id === s.user.id,
    manageable: m.user_id !== s.user.id && admin && (owner || m.role !== "owner"),
  }));
  const invites = admin ? await core.pendingInvites(ctx, org.id) : [];
  return { org, members, invites, has_invites: invites.length > 0, can_invite: admin, can_grant_owner: owner, notice, error };
}

/** The active organisation's id: actions act on it only. */
async function active(ctx: Page): Promise<string> {
  return (await core.requireMember(ctx)).id;
}

const done = (ctx: Page, r: { ok: true } | { ok: false; error: string }, notice: string) => view(ctx, r.ok ? notice : null, r.ok ? null : r.error);

export const load = guarded((ctx) => view(ctx, null, null));

export const actions = {
  invite: guarded(async (ctx) => {
    const r = await core.invite(ctx, { org: await active(ctx), email: ctx.form.get("email"), role: ctx.form.get("role") });
    if (!r.ok && r.halt) return r.halt;
    return view(ctx, r.ok ? "Invitation sent." : null, r.ok ? null : r.error);
  }),
  revoke: guarded(async (ctx) => {
    await core.revokeInvite(ctx, { org: await active(ctx), invite: ctx.form.get("invite") });
    return view(ctx, "Invitation withdrawn.", null);
  }),
  role: guarded(async (ctx) => done(ctx, await core.setRole(ctx, { org: await active(ctx), user: ctx.form.get("user"), role: ctx.form.get("role") }), "Role changed.")),
  remove: guarded(async (ctx) => done(ctx, await core.removeMember(ctx, { org: await active(ctx), user: ctx.form.get("user") }), "Member removed.")),
  leave: guarded(async (ctx) => {
    const s = await core.requireSession();
    const r = await core.removeMember(ctx, { org: await active(ctx), user: s.user.id });
    return r.ok ? redirect(core.basePath(ctx)) : view(ctx, null, r.error);
  }),
};
