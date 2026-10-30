// GET <mount>?from=&to=: the period's tax documents and the VAT return
// boxes (tax.manage). POST ?/csv (from, to): the return as CSV.
import * as core from "../lib/core.ts";
import { day, guarded, type Page } from "../lib/page.ts";

/** The period: `from` and `to` as dates (YYYY-MM-DD, UTC); the current quarter by default. */
function period(url: URL | FormData): { from: number; to: number; fromText: string; toText: string } {
  const get = (k: string) => (url instanceof URL ? url.searchParams.get(k) : url.get(k));
  const now = new Date();
  const q = Math.floor(now.getUTCMonth() / 3) * 3;
  const parse = (v: unknown, fallback: number) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(v) ? Date.parse(`${v}T00:00:00Z`) : fallback);
  const from = parse(get("from"), Date.UTC(now.getUTCFullYear(), q, 1));
  const to = parse(get("to"), Date.UTC(now.getUTCFullYear(), q + 3, 1));
  return { from, to, fromText: day(from), toText: day(to) };
}

async function view(ctx: Page) {
  await ctx.authz.require("tax.manage");
  const p = period(ctx.url);
  const r = await core.vatReturn(ctx, p.from, p.to);
  const docs = await ctx.db.query<{ number: string; kind: string; vat: number; standard: number; zero: number; exempt: number; issued_at: number }>(
    "select number, kind, vat, standard, zero, exempt, issued_at from tax_gcc__documents where issued_at >= ? and issued_at < ? order by issued_at desc limit 500",
    [p.from, p.to],
  );
  const b = r.boxes;
  return {
    from: p.fromText,
    to: p.toText,
    boxes: [
      { box: "1", amount: core.aed(b.box1_standard_rated_supplies.amount), vat: core.aed(b.box1_standard_rated_supplies.vat) },
      { box: "4", amount: core.aed(b.box4_zero_rated_supplies.amount), vat: "" },
      { box: "5", amount: core.aed(b.box5_exempt_supplies.amount), vat: "" },
      { box: "8", amount: core.aed(b.box8_totals.amount), vat: core.aed(b.box8_totals.vat) },
      { box: "9", amount: core.aed(b.box9_standard_rated_expenses.amount), vat: core.aed(b.box9_standard_rated_expenses.vat) },
      { box: "12", amount: "", vat: core.aed(b.box12_total_value_of_due_tax) },
      { box: "13", amount: "", vat: core.aed(b.box13_total_value_of_recoverable_tax) },
      { box: "14", amount: "", vat: core.aed(b.box14_payable_tax) },
    ],
    documents: docs.map((d) => ({ number: d.number, kind: d.kind, net: core.aed(d.standard + d.zero + d.exempt), vat: core.aed(d.vat), date: day(d.issued_at) })),
  };
}

export const guard = { action: "tax.manage" };

export const load = guarded((ctx) => view(ctx));

export const actions = {
  csv: guarded(async (ctx) => {
    await ctx.authz.require("tax.manage");
    const p = period(ctx.form);
    const csv = core.vatReturnCsv(await core.vatReturn(ctx, p.from, p.to));
    return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="vat-return-${p.fromText}-${p.toText}.csv"`, "cache-control": "no-store" } });
  }),
};
