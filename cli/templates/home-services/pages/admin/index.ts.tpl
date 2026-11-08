// GET /admin: the owner's dashboard: three numbers of the active branch (jobs
// today, invoices not paid yet, contracts ending this month). `settings.read`
// is the owner's. The `admin` module's own dashboard (and the cards other
// modules fill into its `admin.dashboard` slot) is at /system/admin: a slot is
// filled by modules, never by the app, so the app reads its own tables here.
import type { LoaderContext } from "@renoxium/sdk";

import { tiles } from "../../lib/admin";
import { shell } from "../../lib/page";
import { day } from "../../lib/quotes";
import { branchOf, noBranch } from "../../lib/scope";

export const guard = { action: "settings.read" };

export async function load(ctx: LoaderContext) {
  const page = await shell(ctx);
  const branch = await branchOf(ctx);
  if (branch === null) return noBranch();
  const t = await tiles(ctx.db, branch.id, day(Math.floor(Date.now() / 1000)));
  return { ...page, branch_name: page.locale === "ar" ? branch.name_ar : branch.name_en, tiles: t };
}
