export const hooks = {
  "notifications.deliver": {
    async handle(ctx, args) {
      await ctx.db.execute("insert into deliver__sent (user_id, channel, title) values (?, ?, ?)", [args.user, args.channel, args.item.title]);
    },
  },
};
