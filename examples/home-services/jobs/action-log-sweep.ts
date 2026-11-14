// Every day: the rows of the visit page's action log (lib/action-log.ts) older than 30 days are deleted;
// a phone replays its queue within days, not weeks. `created_at` is the server's receive time, in seconds.
import type { JobContext } from "@renoxium/sdk";

export const schedule = "23 2 * * *";
export const tz = "Asia/Dubai";

const KEEP_SECONDS = 30 * 24 * 3600;

export async function run(ctx: JobContext<never>): Promise<void> {
  await ctx.db.execute("delete from app__action_log where created_at < ?", [Math.floor(Date.now() / 1000) - KEEP_SECONDS]);
}
