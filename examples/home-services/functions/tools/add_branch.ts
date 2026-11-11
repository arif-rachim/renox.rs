// App MCP tool `add_branch` (the owner connector, docs/20-ai-agents-mcp.md
// section 1b): a new branch, as /admin/branches creates one (lib/admin.ts
// createBranch: an `org` organisation, the branch row, the standard working
// hours, an audit row). The Arabic name is the English one until the owner
// changes it on the page. `branch.write`: no policy names it, so the owner's
// blanket permit alone grants it (the page's `settings.write` needs a second
// factor an agent token never has, see update_settings.ts); `confirm`: the
// first call does everything and the cell rolls it back, so it also finds out
// what cannot be done.
//
// Today it cannot be done from a tool call: `org.createOrg` and `org.switchOrg`
// answer the signed-in session (`auth.currentSession` reads the request's
// cookie) and a tool call has no request; the `org` module offers an agent only
// `invite_member`. The tool then answers `unavailable` and writes nothing,
// until `org` has a service that creates an organisation for a user (as its
// `inviteAs` invites for one).
import { tool } from "@renoxium/sdk";

import { BRANCH_ADD_JSON, parseBranchAdd } from "../../lib/owner-tools";
import { inputOf } from "../../lib/tool-input";

export default tool({
  name: "add_branch",
  description: "Add a branch (name and emirate); asks you to confirm first",
  input: inputOf<{ branch: { name: string; emirate: string } }>(BRANCH_ADD_JSON, parseBranchAdd),
  action: "branch.write",
  confirm: true,
  async run(ctx) {
    const { branchSlug, createBranch } = await import("../../lib/admin");
    const { isNoSession } = await import("../../lib/owner-tools");
    const { refuse } = await import("../../lib/tools");
    const issues: { message: string; path: string[] }[] = [];
    const { branch } = parseBranchAdd(ctx.tool.input as Record<string, unknown>, issues);
    if (issues.length > 0) return refuse("bad_input", issues.map((i) => i.message).join("; "));
    const active = ctx.principal?.attrs.org;
    if (typeof active !== "string" || active === "") return refuse("forbidden", "No branch is active for this account.");
    const slug = branchSlug(branch.name);
    if (slug === "") return refuse("bad_input", "The name needs a Latin letter or a digit (it makes the branch's address).");
    if ((await ctx.db.queryOne<{ n: number }>("select count(*) as n from app__branches where slug = ?", [slug]))?.n !== 0) return refuse("bad_input", `A branch called ${slug} exists.`);
    let made;
    try {
      made = await createBranch(ctx, { name_en: branch.name, name_ar: branch.name, phone: "", emirate: branch.emirate, area: "", address: "" }, active);
    } catch (e) {
      if (!isNoSession(e)) throw e;
      return refuse("unavailable", "A branch cannot be added from here yet (the organisation module creates one only in a signed-in browser session): add it at /admin/branches.");
    }
    if (!made.ok) return refuse("bad_input", "The branch could not be created (its name is taken).");
    if (ctx.tool.preview) return { would_create: { name: branch.name, emirate: branch.emirate } };
    return { id: made.id, name: branch.name, emirate: branch.emirate };
  },
});
