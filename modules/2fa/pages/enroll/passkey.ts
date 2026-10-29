// GET <mount>/enroll/passkey: register a passkey as a second factor; its
// script runs `navigator.credentials.create` and posts the attestation.
import * as core from "../../lib/core.ts";
import { type Page, redirect, signedIn } from "../../lib/page.ts";

const off = () => new Response("Not found", { status: 404 });

export const load = signedIn(async (ctx, s) => (ctx.config.allow_passkeys === false ? off() : { options: JSON.stringify(await core.passkeyRegistrationOptions(ctx, s.user)), error: null }));

export const actions = {
  default: signedIn(async (ctx, s) => {
    if (ctx.config.allow_passkeys === false) return off();
    const ok = await core.finishPasskeyRegistration(ctx, s.user.id, { clientDataJSON: ctx.form.get("client_data"), attestationObject: ctx.form.get("attestation_object"), name: ctx.form.get("name") });
    if (!ok) return { options: JSON.stringify(await core.passkeyRegistrationOptions(ctx, s.user)), error: core.GENERIC_ERROR };
    await core.markVerified(ctx, s.id, s.user.id, "passkey");
    if ((await core.recoveryLeft(ctx, s.user.id)) === 0) await core.newRecoveryCodes(ctx, s.user.id);
    return redirect(core.basePath(ctx));
  }),
};
