// GET <mount>/magic: ask for a sign-in link. POST ?/default: one mail
// through auth.send_mail; the same answer whether or not the account exists.
import type { AuthCtx } from "../../lib/core.ts";
import { sendLink } from "../../lib/tokens.ts";
import { localized } from "../../lib/locale.ts";

type Page = AuthCtx & { url: URL; form: FormData };

export const load = localized(async () => {
  return { message: null, email: "" };
});

export const actions = {
  default: localized(async (ctx: Page) => {
    const email = String(ctx.form.get("email") ?? "");
    return { message: await sendLink(ctx, "magic", email), email };
  }),
};
