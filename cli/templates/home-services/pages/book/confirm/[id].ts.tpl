// GET /book/confirm/<draft>: the last step of /book (#775), for a portal user
// (lib/portal.ts requirePortal: a signed-out visitor goes to phone sign-in and
// comes back here). The draft must exist and be the signed-in user's: its
// phone is their verified phone, else 404. An expired hold sends them back to
// step 2 ("That time was just taken"). The page shows the summary and one
// button; POST ?/confirm makes the job in the action's transaction
// (lib/book.ts confirmDraft) and goes to `/my?booked=<number>`. As on /my,
// requirePortal is the gate and there is no `guard` (portal.book): the
// `customer` role is assigned during the first request after the sign-in,
// after the principal was resolved, so a guard would refuse that request.
import type { ActionContext, LoaderContext } from "@renoxium/sdk";

import { areasOf, confirmDraft, findDraft, step2Of, type DraftRow } from "../../../lib/book";
import { emirateOptions } from "../../../lib/forms";
import { shell } from "../../../lib/page";
import { requirePortal, signOut, type PortalUser } from "../../../lib/portal";
import { clock } from "../../../lib/booking-sync";
import { day as dayOf } from "../../../lib/quotes";

const notFound = (): Response => new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
const seeOther = (to: string): Response => new Response(null, { status: 303, headers: { location: to, "cache-control": "no-store" } });

/** The user's draft, a redirect back to step 2 when its hold expired, or a 404. */
async function draftOf(ctx: LoaderContext | ActionContext, portal: PortalUser): Promise<DraftRow | Response> {
  const d = await findDraft(ctx.db, ctx.params.id);
  if (d === null || d.phone !== portal.phone) return notFound();
  if (d.expires_at <= Math.floor(Date.now() / 1000)) return seeOther(`/book?${step2Of(d)}`);
  return d;
}

export async function load(ctx: LoaderContext) {
  const gate = await requirePortal(ctx);
  if (gate instanceof Response) return gate;
  const d = await draftOf(ctx, gate.portal);
  if (d instanceof Response) return d;
  const page = await shell(ctx);
  const lang = page.locale === "ar" ? "ar" : "en";
  const service = await ctx.db.queryOne<{ name_en: string; name_ar: string }>("select name_en, name_ar from app__services where id = ?", [d.service_id]);
  const areaName = (await areasOf(d.emirate)).find((a) => a.name_en === d.area);
  return {
    ...page,
    draft: {
      id: d.id,
      service: (lang === "ar" ? service?.name_ar : service?.name_en) ?? "",
      address: d.address,
      area: (lang === "ar" ? areaName?.name_ar : areaName?.name_en) ?? d.area,
      emirate: emirateOptions(page.locale).find((e) => e.code === d.emirate)?.name ?? d.emirate,
      name: d.name,
      phone: d.phone,
      day: dayOf(d.slot_start),
      from: clock(d.slot_start),
      to: clock(d.slot_end),
    },
  };
}

export const actions = {
  async confirm(ctx: ActionContext) {
    const gate = await requirePortal(ctx);
    if (gate instanceof Response) return gate;
    const d = await draftOf(ctx, gate.portal);
    if (d instanceof Response) return d;
    const made = await confirmDraft(ctx, gate.portal, d);
    if (made === "taken") return seeOther(`/book?${step2Of(d)}`);
    return seeOther(`/my?booked=${encodeURIComponent(made.number)}`);
  },

  async signout() {
    return signOut();
  },
};
