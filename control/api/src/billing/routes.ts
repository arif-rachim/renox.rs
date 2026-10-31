// Platform billing in AED (#325; deploy-api.md 0.5 section 20). Every
// operation but listPlans and billingWebhook takes the session permission
// `billing` (owner only). Card data never reaches this API: the PSP's
// setup intent is created here, confirmed in the browser, and only its
// payment method id, brand, last four digits and expiry are kept.

import { createHmac, timingSafeEqual } from "node:crypto";

import { aed, fils, invoiceHtml, nextState, PLANS, planOf, reinstate, tenantUsage, vatOf, VAT_RATE, type TierState } from "@renox/billing";
import type { Context, Hono } from "hono";

import { operation } from "../audit.ts";
import { tenantAuth } from "../auth/middleware.ts";
import type { Deps, Env } from "../context.ts";
import { num, type Db } from "../db/db.ts";
import { ApiError, conflict, invalid, notFound } from "../errors.ts";
import { pathParam, readBody } from "../http.ts";
import { onTenantState } from "../routes/activation.ts";
import { crossTenant, requestScope, tenantDb } from "../tenancy/scope.ts";
import { newTenantRestrictions } from "../tenants/erasure.ts";
import { collectDue, markInvoicePaid } from "./collect.ts";

type Row = Record<string, unknown>;

/** The PSP as this API uses it (Stripe UAE first). Tests replace it. */
export interface Psp {
  /** The tenant's customer at the PSP, created once (#350): a saved card is attached to it, so it can be charged again. */
  ensureCustomer(tenantId: string, info: { email: string | null; name: string | null }): Promise<string>;
  createSetup(tenantId: string, customer: string): Promise<{ setup_id: string; client_secret: string; publishable_key: string }>;
  /** The confirmed setup's payment method, or null when it is not confirmed. */
  confirmSetup(setupId: string): Promise<{ id: string; brand: string; last4: string; exp_month: number; exp_year: number } | null>;
  /** Makes the card the customer's default and detaches the one it replaces; best effort. */
  setDefault(customer: string, paymentMethod: string, previous: string | null): Promise<void>;
  /** An off-session charge of an invoice (#350). `unavailable`: the PSP was not reached, nothing was attempted. */
  charge(c: ChargeRequest): Promise<ChargeResult>;
  /** The tenant named in a PaymentIntent's metadata, or null (#351). */
  paymentIntentTenant(paymentIntent: string): Promise<string | null>;
  webhookSecret(): string | null;
}

export interface ChargeRequest {
  tenantId: string;
  invoiceId: string;
  customer: string;
  paymentMethod: string;
  /** The invoice total in fils. */
  amount: number;
  attempt: number;
}

export type ChargeResult =
  | { status: "succeeded" | "pending"; payment_intent: string }
  | { status: "failed"; payment_intent: string | null; code: string }
  | { status: "unavailable" };

const STRIPE = "https://api.stripe.com/v1";

/** One Stripe REST call with the platform's key; null when Stripe is not reached. */
async function stripeApi(path: string, form?: Record<string, string>, idempotencyKey?: string): Promise<{ status: number; body: Record<string, any> } | null> {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new ApiError("RENOX_UNAVAILABLE");
  const headers: Record<string, string> = { authorization: `Bearer ${key}` };
  if (form !== undefined) headers["content-type"] = "application/x-www-form-urlencoded";
  if (idempotencyKey !== undefined) headers["idempotency-key"] = idempotencyKey;
  const res = await fetch(`${STRIPE}/${path}`, { method: form === undefined ? "GET" : "POST", headers, body: form === undefined ? undefined : new URLSearchParams(form), signal: AbortSignal.timeout(15_000) }).catch(() => null);
  if (res === null) return null;
  return { status: res.status, body: ((await res.json().catch(() => ({}))) ?? {}) as Record<string, any> };
}

/** Cards only, confirmed without a redirect: an account with dynamic payment methods asks for a return_url otherwise. */
const CARDS_ONLY = { "automatic_payment_methods[enabled]": "true", "automatic_payment_methods[allow_redirects]": "never" };

/** Stripe over its REST API with the platform's secret key (`STRIPE_SECRET_KEY`). */
export const stripePsp: Psp = {
  async ensureCustomer(tenantId, info) {
    const form: Record<string, string> = { "metadata[tenant_id]": tenantId, description: `Renox tenant ${tenantId}` };
    if (info.email !== null) form.email = info.email;
    if (info.name !== null) form.name = info.name;
    // A retried call with the same fields is the same Customer (Stripe refuses one key with other fields).
    const fields = createHmac("sha256", "renox-customer").update(JSON.stringify(form)).digest("hex").slice(0, 16);
    const r = await stripeApi("customers", form, `customer:${tenantId}:${fields}`);
    if (r === null || r.status !== 200 || typeof r.body.id !== "string") throw new ApiError("RENOX_UNAVAILABLE");
    return r.body.id;
  },
  async createSetup(tenantId, customer) {
    const r = await stripeApi("setup_intents", { "metadata[tenant_id]": tenantId, customer, usage: "off_session", ...CARDS_ONLY });
    if (r === null || r.status !== 200) throw new ApiError("RENOX_UNAVAILABLE");
    const j = r.body as { id: string; client_secret: string };
    return { setup_id: j.id, client_secret: j.client_secret, publishable_key: process.env.STRIPE_PUBLISHABLE_KEY ?? "" };
  },
  async confirmSetup(setupId) {
    const r = await stripeApi(`setup_intents/${encodeURIComponent(setupId)}?expand[]=payment_method`);
    if (r === null || r.status !== 200) throw new ApiError("RENOX_UNAVAILABLE");
    const j = r.body as { status: string; payment_method?: { id: string; card?: { brand: string; last4: string; exp_month: number; exp_year: number } } };
    if (j.status !== "succeeded" || !j.payment_method?.card) return null;
    const c = j.payment_method.card;
    return { id: j.payment_method.id, brand: c.brand, last4: c.last4, exp_month: c.exp_month, exp_year: c.exp_year };
  },
  async setDefault(customer, paymentMethod, previous) {
    await stripeApi(`customers/${encodeURIComponent(customer)}`, { "invoice_settings[default_payment_method]": paymentMethod }).catch(() => null);
    if (previous !== null && previous !== paymentMethod) await stripeApi(`payment_methods/${encodeURIComponent(previous)}/detach`, {}).catch(() => null);
  },
  async charge(c) {
    const r = await stripeApi(
      "payment_intents",
      {
        amount: String(c.amount),
        currency: "aed",
        customer: c.customer,
        payment_method: c.paymentMethod,
        off_session: "true",
        confirm: "true",
        description: `Renox invoice ${c.invoiceId}`,
        "metadata[tenant_id]": c.tenantId,
        "metadata[invoice_id]": c.invoiceId,
        ...CARDS_ONLY,
      },
      // One PaymentIntent per attempt, however often the call is retried.
      `invoice:${c.invoiceId}:${c.attempt}`,
    );
    if (r === null || r.status >= 500 || r.status === 429) return { status: "unavailable" };
    if (r.status === 200) {
      const id = String(r.body.id);
      if (r.body.status === "succeeded") return { status: "succeeded", payment_intent: id };
      if (r.body.status === "processing") return { status: "pending", payment_intent: id };
      return { status: "failed", payment_intent: id, code: String(r.body.status) };
    }
    // 402: declined or authentication_required, with the PaymentIntent in the error.
    const e = (r.body.error ?? {}) as { code?: string; decline_code?: string; payment_intent?: { id?: string } };
    return { status: "failed", payment_intent: typeof e.payment_intent?.id === "string" ? e.payment_intent.id : null, code: e.decline_code ?? e.code ?? `http_${r.status}` };
  },
  async paymentIntentTenant(paymentIntent) {
    const r = await stripeApi(`payment_intents/${encodeURIComponent(paymentIntent)}`);
    const t = r?.status === 200 ? r.body.metadata?.tenant_id : undefined;
    return typeof t === "string" ? t : null;
  },
  webhookSecret: () => process.env.STRIPE_WEBHOOK_SECRET ?? null,
};

let psp: Psp = stripePsp;

/** The PSP in use (the collection of collect.ts). */
export const currentPsp = (): Psp => psp;

/** Tests: a PSP stand-in. */
export function setPsp(p: Psp): void {
  psp = p;
}

/** A billing period (30 days). */
export const MONTH = 30 * 86_400_000;

async function billingRow(db: Db, tenantId: string, now: number): Promise<Row> {
  await db.query("insert into tenant_billing (tenant_id, state_since, period_start) values ($1, $2, $2) on conflict (tenant_id) do nothing", [tenantId, now]);
  return (await db.query<Row>("select * from tenant_billing where tenant_id = $1", [tenantId]))[0] as Row;
}

async function view(deps: Deps, db: Db, tenantId: string, now: number): Promise<unknown> {
  const b = await billingRow(db, tenantId, now);
  const plan = planOf(b.plan as string) ?? (PLANS[0] as (typeof PLANS)[number]);
  const start = num(b.period_start);
  // The meters are read as the platform, for this tenant only (the rollup's own query).
  const usage = (await requestScope.exit(() => tenantUsage(deps.db, start, now, tenantId))).get(tenantId);
  const used = {
    requests: usage?.requests ?? 0,
    cpu_ms: Math.round(usage?.cpu_ms ?? 0),
    egress_bytes: (usage?.egress_bytes ?? 0) + (usage?.fetch_sent_bytes ?? 0),
    db_bytes: 0,
    storage_bytes: 0,
    ai_tokens: 0,
  };
  const over = (Object.keys(used) as (keyof typeof used)[]).filter((k) => {
    const q = plan.quotas[k];
    return q !== null && used[k] > q;
  });
  const subtotal = fils(plan.price_month);
  const vat = vatOf(subtotal);
  return {
    tenant_id: tenantId,
    plan: plan.id,
    pending_plan: b.pending_plan ?? null,
    state: b.state,
    state_since: num(b.state_since),
    period: { start, end: start + MONTH },
    usage: used,
    estimate: { subtotal: aed(subtotal), vat: aed(vat), total: aed(subtotal + vat), currency: "AED" },
    // An anomaly review of the last 24 hours that an operator has not closed (sweep.ts).
    signal: { over_quota: over, anomaly: (await db.query<Row>("select 1 from billing_reviews where tenant_id = $1 and state = 'open' and created_at > $2 limit 1", [tenantId, now - 86_400_000])).length > 0 },
    payment_method: b.payment_method === null ? null : JSON.parse(b.payment_method as string),
    profile: b.profile === null ? null : JSON.parse(b.profile as string),
    // deploy-api.md 0.5 section 21 (#326): the new-tenant restrictions still in force.
    restrictions: await newTenantRestrictions(db, tenantId, num((await db.query<Row>("select created_at from tenants where id = $1", [tenantId]))[0]?.created_at), now),
  };
}

async function body(c: Context<Env>): Promise<Record<string, unknown>> {
  if (!/^application\/json(;|$)/u.test(c.req.header("content-type") ?? "")) throw invalid("content-type", "must be application/json");
  try {
    const v = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readBody(c, 64 * 1024)));
    if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error("x");
    return v as Record<string, unknown>;
  } catch {
    throw invalid("body", "must be a JSON object");
  }
}

function own(c: Context<Env>, db: { tenantId: string }): void {
  if (pathParam(c, "tenant_id", "TenantId") !== db.tenantId) throw notFound();
}

/** Moves the tenant's tier state; `suspended` and back reach the route table (#213's path). */
export async function setTierState(deps: Deps, db: Db, tenantId: string, to: TierState, now: number): Promise<void> {
  const before = (await billingRow(db, tenantId, now)).state as TierState;
  if (before === to) return;
  await db.query("update tenant_billing set state = $2, state_since = $3 where tenant_id = $1", [tenantId, to, now]);
  if (to === "suspended" || before === "suspended") {
    const state = to === "suspended" ? "suspended" : "active";
    await deps.db.transaction(async (tx) => {
      await tx.query("update tenants set state = $1 where id = $2", [state, tenantId]);
      await onTenantState(deps, tx, tenantId, state, now);
    });
  }
}

/** Stripe-Signature: `t=…,v1=…`, HMAC-SHA256 of `<t>.<body>`, 300 s tolerance (ops.md section 22's scheme). */
export function stripeVerified(secret: string, header: string, raw: Uint8Array, nowMs: number): boolean {
  let t: number | null = null;
  const sigs: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.trim().split("=", 2);
    if (k === "t") t = Number(v);
    if (k === "v1" && v) sigs.push(v);
  }
  if (t === null || !Number.isFinite(t) || Math.abs(nowMs / 1000 - t) > 300) return false;
  const want = Buffer.from(createHmac("sha256", secret).update(`${t}.`).update(raw).digest("hex"));
  return sigs.some((s) => s.length === want.length && timingSafeEqual(Buffer.from(s), want));
}

export function registerBilling(app: Hono<Env>, deps: Deps): void {
  app.get("/v1/billing/plans", operation(deps, "listPlans"), async (c) => c.json({ currency: "AED", vat_rate: VAT_RATE, plans: PLANS }));

  app.get("/v1/tenants/:tenant_id/billing", operation(deps, "getBilling"), tenantAuth(deps, "billing"), async (c) => {
    const db = tenantDb(deps, c);
    own(c, db);
    return c.json(await view(deps, db, db.tenantId, deps.now()));
  });

  app.post("/v1/tenants/:tenant_id/billing/plan", operation(deps, "changePlan"), tenantAuth(deps, "billing"), async (c) => {
    const db = tenantDb(deps, c);
    own(c, db);
    const b = await body(c);
    const plan = planOf(String(b.plan));
    if (plan === undefined) throw invalid("plan", "must be free, starter, pro or agency");
    const now = deps.now();
    const row = await billingRow(db, db.tenantId, now);
    const current = planOf(row.plan as string) ?? (PLANS[0] as (typeof PLANS)[number]);
    if (plan.id !== "free" && row.payment_method === null) throw conflict("payment_method", "required");
    if (fils(plan.price_month) >= fils(current.price_month)) {
      await db.query("update tenant_billing set plan = $2, pending_plan = null where tenant_id = $1", [db.tenantId, plan.id]);
      await db.query("update tenants set tier = $2 where id = $1", [db.tenantId, plan.id === "free" ? "free" : "paid"]);
      if ((row.state as TierState) !== "active") await setTierState(deps, db, db.tenantId, reinstate(row.state as TierState), now);
    } else {
      await db.query("update tenant_billing set pending_plan = $2 where tenant_id = $1", [db.tenantId, plan.id]);
    }
    c.set("auditTarget", { tenant_id: db.tenantId, from: current.id, to: plan.id });
    return c.json(await view(deps, db, db.tenantId, now));
  });

  app.put("/v1/tenants/:tenant_id/billing/profile", operation(deps, "setBillingProfile"), tenantAuth(deps, "billing"), async (c) => {
    const db = tenantDb(deps, c);
    own(c, db);
    const b = await body(c);
    const s = (k: string, max: number) => (typeof b[k] === "string" && (b[k] as string).length >= 1 && (b[k] as string).length <= max ? (b[k] as string) : null);
    const profile = { legal_name: s("legal_name", 200), email: s("email", 254), address: s("address", 500), country: s("country", 2), ...(b.trn !== undefined ? { trn: b.trn } : {}) };
    for (const [k, v] of Object.entries(profile)) if (v === null) throw invalid(k, "required");
    if (b.trn !== undefined && !(typeof b.trn === "string" && /^[0-9]{15}$/u.test(b.trn))) throw invalid("trn", "15 digits");
    if (!/^[A-Z]{2}$/u.test(profile.country as string)) throw invalid("country", "ISO 3166 alpha-2");
    await billingRow(db, db.tenantId, deps.now());
    await db.query("update tenant_billing set profile = $2 where tenant_id = $1", [db.tenantId, JSON.stringify(profile)]);
    c.set("auditTarget", { tenant_id: db.tenantId, fields: Object.keys(profile).join(",") });
    return c.json(profile);
  });

  app.post("/v1/tenants/:tenant_id/billing/payment-methods/setup", operation(deps, "startPaymentMethodSetup"), tenantAuth(deps, "billing"), async (c) => {
    const db = tenantDb(deps, c);
    own(c, db);
    const b = await body(c);
    if (b.provider !== "stripe") throw invalid("provider", "must be stripe");
    const row = await billingRow(db, db.tenantId, deps.now());
    // The tenant's Stripe Customer (#350), created on its first setup: the card is attached to it.
    let customer = typeof row.stripe_customer === "string" ? row.stripe_customer : null;
    if (customer === null) {
      const owner = (await db.query<Row>("select u.email from memberships m join users u on u.id = m.user_id where m.tenant_id = $1 and m.role = 'owner' limit 1", [db.tenantId]))[0]?.email;
      const profile = row.profile === null ? null : (JSON.parse(row.profile as string) as { legal_name?: string });
      customer = await psp.ensureCustomer(db.tenantId, { email: typeof owner === "string" ? owner : null, name: profile?.legal_name ?? null });
      await db.query("update tenant_billing set stripe_customer = $2 where tenant_id = $1", [db.tenantId, customer]);
    }
    const s = await psp.createSetup(db.tenantId, customer);
    await db.query("update tenant_billing set setup_id = $2 where tenant_id = $1", [db.tenantId, s.setup_id]);
    c.set("auditTarget", { tenant_id: db.tenantId, provider: "stripe" });
    return c.json({ provider: "stripe", ...s }, 201);
  });

  app.post("/v1/tenants/:tenant_id/billing/payment-methods", operation(deps, "confirmPaymentMethod"), tenantAuth(deps, "billing"), async (c) => {
    const db = tenantDb(deps, c);
    own(c, db);
    const b = await body(c);
    if (Object.keys(b).some((k) => k !== "setup_id")) throw invalid("body", "only setup_id; card data never comes here");
    const row = await billingRow(db, db.tenantId, deps.now());
    if (typeof b.setup_id !== "string" || b.setup_id !== row.setup_id) throw notFound();
    const pm = await psp.confirmSetup(b.setup_id);
    if (pm === null) throw conflict("setup_id", "not confirmed by the PSP");
    const now = deps.now();
    const method = { ...pm, provider: "stripe", added_at: now };
    await db.query("update tenant_billing set payment_method = $2, setup_id = null where tenant_id = $1", [db.tenantId, JSON.stringify(method)]);
    const previous = row.payment_method === null ? null : ((JSON.parse(row.payment_method as string) as { id?: string }).id ?? null);
    if (typeof row.stripe_customer === "string") await psp.setDefault(row.stripe_customer, pm.id, previous);
    // The new card pays the open invoices at once (#350); a paid one reinstates the tier down to the route table.
    await collectDue({ ...deps, db: crossTenant(deps.db, "a new card pays the tenant's open invoices; reinstating the tier publishes its route entries") }, db.tenantId, now, true);
    c.set("auditTarget", { tenant_id: db.tenantId, provider: "stripe", payment_method: pm.id });
    return c.json(method, 201);
  });

  app.get("/v1/tenants/:tenant_id/invoices", operation(deps, "listInvoices"), tenantAuth(deps, "billing"), async (c) => {
    const db = tenantDb(deps, c);
    own(c, db);
    const rows = await db.query<Row>("select body from invoices where tenant_id = $1 order by issued_at desc limit 24", [db.tenantId]);
    return c.json({ items: rows.map((r) => JSON.parse(r.body as string)) });
  });

  app.get("/v1/tenants/:tenant_id/invoices/:invoice_id", operation(deps, "getInvoice"), tenantAuth(deps, "billing"), async (c) => {
    const db = tenantDb(deps, c);
    own(c, db);
    const r = (await db.query<Row>("select body from invoices where tenant_id = $1 and id = $2", [db.tenantId, c.req.param("invoice_id")]))[0];
    if (r === undefined) throw notFound();
    const inv = JSON.parse(r.body as string);
    // 0.5.1: `Accept: text/html` answers the bilingual tax invoice; the dashboard turns it into a PDF with ctx.pdf.
    const accept = c.req.header("accept") ?? "";
    if (/text\/html/iu.test(accept) && !/^\s*application\/json/iu.test(accept)) {
      const p = (await db.query<Row>("select profile from tenant_billing where tenant_id = $1", [db.tenantId]))[0]?.profile;
      const buyer = typeof p === "string" ? (JSON.parse(p) as { legal_name?: string; address?: string }) : {};
      c.header("cache-control", "no-store");
      return c.html(invoiceHtml(inv, { legal_name: buyer.legal_name ?? "", address: buyer.address ?? "" }));
    }
    return c.json(inv);
  });

  app.post("/v1/billing/webhooks/:provider", operation(deps, "billingWebhook"), async (c) => {
    if (c.req.param("provider") !== "stripe") throw notFound();
    const secret = psp.webhookSecret();
    const raw = await readBody(c, 256 * 1024);
    if (secret === null || !stripeVerified(secret, c.req.header("stripe-signature") ?? "", raw, deps.now())) throw new ApiError("RENOX_UNAUTHENTICATED");
    let ev: { id?: string; type?: string; data?: { object?: { id?: string; metadata?: Record<string, string>; last_payment_error?: { code?: string; decline_code?: string } } } };
    try {
      ev = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      throw invalid("body", "not JSON");
    }
    if (typeof ev.id !== "string" || typeof ev.type !== "string") throw invalid("id", "required");
    const now = deps.now();
    const fresh = await deps.db.query("insert into billing_events (provider, event_id, received_at) values ('stripe', $1, $2) on conflict do nothing returning event_id", [ev.id, now]);
    if (fresh.length === 0) return c.json({ received: true, duplicate: true });
    const tenantId = ev.data?.object?.metadata?.tenant_id;
    if (typeof tenantId === "string") {
      const known = await deps.db.query("select 1 from tenants where id = $1", [tenantId]);
      if (known.length > 0) {
        if (ev.type === "charge.dispute.created") await setTierState(deps, deps.db, tenantId, "suspended", now);
        const invoiceId = ev.data?.object?.metadata?.invoice_id;
        if (ev.type === "invoice.paid") {
          if (typeof invoiceId === "string") await markInvoicePaid(deps, tenantId, invoiceId, now);
          const row = await billingRow(deps.db, tenantId, now);
          await setTierState(deps, deps.db, tenantId, reinstate(row.state as TierState), now);
        }
        // The off-session charge of an invoice (#350): the same result as the synchronous answer, once.
        if (ev.type === "payment_intent.succeeded" && typeof invoiceId === "string") await markInvoicePaid(deps, tenantId, invoiceId, now, ev.data?.object?.id ?? null);
        if (ev.type === "payment_intent.payment_failed" && typeof invoiceId === "string")
          await deps.db.query("update invoices set decline_code = $3 where tenant_id = $1 and id = $2 and status = 'open'", [tenantId, invoiceId, ev.data?.object?.last_payment_error?.decline_code ?? ev.data?.object?.last_payment_error?.code ?? "declined"]);
      }
    }
    c.set("auditTarget", { provider: "stripe", event_id: ev.id, type: ev.type, tenant: tenantId ?? "" });
    return c.json({ received: true });
  });
}

/** One tick of the tier machine for a tenant (the hourly job runs it). */
export async function tickTier(deps: Deps, tenantId: string, overQuota: boolean, now: number): Promise<TierState> {
  const row = await billingRow(deps.db, tenantId, now);
  const unpaid = (await deps.db.query<Row>("select min(issued_at) as t from invoices where tenant_id = $1 and status = 'open'", [tenantId]))[0]?.t;
  const to = nextState({
    state: row.state as TierState,
    since: num(row.state_since),
    now,
    overQuota,
    paid: row.plan !== "free",
    unpaidSince: unpaid === null || unpaid === undefined ? null : num(unpaid),
  });
  await setTierState(deps, deps.db, tenantId, to, now);
  return to;
}
