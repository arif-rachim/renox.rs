// GET <mount>/passkeys/register: add a passkey to the signed-in account
// (#291). Its script runs `navigator.credentials.create` and posts the
// attestation to ?/default; then back to the account page.
import { type AuthCtx, currentUser, redirectWith } from "../../lib/core.ts";
import { localized } from "../../lib/locale.ts";
import { finishRegistration, registrationOptions } from "../../lib/passkeys.ts";

type Page = AuthCtx & { url: URL; form: FormData };

const off = () => new Response("Not found", { status: 404 });
const mountOf = (ctx: Page) => ctx.url.pathname.replace(/\/passkeys\/register\/?$/u, "");

export const load = localized(async (ctx: Page) => {
  if (ctx.config.passkeys !== true) return off();
  const user = await currentUser(ctx);
  if (user === null) return redirectWith(`${mountOf(ctx)}/login?next=${encodeURIComponent(ctx.url.pathname)}`, []);
  return { options: JSON.stringify(await registrationOptions(ctx, user)), error: null };
});

export const actions = {
  default: localized(async (ctx: Page) => {
    if (ctx.config.passkeys !== true) return off();
    const user = await currentUser(ctx);
    if (user === null) return redirectWith(`${mountOf(ctx)}/login`, []);
    const r = await finishRegistration(ctx, user, { clientDataJSON: ctx.form.get("client_data"), attestationObject: ctx.form.get("attestation_object"), name: ctx.form.get("name") });
    if (!r.ok) return { options: JSON.stringify(await registrationOptions(ctx, user)), error: r.error };
    return redirectWith(`${mountOf(ctx)}/account`, []);
  }),
};
