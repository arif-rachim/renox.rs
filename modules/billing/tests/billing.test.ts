// The billing module (#329): plans, a Checkout session's request, the
// subscription from verified Stripe events, invoices, usage.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import * as core from "../lib/core.ts";

function ctx(fetchFn: core.BillingCtx["fetch"]) {
  const db = new Database(":memory:");
  for (const f of ["001_init.sql", "002_checkout_refunds.sql", "003_offline_methods.sql", "004_attempts.sql", "005_disputes.sql"]) db.exec(readFileSync(join(import.meta.dir, "../migrations", f), "utf8"));
  const emitted: [string, unknown][] = [];
  const c: core.BillingCtx = {
    db: {
      async query<T>(sql: string, p: unknown[] = []) { return db.query(sql).all(...(p as never[])) as T[]; },
      async queryOne<T>(sql: string, p: unknown[] = []) { return (db.query(sql).get(...(p as never[])) ?? null) as T | null; },
      async execute(sql: string, p: unknown[] = []) { return { changes: db.query(sql).run(...(p as never[])).changes }; },
    },
    fetch: fetchFn,
    secrets: { BILLING_STRIPE_KEY: "sk_test_x" },
    config: { currency: "AED" },
    events: { emit: async (n, p) => void emitted.push([n, p]) },
  };
  return { c, emitted };
}

test("plans, a Checkout session in subscription mode, then the webhook makes it active and paid", async () => {
  let form = "";
  const { c, emitted } = ctx(async (_u, init) => ((form = String(init?.body)), Response.json({ id: "cs_1", url: "https://checkout.stripe.com/c/cs_1" })));
  await core.createPlan(c, { id: "pro", name: "Pro", amount: 29900, interval: "month" });
  await expect(core.createPlan(c, { id: "Bad Id", name: "x", amount: 1, interval: "month" })).rejects.toMatchObject({ code: "INVALID" });
  expect(await core.plans(c)).toEqual([{ id: "pro", name: "Pro", amount: 29900, currency: "AED", interval: "month" }]);
  const s = await core.checkout(c, "cust_1", "pro");
  expect(s).toEqual({ url: "https://checkout.stripe.com/c/cs_1", session_id: "cs_1" });
  const f = new URLSearchParams(form);
  expect(f.get("mode")).toBe("subscription");
  expect(f.get("line_items[0][price_data][unit_amount]")).toBe("29900");
  expect(f.get("line_items[0][price_data][currency]")).toBe("aed");
  expect(f.get("metadata[customer_id]")).toBe("cust_1");
  expect(await core.subscription(c, "cust_1")).toMatchObject({ plan_id: "pro", status: "pending" });
  expect(await core.applyEvent(c, { type: "checkout.session.completed", data: { object: { client_reference_id: "cust_1", customer: "cus_9", subscription: "sub_9" } } })).toBe("completed");
  expect(await core.applyEvent(c, { type: "invoice.paid", data: { object: { id: "in_1", customer: "cus_9", amount_paid: 29900, currency: "aed", lines: { data: [{ period: { end: 1795910400 } }] } } } })).toBe("paid");
  expect(await core.subscription(c, "cust_1")).toMatchObject({ status: "active", current_period_end: 1795910400000 });
  expect(await core.invoices(c, "cust_1")).toMatchObject([{ id: "in_1", amount: 29900, currency: "AED", status: "paid" }]);
  expect(emitted.map(([n]) => n)).toEqual(["billing.subscription_changed", "billing.checkout_completed", "billing.invoice_paid", "billing.payment_received"]);
  expect(await core.applyEvent(c, { type: "customer.subscription.deleted", data: { object: { customer: "cus_9" } } })).toBe("cancelled");
});

test("usage records sum per metric; a PSP error is a BillingError", async () => {
  const { c } = ctx(async () => new Response("{}", { status: 500 }));
  await core.recordUsage(c, "cust_1", "api_calls", 3);
  await core.recordUsage(c, "cust_1", "api_calls", 4);
  expect(await core.usage(c, "cust_1", "api_calls", 0)).toBe(7);
  await expect(core.recordUsage(c, "cust_1", "api_calls", -1)).rejects.toMatchObject({ code: "INVALID" });
  await core.createPlan(c, { id: "pro", name: "Pro", amount: 1, interval: "year" });
  await expect(core.checkout(c, "cust_1", "pro")).rejects.toMatchObject({ code: "PSP" });
});

// #329 F67-B: one checkout per order, the fraud hook point, refunds, every webhook path.
const FIX = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/stripe-events.json"), "utf8")) as Record<string, unknown>;

function recording() {
  const calls: { url: string; body: string; idempotency: string | null }[] = [];
  let n = 0;
  const fetchFn: core.BillingCtx["fetch"] = async (url, init) => {
    calls.push({ url: String(url), body: String(init?.body ?? ""), idempotency: new Headers(init?.headers).get("idempotency-key") });
    n++;
    if (String(url).endsWith("/refunds")) return Response.json({ id: `re_${n}` });
    return Response.json({ id: `cs_${n}`, url: `https://checkout.stripe.com/c/cs_${n}` });
  };
  return { calls, fetchFn };
}

test("one checkout per order: the same order answers the same open session; another amount or a paid order is refused", async () => {
  const { calls, fetchFn } = recording();
  const { c } = ctx(fetchFn);
  const order = { order_id: "order-1001", customer_id: "cust_2", amount: 12500, description: "Order 1001" };
  const first = await core.createCheckout(c, order);
  expect(first).toMatchObject({ session_id: "cs_1", reused: false });
  expect(calls[0]?.idempotency).toBe("checkout:order-1001");
  const f = new URLSearchParams(calls[0]?.body);
  expect([f.get("mode"), f.get("metadata[order_id]"), f.get("payment_intent_data[metadata][order_id]")]).toEqual(["payment", "order-1001", "order-1001"]);
  // A double click: no second session.
  expect(await core.createCheckout(c, order)).toMatchObject({ session_id: "cs_1", reused: true });
  expect(calls).toHaveLength(1);
  await expect(core.createCheckout(c, { ...order, amount: 1 })).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(core.createCheckout(c, { ...order, order_id: "x y" })).rejects.toMatchObject({ code: "INVALID" });
  await expect(core.createCheckout(c, { ...order, order_id: "order-1002", amount: 0 })).rejects.toMatchObject({ code: "INVALID" });
  expect(await core.applyEvent(c, FIX.one_off_completed)).toBe("completed");
  await expect(core.createCheckout(c, order)).rejects.toMatchObject({ code: "CONFLICT" });
});

test("billing.fraud_signal: a filler that halts refuses the checkout before the PSP is called (docs/24, card testing)", async () => {
  const { calls, fetchFn } = recording();
  const { c } = ctx(fetchFn);
  const runs: unknown[] = [];
  c.hooks = { run: async (name, args) => (runs.push([name, args]), { halt: true }) };
  await expect(core.createCheckout(c, { order_id: "o-1", customer_id: "cust_3", amount: 100, description: "x" })).rejects.toMatchObject({ code: "REFUSED" });
  expect(runs).toEqual([["billing.fraud_signal", { customer_id: "cust_3", order_id: "o-1", amount: 100, currency: "AED", mode: "payment" }]]);
  expect(calls).toHaveLength(0);
});

test("refunds: never more than paid less refunded; the PSP call is idempotent; billing.refund is required; billing.refunded emitted", async () => {
  const { calls, fetchFn } = recording();
  const { c, emitted } = ctx(fetchFn);
  const required: string[] = [];
  c.authz = { require: async (a) => void required.push(a) };
  await core.createCheckout(c, { order_id: "order-1001", customer_id: "cust_2", amount: 12500, description: "Order 1001" });
  await core.applyEvent(c, FIX.one_off_completed);
  expect(emitted.map(([n]) => n)).toContain("billing.payment_received");
  await expect(core.refund(c, "order:order-1001", 12501)).rejects.toMatchObject({ code: "INVALID" });
  expect(await core.refund(c, "order:order-1001", 5000)).toMatchObject({ refunded: 5000 });
  const r = calls.find((x) => x.url.endsWith("/refunds"));
  expect(new URLSearchParams(r?.body).get("payment_intent")).toBe("pi_2");
  expect(r?.idempotency).toMatch(/^rfd_/u);
  await expect(core.refund(c, "order:order-1001", 7501)).rejects.toMatchObject({ code: "INVALID" });
  expect(await core.refund(c, "order:order-1001", 7500)).toMatchObject({ refunded: 12500 });
  await expect(core.refund(c, "nope", 1)).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(required.every((a) => a === "billing.refund")).toBe(true);
  expect(emitted.filter(([n]) => n === "billing.refunded").map(([, p]) => p)).toEqual([
    { invoice_id: "order:order-1001", customer_id: "cust_2", amount: 5000 },
    { invoice_id: "order:order-1001", customer_id: "cust_2", amount: 7500 },
  ]);
  // A refused authorisation stops it before the PSP.
  c.authz = { require: async () => Promise.reject(new Error("forbidden")) };
  await expect(core.refund(c, "order:order-1001", 1)).rejects.toThrow("forbidden");
});

test("webhook paths (docs/23 payment failure paths): an issued invoice, a failed payment to past_due, an unknown event ignored; each recorded once", async () => {
  const { fetchFn } = recording();
  const { c, emitted } = ctx(fetchFn);
  await core.createPlan(c, { id: "pro", name: "Pro", amount: 29900, interval: "month" });
  await core.checkout(c, "cust_1", "pro");
  await core.applyEvent(c, { id: "evt_0", type: "checkout.session.completed", data: { object: { client_reference_id: "cust_1", customer: "cus_9", subscription: "sub_9", metadata: { customer_id: "cust_1", order_id: "sub:cust_1:pro" } } } });
  expect(await core.applyEvent(c, FIX.invoice_finalized)).toBe("issued");
  expect(await core.invoices(c, "cust_1")).toMatchObject([{ id: "in_2", status: "open", amount: 29900 }]);
  expect(await core.applyEvent(c, FIX.invoice_payment_failed)).toBe("past_due");
  expect(await core.subscription(c, "cust_1")).toMatchObject({ status: "past_due" });
  expect(emitted.map(([n]) => n)).toEqual(["billing.subscription_changed", "billing.checkout_completed", "billing.invoice_issued", "billing.payment_failed", "billing.subscription_changed"]);
  expect(await core.applyEvent(c, FIX.unknown)).toBe("ignored");
  const rows = await c.db.query<{ event_id: string; type: string; result: string }>("select event_id, type, result from billing__webhook_events order by event_id");
  expect(rows).toEqual([
    { event_id: "evt_0", type: "checkout_completed", result: "completed" },
    { event_id: "evt_2", type: "invoice_issued", result: "issued" },
    { event_id: "evt_3", type: "payment_failed", result: "past_due" },
    { event_id: "evt_4", type: "ignored", result: "ignored" },
  ]);
  // The public view other modules read a user's plan through.
  expect(await c.db.query("select user_id, plan_id, status from billing__public_user_plans_v1")).toEqual([{ user_id: "cust_1", plan_id: "pro", status: "past_due" }]);
});

test("a dispute recorded from a Stripe sandbox (#351): found through its payment intent, kept on the order, billing.disputed emitted; an unknown payment intent is ignored", async () => {
  const dispute = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/stripe-dispute.json"), "utf8")) as { data: { object: { payment_intent: string; amount: number; reason: string; metadata: object } } };
  // Stripe puts none of our metadata on the dispute: the payment intent is the only link.
  expect(dispute.data.object.metadata).toEqual({});
  const { c, emitted } = ctx(recording().fetchFn);
  const paid = structuredClone(FIX.one_off_completed) as { data: { object: { payment_intent: string } } };
  paid.data.object.payment_intent = dispute.data.object.payment_intent;
  expect(await core.applyEvent(c, paid)).toBe("completed");
  expect(await core.applyEvent(c, dispute)).toBe("disputed");
  expect(emitted.filter(([n]) => n === "billing.disputed").map(([, p]) => p)).toEqual([{ invoice_id: "order:order-1001", customer_id: "cust_2", amount: dispute.data.object.amount, reason: "fraudulent" }]);
  const row = await c.db.queryOne<{ disputed_at: number | null; dispute_reason: string }>("select disputed_at, dispute_reason from billing__invoices where id = ?", ["order:order-1001"]);
  expect(row?.disputed_at).toBeGreaterThan(0);
  expect(row?.dispute_reason).toBe("fraudulent");
  const other = structuredClone(dispute);
  other.data.object.payment_intent = "pi_not_ours";
  expect(await core.applyEvent(c, { ...other, id: "evt_other" })).toBe("ignored");
});
