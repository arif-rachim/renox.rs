// GET /signin, POST /signin: sign in with a tenant token (lib/session.ts).
// The token is checked against the API (`GET /v1/apps`, `apps:read`) before
// it is stored, then the browser goes to `next`.
import { redirect, type ActionContext, type LoaderContext } from "renox";

import { Api, apiBase } from "../lib/api.ts";
import { nextPath } from "../lib/guard.ts";
import { KEY_SECRET, signIn, TOKEN_PATTERN } from "../lib/session.ts";

export function load({ url, secrets }: LoaderContext) {
  return {
    next: nextPath(url.searchParams.get("next")),
    api_host: new URL(apiBase(secrets)).host,
    configured: (secrets[KEY_SECRET]?.length ?? 0) >= 32,
    error: null,
  };
}

export const actions = {
  async default({ db, fetch, form, secrets, session, url }: ActionContext) {
    const raw = form.get("token");
    const token = typeof raw === "string" ? raw.trim() : "";
    const next = nextPath(String(form.get("next") ?? url.searchParams.get("next") ?? ""));
    if (!TOKEN_PATTERN.test(token)) return { next, error: "That is not a Renox token: it starts with renox_pat_ followed by 32 letters and digits." };
    if ((secrets[KEY_SECRET]?.length ?? 0) < 32) return { next, error: `The dashboard is not configured: set the ${KEY_SECRET} secret.` };
    const check = await new Api(fetch, token, apiBase(secrets)).listApps();
    if (!check.ok) {
      const error =
        check.status === 401
          ? "The control API refused this token (unknown, expired or revoked)."
          : check.status === 403
            ? "This token cannot list apps: it needs the apps:read scope."
            : `The control API could not be reached (${check.code}).`;
      return { next, error };
    }
    await signIn(db, secrets, session.id, token, Date.now());
    return redirect.safe(next, { fallback: "/apps" });
  },
};
