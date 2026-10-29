// GET <mount>: the signed-in user's organisations and a form to create one.
// POST ?/create: a new organisation (the user its owner, now active).
// POST ?/switch: make another of the user's organisations active, then a
// 303 back to `next` (the switcher partial in the app's header posts here).
import * as core from "../lib/core.ts";
import { guarded, type Page, redirect, toLogin } from "../lib/page.ts";

async function view(ctx: Page, error: string | null, name = "") {
  const s = await core.session();
  if (s === null) return toLogin(ctx);
  const current = await core.currentOrg(ctx);
  const orgs = (await core.listOrgs(ctx, s.user.id)).map((o) => ({ ...o, current: o.id === current?.id }));
  return { user: s.user, orgs, has_orgs: orgs.length > 0, members_url: `${core.basePath(ctx)}/members`, error, name };
}

export const load = guarded((ctx) => view(ctx, null));

export const actions = {
  create: guarded(async (ctx) => {
    const name = String(ctx.form.get("name") ?? "");
    const r = await core.createOrg(ctx, { name, slug: String(ctx.form.get("slug") ?? "") });
    return r.ok ? redirect(`${core.basePath(ctx)}/members`) : view(ctx, r.error, name);
  }),
  switch: guarded(async (ctx) => {
    const r = await core.switchOrg(ctx, String(ctx.form.get("org") ?? ""));
    return r.ok ? redirect(core.safePath(ctx.form.get("next"))) : view(ctx, r.error);
  }),
};
