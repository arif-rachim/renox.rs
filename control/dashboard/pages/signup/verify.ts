// GET /signup/verify#token=…, POST /signup/verify: the address verification
// link of the sign-up email (deploy-api.md 0.5 section 21, `verifyEmail`;
// #326). The token is in the URL fragment, which the browser never sends to
// a server; the page's script copies it into the form and submits it once.
import type { ActionContext, LoaderContext } from "renox";

import { verifyAccount } from "../../lib/api.ts";
import { applyLocale } from "../../lib/locale.ts";

const TOKEN = /^[a-z2-7]{32}$/u;

export function load(ctx: LoaderContext) {
  const lang = applyLocale(ctx);
  if (lang !== null) return lang;
  return { verified: false, tenant_id: null as string | null, error: null as string | null };
}

export const actions = {
  async default(ctx: ActionContext) {
    applyLocale(ctx);
    const { fetch, form, secrets } = ctx;
    const raw = form.get("token");
    const token = typeof raw === "string" ? raw.trim() : "";
    if (!TOKEN.test(token)) return { verified: false, tenant_id: null, error: "This link is not complete. Open the link from the email again." };
    const r = await verifyAccount(fetch, secrets, token);
    if (!r.ok) return { verified: false, tenant_id: null, error: r.status === 404 ? "This link was already used or has expired. Sign in and ask for a new one." : r.status === 429 ? "Too many attempts; try again later." : r.message };
    return { verified: true, tenant_id: r.value.tenant_id ?? null, error: null };
  },
};
