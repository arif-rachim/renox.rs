// App MCP tool `list_people` (the owner connector, docs/20-ai-agents-mcp.md
// section 1b): the people of the branch the token acts in, as /admin/people lists
// them: email, role (`manager` for the app's `branch_manager`, the contract's
// word) and `active`, or `invited` for an invitation not accepted yet. No
// second factor state, no user id and no token is shown. Read only,
// `settings.read` like the page; the members come from org's public view of memberships
// (`org.members` answers the signed-in session only).
import { tool } from "@renoxium/sdk";

import { contractRole, NO_INPUT, noProperties } from "../../lib/owner-tools";
import { inputOf } from "../../lib/tool-input";

export default tool({
  name: "list_people",
  description: "The people of your branch: email, role and whether they joined or are invited",
  input: inputOf<Record<string, never>>(NO_INPUT, noProperties),
  action: "settings.read",
  async run(ctx) {
    const { isStaffRole, pendingInvites, rolesIn } = await import("../../lib/admin");
    const { branchesOfToken, fenced, refuse } = await import("../../lib/tools");
    if (ctx.principal === null) return refuse("forbidden", "A signed-in user is required.");
    const people: { email: string; role: string | null; status: "active" | "invited"; branch: string }[] = [];
    for (const branch of await branchesOfToken(ctx.db, ctx.principal)) {
      // org's public view of memberships, not `org.members`: that service answers the signed-in session, a tool call has none.
      const members = await ctx.db.query<{ user_id: string; email: string }>("select m.user_id as user_id, u.email as email from org__public_members_v1 m join auth__public_users_v1 u on u.id = m.user_id where m.org_id = ? order by u.email", [branch.org_id]);
      for (const m of members) {
        const roles = (await rolesIn(ctx, m.user_id, branch)).filter(isStaffRole);
        people.push({ email: m.email, role: contractRole(roles[0]), status: "active", branch: branch.slug });
      }
      for (const p of await pendingInvites(fenced(ctx.db, branch), branch.id)) people.push({ email: p.email, role: contractRole(p.role), status: "invited", branch: branch.slug });
    }
    return { people };
  },
});
