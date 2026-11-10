// The technicians of a branch: the members of its organisation who hold the
// `technician` role, global or scoped to the branch (renox__role_assignments),
// so each member's roles are asked of `ctx.authz.roles`.
import type { Authz, DbStatements } from "@renoxium/sdk";
import type { Branch } from "./scope";

export type Technician = { id: string; name: string };

interface TechCtx {
  readonly authz: Pick<Authz, "roles">;
  readonly db: DbStatements;
}

/**
 * The branch's technicians by name. The members come from `org`'s public view
 * (org__public_members_v1) and the names from auth's (auth__public_users_v1),
 * not from `org.members`: that service answers for the signed-in session, and
 * an App MCP tool call (functions/tools) has a token's user and no session.
 */
export async function techniciansOf(ctx: TechCtx, branch: Branch): Promise<Technician[]> {
  const members = await ctx.db.query<{ user_id: string; display_name: string | null }>(
    "select m.user_id as user_id, u.display_name as display_name from org__public_members_v1 m join auth__public_users_v1 u on u.id = m.user_id where m.org_id = ?",
    [branch.org_id],
  );
  const out: Technician[] = [];
  for (const m of members) {
    const roles = await ctx.authz.roles.list(m.user_id);
    // A role is global or scoped to one branch's organisation (lib/admin.ts): only this branch's counts.
    if (roles.some((r) => r.role === "technician" && (r.scope_type === "global" || r.scope_id === branch.org_id))) out.push({ id: m.user_id, name: m.display_name ?? "" });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/** A member's display name (the technician on a card), or their id when they are no member (the same views as `techniciansOf`). */
export async function memberName(db: DbStatements, branch: Pick<Branch, "org_id">, userId: string): Promise<string> {
  const row = await db.queryOne<{ display_name: string | null }>(
    "select u.display_name as display_name from org__public_members_v1 m join auth__public_users_v1 u on u.id = m.user_id where m.org_id = ? and m.user_id = ?",
    [branch.org_id, userId],
  );
  return row?.display_name ?? userId;
}

/** The display names of every member of the branch's organisation by user id, in one query (the board names the technician on each card from it). */
export async function memberNames(db: DbStatements, branch: Pick<Branch, "org_id">): Promise<Map<string, string>> {
  const rows = await db.query<{ user_id: string; display_name: string | null }>(
    "select m.user_id as user_id, u.display_name as display_name from org__public_members_v1 m join auth__public_users_v1 u on u.id = m.user_id where m.org_id = ?",
    [branch.org_id],
  );
  return new Map(rows.map((r) => [r.user_id, r.display_name ?? r.user_id]));
}
