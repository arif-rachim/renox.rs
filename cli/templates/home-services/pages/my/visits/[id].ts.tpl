// GET /my/visits/<job id>: one visit of the signed-in customer (#776), for a
// portal user only (lib/portal.ts requirePortal, as on /my). Another
// customer's job, or an id that is not one, is a 404 (never a 403: the page
// does not tell that the id exists). The timeline in the customer's words,
// the time, the address, the notes they gave when they booked, the
// technician's first name and the branch's phone (lib/portal-view.ts
// visitOf, through `customerDb` only). Internal notes, costs, other
// customers' names and the technician's last name or phone are never read.
// A done visit also shows its report (#777, lib/portal-view.ts reportOf):
// what was done, the parts used with their quantities (no prices), the photos
// before and after, who signed and when, and "Download report (PDF)"
// (/my/visits/<id>/report). A thumbnail goes through `<x-image>`, whose URL
// is the platform's image path with a link signed for an hour, made here only
// for a photo customerDb found on this customer's visit; each thumbnail links
// to /my/visits/<id>/photo/<n>, which checks the session on every request.
import type { LoaderContext } from "@renoxium/sdk";
import { storage } from "renox:modules";

import { shell } from "../../../lib/page";
import { requirePortal, signOut } from "../../../lib/portal";
import { reportOf, visitOf } from "../../../lib/portal-view";
import { imageOf } from "../../../lib/visit-data";

const notFound = (): Response => new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });

export async function load(ctx: LoaderContext) {
  const gate = await requirePortal(ctx);
  if (gate instanceof Response) return gate;
  const id = typeof ctx.params.id === "string" && /^[A-Za-z0-9_-]{1,64}$/u.test(ctx.params.id) ? ctx.params.id : null;
  if (id === null) return notFound();
  const page = await shell(ctx);
  const lang = page.locale === "ar" ? "ar" : "en";
  const visit = await visitOf(gate.cdb, id, lang);
  if (visit === null) return notFound();
  // A photo row whose file is not stored (yet) has no thumbnail, only its link: signing it would throw.
  const sign = (p: { file_key: string; width: number; height: number }) => imageOf(ctx.storage, p, 3600, storage).catch(() => null);
  const report = visit.done ? await reportOf(gate.cdb, id, lang, sign) : null;
  return { ...page, visit, report };
}

export const actions = {
  async signout() {
    return signOut();
  },
};
