// The technicians of a branch: the members of its organisation who hold the
// `technician` role, global or scoped to the branch (renox__role_assignments),
// so each member's roles are asked of `ctx.authz.roles`.
import type { Authz } from "@renoxium/sdk";
import { org } from "renox:modules";

import type { Branch } from "./scope";

export type Technician = { id: string; name: string };

interface TechCtx {
  readonly authz: Pick<Authz, "roles">;
}

/** The branch's technicians by name. The caller must be a member of the branch's organisation (`org.members`). */
export async function techniciansOf(ctx: TechCtx, branch: Branch): Promise<Technician[]> {
  const members = await org.members(branch.org_id);
  const out: Technician[] = [];
  for (const m of members) {
    const roles = await ctx.authz.roles.list(m.user_id);
    // A role is global or scoped to one branch's organisation (lib/admin.ts): only this branch's counts.
    if (roles.some((r) => r.role === "technician" && (r.scope_type === "global" || r.scope_id === branch.org_id))) out.push({ id: m.user_id, name: m.display_name });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/** A member's display name (the technician on a card), or their id when they are no member. */
export async function memberName(branch: Branch, userId: string): Promise<string> {
  const members = await org.members(branch.org_id);
  return members.find((m) => m.user_id === userId)?.display_name ?? userId;
}
