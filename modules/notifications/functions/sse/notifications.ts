// GET <mount>/sse/notifications (#289): the signed-in user's live badge and
// list. The connection subscribes to `notif:user:<principal id>`; the policy
// (policies/notifications.cedar) refuses any other user's topic.
import { topicOf } from "../../lib/core.ts";

interface SseCtx {
  conn: { id: string };
  principal: { id: string } | null;
  realtime: { subscribe(conn: { id: string }, topic: string): Promise<void> };
}

export const sse = {
  async open(ctx: SseCtx) {
    if (ctx.principal === null) throw new Error("sign in first");
    await ctx.realtime.subscribe(ctx.conn, topicOf(ctx.principal.id));
  },
};
