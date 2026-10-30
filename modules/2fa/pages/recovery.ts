// GET <mount>/recovery: how many codes are left; POST ?/regenerate (after
// a recent verification) makes a new set, shown once.
import * as core from "../lib/core.ts";
import { type Page, signedIn } from "../lib/page.ts";

async function view(ctx: Page, s: core.Session, codes: string[] | null, error: string | null) {
  return { left: await core.recoveryLeft(ctx, s.user.id), codes, error, back_url: core.basePath(ctx), verify_url: `${core.basePath(ctx)}/verify?next=${encodeURIComponent(`${core.basePath(ctx)}/recovery`)}` };
}

export const load = signedIn((ctx, s) => view(ctx, s, null, null));

export const actions = {
  regenerate: signedIn(async (ctx, s) => {
    if (!(await core.isEnrolled(ctx, s.user.id))) return view(ctx, s, null, "Turn on a second factor first.");
    if (!(await core.recent(ctx))) return view(ctx, s, null, "Confirm it is you with your second factor first.");
    return view(ctx, s, await core.newRecoveryCodes(ctx, s.user.id), null);
  }),
};
