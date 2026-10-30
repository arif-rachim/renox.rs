// The follower of one open live Logs page (#307; ops.md section 20, queued
// jobs). Each run reads the app's lines after the last one sent (lib/
// live-logs.ts), publishes the ones that pass the page's filters as rows of
// partials/log-rows to the page's topic, and queues the next run a second
// later. It stops when the page closed (no row), after 15 minutes, or when
// the sign-in ended; the page then falls back to its 2-second poll.
//
// A job route needs a `schedule` (artifact.md 1.3, V27). This one only runs
// when queued: the yearly tick has no payload and does nothing.
import type { JobContext } from "renox";

import { filters as pageFilters, lineRow, visible } from "../pages/apps/[app]/logs.ts";
import { JOB, step, STEP_MS } from "../lib/live-logs.ts";

export const schedule = "0 0 1 1 *";

export async function run(ctx: JobContext): Promise<void> {
  const topic = (ctx.job.payload as { topic?: unknown } | null)?.topic;
  if (typeof topic !== "string") return;
  const s = await step(ctx.db, ctx.fetch, ctx.secrets, topic, Date.now());
  if (s.stop) {
    await ctx.realtime.publish(topic, { text: s.reason, event: "log-end" });
    return;
  }
  if (s.lines.length > 0) {
    const row = await ctx.db.queryOne<{ app: string; filters: string }>("select app, filters from app__log_followers where topic = ?", [topic]);
    if (row !== null) {
      const f = JSON.parse(row.filters) as Record<string, string | null>;
      const url = new URL("https://dashboard.invalid/");
      for (const [k, v] of Object.entries(f)) if (v !== null) url.searchParams.set(k, v);
      const lines = visible(s.lines, pageFilters(url)).map((l) => lineRow(l, row.app));
      if (lines.length > 0) await ctx.realtime.publish(topic, { fragment: "partials/log-rows", data: { lines }, event: "log-rows" });
    }
  }
  await ctx.jobs.enqueue(JOB, { topic }, { runAt: Date.now() + STEP_MS });
}
