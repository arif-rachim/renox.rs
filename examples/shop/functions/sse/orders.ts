// GET /sse/orders (#292): new orders of the signed-in user's active
// organisation (checkout publishes the rendered row as `order-created`), and
// from #305 the change feed's `{ table, rowid, op }` for every committed change
// of `app__orders` (`[realtime.feeds]` in renox.toml). The topic comes from
// the principal; the policy allows only `orders:<principal.org>`.
import { ordersTopic } from "../../lib/orders.ts";

interface SseCtx {
  conn: { id: string };
  principal: { id: string; attrs: { org?: string } } | null;
  realtime: { subscribe(conn: { id: string }, topic: string): Promise<void> };
}

export const sse = {
  async open(ctx: SseCtx) {
    const org = ctx.principal?.attrs.org;
    if (typeof org !== "string") throw new Error("no active organisation");
    await ctx.realtime.subscribe(ctx.conn, ordersTopic(org));
  },
};
