// GET /admin/tile: the active branch's four numbers (jobs today, invoices not
// paid yet, contracts ending this month, online bookings to confirm) and, with `stock.read`, the parts
// low on stock in the branches the viewer holds (#816), `settings.read` (the owner). The
// `admin` module's dashboard at /admin shows them: the app's filler of its
// `admin.dashboard` slot (partials/admin-tile.html) asks for this page's
// `tile` fragment with htmx (HX-Target home-services-tile), because a filler
// is rendered with the module page's data and runs no loader of the app.
// Opened directly, it is a page of the app's back office.
import type { LoaderContext } from "@renoxium/sdk";

import { tileData } from "../../lib/admin-tile";
import { lowCount } from "../../lib/low-stock";
import { shell } from "../../lib/page";
import { branchOf, noBranch } from "../../lib/scope";
import { heldBranches } from "../../lib/stock";

export const guard = { action: "settings.read" };

export async function load(ctx: LoaderContext) {
  const page = await shell(ctx);
  const branch = await branchOf(ctx);
  if (branch === null) return noBranch();
  // Parts low on stock (#816): over every branch the viewer holds and may read stock in, shown only with `stock.read`.
  const showLow = await ctx.authz.can("stock.read");
  const low = showLow ? await lowCount(ctx.db, (await heldBranches(ctx)).filter((b) => b.can_read).map((b) => b.id)) : 0;
  return { ...page, ...(await tileData(ctx.db, branch, page.locale)), show_low: showLow, low_stock: low };
}
