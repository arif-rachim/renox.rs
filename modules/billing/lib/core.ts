// The billing module (#329): plans and subscriptions of the app's own
// customers, Stripe Checkout sessions, and the state from Stripe's
// verified webhooks (ops.md 1.7.0 section 22: `ctx.webhook.verify` with
// provider stripe, duplicates answered before the handler).

export interface Db {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  queryOne<T>(sql: string, params?: unknown[]): Promise<T | null>;
  execute(sql: string, params?: unknown[]): Promise<{ changes: number }>;
}

export interface BillingCtx {
  db: Db;
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  secrets: Record<string, string | undefined>;
  config: { currency?: string; success_url?: string; cancel_url?: string };
  events: { emit(name: string, payload: unknown): Promise<void> };
}

export class BillingError extends Error {
  constructor(
    message: string,
    readonly code: "INVALID" | "NOT_FOUND" | "NOT_CONFIGURED" | "PSP",
  ) {
    super(message);
    this.name = "BillingError";
  }
}

const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const id = (v: unknown, what: string): string => {
  if (typeof v !== "string" || !ID.test(v)) throw new BillingError(`${what}: lower-case letters, digits, _ and -`, "INVALID");
  return v;
};
const newId = (p: string): string => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

export async function createPlan(ctx: BillingCtx, p: { id?: unknown; name?: unknown; amount?: unknown; interval?: unknown }) {
  const planId = id(p.id, "id");
  if (typeof p.name !== "string" || p.name.length === 0 || p.name.length > 100) throw new BillingError("a name", "INVALID");
  if (typeof p.amount !== "number" || !Number.isInteger(p.amount) || p.amount < 0) throw new BillingError("amount in minor units", "INVALID");
  if (p.interval !== "month" && p.interval !== "year") throw new BillingError("interval month or year", "INVALID");
  const currency = (ctx.config.currency ?? "AED").toUpperCase();
  await ctx.db.execute("insert into billing__plans (id, name, amount, currency, interval, created_at) values (?, ?, ?, ?, ?, ?) on conflict (id) do update set name = excluded.name, amount = excluded.amount, interval = excluded.interval", [planId, p.name, p.amount, currency, p.interval, Date.now()]);
  return { id: planId, name: p.name, amount: p.amount, currency, interval: p.interval };
}

export const plans = (ctx: BillingCtx) => ctx.db.query("select id, name, amount, currency, interval from billing__plans order by amount, id");

/** A Stripe Checkout session in subscription mode; the subscription is `pending` until the webhook. */
export async function checkout(ctx: BillingCtx, customerId: unknown, planId: unknown): Promise<{ url: string; session_id: string }> {
  const customer = id(customerId, "customer_id");
  const plan = await ctx.db.queryOne<{ id: string; name: string; amount: number; currency: string; interval: string }>("select * from billing__plans where id = ?", [id(planId, "plan_id")]);
  if (plan === null) throw new BillingError("no such plan", "NOT_FOUND");
  const key = ctx.secrets.BILLING_STRIPE_KEY;
  if (!key) throw new BillingError("BILLING_STRIPE_KEY is not set", "NOT_CONFIGURED");
  const form = new URLSearchParams({
    mode: "subscription",
    success_url: ctx.config.success_url ?? "/billing/thanks",
    cancel_url: ctx.config.cancel_url ?? "/billing",
    client_reference_id: customer,
    "metadata[customer_id]": customer,
    "subscription_data[metadata][customer_id]": customer,
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": plan.currency.toLowerCase(),
    "line_items[0][price_data][unit_amount]": String(plan.amount),
    "line_items[0][price_data][recurring][interval]": plan.interval,
    "line_items[0][price_data][product_data][name]": plan.name,
  });
  const res = await ctx.fetch("https://api.stripe.com/v1/checkout/sessions", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/x-www-form-urlencoded" }, body: form.toString() });
  if (!res.ok) {
    await res.body?.cancel();
    throw new BillingError(`stripe ${res.status}`, "PSP");
  }
  const s = (await res.json()) as { id: string; url: string };
  await ctx.db.execute(
    "insert into billing__subscriptions (customer_id, plan_id, status, updated_at) values (?, ?, 'pending', ?) on conflict (customer_id) do update set plan_id = excluded.plan_id, updated_at = excluded.updated_at",
    [customer, plan.id, Date.now()],
  );
  return { url: s.url, session_id: s.id };
}

export const subscription = (ctx: BillingCtx, customerId: unknown) =>
  ctx.db.queryOne("select plan_id, status, current_period_end from billing__subscriptions where customer_id = ?", [id(customerId, "customer_id")]);

export async function recordUsage(ctx: BillingCtx, customerId: unknown, metric: unknown, quantity: unknown): Promise<{ id: string }> {
  if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 0) throw new BillingError("quantity: a non-negative integer", "INVALID");
  const usageId = newId("use");
  await ctx.db.execute("insert into billing__usage (id, customer_id, metric, quantity, at) values (?, ?, ?, ?, ?)", [usageId, id(customerId, "customer_id"), id(metric, "metric"), quantity, Date.now()]);
  return { id: usageId };
}

export async function usage(ctx: BillingCtx, customerId: unknown, metric: unknown, since: unknown): Promise<number> {
  const r = await ctx.db.queryOne<{ n: number | null }>("select sum(quantity) as n from billing__usage where customer_id = ? and metric = ? and at >= ?", [id(customerId, "customer_id"), id(metric, "metric"), typeof since === "number" ? since : 0]);
  return r?.n ?? 0;
}

export const invoices = (ctx: BillingCtx, customerId: unknown) =>
  ctx.db.query("select id, amount, currency, status, paid_at, created_at from billing__invoices where customer_id = ? order by created_at desc", [id(customerId, "customer_id")]);

interface StripeEvent {
  type: string;
  data: { object: Record<string, any> };
}

/** One verified Stripe event (the webhook route has checked the signature and the replay). */
export async function applyEvent(ctx: BillingCtx, e: StripeEvent): Promise<string> {
  const o = e.data?.object ?? {};
  const customer = typeof o.metadata?.customer_id === "string" ? o.metadata.customer_id : typeof o.client_reference_id === "string" ? o.client_reference_id : null;
  const t = Date.now();
  switch (e.type) {
    case "checkout.session.completed":
      if (customer === null) return "ignored";
      await ctx.db.execute("update billing__subscriptions set status = 'active', stripe_customer = ?, stripe_subscription = ?, updated_at = ? where customer_id = ?", [o.customer ?? null, o.subscription ?? null, t, customer]);
      await ctx.events.emit("billing.subscription_changed", { customer_id: customer, status: "active" });
      return "active";
    case "invoice.paid": {
      const c = customer ?? (await ctx.db.queryOne<{ customer_id: string }>("select customer_id from billing__subscriptions where stripe_customer = ?", [o.customer]))?.customer_id ?? null;
      if (c === null || typeof o.id !== "string") return "ignored";
      await ctx.db.execute(
        "insert into billing__invoices (id, customer_id, amount, currency, status, paid_at, created_at) values (?, ?, ?, ?, 'paid', ?, ?) on conflict (id) do update set status = 'paid', paid_at = excluded.paid_at",
        [o.id, c, Number(o.amount_paid ?? 0), String(o.currency ?? "aed").toUpperCase(), t, t],
      );
      const end = o.lines?.data?.[0]?.period?.end;
      await ctx.db.execute("update billing__subscriptions set status = 'active', current_period_end = coalesce(?, current_period_end), updated_at = ? where customer_id = ?", [typeof end === "number" ? end * 1000 : null, t, c]);
      await ctx.events.emit("billing.invoice_paid", { invoice_id: o.id, customer_id: c });
      return "paid";
    }
    case "invoice.payment_failed":
    case "customer.subscription.deleted": {
      const status = e.type === "invoice.payment_failed" ? "past_due" : "cancelled";
      const c = customer ?? (await ctx.db.queryOne<{ customer_id: string }>("select customer_id from billing__subscriptions where stripe_customer = ?", [o.customer]))?.customer_id ?? null;
      if (c === null) return "ignored";
      await ctx.db.execute("update billing__subscriptions set status = ?, updated_at = ? where customer_id = ?", [status, t, c]);
      await ctx.events.emit("billing.subscription_changed", { customer_id: c, status });
      return status;
    }
    default:
      return "ignored";
  }
}
