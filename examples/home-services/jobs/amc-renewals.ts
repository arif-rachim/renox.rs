// Every day at 02:30 (Asia/Dubai): a maintenance contract that ends in 30 days
// is announced to its customer and to the staff member who made it, once; one
// whose last day has passed becomes `expired` (lib/contracts.ts remindRenewals).
import type { JobContext } from "@renoxium/sdk";

import { remindRenewals } from "../lib/contracts";

export const schedule = "30 2 * * *";
export const tz = "Asia/Dubai";

export async function run(ctx: JobContext<never>): Promise<void> {
  await remindRenewals(ctx);
}
