// GET <mount>?from=&to=: the period's tax documents and the VAT return
// boxes (tax.manage). POST ?/csv (from, to): the return as CSV.
import * as core from "../lib/core.ts";
import { amount, day, guarded, type Page } from "../lib/page.ts";

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
      { box: "1", amount: amount(b.box1_standard_rated_supplies.amount), vat: amount(b.box1_standard_rated_supplies.vat) },
      { box: "4", amount: amount(b.box4_zero_rated_supplies.amount), vat: null },
      { box: "5", amount: amount(b.box5_exempt_supplies.amount), vat: null },
      { box: "8", amount: amount(b.box8_totals.amount), vat: amount(b.box8_totals.vat) },
      { box: "9", amount: amount(b.box9_standard_rated_expenses.amount), vat: amount(b.box9_standard_rated_expenses.vat) },
      { box: "12", amount: null, vat: amount(b.box12_total_value_of_due_tax) },
      { box: "13", amount: null, vat: amount(b.box13_total_value_of_recoverable_tax) },
      { box: "14", amount: null, vat: amount(b.box14_payable_tax) },
    ],
    // Amounts and dates through the renderer's filters: two decimals, DD/MM/YYYY, the page's digits (#336).
    documents: docs.map((d) => ({ number: d.number, kind: d.kind, net: amount(d.standard + d.zero + d.exempt), vat: amount(d.vat), issued_at: d.issued_at })),
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
