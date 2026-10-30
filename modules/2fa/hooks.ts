// The 2fa module fills two of auth's hooks (#287): `auth.after_login`
// sends a user with a second factor to the verify page, and
// `auth.principal` sets `mfa_verified`.
import * as core from "./lib/core.ts";

export const hooks = {
  "auth.after_login": {
    handle: (ctx: core.TwofaCtx, args: { user_id: string; next?: string; resume?: string }) => core.afterLogin(ctx, args),
  },
  "auth.principal": {
    handle: (ctx: core.TwofaCtx, args: { principal: { id: string; attrs: Record<string, unknown> } }) => core.principalFiller(ctx, args),
  },
};
