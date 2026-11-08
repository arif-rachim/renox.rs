// GET /signup: a new account and tenant (deploy-api.md 0.5 section 21,
// `signup`; #326). The browser sends the form to the control API itself
// (public/account.js, #445): the API's per-IP sign-up bucket must see the
// person's address, not the node's (ADR D23), so the dashboard never proxies
// it and the password never reaches the dashboard. The data processing
// agreement and the terms must be accepted (their versions are on /legal/dpa
// and /legal/terms and the API records the version on the tenant). The API
// answers "check your email" whether or not the address has an account, so
// the page says the same in both cases.
import type { ActionContext, LoaderContext } from "@renoxium/sdk";

import { apiBase } from "../../lib/api.ts";
import { trOf } from "../../lib/i18n.ts";
import { applyLocale, chooseLocale } from "../../lib/locale.ts";

/** deploy-api.yaml `TenantId`. */
export const TENANT_ID = /^[a-z0-9][a-z0-9_-]{0,62}$/u;

/**
 * #540: the Cloudflare Turnstile site key (`RENOX_CAPTCHA_SITE_KEY`, public by
 * design, per deployment). Empty, or anything outside a key's alphabet, means
 * no widget: local and dev mode stay as they were.
 */
export function captchaSiteKey(secrets: Record<string, string | undefined>): string {
  const raw = (secrets.RENOX_CAPTCHA_SITE_KEY ?? "").trim();
  return /^[0-9A-Za-z_-]{1,64}$/u.test(raw) ? raw : "";
}

/** The widget's `data-language` follows the page's locale (EN or AR). */
const captchaLang = (ctx: LoaderContext | ActionContext): string => chooseLocale(ctx.url, ctx.headers).locale;

export function load(ctx: LoaderContext) {
  const lang = applyLocale(ctx);
  if (lang !== null) return lang;
  const api = apiBase(ctx.secrets);
  return { api, api_host: new URL(api).host, error: null as string | null, captcha_site_key: captchaSiteKey(ctx.secrets), captcha_lang: captchaLang(ctx) };
}

export const actions = {
  /** A form posted without the page's script: the sign-up needs it (D23). Nothing is sent anywhere. */
  default(ctx: ActionContext) {
    applyLocale(ctx);
    const api = apiBase(ctx.secrets);
    return { api, api_host: new URL(api).host, error: trOf(ctx)("dash.account.needs_js"), captcha_site_key: captchaSiteKey(ctx.secrets), captcha_lang: captchaLang(ctx) };
  },
};
