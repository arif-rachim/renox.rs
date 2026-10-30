// The WhatsApp Cloud API client (#290; graph.facebook.com only, the
// manifest's network permission). Every call takes `fetch`, so the tests
// run it against a fake Cloud API in the test process (tenant fetch blocks
// private addresses, so a local fake cannot be reached from the worker).

export const API_HOST = "https://graph.facebook.com";

export interface ApiConfig {
  token: string;
  phoneId: string;
  version: string;
}

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

/** What one call came to: sent, a failure to retry (5xx, 429, network), or a final refusal (4xx). */
export type SendResult = { ok: true; waId: string } | { ok: false; retry: true; status: number; error: string } | { ok: false; retry: false; status: number; error: string };

const PHONE = /^\+[1-9][0-9]{7,14}$/u;

/** A phone number in E.164 (`+9715...`); spaces, dashes and brackets are dropped; `00` becomes `+`. */
export function normalizePhone(v: unknown): string | null {
  if (typeof v !== "string") return null;
  let p = v.replace(/[\s\-().]/gu, "");
  if (p.startsWith("00")) p = `+${p.slice(2)}`;
  return PHONE.test(p) ? p : null;
}

/** The Cloud API's `to`: digits only. */
const toOf = (phone: string): string => phone.replace(/^\+/u, "");

async function call(fetch: FetchFn, cfg: ApiConfig, path: string, body: unknown): Promise<SendResult> {
  if (!/^v[0-9]{1,3}\.[0-9]{1,3}$/u.test(cfg.version) || !/^[0-9]{1,32}$/u.test(cfg.phoneId)) return { ok: false, retry: false, status: 0, error: "config" };
  let res: Response;
  try {
    res = await fetch(`${API_HOST}/${cfg.version}/${cfg.phoneId}/${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { ok: false, retry: true, status: 0, error: `network: ${(e as Error)?.name ?? "error"}` };
  }
  let json: { messages?: { id?: string }[]; error?: { code?: number; message?: string } } = {};
  try {
    json = (await res.json()) as typeof json;
  } catch {
    // An empty or non-JSON body.
  }
  if (res.ok) return { ok: true, waId: json.messages?.[0]?.id ?? "" };
  const error = `${res.status}${json.error?.code !== undefined ? ` (${json.error.code})` : ""}`;
  return res.status >= 500 || res.status === 429 ? { ok: false, retry: true, status: res.status, error } : { ok: false, retry: false, status: res.status, error };
}

export function sendText(fetch: FetchFn, cfg: ApiConfig, to: string, text: string): Promise<SendResult> {
  return call(fetch, cfg, "messages", { messaging_product: "whatsapp", recipient_type: "individual", to: toOf(to), type: "text", text: { preview_url: false, body: text } });
}

export function sendTemplate(fetch: FetchFn, cfg: ApiConfig, to: string, name: string, language: string, params: string[]): Promise<SendResult> {
  const components = params.length ? [{ type: "body", parameters: params.map((text) => ({ type: "text", text })) }] : [];
  return call(fetch, cfg, "messages", { messaging_product: "whatsapp", to: toOf(to), type: "template", template: { name, language: { code: language }, components } });
}

export function markRead(fetch: FetchFn, cfg: ApiConfig, waId: string): Promise<SendResult> {
  return call(fetch, cfg, "messages", { messaging_product: "whatsapp", status: "read", message_id: waId });
}

const enc = new TextEncoder();

const hex = (b: ArrayBuffer): string => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");

/** Constant-time comparison of two strings of the same alphabet. */
export function sameString(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

export async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

/** `X-Hub-Signature-256: sha256=<hex>` over the raw body with the app secret, compared in constant time. */
export async function verifySignature(appSecret: string, rawBody: string, header: string | null): Promise<boolean> {
  if (!appSecret || typeof header !== "string" || !header.startsWith("sha256=")) return false;
  const want = await hmacHex(appSecret, rawBody);
  return sameString(header.slice("sha256=".length).toLowerCase(), want);
}

export interface Inbound {
  waId: string;
  from: string;
  text: string;
  at: number;
}

export interface StatusUpdate {
  waId: string;
  status: "sent" | "delivered" | "read" | "failed";
  at: number;
}

/** The messages and status updates of one webhook delivery (`entry[].changes[].value`). */
export function parseWebhook(body: unknown): { messages: Inbound[]; statuses: StatusUpdate[] } {
  const messages: Inbound[] = [];
  const statuses: StatusUpdate[] = [];
  const entries = (body as { entry?: unknown[] } | null)?.entry;
  for (const entry of Array.isArray(entries) ? entries : []) {
    const changes = (entry as { changes?: unknown[] }).changes;
    for (const change of Array.isArray(changes) ? changes : []) {
      const v = (change as { value?: { messages?: unknown[]; statuses?: unknown[] } }).value ?? {};
      for (const m of Array.isArray(v.messages) ? v.messages : []) {
        const o = m as { id?: string; from?: string; timestamp?: string; type?: string; text?: { body?: string } };
        const from = normalizePhone(`+${o.from ?? ""}`);
        if (typeof o.id !== "string" || from === null) continue;
        messages.push({ waId: o.id, from, text: o.type === "text" ? String(o.text?.body ?? "").slice(0, 4096) : `[${o.type ?? "message"}]`, at: Number(o.timestamp ?? 0) * 1000 || Date.now() });
      }
      for (const s of Array.isArray(v.statuses) ? v.statuses : []) {
        const o = s as { id?: string; status?: string; timestamp?: string };
        if (typeof o.id !== "string" || !["sent", "delivered", "read", "failed"].includes(String(o.status))) continue;
        statuses.push({ waId: o.id, status: o.status as StatusUpdate["status"], at: Number(o.timestamp ?? 0) * 1000 || Date.now() });
      }
    }
  }
  return { messages, statuses };
}

/** `https://wa.me/<digits>?text=<message>`: the chat-to-order button. */
export function chatLink(phone: string, text: string): string {
  return `https://wa.me/${toOf(phone)}${text ? `?text=${encodeURIComponent(text.slice(0, 1000))}` : ""}`;
}
