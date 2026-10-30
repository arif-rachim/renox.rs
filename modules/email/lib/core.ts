// The email module (#328): a queue in email__messages, delivered by the
// module's own `email.send_requested` handler after the commit (the outbox
// retries a throw, so a provider 5xx is retried and a 4xx is final), and a
// suppression list that bounces and complaints fill. Bodies are never logged.

export interface Db {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  queryOne<T>(sql: string, params?: unknown[]): Promise<T | null>;
  execute(sql: string, params?: unknown[]): Promise<{ changes: number }>;
}

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface EmailCtx {
  db: Db;
  fetch: FetchFn;
  secrets: Record<string, string | undefined>;
  config: { provider?: string; from?: string; ses_region?: string; sends_per_minute?: number };
  events: { emit(name: string, payload: unknown): Promise<void> };
  log: { info(msg: string, fields?: Record<string, unknown>): void; warn(msg: string, fields?: Record<string, unknown>): void };
}

export class EmailError extends Error {
  constructor(
    message: string,
    readonly code: "INVALID" | "SUPPRESSED" | "RATE_LIMITED" | "NOT_CONFIGURED",
  ) {
    super(message);
    this.name = "EmailError";
  }
}

const ADDRESS = /^[^\s@<>()",;:]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)+$/iu;

export function address(v: unknown): string {
  if (typeof v !== "string" || v.length > 254 || !ADDRESS.test(v.trim())) throw new EmailError("an email address", "INVALID");
  return v.trim().toLowerCase();
}

const newId = (): string => {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return `em_${Date.now().toString(36)}${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}`;
};

export async function suppressed(ctx: EmailCtx, to: unknown): Promise<boolean> {
  return (await ctx.db.queryOne("select 1 as x from email__suppressions where address = ?", [address(to)])) !== null;
}

export async function send(ctx: EmailCtx, msg: { to?: unknown; subject?: unknown; text?: unknown; html?: unknown }): Promise<{ id: string }> {
  const to = address(msg.to);
  if (typeof msg.subject !== "string" || msg.subject.length === 0 || msg.subject.length > 998 || /[\r\n]/u.test(msg.subject)) throw new EmailError("a one-line subject", "INVALID");
  const text = typeof msg.text === "string" ? msg.text : "";
  const html = typeof msg.html === "string" ? msg.html : "";
  if (text === "" && html === "") throw new EmailError("text or html", "INVALID");
  if (await suppressed(ctx, to)) throw new EmailError("the address is suppressed (a bounce or a complaint)", "SUPPRESSED");
  const limit = Number(ctx.config.sends_per_minute ?? 120);
  const t = Date.now();
  const recent = (await ctx.db.queryOne<{ n: number }>("select count(*) as n from email__messages where at > ?", [t - 60_000]))?.n ?? 0;
  if (recent >= limit) throw new EmailError(`at most ${limit} messages a minute`, "RATE_LIMITED");
  const id = newId();
  await ctx.db.execute("insert into email__messages (id, to_address, subject, text_body, html_body, status, at, updated_at) values (?, ?, ?, ?, ?, 'queued', ?, ?)", [id, to, msg.subject, text, html, t, t]);
  await ctx.events.emit("email.send_requested", { message_id: id });
  return { id };
}

export async function status(ctx: EmailCtx, id: unknown): Promise<{ status: string; attempts: number; error: string | null } | null> {
  if (typeof id !== "string") return null;
  return ctx.db.queryOne("select status, attempts, error from email__messages where id = ?", [id]);
}

export async function suppress(ctx: EmailCtx, addr: unknown, reason: unknown): Promise<{ ok: true }> {
  const r = reason === "bounce" || reason === "complaint" ? reason : "manual";
  await ctx.db.execute("insert into email__suppressions (address, reason, at) values (?, ?, ?) on conflict (address) do update set reason = excluded.reason, at = excluded.at", [address(addr), r, Date.now()]);
  return { ok: true };
}

export async function unsuppress(ctx: EmailCtx, addr: unknown): Promise<{ ok: true }> {
  await ctx.db.execute("delete from email__suppressions where address = ?", [address(addr)]);
  return { ok: true };
}

/** One provider call; `retry` when the provider may succeed later (5xx, network). */
export interface SendResult {
  ok: boolean;
  retry: boolean;
  status: number;
  id?: string;
  error?: string;
}

export interface Outgoing {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}

export async function sendResend(fetchFn: FetchFn, key: string, m: Outgoing): Promise<SendResult> {
  let res: Response;
  try {
    res = await fetchFn("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ from: m.from, to: [m.to], subject: m.subject, ...(m.text ? { text: m.text } : {}), ...(m.html ? { html: m.html } : {}) }),
    });
  } catch {
    return { ok: false, retry: true, status: 0, error: "network" };
  }
  if (res.ok) return { ok: true, retry: false, status: res.status, id: ((await res.json().catch(() => ({}))) as { id?: string }).id };
  await res.body?.cancel();
  return { ok: false, retry: res.status >= 500 || res.status === 429, status: res.status, error: `resend ${res.status}` };
}

const hex = (b: ArrayBuffer): string => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const sha256 = async (s: string): Promise<string> => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
async function hmac(key: ArrayBuffer | Uint8Array, s: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", key as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, new TextEncoder().encode(s));
}

/** SigV4 of one SES v2 request (service `ses`), for `x-amz-date` = `amzDate`. */
export async function sesAuthorization(accessKey: string, secretKey: string, region: string, amzDate: string, host: string, path: string, body: string): Promise<string> {
  const date = amzDate.slice(0, 8);
  const payload = await sha256(body);
  const canonical = `POST\n${path}\n\ncontent-type:application/json\nhost:${host}\nx-amz-date:${amzDate}\n\ncontent-type;host;x-amz-date\n${payload}`;
  const scope = `${date}/${region}/ses/aws4_request`;
  const toSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${await sha256(canonical)}`;
  let k = await hmac(new TextEncoder().encode(`AWS4${secretKey}`), date);
  for (const part of [region, "ses", "aws4_request"]) k = await hmac(k, part);
  return `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=content-type;host;x-amz-date, Signature=${hex(await hmac(k, toSign))}`;
}

export async function sendSes(fetchFn: FetchFn, access: string, secret: string, region: string, m: Outgoing, now = new Date()): Promise<SendResult> {
  const host = `email.${region}.amazonaws.com`;
  const path = "/v2/email/outbound-emails";
  const body = JSON.stringify({
    FromEmailAddress: m.from,
    Destination: { ToAddresses: [m.to] },
    Content: { Simple: { Subject: { Data: m.subject, Charset: "UTF-8" }, Body: { ...(m.text ? { Text: { Data: m.text, Charset: "UTF-8" } } : {}), ...(m.html ? { Html: { Data: m.html, Charset: "UTF-8" } } : {}) } } },
  });
  const amzDate = now.toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}/u, "");
  let res: Response;
  try {
    res = await fetchFn(`https://${host}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-amz-date": amzDate, authorization: await sesAuthorization(access, secret, region, amzDate, host, path, body) },
      body,
    });
  } catch {
    return { ok: false, retry: true, status: 0, error: "network" };
  }
  if (res.ok) return { ok: true, retry: false, status: res.status, id: ((await res.json().catch(() => ({}))) as { MessageId?: string }).MessageId };
  await res.body?.cancel();
  return { ok: false, retry: res.status >= 500 || res.status === 429, status: res.status, error: `ses ${res.status}` };
}

/** The `email.send_requested` handler: one provider call; throws to have the outbox retry. */
export async function deliverQueued(ctx: EmailCtx, id: string): Promise<SendResult | null> {
  const m = await ctx.db.queryOne<{ id: string; to_address: string; subject: string; text_body: string; html_body: string; status: string }>("select * from email__messages where id = ?", [id]);
  if (m === null || m.status !== "queued") return null;
  const t = Date.now();
  if (await suppressed(ctx, m.to_address)) {
    await ctx.db.execute("update email__messages set status = 'suppressed', updated_at = ? where id = ?", [t, id]);
    return null;
  }
  const from = ctx.config.from ?? "";
  const out: Outgoing = { from, to: m.to_address, subject: m.subject, text: m.text_body, html: m.html_body };
  let r: SendResult;
  if (from === "") r = { ok: false, retry: false, status: 0, error: "not_configured" };
  else if ((ctx.config.provider ?? "resend") === "ses") {
    const [a, s] = [ctx.secrets.EMAIL_SES_ACCESS_KEY, ctx.secrets.EMAIL_SES_SECRET_KEY];
    r = a && s ? await sendSes(ctx.fetch, a, s, ctx.config.ses_region ?? "me-central-1", out) : { ok: false, retry: false, status: 0, error: "not_configured" };
  } else {
    const k = ctx.secrets.EMAIL_RESEND_KEY;
    r = k ? await sendResend(ctx.fetch, k, out) : { ok: false, retry: false, status: 0, error: "not_configured" };
  }
  if (r.ok) {
    await ctx.db.execute("update email__messages set status = 'sent', provider_id = ?, error = null, attempts = attempts + 1, updated_at = ? where id = ?", [r.id ?? null, t, id]);
    return r;
  }
  await ctx.db.execute(`update email__messages set ${r.retry ? "" : "status = 'failed', "}error = ?, attempts = attempts + 1, updated_at = ? where id = ?`, [r.error ?? "failed", t, id]);
  ctx.log.warn("email not sent", { message_id: id, status: r.status, retry: r.retry });
  if (r.retry) throw new Error(`email ${id}: ${r.error}`);
  return r;
}

/** A bounce or complaint notification (the webhook): the address is suppressed. */
export async function recordFeedback(ctx: EmailCtx, payload: unknown): Promise<{ suppressed: string | null }> {
  const p = (payload ?? {}) as { type?: string; data?: { to?: string[] | string; email?: string } };
  const kind = p.type === "email.bounced" || p.type === "bounce" ? "bounce" : p.type === "email.complained" || p.type === "complaint" ? "complaint" : null;
  const raw = Array.isArray(p.data?.to) ? p.data?.to[0] : (p.data?.to ?? p.data?.email);
  if (kind === null || typeof raw !== "string") return { suppressed: null };
  await suppress(ctx, raw, kind);
  return { suppressed: address(raw) };
}
