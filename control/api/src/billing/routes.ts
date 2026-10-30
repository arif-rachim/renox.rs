// Platform billing in AED (#325; deploy-api.md 0.5 section 20). Every
// operation but listPlans and billingWebhook takes the session permission
// `billing` (owner only). Card data never reaches this API: the PSP's
// setup intent is created here, confirmed in the browser, and only its
// payment method id, brand, last four digits and expiry are kept.

import { createHmac, timingSafeEqual } from "node:crypto";

import { aed, fils, nextState, PLANS, planOf, reinstate, tenantUsage, vatOf, VAT_RATE, type TierState } from "@renox/billing";
import type { Context, Hono } from "hono";

import { operation } from "../audit.ts";
import { tenantAuth } from "../auth/middleware.ts";
import type { Deps, Env } from "../context.ts";
import { num, type Db } from "../db/db.ts";
import { ApiError, conflict, invalid, notFound } from "../errors.ts";
import { pathParam, readBody } from "../http.ts";
import { onTenantState } from "../routes/activation.ts";
import { requestScope, tenantDb } from "../tenancy/scope.ts";
import { newTenantRestrictions } from "../tenants/erasure.ts";

type Row = Record<string, unknown>;

/** The PSP as this API uses it (Stripe UAE first). Tests replace it. */
export interface Psp {
  createSetup(tenantId: string): Promise<{ setup_id: string; client_secret: string; publishable_key: string }>;
  /** The confirmed setup's payment method, or null when it is not confirmed. */
  confirmSetup(setupId: string): Promise<{ id: string; brand: string; last4: string; exp_month: number; exp_year: number } | null>;
  webhookSecret(): string | null;
}

/** Stripe over its REST API with the platform's secret key (`STRIPE_SECRET_KEY`). */
export const stripePsp: Psp = {
  async createSetup(tenantId) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new ApiError("RENOX_UNAVAILABLE");
    const res = await fetch("https://api.stripe.com/v1/setup_intents", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ "metadata[tenant_id]": tenantId, usage: "off_session" }),
    }).catch(() => null);
    if (res === null || !res.ok) throw new ApiError("RENOX_UNAVAILABLE");
    const j = (await res.json()) as { id: string; client_secret: string };
    return { setup_id: j.id, client_secret: j.client_secret, publishable_key: process.env.STRIPE_PUBLISHABLE_KEY ?? "" };
  },
  async confirmSetup(setupId) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new ApiError("RENOX_UNAVAILABLE");
    const res = await fetch(`https://api.stripe.com/v1/setup_intents/${encodeURIComponent(setupId)}?expand[]=payment_method`, { headers: { authorization: `Bearer ${key}` } }).catch(() => null);
    if (res === null || !res.ok) throw new ApiError("RENOX_UNAVAILABLE");
    const j = (await res.json()) as { status: string; payment_method?: { id: string; card?: { brand: string; last4: string; exp_month: number; exp_year: number } } };
    if (j.status !== "succeeded" || !j.payment_method?.card) return null;
    const c = j.payment_method.card;
    return { id: j.payment_method.id, brand: c.brand, last4: c.last4, exp_month: c.exp_month, exp_year: c.exp_year };
  },
  webhookSecret: () => process.env.STRIPE_WEBHOOK_SECRET ?? null,
};

let psp: Psp = stripePsp;

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
    const s = await psp.createSetup(db.tenantId);
    await billingRow(db, db.tenantId, deps.now());
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
    const method = { ...pm, provider: "stripe", added_at: deps.now() };
    await db.query("update tenant_billing set payment_method = $2, setup_id = null where tenant_id = $1", [db.tenantId, JSON.stringify(method)]);
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
    return c.json(JSON.parse(r.body as string));
  });

  app.post("/v1/billing/webhooks/:provider", operation(deps, "billingWebhook"), async (c) => {
    if (c.req.param("provider") !== "stripe") throw notFound();
    const secret = psp.webhookSecret();
    const raw = await readBody(c, 256 * 1024);
    if (secret === null || !stripeVerified(secret, c.req.header("stripe-signature") ?? "", raw, deps.now())) throw new ApiError("RENOX_UNAUTHENTICATED");
    let ev: { id?: string; type?: string; data?: { object?: { metadata?: Record<string, string> } } };
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
        if (ev.type === "invoice.paid") {
          const invoiceId = ev.data?.object?.metadata?.invoice_id;
          if (typeof invoiceId === "string") {
            const r = (await deps.db.query<Row>("select body from invoices where tenant_id = $1 and id = $2", [tenantId, invoiceId]))[0];
            if (r !== undefined) {
              const inv = { ...JSON.parse(r.body as string), status: "paid", paid_at: now };
              await deps.db.query("update invoices set status = 'paid', paid_at = $3, body = $4 where tenant_id = $1 and id = $2", [tenantId, invoiceId, now, JSON.stringify(inv)]);
            }
          }
          const row = await billingRow(deps.db, tenantId, now);
          await setTierState(deps, deps.db, tenantId, reinstate(row.state as TierState), now);
        }
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
