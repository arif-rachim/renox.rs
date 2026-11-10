// The app's tile on the `admin` module's dashboard (the `admin.dashboard`
// slot, partials/admin-tile.html): three numbers of the active branch. A slot
// filler is rendered with the module page's data and runs no loader of the
// app, so the tile asks /admin/tile (pages/admin/tile) for its numbers with
// htmx once the dashboard has loaded; that page's loader calls this.
import type { DbStatements } from "@renoxium/sdk";

import { day } from "./quotes";

export interface Tiles {
  jobs_today: number;
  open_invoices: number;
  amc_renewals: number;
}

/** The three numbers for a branch: today's jobs, invoices not yet paid, active contracts that end this month (Dubai days). */
export async function tiles(db: DbStatements, branchId: string, today: string): Promise<Tiles> {
  const startOfDay = Math.floor(Date.parse(`${today}T00:00:00Z`) / 1000) - 4 * 3600;
  const month = today.slice(0, 7);
  const one = async (sql: string, params: (string | number)[]): Promise<number> => (await db.queryOne<{ n: number }>(sql, params))?.n ?? 0;
  return {
    jobs_today: await one("select count(*) as n from app__jobs where branch_id = ? and status != 'cancelled' and scheduled_start >= ? and scheduled_start < ?", [branchId, startOfDay, startOfDay + 86_400]),
    open_invoices: await one("select count(*) as n from app__invoice_status where branch_id = ? and status in ('issued', 'part-paid')", [branchId]),
    amc_renewals: await one("select count(*) as n from app__contracts where branch_id = ? and status = 'active' and substr(ends_on, 1, 7) = ?", [branchId, month]),
  };
}

/** The tile's data for a branch, today (Dubai). */
export async function tileData(db: DbStatements, branch: { id: string; name_en: string; name_ar: string }, locale: string): Promise<{ branch_name: string; tiles: Tiles }> {
  return { branch_name: locale === "ar" ? branch.name_ar : branch.name_en, tiles: await tiles(db, branch.id, day(Math.floor(Date.now() / 1000))) };
}
