// The notifications module's services (#289): see lib/core.ts.
import * as core from "./lib/core.ts";

type Ctx = core.NotifCtx;

export const badge = (ctx: Ctx) => core.badge(ctx);
export const notify = (ctx: Ctx, user: unknown, item: unknown) => core.notify(ctx, user, item);
export const list = (ctx: Ctx, opts?: { unread?: boolean; limit?: number }) => core.list(ctx, opts ?? {});
export const unreadCount = (ctx: Ctx) => core.unreadCount(ctx);
export const markRead = (ctx: Ctx, id: unknown) => core.markRead(ctx, id);
export const markAllRead = (ctx: Ctx) => core.markAllRead(ctx);
export const preferences = (ctx: Ctx) => core.preferences(ctx);
export const setPreference = (ctx: Ctx, input: unknown) => core.setPreference(ctx, input);
