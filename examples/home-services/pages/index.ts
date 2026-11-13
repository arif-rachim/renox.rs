// GET /: the landing with the company's brand and a sign-in link. The layout
// reads `brand`, `i18n_links`, `notif_badge` and `auth_user` from the page's data
// (lib/page.ts builds them for every page). A portal customer (lib/portal.ts)
// has nothing here: they go to `/my` (#774). The other staff pages are guarded,
// and a guard's deny is a 403 decided before any loader runs (#795), so `/` is
// the staff page that sends a customer on.
import type { LoaderContext } from "@renoxium/sdk";

import { shell } from "../lib/page";
import { portalUser } from "../lib/portal";

export async function load(ctx: LoaderContext) {
  if ((await portalUser(ctx)) !== null) return new Response(null, { status: 303, headers: { location: "/my", "cache-control": "no-store" } });
  return shell(ctx);
}
