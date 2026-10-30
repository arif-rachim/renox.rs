// GET /sse/logs?app=<name>&level=&source=&q=&deployment= (#307): the live
// rows of the Logs page. The handler runs before any event is sent: it
// needs a dashboard sign-in, and the control API must answer the signed-in
// user's token for that app (so only a member of the app's tenant gets
// here); then it subscribes the connection to a topic of its own
// (policies/logs.cedar), records the follower and queues the first run of
// the follower job. Closing the page deletes the row, which stops the job.
import type { CloseContext, RealtimeContext } from "renox";

import { Api, apiBase } from "../../lib/api.ts";
import { appParam, hashParam } from "../../lib/guard.ts";
import { addFollower, dropConn, JOB, newTopic } from "../../lib/live-logs.ts";
import { currentToken } from "../../lib/session.ts";

export const sse = {
  async open(ctx: RealtimeContext) {
    const app = appParam(ctx.url.searchParams.get("app") ?? undefined);
    if (app === null) throw new Error("live logs: an app name");
    const now = Date.now();
    const token = await currentToken(ctx.db, ctx.secrets, ctx.session.id, now);
    if (token === null) throw new Error("live logs: sign in first");
    const allowed = await new Api(ctx.fetch, token, apiBase(ctx.secrets)).getApp(app);
    if (!allowed.ok) throw new Error(`live logs: the control API answered ${allowed.status} for ${app}`);
    const source = ctx.url.searchParams.get("source");
    const filters = {
      level: ctx.url.searchParams.get("level") ?? "all",
      source: source === "server" || source === "client" ? source : "all",
      q: (ctx.url.searchParams.get("q") ?? "").slice(0, 100),
      deployment: hashParam(ctx.url.searchParams.get("deployment")),
    };
    const topic = newTopic(app);
    await ctx.realtime.subscribe(ctx.conn, topic);
    await ctx.db.transaction(async () => {
      await addFollower(ctx.db, { topic, conn_id: ctx.conn.id, session_id: ctx.session.id, app, filters: JSON.stringify(filters), since: now, started_at: now });
      await ctx.jobs.enqueue(JOB, { topic });
    });
  },
  async close(ctx: CloseContext) {
    await dropConn(ctx.db, ctx.conn.id);
  },
};
