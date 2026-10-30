export const hooks = {
  "audit.export": {
    async handle(ctx, args) {
      await ctx.db.execute("insert into tamper__exports (page, last, events, purpose) values (?, ?, ?, ?)", [args.page, args.last ? 1 : 0, args.events.length, args.purpose ?? ""]);
    },
  },
};
