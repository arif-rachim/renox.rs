// GET /reset-password#token=… (#445): the link of the reset mail
// (control/api/src/auth/notify.ts). The token stays in the fragment; the
// browser posts it with the new password to the control API itself
// (`confirmPasswordReset`), which signs out every session of the account.
import type { LoaderContext } from "@renoxium/sdk";

import { apiBase } from "../lib/api.ts";
import { applyLocale } from "../lib/locale.ts";

export function load(ctx: LoaderContext) {
  const lang = applyLocale(ctx);
  if (lang !== null) return lang;
  return { here: "signin", api: apiBase(ctx.secrets) };
}
