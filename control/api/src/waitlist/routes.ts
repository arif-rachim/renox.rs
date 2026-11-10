// The site's waitlists (docs/contracts/deploy-api.md 0.10 section 21, #691):
// `joinWaitlist` takes an address for one list (`connector` or `email`),
// `confirmWaitlist` is the link of the confirmation mail (double opt-in), and
// `exportWaitlist` gives the operator the confirmed rows as CSV.
//
// docs/24-threat-model.md, "Waitlist as a spam relay or an enumeration oracle":
//   - the join never reads a cookie or a session, so a logged-in browser is no
//     different from any other caller and the route cannot be a CSRF target
//     (a form post from the site is a navigation: no CORS, src/cors.ts is not
//     changed);
//   - every answer to a valid request is the same (202 `check_email`, or the
//     same 303), whether the address is new, known, confirmed or its mail was
//     held back by the one-per-hour rule;
//   - a disposable domain is 400, more than 3 joins per IP per hour is 429,
//     the CAPTCHA is checked when one is configured;
//   - `return_to` is followed only when it is on the site's origin
//     (CONTROL_SITE_URL), so the route is no open redirect;
//   - the table keeps the address (it is the list) but the audit row and the
//     IP column hold hashes only; the confirm token is stored as a hash, works
//     once and for 7 days.

import type { Context, Hono } from "hono";
import { operation, writeAudit } from "../audit.ts";
import { emailField } from "../auth/accounts.ts";
import { bucketsOf } from "../auth/buckets.ts";
import { clientIp } from "../auth/ip.ts";
import { sendWaitlistConfirm } from "../auth/notify.ts";
import { newOneTimeValue } from "../auth/sessions.ts";
import { DAY_MS, sha256hex } from "../auth/tokens.ts";
import { DEFAULTS } from "../config.ts";
import type { Deps, Env } from "../context.ts";
import { num } from "../db/db.ts";
import { ApiError, invalid } from "../errors.ts";
import { readBody } from "../http.ts";
import { accountRef, operatorOf, opsAuth } from "../ops/auth.ts";
import { captcha, disposable, SIGNUP_IP } from "../signup/friction.ts";
import type { BucketRule } from "../auth/buckets.ts";

export const INTERESTS = ["connector", "email"] as const;
export type Interest = (typeof INTERESTS)[number];

/** A confirmation link works for 7 days. */
export const CONFIRM_TTL_MS = 7 * DAY_MS;
/** A repeat of a join re-sends the mail at most once an hour. */
export const RESEND_EVERY_MS = 3_600_000;

/**
 * The join's own bucket, with the sign-up's limit (3 per IP per hour) but its own key, so joining a waitlist
 * and signing up do not use each other's allowance (decision recorded in deploy-api.md section 21).
 */
const WAITLIST_IP: BucketRule = SIGNUP_IP;

const BODY_LIMIT = 16 * 1024;
const KEYS = new Set(["email", "interest", "locale", "captcha_token", "return_to"]);

const siteOrigin = (deps: Deps): string => new URL(deps.config.siteUrl ?? DEFAULTS.siteUrl).origin;

/**
 * Where a browser goes after a join: `returnTo` when it is an absolute http(s) URL whose origin is exactly the
 * site's and that carries no credentials, otherwise the site's root. Nothing relative, protocol-relative, with
 * userinfo, or on another host (or another port or scheme) is followed.
 */
export function siteRedirect(site: string, returnTo: unknown): string {
  const origin = new URL(site).origin;
  if (typeof returnTo === "string" && returnTo.length > 0 && returnTo.length <= 2048) {
    try {
      const u = new URL(returnTo);
      if ((u.protocol === "https:" || u.protocol === "http:") && u.origin === origin && u.username === "" && u.password === "") return u.href;
    } catch {
      // not an absolute URL: the root
    }
  }
  return `${origin}/`;
}

/** True when the `Accept` header prefers `text/html` over JSON: a browser navigation (a form post). */
export function prefersHtml(accept: string | undefined): boolean {
  if (accept === undefined) return false;
  const types = accept.split(",").map((s) => s.trim().toLowerCase().split(";")[0] as string);
  const html = types.indexOf("text/html");
  if (html === -1) return false;
  const json = types.indexOf("application/json");
  return json === -1 || html < json;
}

interface JoinBody {
  email: string;
  interest: Interest;
  locale: "en" | "ar";
  captchaToken: unknown;
  returnTo: unknown;
}

async function joinBody(c: Context<Env>): Promise<JoinBody> {
  const type = c.req.header("content-type") ?? "";
  let raw: Record<string, unknown>;
  if (/^application\/x-www-form-urlencoded(;|$)/iu.test(type)) {
    const params = new URLSearchParams(new TextDecoder().decode(await readBody(c, BODY_LIMIT)));
    raw = {};
    for (const [k, v] of params) if (v !== "" && !(k in raw)) raw[k] = v;
    // The Turnstile widget names its field `cf-turnstile-response`; a form may also carry fields of its own (ignored).
    raw.captcha_token ??= raw["cf-turnstile-response"] ?? raw["h-captcha-response"] ?? raw["g-recaptcha-response"];
    for (const k of Object.keys(raw)) if (!KEYS.has(k)) delete raw[k];
  } else if (/^application\/json(;|$)/iu.test(type)) {
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readBody(c, BODY_LIMIT)));
    } catch {
      throw invalid("body", "not valid UTF-8 JSON");
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalid("body", "must be a JSON object");
    raw = value as Record<string, unknown>;
    const unknown = Object.keys(raw).find((k) => !KEYS.has(k));
    if (unknown !== undefined) throw invalid(unknown, "unknown field");
  } else {
    throw invalid("content-type", "must be application/json or application/x-www-form-urlencoded");
  }
  const email = emailField(raw.email);
  if (typeof raw.interest !== "string" || !(INTERESTS as readonly string[]).includes(raw.interest)) throw invalid("interest", "must be connector or email");
  if (raw.locale !== undefined && typeof raw.locale !== "string") throw invalid("locale", "must be a string");
  if (raw.captcha_token !== undefined && (typeof raw.captcha_token !== "string" || raw.captcha_token.length === 0 || raw.captcha_token.length > 4096)) throw invalid("captcha_token", "a non-empty string");
  if (raw.return_to !== undefined && typeof raw.return_to !== "string") throw invalid("return_to", "must be a string");
  return {
    email,
    interest: raw.interest as Interest,
    // `ar` (or `ar-AE` and the like) is Arabic; anything else is English.
    locale: typeof raw.locale === "string" && /^ar([-_]|$)/iu.test(raw.locale.trim()) ? "ar" : "en",
    captchaToken: raw.captcha_token,
    returnTo: raw.return_to,
  };
}

/** One CSV field: quoted when it holds a comma, a quote or a line break; a leading `= + - @` is defused (CSV injection). */
export function csvField(v: string): string {
  const safe = /^[=+\-@\t\r]/u.test(v) ? `'${v}` : v;
  return /[",\r\n]/u.test(safe) ? `"${safe.replace(/"/gu, '""')}"` : safe;
}

export function registerWaitlist(app: Hono<Env>, deps: Deps): void {
  const { db } = deps;

  app.post("/v1/waitlist", operation(deps, "waitlistJoin"), async (c) => {
    // Nothing below reads a cookie or a session.
    c.header("cache-control", "no-store");
    const body = await joinBody(c);
    const emailHash = sha256hex(`waitlist:${body.email}`);
    c.set("auditTarget", { email_sha256: emailHash, interest: body.interest });
    if (disposable(body.email)) throw invalid("email", "disposable");
    const ip = clientIp(c);
    const taken = bucketsOf(deps).take(WAITLIST_IP, `waitlist-ip:${ip ?? "unknown"}`);
    if (!taken.ok) throw new ApiError("RENOX_RATE_LIMITED", undefined, { retryAfter: taken.retryAfter });
    const human = await captcha(body.captchaToken, ip, process.env, (m) => deps.log.warn(m));
    if (human === "missing") throw invalid("captcha_token", "required");
    if (human === "rejected") throw invalid("captcha_token", "rejected");

    const now = deps.now();
    const token = newOneTimeValue();
    const tokenHash = sha256hex(token);
    const ipHash = ip === null ? null : sha256hex(`waitlist-ip:${ip}`);
    const inserted = await db.query(
      "insert into waitlist (email, interest, locale, created_at, confirm_token_hash, confirm_sent_at, ip_hash, source) values ($1, $2, $3, $4, $5, $4, $6, 'site') on conflict (email, interest) do nothing returning id",
      [body.email, body.interest, body.locale, now, tokenHash, ipHash],
    );
    // A known, unconfirmed address gets a new mail (and a new token) at most once an hour; one update decides, so
    // two requests at once send one mail. A confirmed address sends nothing.
    const send =
      inserted.length > 0 ||
      (
        await db.query(
          "update waitlist set confirm_token_hash = $3, confirm_sent_at = $4, locale = $5 where email = $1 and interest = $2 and confirmed_at is null and confirm_sent_at <= $6 returning id",
          [body.email, body.interest, tokenHash, now, body.locale, now - RESEND_EVERY_MS],
        )
      ).length > 0;
    if (send) {
      const base = (deps.config.apiUrl ?? DEFAULTS.apiUrl).replace(/\/+$/u, "");
      await sendWaitlistConfirm(deps, body.email, `${base}/v1/waitlist/confirm?${new URLSearchParams({ token })}`, body.interest, body.locale);
    }
    // Same answer in every case: no enumeration.
    if (prefersHtml(c.req.header("accept"))) return c.redirect(siteRedirect(deps.config.siteUrl ?? DEFAULTS.siteUrl, body.returnTo), 303);
    return c.json({ status: "check_email" }, 202);
  });

  app.get("/v1/waitlist/confirm", async (c) => {
    c.set("action", "confirmWaitlist");
    const site = siteOrigin(deps);
    const value = c.req.query("token");
    const now = deps.now();
    let confirmed = false;
    let interest: Interest | null = null;
    if (typeof value === "string" && /^[a-z2-7]{32}$/u.test(value)) {
      const rows = await db.query<{ interest: Interest }>(
        "update waitlist set confirmed_at = $1, confirm_token_hash = null where confirm_token_hash = $2 and confirmed_at is null and confirm_sent_at > $3 returning interest",
        [now, sha256hex(value), now - CONFIRM_TTL_MS],
      );
      interest = rows[0]?.interest ?? null;
      confirmed = rows[0] !== undefined;
    }
    try {
      await writeAudit(db, {
        at: now,
        tenantId: null,
        actor: "anonymous",
        action: "waitlistConfirm",
        target: { outcome: confirmed ? "confirmed" : "refused", ...(interest === null ? {} : { interest }) },
        status: 303,
        requestId: c.get("requestId"),
        ip: clientIp(c),
      });
    } catch (e) {
      deps.log.error("audit write failed", { action: "waitlistConfirm", request_id: c.get("requestId"), error: String(e) });
    }
    c.header("cache-control", "no-store");
    c.header("referrer-policy", "no-referrer");
    const query = new URLSearchParams({ confirmed: confirmed ? "1" : "0", ...(interest === null ? {} : { list: interest }) });
    return c.redirect(`${site}/thanks?${query}`, 303);
  });

  app.get("/v1/ops/waitlist", opsAuth(deps, "ops:read"), async (c) => {
    c.set("action", "exportWaitlist");
    const interest = c.req.query("interest");
    if (interest !== undefined && !(INTERESTS as readonly string[]).includes(interest)) throw invalid("interest", "must be connector or email");
    const format = c.req.query("format") ?? "csv";
    if (format !== "csv") throw invalid("format", "must be csv");
    const rows = await db.query<{ email: string; interest: string; locale: string; confirmed_at: unknown }>(
      "select email, interest, locale, confirmed_at from waitlist where confirmed_at is not null and ($1::text is null or interest = $1) order by confirmed_at, id",
      [interest ?? null],
    );
    await writeAudit(db, {
      at: deps.now(),
      tenantId: null,
      actor: "operator",
      action: "waitlistExport",
      target: { operator: accountRef(operatorOf(c)), rows: String(rows.length), ...(interest === undefined ? {} : { interest }) },
      status: 200,
      requestId: c.get("requestId"),
      ip: clientIp(c),
    });
    const lines = ["email,interest,locale,confirmed_at", ...rows.map((r) => [r.email, r.interest, r.locale, new Date(num(r.confirmed_at)).toISOString()].map(csvField).join(","))];
    return c.body(`${lines.join("\r\n")}\r\n`, 200, { "content-type": "text/csv; charset=utf-8", "cache-control": "no-store" });
  });
}
