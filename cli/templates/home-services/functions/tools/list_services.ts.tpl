// App MCP tool `list_services` (the owner connector, docs/20-ai-agents-mcp.md
// section 1b): the priced catalogue as /services lists it (the company's
// services and the own services of the branch the token acts in): id, English
// name, price in AED and whether it is on offer. Read only, `customer.read`
// like the page.
import { tool } from "@renoxium/sdk";

import { NO_INPUT, noProperties } from "../../lib/owner-tools";
import { inputOf } from "../../lib/tool-input";

export default tool({
  name: "list_services",
  description: "The service catalogue: id, name, price in AED and whether it is active",
  input: inputOf<Record<string, never>>(NO_INPUT, noProperties),
  action: "customer.read",
  async run(ctx) {
    const { branchesOfToken, refuse } = await import("../../lib/tools");
    if (ctx.principal === null) return refuse("forbidden", "A signed-in user is required.");
    const mine = (await branchesOfToken(ctx.db, ctx.principal)).map((b) => b.id);
    const rows = await ctx.db.query<{ id: number; branch_id: string | null; name_en: string; price_fils: number; active: number }>("select id, branch_id, name_en, price_fils, active from app__services order by id", []);
    const shown = rows.filter((s) => s.branch_id === null || mine.includes(s.branch_id));
    return { services: shown.map((s) => ({ id: s.id, name: s.name_en, price_aed: s.price_fils / 100, active: s.active === 1 })) };
  },
});
