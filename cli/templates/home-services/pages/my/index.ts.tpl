// GET /my: the customer portal's home (#774), for a portal user only
// (lib/portal.ts requirePortal: a signed-out visitor goes to phone sign-in,
// staff go to `/`). The greeting, the phone they signed in with, how many
// customer records they are linked to and, while their account has no name,
// the one-field form "Your name". POST ?/name sets it (auth.setDisplayName);
// an invalid name is a 422 naming the field. POST ?/signout ends the session.
// Everything the page reads of the company's data comes from `customerDb`.
import type { ActionContext, LoaderContext } from "@renoxium/sdk";
import { auth } from "renox:modules";

import { invalid } from "../../lib/invalid";
import { shell } from "../../lib/page";
import { requirePortal, signOut } from "../../lib/portal";

const seeOther = (to: string): Response => new Response(null, { status: 303, headers: { location: to, "cache-control": "no-store" } });

export async function load(ctx: LoaderContext) {
  const gate = await requirePortal(ctx);
  if (gate instanceof Response) return gate;
  const page = await shell(ctx);
  const customers = await gate.cdb.customers();
  return {
    ...page,
    name: gate.portal.name,
    phone: gate.portal.phone,
    linked: customers.length,
    saved: ctx.url.searchParams.get("saved") === "name",
    values: {},
    errors: {},
  };
}

export const actions = {
  async name(ctx: ActionContext) {
    const gate = await requirePortal(ctx);
    if (gate instanceof Response) return gate;
    const page = await shell(ctx);
    const raw = ctx.form.get("display_name");
    const value = typeof raw === "string" ? raw.trim() : "";
    if (value.length < 1 || value.length > 80) return invalid(page.locale, ctx.form, { display_name: "portal.name.err" });
    const r = await auth.setDisplayName(value);
    if ("error" in r) return invalid(page.locale, ctx.form, { display_name: "portal.name.err" });
    return seeOther("/my?saved=name");
  },

  async signout() {
    return signOut();
  },
};
