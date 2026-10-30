// GET <mount>/checkout/pending?order=: what the customer does next for an
// order paid without a card (#330): the bank details and the reference to
// quote for a transfer, or the cash-on-delivery confirmation and its state.
// Only the order's own customer sees it.
import { enabledMethods } from "../../lib/core.ts";
import { guarded, money, type Page } from "../../lib/page.ts";

export const load = guarded(async (ctx: Page) => {
  const order = ctx.url.searchParams.get("order") ?? "";
  const k = await ctx.db.queryOne<{ order_id: string; customer_id: string; amount: number; currency: string; method: string; reference: string | null; status: string }>(
    "select order_id, customer_id, amount, currency, method, reference, status from billing__checkouts where order_id = ?",
    [order],
  );
  if (k === null || k.customer_id !== (ctx.principal as { id: string }).id || k.method === "card") return new Response("Not found", { status: 404 });
  const cod = k.method === "cod" ? await ctx.db.queryOne<{ state: string }>("select state from billing__cod_orders where order_id = ?", [k.order_id]) : null;
  return {
    order: k.order_id,
    amount: money(k.amount, k.currency),
    bank: k.method === "bank" ? { reference: k.reference, name: ctx.config.bank_name ?? "", beneficiary: ctx.config.bank_beneficiary ?? "", iban: ctx.config.bank_iban ?? "" } : null,
    cod: cod === null ? null : { state: cod.state },
    paid: k.status === "completed",
    methods: enabledMethods(ctx),
  };
});
