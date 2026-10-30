// Platform billing (#325; deploy-api.md 0.5 section 20): plans, the
// session-only `billing` permission, the setup-intent flow without card
// data, a paid plan needs a payment method, Stripe webhooks verified and
// de-duplicated, a dispute suspends the tenant down to the route table,
// payment reinstates it, and the tier machine's grace and suspension.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";

import { contentHash } from "@renox/artifact-validate";

import { setPsp, stripePsp, tickTier } from "../src/billing/routes.ts";
import { helloArtifact, upload } from "./artifacts.ts";
import { assertScoped, harness, registeredNode, signup, type Harness, type Session } from "./helpers.ts";

afterEach(assertScoped);

const SECRET = "whsec_test_0123456789";
beforeAll(() =>
  setPsp({
    async createSetup() {
      return { setup_id: "seti_1Q2w3E4r5T6y7U8i", client_secret: "seti_1Q2w3E4r5T6y7U8i_secret_abcdefgh", publishable_key: "pk_test_51Abcdefgh" };
    },
    async confirmSetup(id) {
      return id === "seti_1Q2w3E4r5T6y7U8i" ? { id: "pm_1Q2w3E4r5T6y7U8i", brand: "visa", last4: "4242", exp_month: 12, exp_year: 2029 } : null;
    },
    webhookSecret: () => SECRET,
  }),
);
afterAll(() => setPsp(stripePsp));

const T = "t_bill";

async function setup(): Promise<{ h: Harness; session: Session }> {
  const h = await harness();
  const session = await signup(h, "owner@bill.ae", T);
  return { h, session };
}

function webhook(h: Harness, event: unknown, opts: { secret?: string; t?: number } = {}) {
  const body = JSON.stringify(event);
  const t = opts.t ?? Math.floor(h.clock.now / 1000);
  const sig = createHmac("sha256", opts.secret ?? SECRET).update(`${t}.${body}`).digest("hex");
  return h.request("POST", "/v1/billing/webhooks/stripe", { body, headers: { "content-type": "application/json", "stripe-signature": `t=${t},v1=${sig}` } });
}

describe("billing (section 20)", () => {
  test("plans are public; billing is the owner's session only; another tenant's id is 404", async () => {
    const { h, session } = await setup();
    const plans = (await (await h.request("GET", "/v1/billing/plans")).json()) as { currency: string; plans: { id: string }[] };
    expect(plans.currency).toBe("AED");
    expect(plans.plans.map((p) => p.id)).toEqual(["free", "starter", "pro", "agency"]);
    const b = (await (await h.request("GET", `/v1/tenants/${T}/billing`, { session })).json()) as Record<string, unknown>;
    expect(b).toMatchObject({ tenant_id: T, plan: "free", state: "active", payment_method: null, estimate: { total: "0.00", currency: "AED" } });
    expect((await h.request("GET", "/v1/tenants/t_other/billing", { session })).status).toBe(404);
  });

  test("setup intent, confirmation without card data, then a paid plan", async () => {
    const { h, session } = await setup();
    expect((await h.request("POST", `/v1/tenants/${T}/billing/plan`, { session, json: { plan: "starter" } })).status).toBe(409);
    const s = await h.request("POST", `/v1/tenants/${T}/billing/payment-methods/setup`, { session, json: { provider: "stripe" } });
    expect(s.status).toBe(201);
    expect(await s.json()).toMatchObject({ provider: "stripe", setup_id: "seti_1Q2w3E4r5T6y7U8i" });
    const card = await h.request("POST", `/v1/tenants/${T}/billing/payment-methods`, { session, json: { setup_id: "seti_1Q2w3E4r5T6y7U8i", card_number: "4242424242424242" } });
    expect(card.status).toBe(400);
    const pm = await h.request("POST", `/v1/tenants/${T}/billing/payment-methods`, { session, json: { setup_id: "seti_1Q2w3E4r5T6y7U8i" } });
    expect(pm.status).toBe(201);
    expect(await pm.json()).toMatchObject({ id: "pm_1Q2w3E4r5T6y7U8i", brand: "visa", last4: "4242" });
    const up = (await (await h.request("POST", `/v1/tenants/${T}/billing/plan`, { session, json: { plan: "starter" } })).json()) as Record<string, any>;
    expect(up).toMatchObject({ plan: "starter", estimate: { subtotal: "79.00", vat: "3.95", total: "82.95" } });
    const tier = await h.db.query<{ tier: string }>("select tier from tenants where id = $1", [T]);
    expect(tier[0]?.tier).toBe("paid");
    const profile = await h.request("PUT", `/v1/tenants/${T}/billing/profile`, { session, json: { legal_name: "Bill LLC", email: "a@bill.ae", trn: "12345", address: "Dubai", country: "AE" } });
    expect(profile.status).toBe(400);
  });

  test("webhooks: a bad signature is 401, a replay is a duplicate, a dispute suspends down to the route table, payment reinstates", async () => {
    const { h } = await setup();
    // An active deployment with a route entry.
    const { createTenantToken } = await import("../src/auth/tokens.ts");
    const token = (await createTenantToken(h.db, T, "t", ["*"], 30, h.clock.now)).token;
    expect((await h.request("POST", "/v1/apps", { token, json: { name: "hello" } })).status).toBe(201);
    const files = helloArtifact();
    expect((await upload(h, token, "hello", files)).status).toBe(201);
    await registeredNode(h, "node-1");
    expect((await h.request("POST", "/v1/apps/hello/activate", { token, json: { hash: contentHash(files) } })).status).toBe(200);
    const routes = async () => (await h.db.query<{ n: number }>("select count(*)::int as n from route_entries where tenant_id = $1", [T]))[0]?.n;
    expect(await routes()).toBeGreaterThan(0);
    const dispute = { id: "evt_dispute_1", type: "charge.dispute.created", data: { object: { metadata: { tenant_id: T } } } };
    expect((await webhook(h, dispute, { secret: "wrong" })).status).toBe(401);
    expect((await webhook(h, dispute, { t: Math.floor(h.clock.now / 1000) - 3600 })).status).toBe(401);
    expect((await webhook(h, dispute)).status).toBe(200);
    expect(await (await webhook(h, dispute)).json()).toEqual({ received: true, duplicate: true });
    expect((await h.db.query<{ state: string }>("select state from tenants where id = $1", [T]))[0]?.state).toBe("suspended");
    expect(await routes()).toBe(0);
    const paid = { id: "evt_paid_1", type: "invoice.paid", data: { object: { metadata: { tenant_id: T } } } };
    expect((await webhook(h, paid)).status).toBe(200);
    expect((await h.db.query<{ state: string }>("select state from tenants where id = $1", [T]))[0]?.state).toBe("active");
    expect(await routes()).toBeGreaterThan(0);
  });

  test("the tier machine: free over quota -> over_quota -> grace -> suspended", async () => {
    const { h } = await setup();
    const now = h.clock.now;
    expect(await tickTier(h.deps, T, true, now)).toBe("over_quota");
    expect(await tickTier(h.deps, T, true, now + 3_600_000)).toBe("over_quota");
    expect(await tickTier(h.deps, T, true, now + 86_400_000)).toBe("grace");
    expect(await tickTier(h.deps, T, true, now + 86_400_000 + 7 * 86_400_000)).toBe("suspended");
    expect((await h.db.query<{ state: string }>("select state from tenants where id = $1", [T]))[0]?.state).toBe("suspended");
  });
});
