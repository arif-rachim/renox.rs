// GET /device[?code=XXXX-XXXX]: approve or deny a `renox login` request
// (#446). `renox login` prints this page's URL with the code filled in. The
// page is for signed-in users only. Looking the request up, approving and
// denying are calls of the browser to the control API with the API session
// and its CSRF header (public/account.js), because only a person in a
// browser may approve a device: the API refuses a token for
// `approveDeviceLogin` (ADR D23). The person sees the device's name and the
// scopes it will get (the role's token scopes, lib/scopes.ts), and may
// narrow them.
import type { LoaderContext } from "@renoxium/sdk";

import { apiBase } from "../lib/api.ts";
import { frame, signedIn } from "../lib/guard.ts";
import { ROLE_GRANTABLE } from "../lib/scopes.ts";

/** A user code as `renox login` prints it (eight letters, XXXX-XXXX); anything else is dropped. */
export function codeParam(raw: string | null): string {
  const c = (raw ?? "").trim().toUpperCase();
  return /^[A-Z]{4}-?[A-Z]{4}$/u.test(c) ? (c.includes("-") ? c : `${c.slice(0, 4)}-${c.slice(4)}`) : "";
}

export async function load(ctx: LoaderContext) {
  const api = await signedIn(ctx);
  if (api instanceof Response) return api;
  const code = codeParam(ctx.url.searchParams.get("code"));
  const back = code === "" ? "/device" : `/device?code=${code}`;
  return {
    ...frame(ctx, api, "tokens"),
    api: apiBase(ctx.secrets),
    code,
    grantable_json: JSON.stringify(ROLE_GRANTABLE),
    signin_href: `/signin?next=${encodeURIComponent(back)}`,
  };
}
