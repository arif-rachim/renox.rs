// The billing module (#329): plans and subscriptions of the app's own
// customers, Stripe Checkout sessions, and the state from Stripe's
// verified webhooks (ops.md 1.7.0 section 22: `ctx.webhook.verify` with
// provider stripe, duplicates answered before the handler).

import { PspError, stripe, type PspAdapter, type PspEvent } from "./adapter.ts";
import { COD_MOVES, transferReference, type StatementRow } from "../src/adapters/offline.ts";

export interface Db {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  queryOne<T>(sql: string, params?: unknown[]): Promise<T | null>;
  execute(sql: string, params?: unknown[]): Promise<{ changes: number }>;
}

export interface BillingCtx {
  db: Db;
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  secrets: Record<string, string | undefined>;
  config: { currency?: string; success_url?: string; cancel_url?: string; base_path?: string; methods?: string; bank_name?: string; bank_beneficiary?: string; bank_iban?: string };
  events: { emit(name: string, payload: unknown): Promise<void> };
  /** `billing.fraud_signal` (this module's hook point). */
  hooks?: { run(name: string, args?: unknown): Promise<{ halt: boolean }> };
  authz?: { require(action: string, resource?: unknown): Promise<void> };
  /** Tests: a PSP stand-in. */
  psp?: PspAdapter;
}

export class BillingError extends Error {
  constructor(
    message: string,
    readonly code: "INVALID" | "NOT_FOUND" | "NOT_CONFIGURED" | "PSP" | "CONFLICT" | "REFUSED",
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

/** The PSP adapter for this ctx (Stripe UAE; #330 adds the others). Tests replace it with `ctx.psp`. */
function pspOf(ctx: BillingCtx): PspAdapter {
  if (ctx.psp !== undefined) return ctx.psp;
  const key = ctx.secrets.BILLING_STRIPE_KEY;
  if (!key) throw new BillingError("BILLING_STRIPE_KEY is not set", "NOT_CONFIGURED");
  return stripe(ctx.fetch, key);
}

const ORDER = /^[A-Za-z0-9][A-Za-z0-9_:.-]{0,99}$/u;

export interface CheckoutOptions {
  order_id?: unknown;
  customer_id?: unknown;
  /** A plan: a subscription. */
  plan_id?: unknown;
  /** Without a plan: a one-off payment of `amount` (minor units) for `description`. */
  amount?: unknown;
  description?: unknown;
  /** `card` (the PSP, the default), `cod` (cash on delivery) or `bank` (a transfer with a reference); one-off payments only for the last two. */
  method?: unknown;
}

const METHODS = ["card", "cod", "bank"] as const;
type Method = (typeof METHODS)[number];

/** The methods the app enabled (`config.methods`, comma-separated; card when unset). */
export function enabledMethods(ctx: BillingCtx): Method[] {
  const raw = (ctx.config.methods ?? "card").split(",").map((m) => m.trim());
  return METHODS.filter((m) => raw.includes(m));
}

/**
 * One checkout per order (#329): the same order again answers the same open
 * session (the duplicate-session case: a double click, a retried request);
 * a completed one is a conflict. `billing.fraud_signal` runs first: a filler
 * that halts refuses the checkout (card testing, docs/24).
 */
export async function createCheckout(ctx: BillingCtx, o: CheckoutOptions): Promise<{ url: string; session_id: string; reused: boolean }> {
  const customer = id(o.customer_id, "customer_id");
  if (typeof o.order_id !== "string" || !ORDER.test(o.order_id)) throw new BillingError("order_id: letters, digits, _ : . - (at most 100)", "INVALID");
  const orderId = o.order_id;
  const currency = (ctx.config.currency ?? "AED").toUpperCase();
  let mode: "payment" | "subscription";
  let amount: number;
  let description: string;
  let interval: "month" | "year" | undefined;
  let planId: string | null = null;
  if (o.plan_id !== undefined) {
    const plan = await ctx.db.queryOne<{ id: string; name: string; amount: number; interval: "month" | "year" }>("select * from billing__plans where id = ?", [id(o.plan_id, "plan_id")]);
    if (plan === null) throw new BillingError("no such plan", "NOT_FOUND");
    [mode, amount, description, interval, planId] = ["subscription", plan.amount, plan.name, plan.interval, plan.id];
  } else {
    if (typeof o.amount !== "number" || !Number.isInteger(o.amount) || o.amount <= 0) throw new BillingError("amount: a positive integer in minor units", "INVALID");
    if (typeof o.description !== "string" || o.description.length === 0 || o.description.length > 200) throw new BillingError("a description", "INVALID");
    [mode, amount, description] = ["payment", o.amount, o.description];
  }
  const method: Method = o.method === undefined ? "card" : (METHODS.find((m) => m === o.method) ?? ("" as Method));
  if (!enabledMethods(ctx).includes(method)) throw new BillingError(`method: one of ${enabledMethods(ctx).join(", ")}`, "INVALID");
  if (method !== "card" && mode !== "payment") throw new BillingError("cash on delivery and bank transfer are for one-off payments", "INVALID");
  const existing = await ctx.db.queryOne<{ session_id: string; url: string; status: string; amount: number; customer_id: string }>("select session_id, url, status, amount, customer_id from billing__checkouts where order_id = ?", [orderId]);
  if (existing !== null) {
    if (existing.customer_id !== customer || existing.amount !== amount) throw new BillingError("this order already has a checkout for another amount or customer", "CONFLICT");
    if (existing.status === "completed") throw new BillingError("this order is already paid", "CONFLICT");
    if (existing.status === "open") return { url: existing.url, session_id: existing.session_id, reused: true };
  }
  const signal = await ctx.hooks?.run("billing.fraud_signal", { customer_id: customer, order_id: orderId, amount, currency, mode });
  if (signal?.halt === true) throw new BillingError("the checkout was refused", "REFUSED");
  if (method !== "card") return offlineCheckout(ctx, { orderId, customer, amount, currency, method });
  let s: { id: string; url: string };
  try {
    s = await pspOf(ctx).createSession({ order_id: orderId, customer_id: customer, mode, amount, currency, description, interval, success_url: ctx.config.success_url ?? "/billing/thanks", cancel_url: ctx.config.cancel_url ?? "/billing" });
  } catch (e) {
    if (e instanceof PspError) throw new BillingError(e.message, "PSP");
    throw e;
  }
  const t = Date.now();
  await ctx.db.execute(
    "insert into billing__checkouts (order_id, customer_id, mode, plan_id, amount, currency, session_id, url, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?) on conflict (order_id) do update set session_id = excluded.session_id, url = excluded.url, status = 'open', updated_at = excluded.updated_at",
    [orderId, customer, mode, planId, amount, currency, s.id, s.url, t, t],
  );
  if (planId !== null) {
    await ctx.db.execute(
      "insert into billing__subscriptions (customer_id, plan_id, status, updated_at) values (?, ?, 'pending', ?) on conflict (customer_id) do update set plan_id = excluded.plan_id, updated_at = excluded.updated_at",
      [customer, planId, t],
    );
  }
  return { url: s.url, session_id: s.id, reused: false };
}

/** Cash on delivery or a bank transfer (#330): the app's own pending page, no PSP. */
async function offlineCheckout(ctx: BillingCtx, o: { orderId: string; customer: string; amount: number; currency: string; method: "cod" | "bank" }): Promise<{ url: string; session_id: string; reused: boolean }> {
  const t = Date.now();
  const reference = o.method === "bank" ? transferReference() : null;
  const sessionId = reference ?? `cod_${o.orderId}`;
  const url = `${(ctx.config.base_path ?? "/billing").replace(/\/+$/u, "")}/checkout/pending?order=${encodeURIComponent(o.orderId)}`;
  await ctx.db.execute(
    "insert into billing__checkouts (order_id, customer_id, mode, plan_id, amount, currency, session_id, url, status, created_at, updated_at, method, reference) values (?, ?, 'payment', null, ?, ?, ?, ?, 'open', ?, ?, ?, ?)",
    [o.orderId, o.customer, o.amount, o.currency, sessionId, url, t, t, o.method, reference],
  );
  if (o.method === "cod") await ctx.db.execute("insert into billing__cod_orders (order_id, state, updated_at) values (?, 'placed', ?)", [o.orderId, t]);
  return { url, session_id: sessionId, reused: false };
}

/** Paid outside a PSP: the checkout completed, its paid invoice, the events. */
async function settleOffline(ctx: BillingCtx, orderId: string, customer: string, amount: number, currency: string): Promise<void> {
  const t = Date.now();
  await ctx.db.execute("update billing__checkouts set status = 'completed', updated_at = ? where order_id = ?", [t, orderId]);
  await ctx.db.execute("insert into billing__invoices (id, customer_id, amount, currency, status, paid_at, created_at) values (?, ?, ?, ?, 'paid', ?, ?) on conflict (id) do nothing", [`order:${orderId}`, customer, amount, currency, t, t]);
  await ctx.events.emit("billing.payment_received", { customer_id: customer, invoice_id: `order:${orderId}`, amount });
  await ctx.events.emit("billing.checkout_completed", { customer_id: customer, order_id: orderId });
}

/** Moves a cash-on-delivery order (billing.manage): delivered is paid, refused ends it unpaid. */
export async function codUpdate(ctx: BillingCtx, orderId: unknown, state: unknown): Promise<{ state: string }> {
  await ctx.authz?.require("billing.manage");
  if (typeof orderId !== "string" || !ORDER.test(orderId)) throw new BillingError("an order id", "INVALID");
  const row = await ctx.db.queryOne<{ state: string; customer_id: string; amount: number; currency: string }>(
    "select c.state, k.customer_id, k.amount, k.currency from billing__cod_orders c join billing__checkouts k on k.order_id = c.order_id where c.order_id = ?",
    [orderId],
  );
  if (row === null) throw new BillingError("no such cash-on-delivery order", "NOT_FOUND");
  if (typeof state !== "string" || !(COD_MOVES[row.state] ?? []).includes(state)) throw new BillingError(`from ${row.state}: ${(COD_MOVES[row.state] ?? []).join(" or ") || "no move"}`, "CONFLICT");
  await ctx.db.execute("update billing__cod_orders set state = ?, updated_at = ? where order_id = ?", [state, Date.now(), orderId]);
  if (state === "delivered") await settleOffline(ctx, orderId, row.customer_id, row.amount, row.currency);
  if (state === "refused") {
    await ctx.db.execute("update billing__checkouts set status = 'expired', updated_at = ? where order_id = ?", [Date.now(), orderId]);
    await ctx.events.emit("billing.payment_failed", { customer_id: row.customer_id, order_id: orderId });
  }
  return { state };
}

/**
 * One row of the bank statement (billing.manage): it pays the open bank
 * transfer whose reference is in its description, when the amount is the
 * same. Anything else is kept unmatched for a person to look at; nothing is
 * guessed from a near amount or a name.
 */
export async function matchTransfer(ctx: BillingCtx, row: StatementRow): Promise<{ order_id: string | null; reason: "matched" | "no_reference" | "amount_differs" | "already_paid" }> {
  await ctx.authz?.require("billing.manage");
  const ref = /RNX-[0-9A-HJKMNP-TV-Z]{8}/iu.exec(row.description)?.[0]?.toUpperCase() ?? null;
  const record = (orderId: string | null) =>
    ctx.db.execute("insert into billing__transfers (id, booked_on, amount, description, order_id, imported_at) values (?, ?, ?, ?, ?, ?)", [newId("trf"), row.booked_on.slice(0, 40), row.amount, row.description, orderId, Date.now()]);
  const k = ref === null ? null : await ctx.db.queryOne<{ order_id: string; customer_id: string; amount: number; currency: string; status: string }>("select order_id, customer_id, amount, currency, status from billing__checkouts where reference = ? and method = 'bank'", [ref]);
  if (k === null) {
    await record(null);
    return { order_id: null, reason: "no_reference" };
  }
  if (k.status === "completed") {
    await record(null);
    return { order_id: k.order_id, reason: "already_paid" };
  }
  if (k.amount !== row.amount) {
    await record(null);
    return { order_id: k.order_id, reason: "amount_differs" };
  }
  await record(k.order_id);
  await settleOffline(ctx, k.order_id, k.customer_id, k.amount, k.currency);
  return { order_id: k.order_id, reason: "matched" };
}

/** A subscription checkout (the F67-ALL service): the order is the customer and the plan. */
export async function checkout(ctx: BillingCtx, customerId: unknown, planId: unknown): Promise<{ url: string; session_id: string }> {
  const r = await createCheckout(ctx, { order_id: `sub:${String(customerId)}:${String(planId)}`, customer_id: customerId, plan_id: planId });
  return { url: r.url, session_id: r.session_id };
}

/** Refund part or all of a paid invoice; never more than was paid less what was refunded. Needs billing.refund (sensitive). */
export async function refund(ctx: BillingCtx, invoiceId: unknown, amount: unknown): Promise<{ id: string; refunded: number }> {
  await ctx.authz?.require("billing.refund");
  if (typeof invoiceId !== "string" || invoiceId.length === 0 || invoiceId.length > 200) throw new BillingError("an invoice id", "INVALID");
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount <= 0) throw new BillingError("amount: a positive integer in minor units", "INVALID");
  const inv = await ctx.db.queryOne<{ id: string; customer_id: string; amount: number; status: string; refunded: number; payment_intent: string | null }>("select id, customer_id, amount, status, refunded, payment_intent from billing__invoices where id = ?", [invoiceId]);
  if (inv === null) throw new BillingError("no such invoice", "NOT_FOUND");
  if (inv.status !== "paid") throw new BillingError("only a paid invoice can be refunded", "CONFLICT");
  if (amount > inv.amount - inv.refunded) throw new BillingError(`at most ${inv.amount - inv.refunded} can be refunded`, "INVALID");
  if (inv.payment_intent === null) throw new BillingError("the PSP did not report this invoice's payment", "CONFLICT");
  const refundId = newId("rfd");
  let r: { id: string };
  try {
    r = await pspOf(ctx).refund(inv.payment_intent, amount, refundId);
  } catch (e) {
    if (e instanceof PspError) throw new BillingError(e.message, "PSP");
    throw e;
  }
  await ctx.db.execute("insert into billing__refunds (id, invoice_id, amount, psp_refund, at) values (?, ?, ?, ?, ?)", [refundId, inv.id, amount, r.id, Date.now()]);
  await ctx.db.execute("update billing__invoices set refunded = refunded + ? where id = ?", [amount, inv.id]);
  await ctx.events.emit("billing.refunded", { invoice_id: inv.id, customer_id: inv.customer_id, amount });
  return { id: refundId, refunded: inv.refunded + amount };
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

/** The customer of a provider event: its metadata, or the subscription that holds the provider's customer id. */
async function customerOf(ctx: BillingCtx, e: PspEvent): Promise<string | null> {
  if (typeof e.customer_id === "string") return e.customer_id;
  if (typeof e.psp_customer !== "string") return null;
  return (await ctx.db.queryOne<{ customer_id: string }>("select customer_id from billing__subscriptions where stripe_customer = ?", [e.psp_customer]))?.customer_id ?? null;
}

/** One verified provider event (the webhook route has checked the signature and the replay). */
export async function applyEvent(ctx: BillingCtx, payload: unknown): Promise<string> {
  // Reading a verified event needs no API key (only calls to the PSP do).
  const e = (ctx.psp ?? stripe(ctx.fetch, ctx.secrets.BILLING_STRIPE_KEY ?? "")).parseWebhook(payload);
  const result = await apply(ctx, e);
  if (e.id !== "") await ctx.db.execute("insert into billing__webhook_events (event_id, type, result, at) values (?, ?, ?, ?) on conflict (event_id) do nothing", [e.id, e.kind, result, Date.now()]);
  return result;
}

async function apply(ctx: BillingCtx, e: PspEvent): Promise<string> {
  const t = Date.now();
  const customer = await customerOf(ctx, e);
  switch (e.kind) {
    case "checkout_completed": {
      if (customer === null) return "ignored";
      if (typeof e.order_id === "string") await ctx.db.execute("update billing__checkouts set status = 'completed', updated_at = ? where order_id = ?", [t, e.order_id]);
      if (typeof e.psp_subscription === "string") {
        await ctx.db.execute("update billing__subscriptions set status = 'active', stripe_customer = ?, stripe_subscription = ?, updated_at = ? where customer_id = ?", [e.psp_customer ?? null, e.psp_subscription, t, customer]);
        await ctx.events.emit("billing.subscription_changed", { customer_id: customer, status: "active" });
      } else if (typeof e.payment_intent === "string" && typeof e.order_id === "string") {
        // A one-off payment is its own paid invoice, refundable through its payment intent.
        await ctx.db.execute(
          "insert into billing__invoices (id, customer_id, amount, currency, status, paid_at, created_at, payment_intent) values (?, ?, ?, ?, 'paid', ?, ?, ?) on conflict (id) do nothing",
          [`order:${e.order_id}`, customer, e.amount ?? 0, e.currency ?? "AED", t, t, e.payment_intent],
        );
        await ctx.events.emit("billing.payment_received", { customer_id: customer, invoice_id: `order:${e.order_id}`, amount: e.amount ?? 0 });
      }
      await ctx.events.emit("billing.checkout_completed", { customer_id: customer, order_id: e.order_id ?? "" });
      return "completed";
    }
    case "invoice_issued":
      if (customer === null || typeof e.invoice_id !== "string") return "ignored";
      await ctx.db.execute("insert into billing__invoices (id, customer_id, amount, currency, status, created_at) values (?, ?, ?, ?, 'open', ?) on conflict (id) do nothing", [e.invoice_id, customer, e.amount ?? 0, e.currency ?? "AED", t]);
      await ctx.events.emit("billing.invoice_issued", { invoice_id: e.invoice_id, customer_id: customer, amount: e.amount ?? 0 });
      return "issued";
    case "payment_received": {
      if (customer === null || typeof e.invoice_id !== "string") return "ignored";
      await ctx.db.execute(
        "insert into billing__invoices (id, customer_id, amount, currency, status, paid_at, created_at, payment_intent) values (?, ?, ?, ?, 'paid', ?, ?, ?) on conflict (id) do update set status = 'paid', paid_at = excluded.paid_at, amount = excluded.amount, payment_intent = coalesce(excluded.payment_intent, billing__invoices.payment_intent)",
        [e.invoice_id, customer, e.amount ?? 0, e.currency ?? "AED", t, t, e.payment_intent ?? null],
      );
      await ctx.db.execute("update billing__subscriptions set status = 'active', current_period_end = coalesce(?, current_period_end), updated_at = ? where customer_id = ?", [e.period_end ?? null, t, customer]);
      await ctx.events.emit("billing.invoice_paid", { invoice_id: e.invoice_id, customer_id: customer });
      await ctx.events.emit("billing.payment_received", { customer_id: customer, invoice_id: e.invoice_id, amount: e.amount ?? 0 });
      return "paid";
    }
    case "payment_failed":
      if (customer === null) return "ignored";
      await ctx.db.execute("update billing__subscriptions set status = 'past_due', updated_at = ? where customer_id = ? and status = 'active'", [t, customer]);
      await ctx.events.emit("billing.payment_failed", { customer_id: customer, ...(e.invoice_id === undefined ? {} : { invoice_id: e.invoice_id }), ...(e.order_id === undefined ? {} : { order_id: e.order_id }) });
      await ctx.events.emit("billing.subscription_changed", { customer_id: customer, status: "past_due" });
      return "past_due";
    case "subscription_cancelled":
      if (customer === null) return "ignored";
      await ctx.db.execute("update billing__subscriptions set status = 'cancelled', updated_at = ? where customer_id = ?", [t, customer]);
      await ctx.events.emit("billing.subscription_changed", { customer_id: customer, status: "cancelled" });
      return "cancelled";
    default:
      return "ignored";
  }
}
