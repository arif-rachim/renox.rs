// The billing module installed in an app, on the real worker (#329):
// Stripe's webhook through webhook.verify (a bad signature is 401 before the
// handler; a replay answers duplicate), the customer's page, and the
// invoices page per role: no role is refused, finance reads without the
// refund form, admin gets it (r-can). docs/23 "Webhooks", docs/24 E.
import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { join } from "node:path";

import { app, type TestApp } from "../../../sdk/src/test.ts";

const MODULE = join(import.meta.dir, "..");
const worker = process.env.RENOX_TEST_SPEC ?? process.env.RENOX_WORKER_PATH;
const t = worker ? await app({ project: MODULE }) : (undefined as unknown as TestApp);
const PASSWORD = "correct horse battery";
const SECRET = "whsec_billing_test_0123456789abcdef";

async function user(name: string, role?: string): Promise<TestApp> {
  const u = t.as(name);
  expect((await u.action("/auth/register", "default", { email: `${name}@example.com`, password: PASSWORD, display_name: name })).status).toBe(200);
  expect((await u.action("/auth/login", "default", { email: `${name}@example.com`, password: PASSWORD })).status).toBe(303);
  if (role) expect((await u.request("POST", `/api/grant?role=${role}`)).status).toBe(200);
  return u;
}

const idOf = (name: string): string => t.db.query<{ id: string }>("select id from auth__users where email = ?", [`${name}@example.com`])[0]?.id as string;

function hook(event: unknown, secret = SECRET) {
  const body = JSON.stringify(event);
  const ts = Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
  return t.request("POST", "/billing/webhooks/stripe", { body, headers: { "content-type": "application/json", "stripe-signature": `t=${ts},v1=${sig}` } });
}

describe.skipIf(!worker)("billing in an app", () => {
  test("the webhook: a bad signature is 401, a verified event is applied once, a replay is a duplicate", async () => {
    await user("nour");
    const paid = { id: "evt_paid_1", type: "checkout.session.completed", data: { object: { id: "cs_1", mode: "payment", amount_total: 12500, currency: "aed", payment_intent: "pi_1", client_reference_id: idOf("nour"), metadata: { customer_id: idOf("nour"), order_id: "order-1" } } } };
    expect((await hook(paid, "whsec_wrong")).status).toBe(401);
    const ok = await hook(paid);
    expect(ok.status, ok.html).toBe(200);
    expect(ok.json<{ result: string }>().result).toBe("completed");
    const again = await hook(paid);
    expect(again.status).toBe(200);
    expect(again.json<{ duplicate?: boolean }>().duplicate).toBe(true);
    expect(t.db.query("select id, status, amount from billing__invoices")).toEqual([{ id: "order:order-1", status: "paid", amount: 12500 }]);
  });

  test("the customer's page lists the plans and their own invoices", async () => {
    expect((await t.as("anon").page("/billing")).status).toBe(303);
    const nour = t.as("nour");
    expect((await nour.request("POST", "/api/plan")).status).toBe(200);
    const r = await nour.page("/billing");
    expect(r.status).toBe(200);
    expect(r.html).toContain("AED 299.00");
    expect(r.html).toContain("order:order-1");
    const other = await user("rami");
    expect((await other.page("/billing")).html).not.toContain("order:order-1");
  });

  test("the invoices page per role: none refused, finance reads without the refund form, admin gets it", async () => {
    expect((await t.as("rami").page("/billing/invoices")).status).toBe(403);
    const fin = await user("farah", "finance");
    const f = await fin.page("/billing/invoices");
    expect(f.status).toBe(200);
    expect(f.html).toContain("order:order-1");
    expect(f.html).not.toContain('name="amount"');
    const admin = await user("adel", "admin");
    const a = await admin.page("/billing/invoices");
    expect(a.status).toBe(200);
    expect(a.html).toContain('name="amount"');
  });
});
