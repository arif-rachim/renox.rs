// The Usage and billing page (#325; deploy-api.md 0.5.1 section 20, "Owner
// token rule"; docs/24-threat-model.md E, "Teammate with too much power")
// against the real control API in process: the owner's own token reads
// billing and invoices; a member's token is refused and the page says
// billing is the owner's; a card setup and a paid plan ask for a code when
// the token's verification is older than 15 minutes, then go through; the
// invoice PDF is rendered with ctx.pdf from the API's JSON, card data never
// passes through the dashboard.
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";

import { totp } from "../../../sdk/src/totp.ts";
import { addMember, assertScoped, signup } from "../../api/tests/helpers.ts";
import { STEP_UP_MS } from "../../api/src/auth/mfa.ts";
import { MONTH, setPsp, stripePsp } from "../../api/src/billing/routes.ts";
import { sweepBilling } from "../../api/src/billing/sweep.ts";
import { actions as signinActions } from "../pages/signin.ts";
import { actions, load } from "../pages/billing/index.ts";
import { load as invoicePdf } from "../pages/billing/invoices/[id].ts";
import { actions as securityActions } from "../pages/account/security.ts";
import { actionCtx, dash, loaderCtx, type Dash } from "./helpers.ts";

setDefaultTimeout(30_000);
afterEach(assertScoped);
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
    webhookSecret: () => "whsec_test_0123456789",
  }),
);
afterAll(() => setPsp(stripePsp));

type Data = Record<string, any>;
const data = (v: unknown): Data => {
  expect(v).not.toBeInstanceOf(Response);
  return v as Data;
};

/** A user with an app in `tenantId` and their own token, signed in to a dashboard session of their own. */
async function user(d: Dash, email: string, tenantId: string): Promise<Dash> {
  const session = await signup(d.h, email, tenantId);
  expect((await d.h.request("POST", "/v1/apps", { session, json: { name: `app-${tenantId}` } })).status).toBe(201);
  const made = await d.h.request("POST", "/v1/tokens", { session, json: { name: "dashboard", scopes: ["*"], expires_in_days: 30 } });
  expect(made.status).toBe(201);
  const token = ((await made.json()) as { token: string }).token;
  const mine: Dash = { ...d, sessionId: `S${email.replace(/[^a-z]/gu, "").padEnd(21, "A").slice(0, 21)}` };
  expect(await signinActions.default(actionCtx(mine, "/signin", "default", { token, next: "/billing" }))).toBeInstanceOf(Response);
  return mine;
}

describe("usage and billing", () => {
  test("a signed-out visitor goes to /signin before any API call", async () => {
    const d = await dash();
    expect(((await load(loaderCtx(d, "/billing"))) as Response).status).toBe(303);
    expect(d.calls.sent).toEqual([]);
  });

  test("the owner's token shows the plan, the estimate and the plans", async () => {
    const d = await user(await dash(), "owner@shop.ae", "t-shop");
    const v = data(await load(loaderCtx(d, "/billing")));
    expect(v.owner_only).toBe(false);
    expect(v.billing).toMatchObject({ plan: "free", state: "active", estimate: { total: "0.00", currency: "AED" }, card: null });
    expect(v.billing.plans.map((p: { id: string }) => p.id)).toEqual(["free", "starter", "pro", "agency"]);
    expect(d.calls.sent.every((c) => c.authorization?.startsWith("Bearer renox_pat_"))).toBe(true);
  });

  test("a member's token is refused by the API and the page says billing is the owner's", async () => {
    const owner = await user(await dash(), "owner2@shop.ae", "t-shop2");
    const tokenOfAdmin = await (async () => {
      await signup(owner.h, "admin@shop.ae", "t-admin-own");
      await addMember(owner.h, "t-shop2", "admin@shop.ae", "admin");
      const [u] = await owner.h.db.query<{ id: string }>("select id from users where email = 'admin@shop.ae'");
      const { createTenantToken } = await import("../../api/src/auth/tokens.ts");
      return (await createTenantToken(owner.h.db, "t-shop2", "dashboard", ["*"], 30, owner.h.clock.now, (u as { id: string }).id)).token;
    })();
    const admin: Dash = { ...owner, sessionId: "SadminAAAAAAAAAAAAAAAA" };
    expect(await signinActions.default(actionCtx(admin, "/signin", "default", { token: tokenOfAdmin, next: "/billing" }))).toBeInstanceOf(Response);
    const v = data(await load(loaderCtx(admin, "/billing")));
    expect(v.owner_only).toBe(true);
    expect(v.billing).toBeNull();
    expect(v.problem).toBeNull();
  });

  test("card setup asks for a code past the window, then shows Stripe's form; the card saved, a paid plan goes through", async () => {
    const d = await user(await dash(), "card@shop.ae", "t-card");
    const started = data(await securityActions.totp_start(actionCtx(d, "/account/security", "totp_start", {})));
    const secret = (started.totp_setup as { secret: string }).secret;
    data(await securityActions.totp_confirm(actionCtx(d, "/account/security", "totp_confirm", { code: await totp(secret, d.h.clock.now / 1000) })));
    d.h.clock.now += STEP_UP_MS + 60_000;
    const asked = data(await actions.card_setup(actionCtx(d, "/billing", "card_setup", {})));
    expect(asked.step_up).toEqual({ then: "card_setup", plan: null });
    expect(asked.setup).toBeNull();
    const shown = data(await actions.verify(actionCtx(d, "/billing", "verify", { code: await totp(secret, d.h.clock.now / 1000 + 30), then: "card_setup" })));
    expect(shown.setup).toMatchObject({ setup_id: "seti_1Q2w3E4r5T6y7U8i", publishable_key: "pk_test_51Abcdefgh" });
    const saved = data(await actions.card_confirm(actionCtx(d, "/billing", "card_confirm", { setup_id: "seti_1Q2w3E4r5T6y7U8i" })));
    expect(saved.billing.card).toBe("visa •••• 4242 (12/2029)");
    const up = data(await actions.plan(actionCtx(d, "/billing", "plan", { plan: "starter" })));
    expect(up.notice).toBe("Your plan is now starter.");
    expect(up.billing).toMatchObject({ plan: "starter", estimate: { total: "82.95" } });
    // Nothing the dashboard sent carried a card number.
    expect(d.calls.sent.some((c) => /4242424242424242/u.test(JSON.stringify(c)))).toBe(false);
  });

  test("an invoice PDF is rendered with ctx.pdf from the API's JSON; a malformed id is 404 before any call", async () => {
    const d = await user(await dash(), "inv@shop.ae", "t-inv");
    data(await load(loaderCtx(d, "/billing")));
    const start = d.h.clock.now - MONTH - 1000;
    await d.h.db.query("update tenant_billing set plan = 'starter', period_start = $2, state_since = $2, profile = $3 where tenant_id = $1", ["t-inv", start, JSON.stringify({ legal_name: "Inv LLC", email: "a@inv.ae", address: "Dubai", country: "AE" })]);
    const saved = process.env.RENOX_SELLER_TRN;
    process.env.RENOX_SELLER_TRN = "100000000000001";
    try {
      const [id] = (await sweepBilling(d.h.deps, d.h.clock.now)).invoices;
      const listed = data(await load(loaderCtx(d, "/billing")));
      expect(listed.invoices[0]).toMatchObject({ id, total: "82.95 AED", pdf: `/billing/invoices/${id}` });
      const rendered: [string, Record<string, unknown>][] = [];
      const ctx = { ...loaderCtx(d, `/billing/invoices/${id}`, { params: { id: id as string } }), pdf: { render: async (t: string, v: Record<string, unknown>) => (rendered.push([t, v]), new Uint8Array([37, 80, 68, 70])) } };
      const res = (await invoicePdf(ctx as never)) as Response;
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/pdf");
      expect(rendered[0]?.[0]).toBe("partials/invoice");
      expect(rendered[0]?.[1]).toMatchObject({ id, seller_trn: "100000000000001", buyer_name: "Inv LLC", total: "82.95" });
      const before = d.calls.sent.length;
      expect(((await invoicePdf(loaderCtx(d, "/billing/invoices/x", { params: { id: "../x" } }))) as Response).status).toBe(404);
      expect(d.calls.sent.length).toBe(before);
    } finally {
      if (saved === undefined) delete process.env.RENOX_SELLER_TRN;
      else process.env.RENOX_SELLER_TRN = saved;
    }
  });
});
