// Collecting platform invoices (#350; deploy-api.md 0.5.1 section 20): a
// Stripe Customer per tenant holds the saved card, the monthly close charges
// the invoice off-session, a decline is retried 1, 3 and 7 days after the
// invoice date with an email each time, an invoice unpaid 14 days suspends,
// a new card pays and reinstates, and the PaymentIntent webhooks (payloads
// recorded from a Stripe sandbox) settle an invoice once.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";

import { RETRY_DAYS } from "../src/billing/collect.ts";
import { MONTH, setPsp, stripePsp, type ChargeRequest, type ChargeResult } from "../src/billing/routes.ts";
import { sweepBilling } from "../src/billing/sweep.ts";
import { assertScoped, harness, signup, type Harness, type Session } from "./helpers.ts";
import succeeded from "./fixtures/stripe/payment_intent.succeeded.json";
import failed from "./fixtures/stripe/payment_intent.payment_failed.json";

afterEach(assertScoped);

const SECRET = "whsec_test_collect";
const DAY = 86_400_000;
const T = "t_collect";
const OWNER = "owner@collect.ae";

/** What the stand-in PSP was asked, and how it answers a charge. */
const psp = {
  customers: [] as { tenantId: string; email: string | null; name: string | null }[],
  setups: [] as string[],
  defaults: [] as [string, string, string | null][],
  charges: [] as ChargeRequest[],
  answer: (c: ChargeRequest): ChargeResult => ({ status: "succeeded", payment_intent: `pi_${c.invoiceId}_${c.attempt}` }),
  setup: 0,
};

beforeAll(() =>
  setPsp({
    async ensureCustomer(tenantId, info) {
      psp.customers.push({ tenantId, ...info });
      return `cus_${tenantId}`;
    },
    async createSetup(_tenantId, customer) {
      psp.setups.push(customer);
      const id = `seti_collect_${++psp.setup}`;
      return { setup_id: id, client_secret: `${id}_secret_x`, publishable_key: "pk_test_x" };
    },
    async confirmSetup(id) {
      return { id: id.replace("seti_", "pm_"), brand: "visa", last4: "4242", exp_month: 12, exp_year: 2030 };
    },
    async setDefault(customer, pm, previous) {
      psp.defaults.push([customer, pm, previous]);
    },
    async charge(c) {
      psp.charges.push(c);
      return psp.answer(c);
    },
    async paymentIntentTenant() {
      return null;
    },
    webhookSecret: () => SECRET,
  }),
);
afterAll(() => setPsp(stripePsp));

let savedTrn: string | undefined;
beforeEach(() => {
  psp.customers.length = 0;
  psp.setups.length = 0;
  psp.defaults.length = 0;
  psp.charges.length = 0;
  psp.setup = 0;
  psp.answer = (c) => ({ status: "succeeded", payment_intent: `pi_${c.invoiceId}_${c.attempt}` });
  savedTrn = process.env.RENOX_SELLER_TRN;
  process.env.RENOX_SELLER_TRN = "100000000000001";
});
afterEach(() => {
  if (savedTrn === undefined) delete process.env.RENOX_SELLER_TRN;
  else process.env.RENOX_SELLER_TRN = savedTrn;
});

async function addCard(h: Harness, session: Session): Promise<string> {
  const s = (await (await h.request("POST", `/v1/tenants/${T}/billing/payment-methods/setup`, { session, json: { provider: "stripe" } })).json()) as { setup_id: string };
  const pm = await h.request("POST", `/v1/tenants/${T}/billing/payment-methods`, { session, json: { setup_id: s.setup_id } });
  expect(pm.status).toBe(201);
  return ((await pm.json()) as { id: string }).id;
}

/** A Starter tenant with a saved card whose period ended a second ago. */
async function due(): Promise<{ h: Harness; session: Session; start: number }> {
  const h = await harness();
  const session = await signup(h, OWNER, T);
  await addCard(h, session);
  expect((await h.request("POST", `/v1/tenants/${T}/billing/plan`, { session, json: { plan: "starter" } })).status).toBe(200);
  const start = h.clock.now - MONTH - 1000;
  await h.db.query("update tenant_billing set period_start = $2, state_since = $2 where tenant_id = $1", [T, start]);
  return { h, session, start };
}

const invoice = async (h: Harness) =>
  (await h.db.query<{ id: string; status: string; body: string; charge_attempts: number; payment_intent: string | null; decline_code: string | null; paid_at: unknown }>(
    "select id, status, body, charge_attempts, payment_intent, decline_code, paid_at from invoices where tenant_id = $1",
    [T],
  ))[0];
const tenantState = async (h: Harness) => (await h.db.query<{ state: string }>("select state from tenants where id = $1", [T]))[0]?.state;
const failures = (h: Harness) => h.mailer.sent.filter((m) => m.to === OWNER && m.kind === "invoice_payment_failed");

function webhook(h: Harness, event: unknown) {
  const body = JSON.stringify(event);
  const t = Math.floor(h.clock.now / 1000);
  const sig = createHmac("sha256", SECRET).update(`${t}.${body}`).digest("hex");
  return h.request("POST", "/v1/billing/webhooks/stripe", { body, headers: { "content-type": "application/json", "stripe-signature": `t=${t},v1=${sig}` } });
}

/** A recorded sandbox event, pointed at this tenant's invoice. */
function recorded(event: typeof succeeded | typeof failed, invoiceId: string, id: string): unknown {
  const e = structuredClone(event) as { id: string; data: { object: { metadata: Record<string, string> } } };
  e.id = id;
  e.data.object.metadata = { tenant_id: T, invoice_id: invoiceId };
  return e;
}

describe("collecting invoices (#350)", () => {
  test("a Customer per tenant: made on the first setup with the owner's email, reused after; a new card becomes the default and replaces the old one", async () => {
    const h = await harness();
    const session = await signup(h, OWNER, T);
    await h.request("PUT", `/v1/tenants/${T}/billing/profile`, { session, json: { legal_name: "Collect LLC", email: "billing@collect.ae", address: "Dubai", country: "AE" } });
    const first = await addCard(h, session);
    expect(psp.customers).toEqual([{ tenantId: T, email: OWNER, name: "Collect LLC" }]);
    expect((await h.db.query<{ stripe_customer: string }>("select stripe_customer from tenant_billing where tenant_id = $1", [T]))[0]?.stripe_customer).toBe(`cus_${T}`);
    const second = await addCard(h, session);
    expect(psp.customers).toHaveLength(1);
    expect(psp.setups).toEqual([`cus_${T}`, `cus_${T}`]);
    expect(psp.defaults).toEqual([
      [`cus_${T}`, first, null],
      [`cus_${T}`, second, first],
    ]);
    // The API's answer has no customer id: the PaymentMethod shape is unchanged.
    const b = (await (await h.request("GET", `/v1/tenants/${T}/billing`, { session })).json()) as { payment_method: Record<string, unknown> };
    expect(Object.keys(b.payment_method).sort()).toEqual(["added_at", "brand", "exp_month", "exp_year", "id", "last4", "provider"]);
  });

  test("the close charges the invoice off-session and marks it paid; the next pass charges nothing", async () => {
    const { h } = await due();
    const [id] = (await sweepBilling(h.deps, h.clock.now)).invoices;
    expect(psp.charges).toEqual([{ tenantId: T, invoiceId: id as string, customer: `cus_${T}`, paymentMethod: "pm_collect_1", amount: 8295, attempt: 1 }]);
    const inv = await invoice(h);
    expect(inv).toMatchObject({ id, status: "paid", charge_attempts: 1, payment_intent: `pi_${id}_1`, decline_code: null });
    expect(JSON.parse(inv?.body ?? "{}")).toMatchObject({ status: "paid", paid_at: h.clock.now, total: "82.95" });
    await sweepBilling(h.deps, h.clock.now + 3_600_000);
    expect(psp.charges).toHaveLength(1);
    expect(failures(h)).toHaveLength(0);
  });

  test("a decline is retried 1, 3 and 7 days after the invoice date with an email each time; unpaid 14 days suspends; a new card pays and reinstates", async () => {
    const { h, session } = await due();
    psp.answer = () => ({ status: "failed", payment_intent: "pi_declined", code: "insufficient_funds" });
    const now = h.clock.now;
    await sweepBilling(h.deps, now);
    expect(await invoice(h)).toMatchObject({ status: "open", charge_attempts: 1, decline_code: "insufficient_funds", payment_intent: "pi_declined" });
    expect(failures(h)).toHaveLength(1);
    expect(failures(h)[0]?.text).toContain(new Date(now + DAY).toISOString().slice(0, 10));
    expect(failures(h)[0]?.text).not.toContain("4242");
    // Hourly passes before the first retry day do nothing.
    await sweepBilling(h.deps, now + 3_600_000);
    expect(psp.charges).toHaveLength(1);
    for (const [i, d] of RETRY_DAYS.entries()) {
      await sweepBilling(h.deps, now + d * DAY + 1000);
      expect(psp.charges.map((c) => c.attempt)).toEqual(Array.from({ length: i + 2 }, (_, k) => k + 1));
    }
    expect(failures(h)).toHaveLength(4);
    expect(failures(h).at(-1)?.text).toContain("No further attempt");
    expect(await tenantState(h)).toBe("active");
    await sweepBilling(h.deps, now + 10 * DAY);
    expect(psp.charges).toHaveLength(4);
    await sweepBilling(h.deps, now + 14 * DAY + 1000);
    expect(await tenantState(h)).toBe("suspended");
    // A new card pays at once and the tenant is active again (the request runs at the harness's clock).
    psp.answer = (c) => ({ status: "succeeded", payment_intent: `pi_${c.invoiceId}_${c.attempt}` });
    await addCard(h, session);
    expect(psp.charges.at(-1)).toMatchObject({ attempt: 5, paymentMethod: "pm_collect_2" });
    expect(await invoice(h)).toMatchObject({ status: "paid", decline_code: null });
    expect(await tenantState(h)).toBe("active");
  });

  test("a card saved before the Customer existed is not charged; the owner is asked for a card", async () => {
    const { h } = await due();
    await h.db.query("update tenant_billing set stripe_customer = null where tenant_id = $1", [T]);
    await sweepBilling(h.deps, h.clock.now);
    expect(psp.charges).toHaveLength(0);
    expect(await invoice(h)).toMatchObject({ status: "open", charge_attempts: 1, decline_code: "no_payment_method" });
    expect(failures(h)[0]?.text).toContain("no card on file can be charged");
  });

  test("the PSP unreachable: nothing is counted and the next hour tries again", async () => {
    const { h } = await due();
    psp.answer = () => ({ status: "unavailable" });
    await sweepBilling(h.deps, h.clock.now);
    expect(await invoice(h)).toMatchObject({ status: "open", charge_attempts: 0 });
    expect(failures(h)).toHaveLength(0);
    psp.answer = (c) => ({ status: "succeeded", payment_intent: `pi_${c.invoiceId}_${c.attempt}` });
    await sweepBilling(h.deps, h.clock.now + 3_600_000);
    expect(await invoice(h)).toMatchObject({ status: "paid", charge_attempts: 1 });
  });

  test("webhooks recorded from the sandbox: payment_intent.payment_failed records the decline; payment_intent.succeeded settles the invoice once", async () => {
    const { h } = await due();
    psp.answer = () => ({ status: "pending", payment_intent: succeeded.data.object.id });
    const [id] = (await sweepBilling(h.deps, h.clock.now)).invoices;
    expect(await invoice(h)).toMatchObject({ status: "open", charge_attempts: 1 });
    expect(failures(h)).toHaveLength(0);
    expect((await webhook(h, recorded(failed, id as string, "evt_collect_failed"))).status).toBe(200);
    expect((await invoice(h))?.decline_code).toBe("generic_decline");
    h.clock.now += 60_000;
    const paidAt = h.clock.now;
    expect((await webhook(h, recorded(succeeded, id as string, "evt_collect_paid"))).status).toBe(200);
    expect(await invoice(h)).toMatchObject({ status: "paid", payment_intent: succeeded.data.object.id, decline_code: null });
    // The same payment under another event id changes nothing.
    h.clock.now += 60_000;
    expect((await webhook(h, recorded(succeeded, id as string, "evt_collect_paid_2"))).status).toBe(200);
    expect(Number((await invoice(h))?.paid_at)).toBe(paidAt);
  });
});
