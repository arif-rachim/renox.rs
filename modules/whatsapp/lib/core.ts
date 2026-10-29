// The whatsapp module's logic (#290). Outgoing messages are rows of
// whatsapp__messages, queued by the services and sent by the module's own
// handler of `whatsapp.send_requested` (the outbox runs it after the
// commit and retries it when it throws): a 5xx never blocks a request.

import * as api from "./cloud-api.ts";
import * as otp from "./otp.ts";

export interface Db {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  queryOne<T>(sql: string, params?: unknown[]): Promise<T | null>;
  execute(sql: string, params?: unknown[]): Promise<{ changes: number }>;
}

export interface WaCtx {
  db: Db;
  fetch: api.FetchFn;
  secrets: Record<string, string | undefined>;
  config: { api_version?: string; sends_per_minute?: number; otp_template?: string; otp_language?: string };
  events: { emit(name: string, payload: unknown): Promise<void> };
  log: { info(msg: string, fields?: Record<string, unknown>): void; warn(msg: string, fields?: Record<string, unknown>): void };
}

export class WaError extends Error {
  constructor(
    message: string,
    readonly code: "INVALID" | "RATE_LIMITED" | "NOT_CONFIGURED",
  ) {
    super(message);
    this.name = "WaError";
  }
}

const TEMPLATE_NAME = /^[a-z0-9_]{1,512}$/u;
const LANGUAGE = /^[a-z]{2,3}(_[A-Z]{2})?$/u;

const newId = (): string => {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return `wam_${Date.now().toString(36)}${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}`;
};

function phoneOf(v: unknown): string {
  const p = api.normalizePhone(v);
  if (p === null) throw new WaError("a phone number in international form (+971...)", "INVALID");
  return p;
}

function appSecret(ctx: WaCtx): string {
  const s = ctx.secrets.WHATSAPP_APP_SECRET;
  if (!s) throw new WaError("WHATSAPP_APP_SECRET is not set", "NOT_CONFIGURED");
  return s;
}

/** Queues one outgoing message after the tenant's per-minute limit. */
async function queue(ctx: WaCtx, phone: string, kind: "text" | "template" | "otp", body: string): Promise<{ id: string }> {
  const limit = Number(ctx.config.sends_per_minute ?? 60);
  const t = Date.now();
  const recent = (await ctx.db.queryOne<{ n: number }>("select count(*) as n from whatsapp__messages where direction = 'out' and at > ?", [t - 60_000]))?.n ?? 0;
  if (recent >= limit) throw new WaError(`at most ${limit} messages a minute`, "RATE_LIMITED");
  const id = newId();
  await ctx.db.execute("insert into whatsapp__messages (id, direction, kind, phone, body, status, at, updated_at) values (?, 'out', ?, ?, ?, 'queued', ?, ?)", [id, kind, phone, body, t, t]);
  await ctx.events.emit("whatsapp.send_requested", { message_id: id });
  return { id };
}

export async function send(ctx: WaCtx, to: unknown, text: unknown): Promise<{ id: string }> {
  if (typeof text !== "string" || text.trim() === "" || text.length > 4096) throw new WaError("a text of 1 to 4096 characters", "INVALID");
  return queue(ctx, phoneOf(to), "text", text);
}

export async function sendTemplate(ctx: WaCtx, to: unknown, name: unknown, params: unknown = [], language: unknown = "en"): Promise<{ id: string }> {
  if (typeof name !== "string" || !TEMPLATE_NAME.test(name)) throw new WaError("a template name", "INVALID");
  if (typeof language !== "string" || !LANGUAGE.test(language)) throw new WaError("a language code (en, ar, en_US)", "INVALID");
  if (!Array.isArray(params) || params.length > 20 || !params.every((p) => typeof p === "string" && p.length <= 1024)) throw new WaError("params are up to 20 strings", "INVALID");
  const tpl = await ctx.db.queryOne<{ status: string }>("select status from whatsapp__templates where name = ? and language = ?", [name, language]);
  if (tpl !== null && tpl.status !== "approved") throw new WaError(`template ${name} (${language}) is ${tpl.status}`, "INVALID");
  return queue(ctx, phoneOf(to), "template", JSON.stringify({ name, language, params }));
}

/** The same answer for every valid phone: whether it has WhatsApp, an account, or a code already. */
export async function sendOtp(ctx: WaCtx, phone: unknown): Promise<{ sent: true; expires_in: number }> {
  const p = phoneOf(phone);
  const secret = appSecret(ctx);
  const answer = { sent: true as const, expires_in: otp.OTP_TTL_MS / 1000 };
  const t = Date.now();
  const prior = await ctx.db.queryOne<{ created_at: number }>("select created_at from whatsapp__otp where phone = ?", [p]);
  if (prior !== null && t - prior.created_at < otp.OTP_RESEND_MS) return answer;
  const code = otp.newCode();
  await ctx.db.execute("delete from whatsapp__otp where phone = ?", [p]);
  await ctx.db.execute("insert into whatsapp__otp (phone, code_hash, expires_at, attempts, created_at) values (?, ?, ?, 0, ?)", [p, await otp.codeHash(secret, p, code), t + otp.OTP_TTL_MS, t]);
  await queue(ctx, p, "otp", await otp.seal(secret, code));
  return answer;
}

/** auth's code (#291, the `auth.send_otp` filler): sent as an OTP message, sealed in the queue like ours. */
export async function sendCode(ctx: WaCtx, phone: unknown, code: unknown): Promise<{ id: string }> {
  if (typeof code !== "string" || !/^[0-9]{4,10}$/u.test(code)) throw new WaError("a numeric code", "INVALID");
  return queue(ctx, phoneOf(phone), "otp", await otp.seal(appSecret(ctx), code));
}

/** `{ ok: false }` for a wrong, expired, used, or exhausted code alike. */
export async function verifyOtp(ctx: WaCtx, phone: unknown, code: unknown): Promise<{ ok: boolean }> {
  const p = api.normalizePhone(phone);
  if (p === null || typeof code !== "string" || !/^[0-9]{6}$/u.test(code)) return { ok: false };
  const secret = appSecret(ctx);
  const row = await ctx.db.queryOne<{ code_hash: string; expires_at: number; attempts: number; verified_at: number | null }>("select code_hash, expires_at, attempts, verified_at from whatsapp__otp where phone = ?", [p]);
  const t = Date.now();
  if (row === null || row.verified_at !== null || row.expires_at <= t || row.attempts >= otp.OTP_ATTEMPTS) return { ok: false };
  await ctx.db.execute("update whatsapp__otp set attempts = attempts + 1 where phone = ?", [p]);
  if (!(await otp.codeMatches(secret, p, code, row.code_hash))) return { ok: false };
  await ctx.db.execute("update whatsapp__otp set verified_at = ? where phone = ?", [t, p]);
  return { ok: true };
}

/** The user's WhatsApp contact, once the phone passed verifyOtp in the last 10 minutes. */
export async function linkPhone(ctx: WaCtx, userId: unknown, phone: unknown): Promise<{ ok: boolean }> {
  const p = api.normalizePhone(phone);
  if (typeof userId !== "string" || userId === "" || p === null) return { ok: false };
  const row = await ctx.db.queryOne<{ verified_at: number | null }>("select verified_at from whatsapp__otp where phone = ?", [p]);
  const t = Date.now();
  if (row?.verified_at == null || t - row.verified_at > 10 * 60_000) return { ok: false };
  await ctx.db.execute("delete from whatsapp__contacts where user_id = ?", [userId]);
  await ctx.db.execute("insert into whatsapp__contacts (user_id, phone, verified_at) values (?, ?, ?)", [userId, p, row.verified_at]);
  return { ok: true };
}

export interface InboxRow {
  id: string;
  direction: "in" | "out";
  kind: string;
  phone: string;
  body: string;
  status: string;
  at: number;
}

export async function inbox(ctx: WaCtx, filter: { phone?: string; direction?: "in" | "out"; limit?: number } = {}): Promise<InboxRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  const p = filter.phone === undefined ? null : api.normalizePhone(filter.phone);
  if (filter.phone !== undefined) {
    where.push("phone = ?");
    params.push(p ?? "");
  }
  if (filter.direction === "in" || filter.direction === "out") {
    where.push("direction = ?");
    params.push(filter.direction);
  }
  const limit = Math.min(Math.max(Math.trunc(Number(filter.limit ?? 50)) || 50, 1), 200);
  const rows = await ctx.db.query<InboxRow>(`select id, direction, kind, phone, body, status, at from whatsapp__messages ${where.length ? `where ${where.join(" and ")}` : ""} order by at desc, id desc limit ?`, [...params, limit]);
  return rows.map((r) => (r.kind === "otp" ? { ...r, body: "[otp]" } : r));
}

function apiConfig(ctx: WaCtx): api.ApiConfig | null {
  const token = ctx.secrets.WHATSAPP_TOKEN;
  const phoneId = ctx.secrets.WHATSAPP_PHONE_ID;
  if (!token || !phoneId) return null;
  return { token, phoneId, version: ctx.config.api_version ?? "v21.0" };
}

/**
 * The outbox handler of `whatsapp.send_requested`: sends one queued
 * message. A 5xx, a 429, or a network failure throws, so the outbox
 * retries it; a 4xx marks it failed. An OTP's sealed code is cleared once
 * the message is sent or failed.
 */
export async function deliverQueued(ctx: WaCtx, messageId: string): Promise<api.SendResult | null> {
  const m = await ctx.db.queryOne<{ id: string; kind: string; phone: string; body: string; status: string }>("select id, kind, phone, body, status from whatsapp__messages where id = ? and direction = 'out'", [messageId]);
  if (m === null || m.status !== "queued") return null;
  const cfg = apiConfig(ctx);
  const t = Date.now();
  const fail = async (error: string) => {
    await ctx.db.execute("update whatsapp__messages set status = 'failed', error = ?, body = case kind when 'otp' then '' else body end, attempts = attempts + 1, updated_at = ? where id = ?", [error, t, m.id]);
  };
  if (cfg === null) {
    await fail("not_configured");
    return { ok: false, retry: false, status: 0, error: "not_configured" };
  }
  let r: api.SendResult;
  if (m.kind === "text") r = await api.sendText(ctx.fetch, cfg, m.phone, m.body);
  else if (m.kind === "template") {
    const tpl = JSON.parse(m.body) as { name: string; language: string; params: string[] };
    r = await api.sendTemplate(ctx.fetch, cfg, m.phone, tpl.name, tpl.language, tpl.params);
  } else {
    const code = await otp.unseal(ctx.secrets.WHATSAPP_APP_SECRET ?? "", m.body);
    if (code === null) {
      await fail("unsealable");
      return { ok: false, retry: false, status: 0, error: "unsealable" };
    }
    const template = ctx.config.otp_template ?? "";
    r = template
      ? await api.sendTemplate(ctx.fetch, cfg, m.phone, template, ctx.config.otp_language ?? "en", [code])
      : await api.sendText(ctx.fetch, cfg, m.phone, `Your code is ${code}. It expires in 5 minutes. Do not share it.`);
  }
  if (r.ok) {
    await ctx.db.execute("update whatsapp__messages set status = 'sent', wa_id = ?, error = null, body = case kind when 'otp' then '' else body end, attempts = attempts + 1, updated_at = ? where id = ?", [r.waId || null, t, m.id]);
    return r;
  }
  if (!r.retry) {
    await fail(r.error);
    return r;
  }
  await ctx.db.execute("update whatsapp__messages set error = ?, attempts = attempts + 1, updated_at = ? where id = ?", [r.error, t, m.id]);
  ctx.log.warn("whatsapp: send failed, the outbox retries it", { message_id: m.id, error: r.error });
  throw new Error(`whatsapp send ${m.id}: ${r.error}`);
}

/** Stores one webhook delivery: inbound messages (once each) and status updates. Returns the new inbound ids. */
export async function receive(ctx: WaCtx, parsed: ReturnType<typeof api.parseWebhook>): Promise<string[]> {
  const t = Date.now();
  const ids: string[] = [];
  for (const m of parsed.messages) {
    const seen = await ctx.db.queryOne("select 1 as x from whatsapp__messages where wa_id = ?", [m.waId]);
    if (seen !== null) continue;
    const id = newId();
    await ctx.db.execute("insert into whatsapp__messages (id, direction, kind, wa_id, phone, body, status, at, updated_at) values (?, 'in', 'text', ?, ?, ?, 'received', ?, ?)", [id, m.waId, m.from, m.text, m.at, t]);
    await ctx.events.emit("whatsapp.message_received", { message_id: id, from: m.from });
    ids.push(id);
  }
  const rank = { sent: 1, delivered: 2, read: 3, failed: 4 } as const;
  for (const s of parsed.statuses) {
    const row = await ctx.db.queryOne<{ id: string; status: string }>("select id, status from whatsapp__messages where wa_id = ? and direction = 'out'", [s.waId]);
    if (row === null) continue;
    // Statuses can arrive out of order: never move backwards.
    if ((rank[row.status as keyof typeof rank] ?? 0) >= rank[s.status]) continue;
    await ctx.db.execute("update whatsapp__messages set status = ?, updated_at = ? where id = ?", [s.status, t, row.id]);
  }
  return ids;
}
