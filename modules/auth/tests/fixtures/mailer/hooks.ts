// Records every mail auth asks to send (a test stands in for the F7 email module).
export const hooks = {
  "auth.send_mail": {
    async handle(ctx, mail) {
      await ctx.db.execute("insert into mailer__sent (mail_to, template, url) values (?, ?, ?)", [mail.to, mail.template, mail.args.url]);
    },
  },
};
export const on = {
  "auth.password_changed": async (ctx, e) => {
    await ctx.db.execute("insert into mailer__events (name, user_id) values (?, ?)", [e.name, e.payload.user_id]);
  },
};
