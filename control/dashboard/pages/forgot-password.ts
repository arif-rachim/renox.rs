// GET /forgot-password (#445): the browser asks the control API for a reset
// mail itself (`requestPasswordReset`, ADR D23: the mail bucket must see the
// person's address). The API answers "check your email" whether or not the
// address has an account, and so does the page.
import type { LoaderContext } from "@renoxium/sdk";

import { apiBase } from "../lib/api.ts";
import { applyLocale } from "../lib/locale.ts";

export function load(ctx: LoaderContext) {
  const lang = applyLocale(ctx);
  if (lang !== null) return lang;
  return { here: "signin", api: apiBase(ctx.secrets) };
}
