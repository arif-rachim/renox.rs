// GET <mount>?from=&to=: a period's daily sales and cash (reports.view).
// POST ?/export (kind: sales | cash | xero | quickbooks | zoho, format:
// csv | xlsx, from, to): the file (reports.export, sensitive, audited).
import { period, exported, KINDS, type Kind } from "../lib/report.ts";
import { day, guarded, type Page } from "../lib/page.ts";

function range(src: URL | FormData) {
  const get = (k: string) => (src instanceof URL ? src.searchParams.get(k) : src.get(k));
  const now = Date.now();
  const parse = (v: unknown, fb: number) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(v) ? Date.parse(`${v}T00:00:00Z`) : fb);
  const to = parse(get("to"), Math.floor(now / 86_400_000) * 86_400_000 + 86_400_000);
  const from = parse(get("from"), to - 30 * 86_400_000);
  return { from, to };
}

export const guard = { action: "reports.view" };

export const load = guarded(async (ctx: Page) => {
  await ctx.authz.require("reports.view");
  const r = range(ctx.url);
  const p = await period(ctx.db, r.from, r.to);
  return { from: day(r.from), to: day(r.to), sales: p.sales, cash: p.cash, kinds: KINDS };
});

export const actions = {
  export: guarded(async (ctx: Page) => {
    await ctx.authz.require("reports.export");
    const r = range(ctx.form);
    const kind = KINDS.find((k) => k === ctx.form.get("kind")) ?? ("sales" as Kind);
    const format = ctx.form.get("format") === "xlsx" ? "xlsx" : "csv";
    const f = await exported(ctx.db, kind, format, r.from, r.to);
    return new Response(f.body as BodyInit, { headers: { "content-type": f.type, "content-disposition": `attachment; filename="${f.name}"`, "cache-control": "no-store" } });
  }),
};
