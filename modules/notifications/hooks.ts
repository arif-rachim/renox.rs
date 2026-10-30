// The notifications module's listeners (#289). auth has no "login from a
// new device" event yet, so only org's membership is turned into a
// notification here; apps call `notify` for their own.
import { notify, type NotifCtx } from "./lib/core.ts";

interface Event {
  name: string;
  payload: Record<string, unknown>;
}

export const on = {
  async "org.member_added"(ctx: NotifCtx, e: Event) {
    const user = e.payload.user_id;
    if (typeof user !== "string" || e.payload.role === "owner") return; // the creator needs no notice
    await notify(ctx, user, { category: "org", title: "You joined an organisation", link: "/org/members" });
  },
};
