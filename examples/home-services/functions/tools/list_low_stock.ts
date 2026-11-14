// App MCP tool `list_low_stock` (the owner connector, docs/20-ai-agents-mcp.md section 1b; #816): what the company
// is running out of, so an owner can ask "what are we running out of?". For each branch the token acts in, the parts
// whose quantity on hand is under their minimum, as /admin/stock?low=1 lists them: SKU, English name, unit, on hand
// and minimum, at most 20 a branch (`more` says how many are left out). Read only, no confirmation, `stock.read`
// like the page.
import { tool } from "@renoxium/sdk";

import { NO_INPUT, noProperties } from "../../lib/owner-tools";
import { inputOf } from "../../lib/tool-input";

/** How many parts a branch lists. */
const MAX_PARTS = 20;

export default tool({
  name: "list_low_stock",
  description: "Parts under their minimum stock in each branch: SKU, name, unit, on hand and minimum (up to 20 a branch)",
  input: inputOf<Record<string, never>>(NO_INPUT, noProperties),
  action: "stock.read",
  async run(ctx) {
    const { branchesOfToken, refuse } = await import("../../lib/tools");
    const { lowParts } = await import("../../lib/low-stock");
    const { round3 } = await import("../../lib/stock");
    if (ctx.principal === null) return refuse("forbidden", "A signed-in user is required.");
    const branches = [];
    for (const b of await branchesOfToken(ctx.db, ctx.principal)) {
      const lines = await lowParts(ctx.db, b.id);
      branches.push({
        branch: b.slug,
        name: b.name_en,
        low_parts: lines.slice(0, MAX_PARTS).map((l) => ({ sku: l.part.sku, name: l.part.name_en, unit: l.part.unit, on_hand: round3(l.qty), minimum: round3(l.part.min_stock) })),
        more: Math.max(0, lines.length - MAX_PARTS),
      });
    }
    return { branches };
  },
});
