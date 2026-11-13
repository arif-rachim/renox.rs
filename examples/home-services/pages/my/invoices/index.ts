// GET /my/invoices: the signed-in customer's tax invoices (#777), for a portal
// user only (lib/portal.ts requirePortal: a signed-out visitor goes to phone
// sign-in and comes back here, staff go to `/`). Newest first, 10 a page
// (`?page=`): the number, the day, what it is for, the total with VAT in AED
// and whether it is paid (on which day) or open (due on which day); on top,
// how many are open and what is left to pay. Each line links to
// /my/invoices/<number>. Every invoice listed is issued (the app keeps no
// draft invoice). Everything is read through `customerDb` only
// (lib/portal-view.ts invoicesOf).
import type { LoaderContext } from "@renoxium/sdk";

import { shell } from "../../../lib/page";
import { requirePortal, signOut } from "../../../lib/portal";
import { invoicesOf, lookupsOf, pageOf } from "../../../lib/portal-view";

export async function load(ctx: LoaderContext) {
  const gate = await requirePortal(ctx);
  if (gate instanceof Response) return gate;
  const page = await shell(ctx);
  const l = await lookupsOf(gate.cdb, page.locale === "ar" ? "ar" : "en");
  return { ...page, invoices: await invoicesOf(gate.cdb, l, pageOf(ctx.url.searchParams.get("page"))) };
}

export const actions = {
  async signout() {
    return signOut();
  },
};
