// The org module's services (docs/contracts/manifest.md [exports.services]).
// Each gets org's ctx (its own tables, in the caller's transaction) first,
// then the caller's arguments. A call the caller's membership does not
// allow throws ORG_FORBIDDEN (the caller sees RENOX_MODULE_SERVICE).

import * as core from "./lib/core.ts";
import type { CurrentOrg, Member, Org, OrgCtx, Role, Switcher } from "./lib/core.ts";

/** Create an organisation; the signed-in user is its owner and it becomes the active one. */
export async function createOrg(ctx: OrgCtx, input: { name: string; slug?: string }): Promise<{ org: Org } | { error: string }> {
  const r = await core.createOrg(ctx, input);
  return r.ok ? { org: r.org } : { error: r.error };
}

/** The organisations of `user`, with the user's role in each. */
export async function listOrgs(ctx: OrgCtx, user: string): Promise<Org[]> {
  return core.listOrgs(ctx, user);
}

/** The active organisation of this session; `scope` is `{ org_id, role }` for the authz context (F5). */
export async function currentOrg(ctx: OrgCtx): Promise<CurrentOrg | null> {
  return core.currentOrg(ctx);
}

/** The active organisation, or throws: AUTH_REQUIRED signed out, ORG_FORBIDDEN below `role`. */
export async function requireMember(ctx: OrgCtx, role?: Role): Promise<CurrentOrg> {
  return core.requireMember(ctx, role ?? "member");
}

export async function switchOrg(ctx: OrgCtx, org: string): Promise<{ org: Org } | { error: string }> {
  const r = await core.switchOrg(ctx, String(org ?? ""));
  return r.ok ? { org: r.org } : { error: r.error };
}

/** The members of `org`; the caller must be one of them. */
export async function members(ctx: OrgCtx, org: string): Promise<Member[]> {
  return core.members(ctx, String(org ?? ""));
}

export async function invite(ctx: OrgCtx & { url: URL }, input: { org: string; email: string; role?: Role }): Promise<{ invite_id: string; expires_at: number } | { error: string }> {
  const r = await core.invite(ctx, input);
  return r.ok ? { invite_id: r.invite_id, expires_at: r.expires_at } : { error: r.error };
}

export async function revokeInvite(ctx: OrgCtx, input: { org: string; invite: string }): Promise<{ ok: true }> {
  await core.revokeInvite(ctx, input);
  return { ok: true };
}

export async function acceptInvite(ctx: OrgCtx, token: string): Promise<{ org: Org } | { error: string }> {
  const r = await core.acceptInvite(ctx, String(token ?? ""));
  return r.ok ? { org: r.org } : { error: r.error };
}

export async function setRole(ctx: OrgCtx, input: { org: string; user: string; role: Role }): Promise<{ ok: true } | { error: string }> {
  const r = await core.setRole(ctx, input);
  return r.ok ? { ok: true } : { error: r.error };
}

export async function removeMember(ctx: OrgCtx, input: { org: string; user: string }): Promise<{ ok: true } | { error: string }> {
  const r = await core.removeMember(ctx, input);
  return r.ok ? { ok: true } : { error: r.error };
}

/** For a page's load: `org_switcher: await org.switcher(url.pathname)` feeds the switcher partial. */
export async function switcher(ctx: OrgCtx, next?: string): Promise<Switcher | null> {
  return core.switcher(ctx, next);
}
