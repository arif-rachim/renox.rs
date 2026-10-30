// Test only: subscribes to the topic of the user named in ?user= (another
// user's notifications). The module's policy refuses it (RENOX_FORBIDDEN):
// the stream ends without an event.
export const sse = {
  async open(ctx) {
    await ctx.realtime.subscribe(ctx.conn, `notif:user:${ctx.url.searchParams.get("user")}`);
  },
};
