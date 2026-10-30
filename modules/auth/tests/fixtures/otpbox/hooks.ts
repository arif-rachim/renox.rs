export const hooks = {
  "auth.send_otp": {
    async handle(ctx, args) {
      await ctx.db.execute("insert into otpbox__codes (phone, code, purpose) values (?, ?, ?)", [args.to, args.code, args.purpose]);
    },
  },
  "auth.principal": {
    async handle(_ctx, args) {
      args.principal.attrs.org = "o_test";
      args.principal.attrs.not_in_the_schema = "dropped";
    },
  },
  "auth.after_login": {
    async handle(ctx, args) {
      const halt = await ctx.db.queryOne("select 1 as x from otpbox__halt where user_id = ?", [args.user_id]);
      if (halt) return { halt: true, response: new Response("second factor", { status: 401 }) };
    },
  },
};
