// org asks `org.send_mail` to deliver an invitation; no official module
// sends it yet, so this one keeps the mail in outbox__mail for the
// owner to pass on. Replace it with a mail module before real users join.
interface Mail {
  to: string;
  template: string;
  args: { url: string; org_name: string };
}

interface HookCtx {
  db: { execute(sql: string, params?: unknown[]): Promise<unknown> };
}

export const hooks = {
  "org.send_mail": {
    async handle(ctx: HookCtx, mail: Mail) {
      await ctx.db.execute("insert into outbox__mail (mail_to, template, url, org_name, created_at) values (?, ?, ?, ?, ?)", [mail.to, mail.template, mail.args.url, mail.args.org_name, Math.floor(Date.now() / 1000)]);
    },
  },
};
