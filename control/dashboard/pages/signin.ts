// GET /signin, POST /signin: sign in to the dashboard (#445, ADR D23).
//
// The primary way is the email and password of the user's account. The
// browser does it against the control API directly (public/account.js:
// login, the second factor, then a one-day `dashboard` token with the role's
// scopes of lib/scopes.ts), because the dashboard must not proxy the API's
// sign-in: its per-IP buckets would see the node's address for every user.
// The browser then posts that token here, like the operators' pasted token.
//
// The POST checks a token against the API (`GET /v1/apps`, `apps:read`)
// before it is stored (lib/session.ts), then the browser goes to `next`.
import { redirect, type ActionContext, type LoaderContext } from "@renoxium/sdk";

import { Api, apiBase } from "../lib/api.ts";
import { nextPath } from "../lib/guard.ts";
import { trOf } from "../lib/i18n.ts";
import { applyLocale } from "../lib/locale.ts";
import { DASHBOARD_TOKEN_DAYS, ROLE_SCOPES } from "../lib/scopes.ts";
import { KEY_SECRET, signIn, TOKEN_PATTERN } from "../lib/session.ts";

/** What every render of the page needs: where the browser signs in, and what it asks for. */
function page(ctx: LoaderContext | ActionContext, next: string) {
  const api = apiBase(ctx.secrets);
  return {
    here: "signin",
    next,
    api,
    api_host: new URL(api).host,
    scopes_json: JSON.stringify(ROLE_SCOPES),
    token_days: DASHBOARD_TOKEN_DAYS,
    configured: (ctx.secrets[KEY_SECRET]?.length ?? 0) >= 32,
    error: null as string | null,
  };
}

export function load(ctx: LoaderContext) {
  const lang = applyLocale(ctx);
  if (lang !== null) return lang;
  return page(ctx, nextPath(ctx.url.searchParams.get("next")));
}

export const actions = {
  async default(ctx: ActionContext) {
    applyLocale(ctx);
    const { db, fetch, form, secrets, session, url } = ctx;
    const raw = form.get("token");
    const token = typeof raw === "string" ? raw.trim() : "";
    const next = nextPath(String(form.get("next") ?? url.searchParams.get("next") ?? ""));
    const tr = trOf(ctx);
    const back = page(ctx, next);
    if (!TOKEN_PATTERN.test(token)) return { ...back, error: tr("dash.signin.not_token") };
    if ((secrets[KEY_SECRET]?.length ?? 0) < 32) return { ...back, error: tr("dash.signin.set_secret", { secret: KEY_SECRET }) };
    const check = await new Api(fetch, token, apiBase(secrets)).listApps();
    if (!check.ok) {
      const error =
        check.status === 401
          ? tr("dash.signin.refused")
          : check.status === 403
            ? tr("dash.signin.no_scope")
            : tr("dash.problem.unreachable_short", { code: check.code });
      return { ...back, error };
    }
    await signIn(db, secrets, session.id, token, Date.now());
    return redirect.safe(next, { fallback: "/apps" });
  },
};
