// GET /my/visits/<job id>: one visit of the signed-in customer (#776), for a
// portal user only (lib/portal.ts requirePortal, as on /my). Another
// customer's job, or an id that is not one, is a 404 (never a 403: the page
// does not tell that the id exists). The timeline in the customer's words,
// the time, the address, the notes they gave when they booked, the
// technician's first name and the branch's phone (lib/portal-view.ts
// visitOf, through `customerDb` only). Internal notes, costs, other
// customers' names and the technician's last name or phone are never read.
// The "Visit report" link of a done visit comes with the report page of the
// next issue of #772 (#777); there is no such route yet, so no link.
import type { LoaderContext } from "@renoxium/sdk";

import { shell } from "../../../lib/page";
import { requirePortal, signOut } from "../../../lib/portal";
import { visitOf } from "../../../lib/portal-view";

const notFound = (): Response => new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });

export async function load(ctx: LoaderContext) {
  const gate = await requirePortal(ctx);
  if (gate instanceof Response) return gate;
  const id = typeof ctx.params.id === "string" && /^[A-Za-z0-9_-]{1,64}$/u.test(ctx.params.id) ? ctx.params.id : null;
  if (id === null) return notFound();
  const page = await shell(ctx);
  const visit = await visitOf(gate.cdb, id, page.locale === "ar" ? "ar" : "en");
  if (visit === null) return notFound();
  return { ...page, visit };
}

export const actions = {
  async signout() {
    return signOut();
  },
};
