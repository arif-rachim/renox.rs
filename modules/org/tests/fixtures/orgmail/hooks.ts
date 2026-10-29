// Records every invitation org asks to send (a test stands in for the F7
// email module), refuses invitations to @blocked.example, and records
// org's events.
const record = async (ctx, e) => {
  await ctx.db.execute("insert into orgmail__events (name, org_id, user_id, role) values (?, ?, ?, ?)", [e.name, e.payload.org_id, e.payload.user_id ?? "", e.payload.role ?? null]);
};

export const hooks = {
  "org.send_mail": {
    async handle(ctx, mail) {
      await ctx.db.execute("insert into orgmail__sent (mail_to, template, url, org_name) values (?, ?, ?, ?)", [mail.to, mail.template, mail.args.url, mail.args.org_name]);
    },
  },
  "org.before_invite": {
    async handle(_ctx, args) {
      if (args.email.endsWith("@blocked.example")) return { halt: true, response: new Response("invitations to that domain are not allowed", { status: 422 }) };
    },
  },
};

export const on = {
  "org.created": record,
  "org.member_added": record,
  "org.member_removed": record,
};
