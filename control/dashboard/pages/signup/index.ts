// GET /signup, POST /signup: a new account and tenant (deploy-api.md 0.5
// section 21, `signup`; #326). The data processing agreement and the terms
// must be accepted (their versions are on /legal/dpa and /legal/terms and the
// API records the version on the tenant). The password passes through this
// action once, to the API, and is never stored, logged or rendered back. The
// API answers "check your email" whether or not the address has an account,
// so this page says the same in both cases.
import type { ActionContext, LoaderContext } from "renox";

import { apiBase, signupAccount } from "../../lib/api.ts";
import { trOf } from "../../lib/i18n.ts";
import { applyLocale } from "../../lib/locale.ts";

/** deploy-api.yaml `TenantId`. */
export const TENANT_ID = /^[a-z0-9][a-z0-9_-]{0,62}$/u;

export function load(ctx: LoaderContext) {
  const lang = applyLocale(ctx);
  if (lang !== null) return lang;
  const { secrets } = ctx;
  return { api_host: new URL(apiBase(secrets)).host, sent: false, error: null as string | null, email: "", tenant_id: "" };
}

export const actions = {
  async default(ctx: ActionContext) {
    applyLocale(ctx);
    const { fetch, form, secrets } = ctx;
    const field = (k: string) => {
      const v = form.get(k);
      return typeof v === "string" ? v : "";
    };
    const email = field("email").trim().toLowerCase();
    const password = field("password");
    const tenantId = field("tenant_id").trim();
    const back = { sent: false, email, tenant_id: tenantId };
    const tr = trOf(ctx);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) || email.length > 254) return { ...back, error: tr("dash.signup.err_email") };
    if (password.length < 12 || password.length > 1024) return { ...back, error: tr("dash.signup.err_password") };
    if (!TENANT_ID.test(tenantId)) return { ...back, error: tr("dash.signup.err_workspace") };
    if (form.get("dpa") !== "yes") return { ...back, error: tr("dash.signup.err_accept") };
    const r = await signupAccount(fetch, secrets, { email, password, tenant_id: tenantId, tenant_name: field("tenant_name").trim() || tenantId, dpa_accepted: true });
    if (!r.ok) {
      const reason = r.details.flatMap((d) => (typeof d === "object" && d !== null && typeof (d as { reason?: unknown }).reason === "string" ? [(d as { field?: string; reason: string }).field === "email" && (d as { reason: string }).reason === "disposable" ? tr("dash.signup.err_disposable") : `${(d as { field?: string }).field ?? "request"}: ${(d as { reason: string }).reason}`] : []))[0];
      const error = r.status === 409 ? tr("dash.signup.err_taken") : r.status === 429 ? tr("dash.signup.err_too_many") : (reason ?? r.message);
      return { ...back, error };
    }
    return { sent: true, error: null, email, tenant_id: "" };
  },
};
