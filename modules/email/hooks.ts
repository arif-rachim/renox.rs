// The email module's handlers (#328):
// - its own queue: the outbox runs `email.send_requested` after the commit
//   and retries it on a throw;
// - `auth.send_mail`: the confirmation, reset and magic-link emails of the
//   auth module, from this module's bilingual templates;
// - `auth.user_registered`: the welcome email (the address from auth's
//   public view);
// - `notifications.deliver` for the `email` channel.
import * as core from "./lib/core.ts";

interface Event {
  name: string;
  payload: { message_id?: string; user_id?: string };
}

type Ctx = core.EmailCtx & { locale?: string };

const localeOf = (ctx: Ctx): "en" | "ar" => (typeof ctx.locale === "string" && ctx.locale.startsWith("ar") ? "ar" : "en");

/** A refusal (a suppressed or invalid address) is not the caller's failure: auth answers the same either way. */
async function quietly(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    if (!(e instanceof core.EmailError)) throw e;
  }
}

export const on = {
  async "email.send_requested"(ctx: Ctx, e: Event) {
    if (typeof e.payload.message_id === "string") await core.deliverQueued(ctx, e.payload.message_id);
  },
  async "auth.user_registered"(ctx: Ctx, e: Event) {
    const u = await ctx.db.queryOne<{ email: string; display_name: string | null }>("select email, display_name from auth__public_users_v1 where id = ?", [e.payload.user_id]);
    if (u === null) return;
    await quietly(() => core.sendTemplate(ctx, u.email, "welcome", { display_name: u.display_name ?? "" }, { locale: localeOf(ctx) }));
  },
};

export const hooks = {
  "auth.send_mail": {
    async handle(ctx: Ctx, args: { to: string; template: string; args: { url?: string; expires_minutes?: number; display_name?: string } }) {
      await quietly(() => core.sendTemplate(ctx, args.to, args.template, args.args ?? {}, { locale: localeOf(ctx) }));
    },
  },
  "notifications.deliver": {
    /** Only the `email` channel; the address is the user's (auth's public view). */
    async handle(ctx: Ctx, args: { user: string; channel: string; item: { title: string; body?: string; link?: string } }) {
      if (args.channel !== "email") return;
      const u = await ctx.db.queryOne<{ email: string }>("select email from auth__public_users_v1 where id = ?", [args.user]);
      if (u === null) return;
      await quietly(() => core.sendRaw(ctx, { to: u.email, subject: args.item.title, text: [args.item.body, args.item.link].filter((s) => typeof s === "string" && s !== "").join("\n\n") || args.item.title }));
    },
  },
};
