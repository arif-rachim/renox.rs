// GET /my: the customer portal's home (#774, #776), for a portal user only
// (lib/portal.ts requirePortal: a signed-out visitor goes to phone sign-in,
// staff go to `/`). The greeting, the phone they signed in with, how many
// customer records they are linked to and, while their account has no name,
// the one-field form "Your name". POST ?/name sets it (auth.setDisplayName);
// an invalid name is a 422 naming the field. POST ?/signout ends the session.
// "Book a service" links to /book; `?booked=<number>` (from /book/confirm)
// says that booking was received.
//
// The lists (#776, lib/portal-view.ts): Upcoming (at most 10, soonest first),
// Past visits (10 a page, `?page=`) and the active Contracts, each with its
// empty state; the tile "Invoices" (#777: how many are open and what is left
// to pay on them) links to /my/invoices; a customer of two branches sees each item marked with its
// branch. While a visit is on its way or in progress the page reloads itself
// every minute (the portal layout's <meta http-equiv="refresh">). Everything
// the page reads of the company's data comes from `customerDb`.
import type { ActionContext, LoaderContext } from "@renoxium/sdk";
import { auth } from "renox:modules";

import { invalid } from "../../lib/invalid";
import { shell } from "../../lib/page";
import { requirePortal, signOut } from "../../lib/portal";
import { contractsOf, isLive, lookupsOf, openInvoicesOf, pageOf, pastOf, upcomingOf } from "../../lib/portal-view";

const seeOther = (to: string): Response => new Response(null, { status: 303, headers: { location: to, "cache-control": "no-store" } });

export async function load(ctx: LoaderContext) {
  const gate = await requirePortal(ctx);
  if (gate instanceof Response) return gate;
  const page = await shell(ctx);
  const lang = page.locale === "ar" ? "ar" : "en";
  const customers = await gate.cdb.customers();
  // After /book/confirm (#775): the booking's number, when it is one of theirs.
  const asked = ctx.url.searchParams.get("booked") ?? "";
  const booked = /^J-\d{6,}$/u.test(asked) && (await gate.cdb.jobByNumber(asked)) !== null ? asked : null;
  const jobs = await gate.cdb.jobs();
  const l = await lookupsOf(gate.cdb, lang);
  const upcoming = await upcomingOf(gate.cdb, jobs, l);
  return {
    ...page,
    name: gate.portal.name,
    phone: gate.portal.phone,
    linked: customers.length,
    saved: ctx.url.searchParams.get("saved") === "name",
    booked,
    upcoming,
    past: pastOf(jobs, l, pageOf(ctx.url.searchParams.get("page"))),
    contracts: await contractsOf(gate.cdb, jobs, l),
    invoices: await openInvoicesOf(gate.cdb),
    refresh: isLive(upcoming.map((u) => u.status)) ? "60" : null,
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
