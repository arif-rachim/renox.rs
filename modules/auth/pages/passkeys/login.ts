// GET <mount>/passkeys/login: sign in with a passkey (#291). The page
// carries the options; its script runs `navigator.credentials.get` and
// posts the assertion to ?/default, which verifies it (lib/passkeys.ts).
// Off unless config `passkeys`.
import { type AuthCtx, currentUser, redirectWith } from "../../lib/core.ts";
import { localized } from "../../lib/locale.ts";
import { finishLogin, loginOptions } from "../../lib/passkeys.ts";

type Page = AuthCtx & { url: URL; form: FormData };

const off = () => new Response("Not found", { status: 404 });

async function view(ctx: Page, next: string, error: string | null) {
  return { next, options: JSON.stringify(await loginOptions(ctx)), error };
}

export const load = localized(async (ctx: Page) => {
  if (ctx.config.passkeys !== true) return off();
  const next = ctx.url.searchParams.get("next") ?? "/";
  if ((await currentUser(ctx)) !== null) return redirectWith(next, []);
  return view(ctx, next, null);
});

export const actions = {
  default: localized(async (ctx: Page) => {
    if (ctx.config.passkeys !== true) return off();
    const f = (k: string) => ctx.form.get(k);
    const next = String(f("next") ?? "/");
    const r = await finishLogin(ctx, { credentialId: f("credential_id"), clientDataJSON: f("client_data"), authenticatorData: f("authenticator_data"), signature: f("signature") }, next);
    if (!r.ok) return view(ctx, next, r.error);
    if (r.halt) return r.halt;
    return redirectWith(next, [r.cookie]);
  }),
};
