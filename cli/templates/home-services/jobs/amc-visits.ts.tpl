// Every day at 02:00 (Asia/Dubai): the visits of the active maintenance
// contracts that fall due within 14 days become `new` jobs (lib/contracts.ts
// generateVisits). A visit is made once, so a repeated run or a retry does
// nothing more.
import type { JobContext } from "@renoxium/sdk";

import { generateVisits } from "../lib/contracts";

export const schedule = "0 2 * * *";
export const tz = "Asia/Dubai";

export async function run(ctx: JobContext<never>): Promise<void> {
  await generateVisits(ctx);
}
