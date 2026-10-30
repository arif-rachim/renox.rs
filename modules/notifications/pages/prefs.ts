// GET <mount>/prefs: the signed-in user's channels per category; POST
// ?/set turns one on or off.
import * as core from "../lib/core.ts";
import { guarded, type Page } from "../lib/page.ts";

async function view(ctx: Page, notice: string | null) {
  core.me(ctx);
  const prefs = (await core.preferences(ctx)).map((p) => ({ ...p, toggle: p.enabled ? "0" : "1" }));
  return { prefs, has_prefs: prefs.length > 0, back_url: core.basePath(ctx), notice };
}

export const load = guarded((ctx) => view(ctx, null));

export const actions = {
  set: guarded(async (ctx) => {
    await core.setPreference(ctx, { category: ctx.form.get("category"), channel: ctx.form.get("channel"), enabled: ctx.form.get("enabled") });
    return view(ctx, "Saved.");
  }),
};
