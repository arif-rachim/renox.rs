// Every day at 08:00 (Asia/Dubai): each branch with parts under their minimum tells its managers and the owner,
// once for each list, in the app (lib/low-stock.ts notifyLowStock): up to ten parts with SKU, name, on hand and
// minimum, and a link to /admin/stock?low=1. The same list as the last time tells nobody.
import type { JobContext } from "@renoxium/sdk";

import { notifyLowStock } from "../lib/low-stock";

export const schedule = "0 8 * * *";
export const tz = "Asia/Dubai";

export async function run(ctx: JobContext<never>): Promise<void> {
  await notifyLowStock(ctx);
}
