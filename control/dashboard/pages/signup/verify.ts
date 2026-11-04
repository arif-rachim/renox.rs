// GET /signup/verify#token=…: the address verification link of the sign-up
// email (deploy-api.md 0.5 section 21, `verifyEmail`; #326, #445). The token
// is in the URL fragment, which the browser never sends to a server; the
// page's script (public/account.js) posts it to the control API itself, so
// the API signs this browser in, and then continues to /signin?continue=1,
// which turns that session into the dashboard's sign-in. No detour through
// the CLI.
import type { LoaderContext } from "@renoxium/sdk";

import { apiBase } from "../../lib/api.ts";
import { INSTALL_URL } from "../../lib/install.ts";
import { applyLocale } from "../../lib/locale.ts";

export function load(ctx: LoaderContext) {
  const lang = applyLocale(ctx);
  if (lang !== null) return lang;
  return { api: apiBase(ctx.secrets), install_url: INSTALL_URL };
}
