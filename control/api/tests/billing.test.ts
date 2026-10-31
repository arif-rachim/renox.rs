// Platform billing (#325; deploy-api.md 0.5 section 20): plans, the
// session-only `billing` permission, the setup-intent flow without card
// data, a paid plan needs a payment method, Stripe webhooks verified and
// de-duplicated, a dispute suspends the tenant down to the route table,
// payment reinstates it, and the tier machine's grace and suspension.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";

import { contentHash } from "@renox/artifact-validate";

import { createTenantToken } from "../src/auth/tokens.ts";
import { MONTH, setPsp, stripePsp, tickTier } from "../src/billing/routes.ts";
import { sweepBilling } from "../src/billing/sweep.ts";
import { helloArtifact, upload } from "./artifacts.ts";
import { totp } from "../../../sdk/src/totp.ts";
import { addMember, assertScoped, harness, registeredNode, signup, type Harness, type Session } from "./helpers.ts";

afterEach(assertScoped);

const SECRET = "whsec_test_0123456789";
beforeAll(() =>
  setPsp({
    async ensureCustomer() {
      return "cus_Q2w3E4r5T6y7U8";
    },
    async createSetup() {
      return { setup_id: "seti_1Q2w3E4r5T6y7U8i", client_secret: "seti_1Q2w3E4r5T6y7U8i_secret_abcdefgh", publishable_key: "pk_test_51Abcdefgh" };
    },
    async confirmSetup(id) {
      return id === "seti_1Q2w3E4r5T6y7U8i" ? { id: "pm_1Q2w3E4r5T6y7U8i", brand: "visa", last4: "4242", exp_month: 12, exp_year: 2029 } : null;
    },
    async setDefault() {},
    async charge(c) {
      return { status: "succeeded", payment_intent: `pi_${c.invoiceId}_${c.attempt}` };
    },
    async paymentIntentTenant() {
      return null;
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
    const routes = async () => (await h.db.query<{ n: number }>("select count(*)::int as n from route_entries where tenant_id = $1 and status = 'active'", [T]))[0]?.n;
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

  test("the monthly close: gapless numbers per year, both TRNs, the next period, a pending downgrade; free bills nothing; no seller TRN, no invoice", async () => {
    const h = await harness();
    const now = h.clock.now;
    for (const t of ["t_a", "t_b", "t_c"]) await h.db.query("insert into tenants (id, name, tier, created_at) values ($1, $1, 'paid', $2)", [t, now]);
    const start = now - MONTH - 1000;
    await h.db.query("insert into tenant_billing (tenant_id, plan, state_since, period_start, profile) values ('t_a', 'starter', $1, $1, $2)", [start, JSON.stringify({ legal_name: "A LLC", email: "a@a.ae", address: "Dubai", country: "AE", trn: "100000000000003" })]);
    await h.db.query("insert into tenant_billing (tenant_id, plan, pending_plan, state_since, period_start) values ('t_b', 'pro', 'free', $1, $1)", [start]);
    await h.db.query("insert into tenant_billing (tenant_id, plan, state_since, period_start) values ('t_c', 'free', $1, $1)", [start]);
    const saved = process.env.RENOX_SELLER_TRN;
    try {
      delete process.env.RENOX_SELLER_TRN;
      expect((await sweepBilling(h.deps, now)).invoices).toEqual([]);
      expect((await h.db.query<{ n: number }>("select count(*)::int as n from invoices"))[0]?.n).toBe(0);
      process.env.RENOX_SELLER_TRN = "100000000000001";
      const r = await sweepBilling(h.deps, now);
      const year = new Date(start + MONTH - 1).getUTCFullYear();
      expect(r.invoices).toEqual([`INV-${year}-000001`, `INV-${year}-000002`]);
      const a = JSON.parse((await h.db.query<{ body: string }>("select body from invoices where tenant_id = 't_a'"))[0]?.body ?? "{}");
      expect(a).toMatchObject({ seller_trn: "100000000000001", buyer_trn: "100000000000003", subtotal: "79.00", vat: "3.95", total: "82.95", status: "open", period: { start, end: start + MONTH } });
      const rows = await h.db.query<{ tenant_id: string; plan: string; pending_plan: string | null; period_start: unknown }>("select tenant_id, plan, pending_plan, period_start from tenant_billing order by tenant_id");
      expect(rows.map((x) => [x.tenant_id, x.plan, x.pending_plan, Number(x.period_start)])).toEqual([
        ["t_a", "starter", null, start + MONTH],
        ["t_b", "free", null, start + MONTH],
        ["t_c", "free", null, start + MONTH],
      ]);
      expect((await h.db.query<{ tier: string }>("select tier from tenants where id = 't_b'"))[0]?.tier).toBe("free");
      // A second pass in the same period closes nothing.
      expect((await sweepBilling(h.deps, now)).invoices).toEqual([]);
    } finally {
      if (saved === undefined) delete process.env.RENOX_SELLER_TRN;
      else process.env.RENOX_SELLER_TRN = saved;
    }
  });

  test("the hourly pass drives a free tenant over quota through over_quota, grace and suspended, emailing the owner at each step", async () => {
    const { h } = await setup();
    const now = h.clock.now;
    await sweepBilling(h.deps, now);
    // 200,000 requests this period: the Free quota is 100,000.
    await h.db.query("insert into meters_hourly (tenant_id, deployment_hash, hour_start, requests) values ($1, $2, $3, 200000)", [T, "a".repeat(64), now]);
    await sweepBilling(h.deps, now + 1000);
    expect((await h.db.query<{ state: string }>("select state from tenant_billing where tenant_id = $1", [T]))[0]?.state).toBe("over_quota");
    expect(h.mailer.last("owner@bill.ae", "tier_over_quota")?.text).toContain("requests");
    await sweepBilling(h.deps, now + 86_400_000 + 2000);
    const grace = h.mailer.last("owner@bill.ae", "tier_grace")?.text ?? "";
    expect(grace).toContain(new Date(now + 86_400_000 + 2000 + 7 * 86_400_000).toISOString().slice(0, 10));
    await sweepBilling(h.deps, now + 86_400_000 + 2000 + 7 * 86_400_000);
    expect((await h.db.query<{ state: string }>("select state from tenants where id = $1", [T]))[0]?.state).toBe("suspended");
    expect(h.mailer.last("owner@bill.ae", "tier_suspended")?.subject).toBe("Your Renox tenant is suspended");
  });

  test("the anomaly rule: a spike against the 7-day median writes one review row and the signal; a paid tenant is reviewed, not moved", async () => {
    const { h, session } = await setup();
    const HOUR = 3_600_000;
    const now = Math.floor(h.clock.now / HOUR) * HOUR + 5 * 60_000;
    const last = Math.floor(now / HOUR) * HOUR - HOUR;
    const hash = "b".repeat(64);
    for (let i = 1; i <= 48; i++) await h.db.query("insert into meters_hourly (tenant_id, deployment_hash, hour_start, requests) values ($1, $2, $3, 150)", [T, hash, last - i * HOUR]);
    await h.db.query("insert into meters_hourly (tenant_id, deployment_hash, hour_start, requests) values ($1, $2, $3, 4000)", [T, hash, last]);
    await h.db.query("insert into tenant_billing (tenant_id, plan, state_since, period_start) values ($1, 'starter', $2, $2)", [T, now - 1000]);
    const r = await sweepBilling(h.deps, now);
    expect(r.reviews).toBe(1);
    const rows = await h.db.query<{ dimension: string; observed: number; median: number; state: string }>("select dimension, observed, median, state from billing_reviews where tenant_id = $1", [T]);
    expect(rows).toEqual([{ dimension: "requests", observed: 4000, median: 150, state: "open" }]);
    // The same hour again: no second row.
    expect((await sweepBilling(h.deps, now + 60_000)).reviews).toBe(1);
    expect((await h.db.query<{ n: number }>("select count(*)::int as n from billing_reviews"))[0]?.n).toBe(1);
    expect((await h.db.query<{ state: string }>("select state from tenant_billing where tenant_id = $1", [T]))[0]?.state).toBe("active");
    h.clock.now = now;
    const b = (await (await h.request("GET", `/v1/tenants/${T}/billing`, { session })).json()) as { signal: { anomaly: boolean } };
    expect(b.signal.anomaly).toBe(true);
  });
});

// deploy-api.md 0.5.1 section 20, "Owner token rule" (#325, #346). docs/24-threat-model.md E,
// "Teammate with too much power": billing stays the owner's, now also through the owner's own token
// (the dashboard signs in with it, D23); every other token is 403.
describe("billing with the owner's token (0.5.1)", () => {
  const userId = async (h: Harness, email: string) => ((await h.db.query<{ id: string }>("select id from users where email = $1", [email]))[0] as { id: string }).id;
  const token = async (h: Harness, scopes: string[], user: string | null) => (await createTenantToken(h.db, T, "dash", scopes, 30, h.clock.now, user)).token;

  test("the owner's token reads billing; a member's, a bootstrap and an app-scoped token are 403", async () => {
    const { h } = await setup();
    const owner = await userId(h, "owner@bill.ae");
    const ok = await h.request("GET", `/v1/tenants/${T}/billing`, { token: await token(h, ["*"], owner) });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ tenant_id: T, plan: "free" });
    await signup(h, "admin@bill.ae", "t_bill_admin");
    const admin = await addMember(h, T, "admin@bill.ae", "admin");
    for (const t of [await token(h, ["*"], admin), await token(h, ["*"], null), await token(h, ["deploy:hello"], owner)]) {
      const r = await h.request("GET", `/v1/tenants/${T}/billing`, { token: t });
      expect(r.status).toBe(403);
      expect(((await r.json()) as { error: { code: string } }).error.code).toBe("RENOX_TOKEN_SCOPE");
    }
    // Another tenant's id with the owner's token is still 404 (the IDOR row).
    expect((await h.request("GET", "/v1/tenants/t_other/billing", { token: await token(h, ["*"], owner) })).status).toBe(404);
  });

  test("payment-method setup and a paid plan with a token need a recent second factor with that token", async () => {
    const { h, session } = await setup();
    const owner = await userId(h, "owner@bill.ae");
    const start = (await (await h.request("POST", "/v1/account/mfa/totp", { session, json: {} })).json()) as { secret: string };
    expect((await h.request("POST", "/v1/account/mfa/totp/confirm", { session, json: { code: await totp(start.secret, h.clock.now / 1000) } })).status).toBe(200);
    const t = await token(h, ["*"], owner);
    const setupReq = () => h.request("POST", `/v1/tenants/${T}/billing/payment-methods/setup`, { token: t, json: { provider: "stripe" } });
    const refused = await setupReq();
    expect(refused.status).toBe(403);
    expect(JSON.stringify(await refused.json())).toContain("step_up_required");
    // The reads are not stepped up.
    expect((await h.request("GET", `/v1/tenants/${T}/invoices`, { token: t })).status).toBe(200);
    h.clock.now += 31_000;
    expect((await h.request("POST", "/v1/account/mfa/verify", { token: t, json: { method: "totp", code: await totp(start.secret, h.clock.now / 1000) } })).status).toBe(200);
    expect((await setupReq()).status).toBe(201);
    expect((await h.request("POST", `/v1/tenants/${T}/billing/payment-methods`, { token: t, json: { setup_id: "seti_1Q2w3E4r5T6y7U8i" } })).status).toBe(201);
    expect((await h.request("POST", `/v1/tenants/${T}/billing/plan`, { token: t, json: { plan: "starter" } })).status).toBe(200);
    // Past the 15-minute window a paid plan is refused again; free is not stepped up.
    h.clock.now += 16 * 60_000;
    expect((await h.request("POST", `/v1/tenants/${T}/billing/plan`, { token: t, json: { plan: "pro" } })).status).toBe(403);
    expect((await h.request("POST", `/v1/tenants/${T}/billing/plan`, { token: t, json: { plan: "free" } })).status).toBe(200);
  });

  test("getInvoice answers the bilingual HTML with Accept: text/html, JSON otherwise", async () => {
    const { h, session } = await setup();
    const owner = await userId(h, "owner@bill.ae");
    expect((await h.request("GET", `/v1/tenants/${T}/billing`, { session })).status).toBe(200);
    const start = h.clock.now - MONTH - 1000;
    await h.db.query("update tenant_billing set plan = 'starter', period_start = $2, state_since = $2, profile = $3 where tenant_id = $1", [T, start, JSON.stringify({ legal_name: "Bill <LLC>", email: "a@bill.ae", address: "Dubai", country: "AE" })]);
    const saved = process.env.RENOX_SELLER_TRN;
    process.env.RENOX_SELLER_TRN = "100000000000001";
    try {
      const [id] = (await sweepBilling(h.deps, h.clock.now)).invoices;
      const t = await token(h, ["*"], owner);
      const html = await h.request("GET", `/v1/tenants/${T}/invoices/${id}`, { token: t, headers: { accept: "text/html" } });
      expect(html.status).toBe(200);
      expect(html.headers.get("content-type")).toContain("text/html");
      const page = await html.text();
      expect(page).toContain("Tax Invoice");
      expect(page).toContain("فاتورة ضريبية");
      expect(page).toContain("Bill &lt;LLC&gt;");
      const json = await h.request("GET", `/v1/tenants/${T}/invoices/${id}`, { token: t });
      expect(await json.json()).toMatchObject({ id, seller_trn: "100000000000001" });
    } finally {
      if (saved === undefined) delete process.env.RENOX_SELLER_TRN;
      else process.env.RENOX_SELLER_TRN = saved;
    }
  });
});
