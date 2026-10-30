// GET <mount>: the signed-in user's notifications, newest first, live over
// SSE (new items at the top, the unread count). POST ?/read marks one read,
// ?/all marks all read.
import * as core from "../lib/core.ts";
import { guarded, type Page } from "../lib/page.ts";

async function view(ctx: Page, notice: string | null) {
  core.me(ctx);
  const items = await core.list(ctx, { limit: core.LIST_MAX });
  const base = core.basePath(ctx);
  return { items, has_items: items.length > 0, notif_unread: await core.unreadCount(ctx), sse: `${base}/sse/notifications`, prefs_url: `${base}/prefs`, notice };
}

export const load = guarded((ctx) => view(ctx, null));

export const actions = {
  read: guarded(async (ctx) => {
    await core.markRead(ctx, ctx.form.get("id"));
    return view(ctx, null);
  }),
  all: guarded(async (ctx) => {
    const n = await core.markAllRead(ctx);
    return view(ctx, n > 0 ? "All marked read." : null);
  }),
};
