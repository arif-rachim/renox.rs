// Handles auth.user_registered (a durable event): idempotent by user id.
export const on = {
  "auth.user_registered": async (ctx, e) => {
    await ctx.db.execute("insert or ignore into reader__registered (user_id, at) values (?, ?)", [e.payload.user_id, e.payload.at]);
  },
};
