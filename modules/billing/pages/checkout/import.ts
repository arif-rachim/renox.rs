// GET/POST <mount>/checkout/import: paste a bank statement (CSV with date,
// amount and description columns) and match its rows against the open bank
// transfers by reference and exact amount (#330). billing.manage.
import { matchTransfer } from "../../lib/core.ts";
import { guarded, money, type Page } from "../../lib/page.ts";
import { parseStatement } from "../../src/adapters/offline.ts";

export const guard = { action: "billing.manage" };

export const load = guarded(async (ctx: Page) => {
  await ctx.authz.require("billing.manage");
  return { results: null, problems: [] as string[] };
});

export const actions = {
  import: guarded(async (ctx: Page) => {
    await ctx.authz.require("billing.manage");
    const raw = ctx.form.get("statement");
    const text = typeof raw === "string" ? raw.slice(0, 1_000_000) : "";
    const { rows, problems } = parseStatement(text);
    const results = [];
    for (const r of rows.slice(0, 5000)) {
      const m = await matchTransfer(ctx, r);
      results.push({ booked_on: r.booked_on, amount: money(r.amount, (ctx.config.currency ?? "AED").toUpperCase()), description: r.description, order: m.order_id ?? "-", reason: m.reason });
    }
    return { results, problems };
  }),
};
