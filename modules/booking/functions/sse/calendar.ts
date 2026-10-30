// GET <mount>/sse/calendar (#334): the signed-in staff member's live
// calendar. The change feed publishes every committed change of
// booking__bookings to `calendar:<staff_id>` ([realtime.feeds]); the topic
// comes from the staff row of the principal, never from the request.
interface SseCtx {
  conn: { id: string };
  principal: { id: string } | null;
  db: { queryOne<T>(sql: string, params?: unknown[]): Promise<T | null> };
  realtime: { subscribe(conn: { id: string }, topic: string): Promise<void> };
}

export const sse = {
  async open(ctx: SseCtx) {
    const staff = ctx.principal === null ? null : await ctx.db.queryOne<{ id: string }>("select id from booking__staff where user_id = ?", [ctx.principal.id]);
    if (staff === null) throw new Error("not a staff member");
    await ctx.realtime.subscribe(ctx.conn, `calendar:${staff.id}`);
  },
};
