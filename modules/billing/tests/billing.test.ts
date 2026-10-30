// The billing module (#329): plans, a Checkout session's request, the
// subscription from verified Stripe events, invoices, usage.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import * as core from "../lib/core.ts";

function ctx(fetchFn: core.BillingCtx["fetch"]) {
  const db = new Database(":memory:");
  db.exec(readFileSync(join(import.meta.dir, "../migrations/001_init.sql"), "utf8"));
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
  expect(await core.applyEvent(c, { type: "checkout.session.completed", data: { object: { client_reference_id: "cust_1", customer: "cus_9", subscription: "sub_9" } } })).toBe("active");
  expect(await core.applyEvent(c, { type: "invoice.paid", data: { object: { id: "in_1", customer: "cus_9", amount_paid: 29900, currency: "aed", lines: { data: [{ period: { end: 1795910400 } }] } } } })).toBe("paid");
  expect(await core.subscription(c, "cust_1")).toMatchObject({ status: "active", current_period_end: 1795910400000 });
  expect(await core.invoices(c, "cust_1")).toMatchObject([{ id: "in_1", amount: 29900, currency: "AED", status: "paid" }]);
  expect(emitted.map(([n]) => n)).toEqual(["billing.subscription_changed", "billing.invoice_paid"]);
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
