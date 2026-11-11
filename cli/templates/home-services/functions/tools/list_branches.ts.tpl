// App MCP tool `list_branches` (the owner connector, docs/20-ai-agents-mcp.md
// section 1b): the company's branches as /admin/branches lists them (each an
// `org` organisation): id, English name and emirate. Read only, `settings.read`
// like the page.
import { tool } from "@renoxium/sdk";

import { NO_INPUT, noProperties } from "../../lib/owner-tools";
import { inputOf } from "../../lib/tool-input";

export default tool({
  name: "list_branches",
  description: "The company's branches: id, name and emirate",
  input: inputOf<Record<string, never>>(NO_INPUT, noProperties),
  action: "settings.read",
  async run(ctx) {
    const { allBranches } = await import("../../lib/admin");
    return { branches: (await allBranches(ctx.db)).map((b) => ({ id: b.id, name: b.name_en, emirate: b.emirate })) };
  },
});
