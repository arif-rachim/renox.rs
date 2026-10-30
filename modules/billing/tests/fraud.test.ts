// Card testing (#123; docs/24-threat-model.md "Card testing through tenant
// checkouts"): 200 payment attempts from one IP in a minute are limited
// after the bucket and never reach the PSP; 3-D Secure is requested on the
// first attempt; a customer is blocked for the day after repeated declines.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import * as core from "../lib/core.ts";
import { LIMITS } from "../src/fraud/limits.ts";

function ctx() {
  const db = new Database(":memory:");
  for (const f of ["001_init.sql", "002_checkout_refunds.sql", "003_offline_methods.sql", "004_attempts.sql"]) db.exec(readFileSync(join(import.meta.dir, "../migrations", f), "utf8"));
  const sent: string[] = [];
  const c: core.BillingCtx = {
    db: {
      async query<T>(sql: string, p: unknown[] = []) { return db.query(sql).all(...(p as never[])) as T[]; },
      async queryOne<T>(sql: string, p: unknown[] = []) { return (db.query(sql).get(...(p as never[])) ?? null) as T | null; },
      async execute(sql: string, p: unknown[] = []) { return { changes: db.query(sql).run(...(p as never[])).changes }; },
    },
    fetch: async (_u, init) => {
      sent.push(String(init?.body ?? ""));
      return Response.json({ id: `cs_${sent.length}`, url: "https://checkout.stripe.com/c/x" });
    },
    secrets: { BILLING_STRIPE_KEY: "sk_test_x" },
    config: { currency: "AED" },
    events: { emit: async () => {} },
  };
  return { c, sent };
}

test("200 attempts from one IP in a minute: limited after the bucket, the rest never reach the PSP; 3DS requested on the first", async () => {
  const { c, sent } = ctx();
  let refused = 0;
  for (let i = 0; i < 200; i++) {
    try {
      await core.createCheckout(c, { order_id: `o-${i}`, customer_id: `card-tester-${i}`, amount: 100, description: "x", client_ip: "198.51.100.9" });
    } catch (e) {
      expect(e).toMatchObject({ code: "REFUSED" });
      refused++;
    }
  }
  expect(sent).toHaveLength(LIMITS.ip.max);
  expect(refused).toBe(200 - LIMITS.ip.max);
  expect(new URLSearchParams(sent[0]).get("payment_method_options[card][request_three_d_secure]")).toBe("any");
  // Another IP is not affected.
  await core.createCheckout(c, { order_id: "o-other", customer_id: "honest", amount: 100, description: "x", client_ip: "203.0.113.4" });
  expect(sent).toHaveLength(LIMITS.ip.max + 1);
});

test("one customer, many orders: the customer bucket; after repeated declines the customer is blocked for the day", async () => {
  const { c, sent } = ctx();
  for (let i = 0; i < LIMITS.customer.max; i++) await core.createCheckout(c, { order_id: `c-${i}`, customer_id: "same", amount: 100, description: "x" });
  await expect(core.createCheckout(c, { order_id: "c-x", customer_id: "same", amount: 100, description: "x" })).rejects.toMatchObject({ code: "REFUSED" });
  expect(sent).toHaveLength(LIMITS.customer.max);
  for (let i = 0; i < LIMITS.declines.max; i++) await core.applyEvent(c, { id: `evt_d${i}`, type: "payment_intent.payment_failed", data: { object: { metadata: { customer_id: "decliner", order_id: `d-${i}` } } } });
  await expect(core.createCheckout(c, { order_id: "d-next", customer_id: "decliner", amount: 100, description: "x" })).rejects.toThrow("declines");
});
