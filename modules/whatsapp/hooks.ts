// The whatsapp module's handlers (#290): its own queue (the outbox runs
// `whatsapp.send_requested` after the commit and retries it on a throw),
// and the `notifications.deliver` filler for the `whatsapp` channel.
import * as core from "./lib/core.ts";

interface Event {
  name: string;
  payload: { message_id?: string };
}

export const on = {
  async "whatsapp.send_requested"(ctx: core.WaCtx, e: Event) {
    if (typeof e.payload.message_id === "string") await core.deliverQueued(ctx, e.payload.message_id);
  },
};

export const hooks = {
  "notifications.deliver": {
    /** Only the `whatsapp` channel, and only to a user with a verified contact (linkPhone). */
    async handle(ctx: core.WaCtx, args: { user: string; channel: string; item: { title: string; body?: string; link?: string } }) {
      if (args.channel !== "whatsapp") return;
      const c = await ctx.db.queryOne<{ phone: string }>("select phone from whatsapp__contacts where user_id = ?", [args.user]);
      if (c === null) return;
      const text = [args.item.title, args.item.body, args.item.link].filter((s) => typeof s === "string" && s !== "").join("\n");
      await core.send(ctx, c.phone, text);
    },
  },
};
