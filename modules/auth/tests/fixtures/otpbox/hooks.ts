export const hooks = {
  "auth.send_otp": {
    async handle(ctx, args) {
      await ctx.db.execute("insert into otpbox__codes (phone, code, purpose) values (?, ?, ?)", [args.to, args.code, args.purpose]);
    },
  },
  "auth.principal": {
    async handle(ctx, args) {
      // #590: an agent token's principal: the organisation chosen at
      // consent while the user still has it (as org does), and an
      // mfa_verified that auth must override.
      if (args.agent === true) {
        const m = args.org_id ? await ctx.db.queryOne("select org_id from otpbox__orgs where user_id = ? and org_id = ?", [args.principal.id, args.org_id]) : null;
        if (m) args.principal.attrs.org = m.org_id;
        args.principal.attrs.mfa_verified = true;
        args.principal.attrs.not_in_the_schema = "dropped";
        return;
      }
      args.principal.attrs.org = "o_test";
      args.principal.attrs.not_in_the_schema = "dropped";
    },
  },
  "auth.agent_orgs": {
    async handle(ctx, args) {
      for (const r of await ctx.db.query("select org_id, name from otpbox__orgs where user_id = ? order by org_id", [args.user_id])) args.orgs.push({ id: r.org_id, name: r.name });
    },
  },
  "auth.after_login": {
    async handle(ctx, args) {
      const halt = await ctx.db.queryOne("select 1 as x from otpbox__halt where user_id = ?", [args.user_id]);
      if (halt) return { halt: true, response: new Response("second factor", { status: 401 }) };
    },
  },
};
