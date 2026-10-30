// The notifications module's logic (#289): one row per notification, the
// badge and the list pushed to the user's open pages over SSE
// (`notif:user:<id>`), and the other channels through the
// `notifications.deliver` hook, honouring the user's preferences. Both
// tables are owned by user_id: every statement goes through db.scoped().

export interface Db {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  queryOne<T>(sql: string, params?: unknown[]): Promise<T | null>;
  execute(sql: string, params?: unknown[]): Promise<{ changes: number }>;
}

export interface NotifCtx {
  db: Db & { scoped(scope: { user_id: string }): Db };
  principal: { id: string; kind?: string } | null;
  config: { channels?: string; base_path?: string };
  hooks: { run(name: string, args: unknown): Promise<unknown> };
  realtime: { publish(topic: string, payload: unknown): Promise<number> };
}

export interface Item {
  id: string;
  category: string;
  title: string;
  body: string;
  link: string;
  read_at: number | null;
  created_at: number;
}

export const INAPP = "inapp";
const CATEGORY = /^[a-z][a-z0-9_.-]{0,63}$/u;
const CHANNEL = /^[a-z][a-z0-9_]{0,31}$/u;
export const LIST_MAX = 100;

export class NotifError extends Error {
  constructor(
    message: string,
    readonly code: "AUTH_REQUIRED" | "INVALID",
  ) {
    super(message);
    this.name = "NotifError";
  }
}

/** The user's topic; the policy lets only that user subscribe. */
export const topicOf = (userId: string): string => `notif:user:${userId}`;

/** The signed-in user's id, or throws. */
export function me(ctx: NotifCtx): string {
  const p = ctx.principal;
  if (p === null || (p.kind !== undefined && p.kind !== "user")) throw new NotifError("sign in first", "AUTH_REQUIRED");
  return p.id;
}

/** The module's mount (`config.base_path`). */
export function basePath(ctx: Pick<NotifCtx, "config">): string {
  const p = ctx.config.base_path;
  return typeof p === "string" && /^\/[A-Za-z0-9/_-]*$/u.test(p) ? p.replace(/\/+$/u, "") || "/notifications" : "/notifications";
}

/** The header badge's data (`notif_badge`), or null when signed out. */
export async function badge(ctx: NotifCtx): Promise<{ count: number; url: string; sse: string } | null> {
  const p = ctx.principal;
  if (p === null || (p.kind !== undefined && p.kind !== "user")) return null;
  const base = basePath(ctx);
  return { count: await unreadCountOf(ctx.db.scoped({ user_id: p.id })), url: base, sse: `${base}/sse/notifications` };
}

/** The configured channels besides in-app (`config.channels`). */
export function channels(ctx: NotifCtx): string[] {
  return (ctx.config.channels ?? "")
    .split(",")
    .map((c) => c.trim())
    .filter((c) => CHANNEL.test(c) && c !== INAPP);
}

/** A link a notification may carry: a path of the app, or an https URL. */
export function safeLink(v: unknown): string {
  if (typeof v !== "string" || v === "") return "";
  if (v.startsWith("/") && !v.startsWith("//") && !v.startsWith("/\\")) return v.slice(0, 2000);
  try {
    const u = new URL(v);
    return u.protocol === "https:" ? u.href.slice(0, 2000) : "";
  } catch {
    return "";
  }
}

const newId = (): string => {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return `ntf_${Date.now().toString(36)}${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}`;
};

/** Which channels `userId` turned off for `category`. */
async function disabled(db: Db, category: string): Promise<Set<string>> {
  const rows = await db.query<{ channel: string }>("select channel from notifications__prefs where category = ? and enabled = 0", [category]);
  return new Set(rows.map((r) => r.channel));
}

export async function unreadCountOf(db: Db): Promise<number> {
  return (await db.queryOne<{ n: number }>("select count(*) as n from notifications__items where read_at is null"))?.n ?? 0;
}

/** Push the badge (and, for a new item, the item) to the user's open pages. */
export async function push(ctx: NotifCtx, userId: string, item: Item | null): Promise<void> {
  const db = ctx.db.scoped({ user_id: userId });
  const count = await unreadCountOf(db);
  await ctx.realtime.publish(topicOf(userId), { fragment: "partials/count", data: { notif_unread: count }, event: "notif-badge" });
  if (item !== null) await ctx.realtime.publish(topicOf(userId), { fragment: "partials/item", data: { n: item }, event: "notif-item" });
}

export async function notify(ctx: NotifCtx, userId: unknown, input: unknown): Promise<{ id: string | null; channels: string[] }> {
  if (typeof userId !== "string" || userId === "" || userId.length > 128) throw new NotifError("notify: a user id", "INVALID");
  const o = input as { category?: unknown; title?: unknown; body?: unknown; link?: unknown } | null;
  if (typeof o !== "object" || o === null) throw new NotifError("notify: { category, title, body?, link? }", "INVALID");
  if (typeof o.category !== "string" || !CATEGORY.test(o.category)) throw new NotifError("notify: category is [a-z][a-z0-9_.-]*", "INVALID");
  if (typeof o.title !== "string" || o.title.trim() === "" || o.title.length > 200) throw new NotifError("notify: a title of 1 to 200 characters", "INVALID");
  if (o.body !== undefined && (typeof o.body !== "string" || o.body.length > 2000)) throw new NotifError("notify: body is at most 2000 characters", "INVALID");
  const db = ctx.db.scoped({ user_id: userId });
  const off = await disabled(db, o.category);
  const item: Item = { id: newId(), category: o.category, title: o.title.trim(), body: typeof o.body === "string" ? o.body : "", link: safeLink(o.link), read_at: null, created_at: Date.now() };
  const sent: string[] = [];
  if (!off.has(INAPP)) {
    await db.execute("insert into notifications__items (id, user_id, category, title, body, link, created_at) values (?, ?, ?, ?, ?, ?, ?)", [item.id, userId, item.category, item.title, item.body, item.link, item.created_at]);
    await push(ctx, userId, item);
    sent.push(INAPP);
  }
  for (const channel of channels(ctx)) {
    if (off.has(channel)) continue;
    await ctx.hooks.run("notifications.deliver", { user: userId, channel, item: { id: item.id, category: item.category, title: item.title, body: item.body, link: item.link } });
    sent.push(channel);
  }
  return { id: sent.includes(INAPP) ? item.id : null, channels: sent };
}

export async function list(ctx: NotifCtx, opts: { unread?: boolean; limit?: number } = {}): Promise<Item[]> {
  const db = ctx.db.scoped({ user_id: me(ctx) });
  const limit = Math.min(Math.max(Math.trunc(Number(opts.limit ?? 50)) || 50, 1), LIST_MAX);
  const where = opts.unread ? "where read_at is null" : "";
  return db.query<Item>(`select id, category, title, body, link, read_at, created_at from notifications__items ${where} order by created_at desc, id desc limit ?`, [limit]);
}

export async function markRead(ctx: NotifCtx, id: unknown): Promise<boolean> {
  const user = me(ctx);
  if (typeof id !== "string") return false;
  const r = await ctx.db.scoped({ user_id: user }).execute("update notifications__items set read_at = ? where id = ? and read_at is null", [Date.now(), id]);
  if (r.changes > 0) await push(ctx, user, null);
  return r.changes > 0;
}

export async function markAllRead(ctx: NotifCtx): Promise<number> {
  const user = me(ctx);
  const r = await ctx.db.scoped({ user_id: user }).execute("update notifications__items set read_at = ? where read_at is null", [Date.now()]);
  if (r.changes > 0) await push(ctx, user, null);
  return r.changes;
}

export async function unreadCount(ctx: NotifCtx): Promise<number> {
  return unreadCountOf(ctx.db.scoped({ user_id: me(ctx) }));
}

export interface Pref {
  category: string;
  channel: string;
  enabled: boolean;
}

/** One row per category the user has notifications or preferences for, and per channel. */
export async function preferences(ctx: NotifCtx): Promise<Pref[]> {
  const db = ctx.db.scoped({ user_id: me(ctx) });
  const rows = await db.query<{ category: string; channel: string; enabled: number }>("select category, channel, enabled from notifications__prefs");
  const seen = await db.query<{ category: string }>("select distinct category from notifications__items");
  const cats = [...new Set([...seen.map((r) => r.category), ...rows.map((r) => r.category)])].sort();
  const all = [INAPP, ...channels(ctx)];
  const off = new Set(rows.filter((r) => r.enabled === 0).map((r) => `${r.category}\u0000${r.channel}`));
  return cats.flatMap((category) => all.map((channel) => ({ category, channel, enabled: !off.has(`${category}\u0000${channel}`) })));
}

export async function setPreference(ctx: NotifCtx, input: unknown): Promise<Pref> {
  const user = me(ctx);
  const o = input as { category?: unknown; channel?: unknown; enabled?: unknown } | null;
  if (typeof o?.category !== "string" || !CATEGORY.test(o.category)) throw new NotifError("setPreference: a category", "INVALID");
  if (typeof o.channel !== "string" || ![INAPP, ...channels(ctx)].includes(o.channel)) throw new NotifError("setPreference: a configured channel", "INVALID");
  const enabled = o.enabled === true || o.enabled === "true" || o.enabled === "1" || o.enabled === "on";
  const db = ctx.db.scoped({ user_id: user });
  await db.execute("delete from notifications__prefs where category = ? and channel = ?", [o.category, o.channel]);
  await db.execute("insert into notifications__prefs (user_id, category, channel, enabled) values (?, ?, ?, ?)", [user, o.category, o.channel, enabled ? 1 : 0]);
  return { category: o.category, channel: o.channel, enabled };
}
