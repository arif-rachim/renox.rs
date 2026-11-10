// GET /admin/tile: the active branch's three numbers (jobs today, invoices not
// paid yet, contracts ending this month), `settings.read` (the owner). The
// `admin` module's dashboard at /admin shows them: the app's filler of its
// `admin.dashboard` slot (partials/admin-tile.html) asks for this page's
// `tile` fragment with htmx (HX-Target home-services-tile), because a filler
// is rendered with the module page's data and runs no loader of the app.
// Opened directly, it is a page of the app's back office.
import type { LoaderContext } from "@renoxium/sdk";

import { tileData } from "../../lib/admin-tile";
import { shell } from "../../lib/page";
import { branchOf, noBranch } from "../../lib/scope";

export const guard = { action: "settings.read" };

export async function load(ctx: LoaderContext) {
  const page = await shell(ctx);
  const branch = await branchOf(ctx);
  if (branch === null) return noBranch();
  return { ...page, ...(await tileData(ctx.db, branch, page.locale)) };
}
