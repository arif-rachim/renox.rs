// GET /billing: Usage and billing (docs/19-platform-wireframes.md 3.13; #325;
// deploy-api.md 0.5.1 section 20, "Owner token rule"). The dashboard signs in
// with the user's own token (D23), and the API accepts the owner's token on
// the billing operations: a member's token is answered 403 and the page says
// billing is the owner's. Starting a card setup, confirming it, and a change
// to a paid plan need a recent second factor with the token; on
// `step_up_required` the page asks for a code inline and retries.
//
// POST ?/plan (plan), ?/card_setup, ?/card_confirm (setup_id, from
// public/billing.js after Stripe's form), ?/verify (code, then, plan).
// Card numbers never reach the dashboard or the API: Stripe's form takes them
// in its own frame and the page sends only the setup id.
import type { ActionContext, LoaderContext } from "renox";

import { apiBase, type Api, type ApiFailure, type Billing, type Invoice, needsStepUp, type PaymentSetup, type Plan, type Result } from "../../lib/api.ts";
import { problem, type Problem, signedIn } from "../../lib/guard.ts";
import { trOf } from "../../lib/i18n.ts";
import { clock } from "../../lib/view.ts";

const RETRY = ["plan", "card_setup", "card_confirm"] as const;
type Retry = (typeof RETRY)[number];

const CODE = /^[a-z0-9 -]{6,24}$/iu;
const PLAN = /^[a-z]{1,16}$/u;
const SETUP = /^seti_[A-Za-z0-9]{8,64}$/u;

interface View {
  notice: string | null;
  problem: Problem | null;
  step_up: { then: Retry; plan: string | null } | null;
  setup: PaymentSetup | null;
}

const empty = (): View => ({ notice: null, problem: null, step_up: null, setup: null });

/** The signed-in user's tenant: the API scopes every app to it, so the first app names it. */
async function tenantOf(api: Api): Promise<Result<string | null>> {
  const apps = await api.listApps();
  if (!apps.ok) return apps;
  return { ok: true, value: apps.value.apps[0]?.tenant_id ?? null };
}

const notOwner = (f: ApiFailure): boolean => f.status === 403 && !needsStepUp(f);

/** A refused code is the API's 401 with `field: "mfa"`: shown, and the sign-in kept (as pages/account/security.ts). */
const codeRefused = (f: ApiFailure): boolean =>
  f.status === 401 && f.details.some((d) => typeof d === "object" && d !== null && (d as { field?: unknown }).field === "mfa");

function shown(b: Billing, plans: Plan[]) {
  return {
    plan: b.plan,
    pending_plan: b.pending_plan,
    state: b.state,
    period: `${clock(b.period.start).slice(0, 10)} – ${clock(b.period.end).slice(0, 10)}`,
    estimate: b.estimate,
    over_quota: b.signal.over_quota.length === 0 ? null : b.signal.over_quota.join(", "),
    anomaly: b.signal.anomaly,
    card: b.payment_method === null ? null : `${b.payment_method.brand} •••• ${b.payment_method.last4} (${String(b.payment_method.exp_month).padStart(2, "0")}/${b.payment_method.exp_year})`,
    plans: plans.map((p) => ({ id: p.id, name: p.name ?? p.id, price: p.price_month, current: p.id === b.plan })),
  };
}

const invoiceRows = (items: Invoice[]) =>
  items.map((i) => ({ id: i.id, issued: clock(i.issued_at).slice(0, 10), total: `${i.total} ${i.currency}`, status: i.status, pdf: `/billing/invoices/${encodeURIComponent(i.id)}` }));

async function page(ctx: LoaderContext | ActionContext, api: Api, view: View) {
  const base = { signed_in: true, impersonation: api.impersonation, api_host: new URL(apiBase(ctx.secrets)).host, section: "billing", owner_only: false, no_tenant: false, billing: null, invoices: [] as ReturnType<typeof invoiceRows>, has_invoices: false, ...view };
  const tenant = await tenantOf(api);
  if (!tenant.ok) return { ...base, problem: view.problem ?? (await problem(ctx, tenant)) };
  if (tenant.value === null) return { ...base, no_tenant: true };
  const [b, plans, inv] = await Promise.all([api.getBilling(tenant.value), api.listPlans(), api.listInvoices(tenant.value)]);
  if (!b.ok) return notOwner(b) ? { ...base, owner_only: true } : { ...base, problem: view.problem ?? (await problem(ctx, b)) };
  const invoices = inv.ok ? invoiceRows(inv.value.items) : [];
  return { ...base, billing: shown(b.value, plans.ok ? plans.value.plans : []), invoices, has_invoices: invoices.length > 0 };
}

export async function load(ctx: LoaderContext) {
  const api = await signedIn(ctx);
  if (api instanceof Response) return api;
  return page(ctx, api, empty());
}

const field = (ctx: ActionContext, name: string): string => {
  const v = ctx.form.get(name);
  return typeof v === "string" ? v.trim() : "";
};

async function run(ctx: ActionContext, api: Api, action: Retry, arg: string) {
  const tenant = await tenantOf(api);
  if (!tenant.ok || tenant.value === null) return page(ctx, api, empty());
  const t = tenant.value;
  const tr = trOf(ctx);
  const after = async <T>(r: Result<T>, ok: (v: T) => Partial<View>) => {
    if (!r.ok) {
      if (needsStepUp(r)) return page(ctx, api, { ...empty(), step_up: { then: action, plan: action === "plan" ? arg : action === "card_confirm" ? arg : null } });
      return page(ctx, api, { ...empty(), problem: await problem(ctx, r) });
    }
    return page(ctx, api, { ...empty(), ...ok(r.value) });
  };
  switch (action) {
    case "plan":
      if (!PLAN.test(arg)) return page(ctx, api, { ...empty(), notice: tr("dash.billing.choose_plan") });
      return after(await api.changePlan(t, arg), (v) => ({ notice: v.pending_plan !== null ? tr("dash.billing.plan_pending", { plan: v.pending_plan }) : tr("dash.billing.plan_now", { plan: v.plan }) }));
    case "card_setup":
      return after(await api.startPaymentMethodSetup(t), (v) => ({ setup: v }));
    case "card_confirm":
      if (!SETUP.test(arg)) return page(ctx, api, { ...empty(), notice: tr("dash.billing.card_unfinished") });
      return after(await api.confirmPaymentMethod(t, arg), (v) => ({ notice: tr("dash.billing.card_saved", { brand: v.brand, last4: v.last4 }) }));
  }
}

const withApi =
  (fn: (ctx: ActionContext, api: Api) => Promise<unknown>) =>
  async (ctx: ActionContext): Promise<unknown> => {
    const api = await signedIn(ctx);
    if (api instanceof Response) return api;
    return fn(ctx, api);
  };

export const actions = {
  plan: withApi((ctx, api) => run(ctx, api, "plan", field(ctx, "plan"))),
  card_setup: withApi((ctx, api) => run(ctx, api, "card_setup", "")),
  card_confirm: withApi((ctx, api) => run(ctx, api, "card_confirm", field(ctx, "setup_id"))),

  verify: withApi(async (ctx, api) => {
    const code = field(ctx, "code");
    const then = field(ctx, "then") as Retry;
    const arg = field(ctx, "arg");
    const again = RETRY.includes(then) ? { then, plan: arg === "" ? null : arg } : null;
    if (!CODE.test(code)) return page(ctx, api, { ...empty(), step_up: again, notice: trOf(ctx)("dash.common.enter_code") });
    const method = /^\d{6}$/u.test(code.replace(/\s/gu, "")) ? "totp" : "recovery";
    const r = await api.verifyMfa({ method, code: method === "totp" ? code.replace(/\s/gu, "") : code });
    if (!r.ok) {
      const p = codeRefused(r) ? { code: r.code, message: trOf(ctx)("dash.billing.code_refused"), status: r.status, request_id: r.requestId, signed_out: false, details: [] } : await problem(ctx, r);
      return page(ctx, api, { ...empty(), step_up: again, problem: p });
    }
    return RETRY.includes(then) ? run(ctx, api, then, arg) : page(ctx, api, { ...empty(), notice: trOf(ctx)("dash.common.verified") });
  }),
};
