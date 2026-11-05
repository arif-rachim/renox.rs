// GET /account/tokens: the tenant's tokens (#446): create one with a name,
// scopes and an expiry (the value is shown once, in this browser only),
// list them with their last use, revoke one. The calls go from the browser
// to the control API with the API session (public/account.js), so the
// step-up rule for users with a second factor applies (`createToken`,
// `revokeToken`), and the dashboard's own token never needs `tokens:write`
// (lib/scopes.ts).
import type { LoaderContext } from "@renoxium/sdk";

import { apiBase } from "../../lib/api.ts";
import { frame, signedIn } from "../../lib/guard.ts";
import { ROLE_GRANTABLE } from "../../lib/scopes.ts";

export async function load(ctx: LoaderContext) {
  const api = await signedIn(ctx);
  if (api instanceof Response) return api;
  return { ...frame(ctx, api, "tokens"), api: apiBase(ctx.secrets), grantable_json: JSON.stringify(ROLE_GRANTABLE) };
}
