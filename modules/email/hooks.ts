// The email module's handlers (#328): its own queue (the outbox runs
// `email.send_requested` after the commit and retries it on a throw) and
// the `notifications.deliver` filler for the `email` channel.
import * as core from "./lib/core.ts";

interface Event {
  name: string;
  payload: { message_id?: string };
}

export const on = {
  async "email.send_requested"(ctx: core.EmailCtx, e: Event) {
    if (typeof e.payload.message_id === "string") await core.deliverQueued(ctx, e.payload.message_id);
  },
};

export const hooks = {
  "notifications.deliver": {
    /** Only the `email` channel; the address is the user's (auth's users table through the app's data). */
    async handle(ctx: core.EmailCtx & { services?: { auth?: { emailOf?: (id: string) => Promise<string | null> } } }, args: { user: string; channel: string; item: { title: string; body?: string; link?: string } }) {
      if (args.channel !== "email") return;
      const to = await ctx.services?.auth?.emailOf?.(args.user);
      if (typeof to !== "string" || (await core.suppressed(ctx, to))) return;
      await core.send(ctx, { to, subject: args.item.title, text: [args.item.body, args.item.link].filter((s) => typeof s === "string" && s !== "").join("\n\n") || args.item.title });
    },
  },
};
