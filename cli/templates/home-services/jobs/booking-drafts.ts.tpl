// Every hour: the drafts of /book (#775) whose hold expired before the visitor
// confirmed them are deleted, and their holds released in `booking`
// (lib/book.ts sweepDrafts); the per-address log keeps one day.
import type { JobContext } from "@renoxium/sdk";

import { sweepDrafts } from "../lib/book";

export const schedule = "11 * * * *";
export const tz = "Asia/Dubai";

export async function run(ctx: JobContext<never>): Promise<void> {
  await sweepDrafts(ctx);
}
