// GET <mount>: the plans, the signed-in user's subscription and invoices.
// POST ?/subscribe (plan_id): a checkout for the user (one per user and
// plan, so a double click answers the same session) and a redirect to it.
import * as core from "../lib/core.ts";
import { day, guarded, money, type Page } from "../lib/page.ts";

async function view(ctx: Page) {
  const me = (ctx.principal as { id: string }).id;
  const plans = (await core.plans(ctx)) as { id: string; name: string; amount: number; currency: string; interval: "month" | "year" }[];
  const sub = (await core.subscription(ctx, me)) as { plan_id: string; status: string; current_period_end: number | null } | null;
  const invoices = (await core.invoices(ctx, me)) as { id: string; amount: number; currency: string; status: string; paid_at: number | null; created_at: number }[];
  return {
    plans: plans.map((p) => ({ id: p.id, name: p.name, price: money(p.amount, p.currency), interval: p.interval, current: sub?.plan_id === p.id && sub.status === "active" })),
    subscription: sub === null ? null : { plan: plans.find((p) => p.id === sub.plan_id)?.name ?? sub.plan_id, status: sub.status, until: day(sub.current_period_end) },
    invoices: invoices.map((i) => ({ id: i.id, amount: money(i.amount, i.currency), status: i.status, date: day(i.paid_at ?? i.created_at) })),
  };
}

export const load = guarded((ctx) => view(ctx));

export const actions = {
  subscribe: guarded(async (ctx) => {
    const me = (ctx.principal as { id: string }).id;
    const r = await core.checkout(ctx, me, ctx.form.get("plan_id"));
    return new Response(null, { status: 303, headers: { location: r.url, "cache-control": "no-store" } });
  }),
};
