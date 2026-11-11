// App MCP tool `add_service` (the owner connector, docs/20-ai-agents-mcp.md
// section 1b): a new service in the company's catalogue (every branch offers
// it): a visit priced in AED, 5 % VAT, on offer, with a code made from its name
// (`AC service` is `AC-SERVICE`), as the first setup makes them. The Arabic
// name is the English one until the owner changes it. `service.write`: no
// policy names it, so the owner's blanket permit alone grants it (the page's
// `settings.write` needs a second factor an agent token never has, see
// update_settings.ts); `confirm`: the first call creates nothing.
import { tool } from "@renoxium/sdk";

import { parseServiceAdd, SERVICE_ADD_JSON } from "../../lib/owner-tools";
import { inputOf } from "../../lib/tool-input";

export default tool({
  name: "add_service",
  description: "Add a service to the catalogue (name and price in AED); asks you to confirm first",
  input: inputOf<{ service: { name: string; price_fils: number } }>(SERVICE_ADD_JSON, parseServiceAdd),
  action: "service.write",
  confirm: true,
  async run(ctx) {
    const { audit } = await import("renox:modules");
    const { serviceCode } = await import("../../lib/setup");
    const { refuse } = await import("../../lib/tools");
    const issues: { message: string; path: string[] }[] = [];
    const { service } = parseServiceAdd(ctx.tool.input as Record<string, unknown>, issues);
    if (issues.length > 0) return refuse("bad_input", issues.map((i) => i.message).join("; "));
    if (ctx.tool.preview) return { would_create: { name: service.name, price_aed: service.price_fils / 100 } };
    const codes = new Set((await ctx.db.query<{ code: string }>("select code from app__services", [])).map((r) => r.code));
    const code = serviceCode(service.name, codes.size, codes);
    const made = await ctx.db.execute("insert into app__services (branch_id, code, name_en, name_ar, unit, price_fils, vat_rate, active) values (null, ?, ?, ?, 'visit', ?, 5, 1)", [code, service.name, service.name, service.price_fils]);
    const id = Number(made.lastInsertRowid);
    await audit.record({ action: "service.create", actor: { kind: "user", id: ctx.principal?.id ?? "unknown" }, resource: { type: "Service", id: String(id) }, details: { code } });
    return { id, name: service.name, price_aed: service.price_fils / 100, active: true };
  },
});
