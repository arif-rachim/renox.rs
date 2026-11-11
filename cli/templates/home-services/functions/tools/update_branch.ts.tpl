// App MCP tool `update_branch` (the owner connector, docs/20-ai-agents-mcp.md
// section 1b): renames a branch or moves it to another emirate, as
// /admin/branches updates one (lib/admin.ts updateBranch: the English name is the
// organisation's name too; the address name and the organisation do not
// change). An Arabic name that was the English one follows it. The
// organisation keeps its old name: `org.rename` answers the signed-in session
// only and a tool call has none (the `org` module offers an agent nothing but
// `invite_member`), so the switcher shows the old name until the branch is
// renamed on /admin/branches. `branch.write`, see add_branch.ts; `confirm`: the
// first call names the change.
import { tool } from "@renoxium/sdk";

import { BRANCH_UPDATE_JSON, parseBranchUpdate } from "../../lib/owner-tools";
import { inputOf } from "../../lib/tool-input";

export default tool({
  name: "update_branch",
  description: "Change a branch's name or emirate (id from list_branches); asks you to confirm first",
  input: inputOf<{ id: string; branch: { name?: string; emirate?: string } }>(BRANCH_UPDATE_JSON, parseBranchUpdate),
  action: "branch.write",
  confirm: true,
  async run(ctx) {
    const { allBranches, updateBranch } = await import("../../lib/admin");
    const { refuse } = await import("../../lib/tools");
    const issues: { message: string; path: string[] }[] = [];
    const input = parseBranchUpdate(ctx.tool.input as Record<string, unknown>, issues);
    if (issues.length > 0) return refuse("bad_input", issues.map((i) => i.message).join("; "));
    const row = (await allBranches(ctx.db)).find((b) => b.id === input.id);
    if (row === undefined) return refuse("not_found", `No branch ${input.id}.`);
    const name = input.branch.name ?? row.name_en;
    const emirate = input.branch.emirate ?? row.emirate;
    if (ctx.tool.preview) {
      const would_change: { field: string; from: string; to: string }[] = [];
      if (name !== row.name_en) would_change.push({ field: "name", from: row.name_en, to: name });
      if (emirate !== row.emirate) would_change.push({ field: "emirate", from: row.emirate, to: emirate });
      return { would_change };
    }
    const nameAr = row.name_ar === row.name_en ? name : row.name_ar;
    if (!(await updateBranch(ctx, row.id, { name_en: name, name_ar: nameAr, phone: row.phone, emirate, area: row.area, address: row.address }, false))) return refuse("not_found", `No branch ${input.id}.`);
    return { id: row.id, name, emirate };
  },
});
