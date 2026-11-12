// App MCP tool `invite_staff` (the owner connector's `invite_people`, #751,
// docs/20-ai-agents-mcp.md section 1b): invites a person to one branch with a
// staff role, as /admin/people does (lib/admin.ts inviteStaff: the `org`
// invitation, the `app__staff_invites` row that carries the role, an audit
// row). The person gets the role in that branch when they accept (hooks.ts,
// `org.member_added`), at once when they already have an account. `org`'s
// own `invite_member` knows only org roles, so the staff role would be lost.
//
// The branch is matched by its English or Arabic name, compared trimmed and
// case-insensitively (exact, not a prefix); its id and address name are
// accepted too. An unknown branch or role is a `bad_input` that names the
// allowed values. `owner` is not a role this tool gives. `settings.update`:
// the non-sensitive, owner-only action of the owner connector (see
// update_settings.ts); `user.manage` is sensitive and never passes for an
// agent token. `confirm`: the first call names the invitation and sends
// nothing (the mail of an invitation is not undone by a rolled back transaction).
import { tool } from "@renoxium/sdk";

import { INVITE_STAFF_JSON, type InviteRole, parseInviteStaff } from "../../lib/owner-tools";
import { inputOf } from "../../lib/tool-input";

const ROLE_WORDS: Record<InviteRole, string> = { branch_manager: "branch manager", dispatcher: "dispatcher", technician: "technician", accountant: "accountant" };

export default tool({
  name: "invite_staff",
  description: "Invite a person by email to a branch with a staff role (branch_manager, dispatcher, technician or accountant); asks you to confirm first",
  input: inputOf<{ email: string; role: InviteRole; branch: string }>(INVITE_STAFF_JSON, parseInviteStaff),
  action: "settings.update",
  confirm: true,
  async run(ctx) {
    const { allBranches, inviteStaff } = await import("../../lib/admin");
    const { branchByName } = await import("../../lib/owner-tools");
    const { fenced, refuse } = await import("../../lib/tools");
    const issues: { message: string; path: string[] }[] = [];
    const input = parseInviteStaff(ctx.tool.input as Record<string, unknown>, issues);
    if (issues.length > 0) return refuse("bad_input", issues.map((i) => i.message).join("; "));
    const all = await allBranches(ctx.db);
    const wanted = input.branch.trim().toLowerCase();
    const branch = branchByName(all, input.branch) ?? all.find((b) => b.id === wanted || b.slug === wanted) ?? null;
    if (branch === null) return refuse("bad_input", `No branch "${input.branch}". The branches are: ${all.map((b) => b.name_en).join(", ")}.`, { branches: all.map((b) => b.name_en) });
    if (ctx.tool.preview) return { would_invite: { email: input.email, role: input.role, branch: branch.name_en }, plan: `Invite ${input.email} as a ${ROLE_WORDS[input.role]} in the ${branch.name_en} branch.` };
    let sent;
    try {
      sent = await inviteStaff(ctx, fenced(ctx.db, branch), branch, input.email, input.role);
    } catch (e) {
      const code = (e as { code?: unknown } | null)?.code;
      if (code === "ORG_FORBIDDEN") return refuse("forbidden", `You are not an admin of the ${branch.name_en} branch's organisation.`);
      if (code === "AUTH_REQUIRED") return refuse("unavailable", "The invitation could not be sent for this account.");
      throw e;
    }
    if (!sent.ok) return refuse(sent.error === "backoffice.err.email" ? "bad_input" : "unavailable", sent.error === "backoffice.err.email" ? "The email is not an address." : "The invitation was not sent.");
    return { invited: true, email: input.email, role: input.role, branch: branch.name_en, joined: sent.applied };
  },
});
