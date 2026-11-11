// App MCP tool `update_service` (the owner connector, docs/20-ai-agents-mcp.md
// section 1b): changes a service's name, price or whether it is on offer, as
// /services does for the price and the switch (a service of another branch is
// not found). An Arabic name that was the English one follows it. `service.write`,
// see add_service.ts; `confirm`: the first call names each change, with the
// price from its value now to the new one.
import { tool } from "@renoxium/sdk";

import { parseServiceUpdate, SERVICE_UPDATE_JSON } from "../../lib/owner-tools";
import { inputOf } from "../../lib/tool-input";

type Row = {
  id: number;
  branch_id: string | null;
  name_en: string;
  name_ar: string;
  price_fils: number;
  active: number;
};

export default tool({
  name: "update_service",
  description: "Change a service's name, price in AED or whether it is active (id from list_services); asks you to confirm first",
  input: inputOf<{ id: number; service: { name?: string; price_fils?: number; active?: boolean } }>(SERVICE_UPDATE_JSON, parseServiceUpdate),
  action: "service.write",
  confirm: true,
  async run(ctx) {
    const { audit } = await import("renox:modules");
    const { branchesOfToken, refuse } = await import("../../lib/tools");
    const issues: { message: string; path: string[] }[] = [];
    const input = parseServiceUpdate(ctx.tool.input as Record<string, unknown>, issues);
    if (issues.length > 0) return refuse("bad_input", issues.map((i) => i.message).join("; "));
    if (ctx.principal === null) return refuse("forbidden", "A signed-in user is required.");
    const mine = (await branchesOfToken(ctx.db, ctx.principal)).map((b) => b.id);
    const row = await ctx.db.queryOne<Row>("select id, branch_id, name_en, name_ar, price_fils, active from app__services where id = ?", [input.id]);
    if (row === null || (row.branch_id !== null && !mine.includes(row.branch_id))) return refuse("not_found", `No service ${input.id}.`);
    const s = input.service;
    const name = s.name ?? row.name_en;
    const price = s.price_fils ?? row.price_fils;
    const active = s.active ?? row.active === 1;
    if (ctx.tool.preview) {
      const would_change: { field: string; from: string | number | boolean; to: string | number | boolean }[] = [];
      if (name !== row.name_en) would_change.push({ field: "name", from: row.name_en, to: name });
      if (price !== row.price_fils) would_change.push({ field: "price_aed", from: row.price_fils / 100, to: price / 100 });
      if (active !== (row.active === 1)) would_change.push({ field: "active", from: row.active === 1, to: active });
      return { would_change };
    }
    const nameAr = row.name_ar === row.name_en ? name : row.name_ar;
    await ctx.db.execute("update app__services set name_en = ?, name_ar = ?, price_fils = ?, active = ? where id = ?", [name, nameAr, price, active ? 1 : 0, row.id]);
    await audit.record({ action: "service.update", actor: { kind: "user", id: ctx.principal.id }, resource: { type: "Service", id: String(row.id) } });
    return { id: row.id, name, price_aed: price / 100, active };
  },
});
