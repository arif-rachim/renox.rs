// Sign-up friction (#123; deploy-api.md 0.5 section 21, "Friction"): a
// disposable address domain is refused before anything is stored; more than
// 3 sign-ups per IP per hour or 20 per ASN per day is 429; the CAPTCHA token
// is checked with the provider before anything is stored. The same CAPTCHA
// check guards reportAbuse (section 22).
//
// The CAPTCHA provider is any siteverify endpoint that takes `secret`,
// `response` and `remoteip` as a form and answers `{ success }` (Cloudflare
// Turnstile by default, hCaptcha and reCAPTCHA have the same shape). Without
// RENOX_CAPTCHA_SECRET the check is off (local mode), and the API warns once.
//
// The ASN of an address comes from an iptoasn.com-style TSV
// (`range_start  range_end  AS_number  country  description`, IPv4 and IPv6)
// named by RENOX_ASN_DB; without it the per-ASN rate is not applied.

import { readFileSync } from "node:fs";
import { isIP } from "node:net";

import type { BucketRule } from "../auth/buckets.ts";
import type { Db } from "../db/db.ts";

/** A short list of well-known disposable domains; operators extend it with RENOX_DISPOSABLE_DOMAINS. */
const BUILTIN = ["mailinator.com", "guerrillamail.com", "10minutemail.com", "tempmail.com", "temp-mail.org", "yopmail.com", "trashmail.com", "sharklasers.com", "getnada.com", "dispostable.com", "maildrop.cc", "throwawaymail.com"];

export function disposable(email: string, extra = process.env.RENOX_DISPOSABLE_DOMAINS ?? ""): boolean {
  const domain = email.split("@").pop()?.toLowerCase() ?? "";
  const list = new Set([...BUILTIN, ...extra.split(",").map((d) => d.trim().toLowerCase()).filter(Boolean)]);
  return [...list].some((d) => domain === d || domain.endsWith(`.${d}`));
}

/** Section 21: 3 sign-ups per IP per hour, 20 per ASN per day (token buckets, refilled evenly). */
export const SIGNUP_IP: BucketRule = { burst: 3, everySeconds: 3600 / 3 };
export const SIGNUP_ASN: BucketRule = { burst: 20, everySeconds: 86_400 / 20 };

// ---------------------------------------------------------------- CAPTCHA

export type CaptchaFetch = (url: string, init: RequestInit) => Promise<Response>;

const TURNSTILE = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** The provider's fetch; tests replace it. */
let captchaFetch: CaptchaFetch = (url, init) => fetch(url, init);
export const setCaptchaFetch = (f: CaptchaFetch): void => {
  captchaFetch = f;
};
export const currentCaptchaFetch = (): CaptchaFetch => captchaFetch;

let warned = false;

/**
 * The CAPTCHA verdict of a token: "off" when no secret is configured, "missing"
 * when the token is absent, "rejected" when the provider says no or cannot be
 * reached (the check fails closed), "ok" otherwise. The token and the secret
 * are never logged.
 */
export async function captcha(token: unknown, ip: string | null, env: Record<string, string | undefined> = process.env, warn: (m: string) => void = () => {}): Promise<"off" | "missing" | "rejected" | "ok"> {
  const secret = env.RENOX_CAPTCHA_SECRET ?? "";
  if (secret === "") {
    if (!warned) warn("RENOX_CAPTCHA_SECRET is not set: CAPTCHA tokens are not checked (local mode only)");
    warned = true;
    return "off";
  }
  if (typeof token !== "string" || token.length === 0 || token.length > 4096) return "missing";
  const form = new URLSearchParams({ secret, response: token });
  if (ip !== null) form.set("remoteip", ip);
  try {
    const res = await captchaFetch(env.RENOX_CAPTCHA_VERIFY_URL ?? TURNSTILE, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return "rejected";
    const body = (await res.json().catch(() => ({}))) as { success?: unknown };
    return body.success === true ? "ok" : "rejected";
  } catch {
    return "rejected";
  }
}

// ---------------------------------------------------------------- ASN

interface Ranges {
  v4: { start: number[]; end: number[]; asn: number[] };
  v6: { start: bigint[]; end: bigint[]; asn: number[] };
}

const tables = new Map<string, Ranges>();

function v4(ip: string): number {
  return ip.split(".").reduce((n, p) => n * 256 + Number(p), 0);
}

function v6(ip: string): bigint {
  const [head = "", tail] = ip.split("::");
  const parts = (s: string): string[] => (s === "" ? [] : s.split(":"));
  let groups = parts(head);
  const rest = tail === undefined ? [] : parts(tail);
  // An embedded IPv4 tail (::ffff:1.2.3.4) counts as two groups.
  const expand = (g: string[]): string[] => g.flatMap((x) => (x.includes(".") ? [((v4(x) >>> 16) & 0xffff).toString(16), (v4(x) & 0xffff).toString(16)] : [x]));
  groups = expand(groups);
  const end = expand(rest);
  const all = tail === undefined ? groups : [...groups, ...Array<string>(8 - groups.length - end.length).fill("0"), ...end];
  return all.reduce((n, g) => (n << 16n) | BigInt(parseInt(g || "0", 16)), 0n);
}

/** Parses an iptoasn TSV; rows with AS 0 (not routed) and malformed rows are left out. */
export function parseAsnTable(text: string): Ranges {
  const r4: [number, number, number][] = [];
  const r6: [bigint, bigint, number][] = [];
  for (const line of text.split("\n")) {
    const [a, b, n] = line.split("\t");
    const asn = Number(n);
    if (a === undefined || b === undefined || !Number.isInteger(asn) || asn <= 0) continue;
    const kind = isIP(a);
    if (kind !== isIP(b)) continue;
    if (kind === 4) r4.push([v4(a), v4(b), asn]);
    else if (kind === 6) r6.push([v6(a), v6(b), asn]);
  }
  r4.sort((x, y) => x[0] - y[0]);
  r6.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
  return {
    v4: { start: r4.map((x) => x[0]), end: r4.map((x) => x[1]), asn: r4.map((x) => x[2]) },
    v6: { start: r6.map((x) => x[0]), end: r6.map((x) => x[1]), asn: r6.map((x) => x[2]) },
  };
}

/** The last index whose start is <= key (binary search), or -1. */
function floor<T extends number | bigint>(starts: T[], key: T): number {
  let lo = 0;
  let hi = starts.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((starts[mid] as T) <= key) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** The ASN of an address in a parsed table, or null. */
export function asnIn(t: Ranges, ip: string): number | null {
  const kind = isIP(ip);
  if (kind === 4) {
    const k = v4(ip);
    const i = floor(t.v4.start, k);
    return i >= 0 && k <= (t.v4.end[i] as number) ? (t.v4.asn[i] as number) : null;
  }
  if (kind === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/iu.exec(ip);
    if (mapped !== null) return asnIn(t, mapped[1] as string);
    const k = v6(ip);
    const i = floor(t.v6.start, k);
    return i >= 0 && k <= (t.v6.end[i] as bigint) ? (t.v6.asn[i] as number) : null;
  }
  return null;
}

/** The ASN of a client address from RENOX_ASN_DB (read once per path), or null without one. */
export function asnOf(ip: string | null, path = process.env.RENOX_ASN_DB ?? ""): number | null {
  if (ip === null || path === "") return null;
  let t = tables.get(path);
  if (t === undefined) {
    try {
      t = parseAsnTable(readFileSync(path, "utf8"));
    } catch {
      t = parseAsnTable("");
    }
    tables.set(path, t);
  }
  return asnIn(t, ip);
}

// ---------------------------------------------------------------- flags

/**
 * Section 21: the new-tenant restrictions stay past 7 days while the tenant
 * has an abuse flag (a ticket not dismissed, section 22) or an anomaly review
 * (section 20) from the last 7 days.
 */
export async function flagged(db: Db, tenantId: string, now: number): Promise<boolean> {
  const since = now - 7 * 86_400_000;
  const rows = await db.query<{ n: number }>(
    `select (select count(*) from abuse_tickets where tenant_id = $1 and state <> 'dismissed' and reported_at >= $2)
          + (select count(*) from billing_reviews where tenant_id = $1 and created_at >= $2) as n`,
    [tenantId, since],
  );
  return Number(rows[0]?.n ?? 0) > 0;
}
