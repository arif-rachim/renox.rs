// The site's waitlists (docs/contracts/deploy-api.md 0.10 section 21, #691):
// double opt-in, the same answer for every address, no cookie read, a
// `return_to` that cannot leave the site, and the operator's CSV export.
//
// docs/24-threat-model.md, "Waitlist as a spam relay or an enumeration oracle".

import { afterEach, describe, expect, test } from "bun:test";
import { DAY_MS, sha256hex } from "../src/auth/tokens.ts";
import { csvField, prefersHtml, siteRedirect } from "../src/waitlist/routes.ts";
import { assertScoped, harness, OPERATOR_TOKEN, signup, tenant, type Harness } from "./helpers.ts";

afterEach(assertScoped);

const SITE = "https://renoxium.com";
const HTML = { accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" };

const form = (fields: Record<string, string>): { body: string; headers: Record<string, string> } => ({
  body: new URLSearchParams(fields).toString(),
  headers: { "content-type": "application/x-www-form-urlencoded", ...HTML },
});

/** A form post as the site's page sends it. */
const join = (h: Harness, fields: Record<string, string>, ip?: string, extra: Record<string, string> = {}): Promise<Response> => {
  const f = form(fields);
  return h.request("POST", "/v1/waitlist", { body: f.body, headers: { ...f.headers, ...extra }, ...(ip === undefined ? {} : { ip }) });
};

/** The confirm path of the last waitlist mail to `to`. */
function confirmPath(h: Harness, to: string): string {
  const mail = h.mailer.last(to, "waitlist_confirm");
  const m = mail === undefined ? null : /https:\/\/api\.renoxium\.com(\/v1\/waitlist\/confirm\?token=[a-z2-7]{32})/u.exec(mail.text);
  if (m === null) throw new Error(`no waitlist_confirm mail with a link to ${to}`);
  return m[1] as string;
}

const auditRows = (h: Harness, action: string) =>
  h.db.query<{ tenant_id: string | null; actor: string; target: Record<string, string>; status: number }>("select tenant_id, actor, target, status from audit where action = $1 order by id", [action]);

const rows = (h: Harness) => h.db.query<{ email: string; interest: string; locale: string; confirmed_at: unknown; confirm_token_hash: string | null; ip_hash: string | null; source: string }>("select email, interest, locale, confirmed_at, confirm_token_hash, ip_hash, source from waitlist order by id");

describe("joinWaitlist", () => {
  test("a form post answers 303 to the return_to on the site, stores an unconfirmed row and sends one mail; the link confirms once", async () => {
    const h = await harness();
    const res = await join(h, { email: "Founder@Hello.AE", interest: "connector", locale: "en", return_to: `${SITE}/thanks?list=connector` }, "192.0.2.50");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${SITE}/thanks?list=connector`);
    const [row] = await rows(h);
    expect(row).toMatchObject({ email: "founder@hello.ae", interest: "connector", locale: "en", confirmed_at: null, source: "site" });
    // Only hashes: the client address and the token are not stored.
    expect(row?.ip_hash).toBe(sha256hex("waitlist-ip:192.0.2.50"));
    expect(JSON.stringify(row)).not.toContain("192.0.2.50");
    expect(h.mailer.sent.map((m) => [m.to, m.kind])).toEqual([["founder@hello.ae", "waitlist_confirm"]]);
    const path = confirmPath(h, "founder@hello.ae");
    const token = new URL(`https://x${path}`).searchParams.get("token") as string;
    expect(row?.confirm_token_hash).toBe(sha256hex(token));

    const ok = await h.request("GET", path);
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toBe(`${SITE}/thanks?confirmed=1&list=connector`);
    const [done] = await rows(h);
    expect(done?.confirmed_at).not.toBeNull();
    expect(done?.confirm_token_hash).toBeNull();
    // A second use, and an unknown or malformed token, all land on confirmed=0.
    const again = await h.request("GET", path);
    expect(again.status).toBe(303);
    expect(again.headers.get("location")).toBe(`${SITE}/thanks?confirmed=0`);
    for (const t of ["abcdefghijklmnopqrstuvwxyz234567", "nonsense", ""]) {
      const r = await h.request("GET", `/v1/waitlist/confirm?token=${t}`);
      expect(r.headers.get("location")).toBe(`${SITE}/thanks?confirmed=0`);
    }
    expect((await h.request("GET", "/v1/waitlist/confirm")).headers.get("location")).toBe(`${SITE}/thanks?confirmed=0`);
  });

  test("the token works for 7 days: an expired one lands on confirmed=0 and the row stays unconfirmed", async () => {
    const h = await harness();
    await join(h, { email: "late@hello.ae", interest: "email" });
    const path = confirmPath(h, "late@hello.ae");
    h.clock.now += 7 * DAY_MS + 1;
    const res = await h.request("GET", path);
    expect(res.headers.get("location")).toBe(`${SITE}/thanks?confirmed=0`);
    expect((await rows(h))[0]?.confirmed_at).toBeNull();
    // Just inside the 7 days it would have worked.
    const h2 = await harness();
    await join(h2, { email: "ontime@hello.ae", interest: "email" });
    const p2 = confirmPath(h2, "ontime@hello.ae");
    h2.clock.now += 7 * DAY_MS - 1000;
    expect((await h2.request("GET", p2)).headers.get("location")).toBe(`${SITE}/thanks?confirmed=1&list=email`);
  });

  test("a disposable domain is 400 and stores nothing", async () => {
    const h = await harness();
    const res = await h.request("POST", "/v1/waitlist", { json: { email: "x@mailinator.com", interest: "connector" } });
    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error: { code: string; details: { field: string; reason: string }[] } };
    expect(error.code).toBe("RENOX_VALIDATION");
    expect(error.details).toEqual([{ field: "email", reason: "disposable" }]);
    expect(await rows(h)).toEqual([]);
    expect(h.mailer.sent).toEqual([]);
  });

  test("bad input is 400: the address, the list, an unknown JSON field, a body that is neither JSON nor a form", async () => {
    const h = await harness();
    expect((await h.request("POST", "/v1/waitlist", { json: { email: "nope", interest: "email" } })).status).toBe(400);
    expect((await h.request("POST", "/v1/waitlist", { json: { email: "a@b.ae", interest: "newsletter" } })).status).toBe(400);
    expect((await h.request("POST", "/v1/waitlist", { json: { email: "a@b.ae" } })).status).toBe(400);
    expect((await h.request("POST", "/v1/waitlist", { json: { email: "a@b.ae", interest: "email", extra: 1 } })).status).toBe(400);
    expect((await h.request("POST", "/v1/waitlist", { json: { email: "a@b.ae", interest: "email", return_to: 5 } })).status).toBe(400);
    expect((await h.request("POST", "/v1/waitlist", { body: "x", headers: { "content-type": "text/plain" } })).status).toBe(400);
    // A form post that fails is the API's error too, not a redirect.
    expect((await join(h, { email: "nope", interest: "email" })).status).toBe(400);
    expect(await rows(h)).toEqual([]);
  });

  test("the fourth post from one IP within the hour is 429 with Retry-After; another IP is not affected; sign-up has its own allowance", async () => {
    const h = await harness();
    for (let i = 0; i < 3; i++) expect((await h.request("POST", "/v1/waitlist", { ip: "203.0.113.7", json: { email: `u${i}@hello.ae`, interest: "email" } })).status).toBe(202);
    const fourth = await h.request("POST", "/v1/waitlist", { ip: "203.0.113.7", json: { email: "u3@hello.ae", interest: "email" } });
    expect(fourth.status).toBe(429);
    expect(Number(fourth.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(((await fourth.json()) as { error: { code: string } }).error.code).toBe("RENOX_RATE_LIMITED");
    expect((await h.request("POST", "/v1/waitlist", { ip: "203.0.113.8", json: { email: "u4@hello.ae", interest: "email" } })).status).toBe(202);
    // The sign-up's per-IP bucket is a different key.
    const s = await h.request("POST", "/v1/account/signup", { ip: "203.0.113.7", json: { email: "dev@hello.ae", password: "correct horse battery staple" } });
    expect(s.status).toBe(202);
    // An hour later the bucket has refilled.
    h.clock.now += 3_600_000;
    expect((await h.request("POST", "/v1/waitlist", { ip: "203.0.113.7", json: { email: "u5@hello.ae", interest: "email" } })).status).toBe(202);
  });

  test("a return_to that is not exactly on the site's origin is replaced by the site root", async () => {
    const h = await harness();
    const bad = [
      "https://evil.example/x",
      "//evil.com",
      "//evil.com/thanks",
      "https://renoxium.com.evil.com/",
      "https://renoxium.com@evil.com/",
      "https://user@renoxium.com/thanks",
      "http://renoxium.com/thanks",
      "https://renoxium.com:8443/thanks",
      "javascript:alert(1)",
      "/thanks",
      "thanks",
      "https://dashboard.renoxium.com/",
    ];
    let n = 0;
    for (const return_to of bad) {
      const res = await join(h, { email: `r${n}@hello.ae`, interest: "email", return_to }, `198.51.100.${++n}`);
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(`${SITE}/`);
    }
    // Without a return_to too; an https URL on the site keeps its path and query.
    expect((await join(h, { email: "none@hello.ae", interest: "email" }, "198.51.100.99")).headers.get("location")).toBe(`${SITE}/`);
    expect((await join(h, { email: "ok@hello.ae", interest: "email", return_to: `${SITE}/ar/thanks?list=email` }, "198.51.100.98")).headers.get("location")).toBe(`${SITE}/ar/thanks?list=email`);
    expect(siteRedirect("https://site.test", "https://site.test/a?b=1#c")).toBe("https://site.test/a?b=1#c");
    expect(siteRedirect("https://site.test", `https://site.test/${"a".repeat(3000)}`)).toBe("https://site.test/");
  });

  test("a request carrying a dashboard session cookie behaves exactly like one without", async () => {
    const h = await harness();
    const session = await signup(h, "dev@hello.ae", "t-dev");
    const plain = await join(h, { email: "a@hello.ae", interest: "connector", return_to: `${SITE}/thanks?list=connector` }, "198.51.100.1");
    const withCookie = await h.request("POST", "/v1/waitlist", {
      ...form({ email: "b@hello.ae", interest: "connector", return_to: `${SITE}/thanks?list=connector` }),
      session,
      ip: "198.51.100.2",
    });
    expect(withCookie.status).toBe(plain.status);
    expect(withCookie.headers.get("location")).toBe(plain.headers.get("location"));
    expect(withCookie.headers.get("set-cookie")).toBeNull();
    // The audit row is anonymous: the session was never read, so the row names no user or tenant.
    const audit = await auditRows(h, "waitlistJoin");
    expect(audit.map((r) => [r.actor, r.tenant_id])).toEqual([["anonymous", null], ["anonymous", null]]);
    // No CORS headers for a cross-site form post: it is a navigation.
    const cross = await h.request("POST", "/v1/waitlist", { json: { email: "c@hello.ae", interest: "email" }, headers: { origin: "https://evil.example" } });
    expect(cross.headers.get("access-control-allow-origin")).toBeNull();
    expect(cross.headers.get("access-control-allow-credentials")).toBeNull();
  });

  test("JSON callers get 202 check_email for new, known, confirmed and held-back addresses alike; a repeat re-sends at most once an hour", async () => {
    const h = await harness();
    const post = (email: string, ip: string) => h.request("POST", "/v1/waitlist", { ip, json: { email, interest: "connector" } });
    const first = await post("same@hello.ae", "192.0.2.1");
    expect(first.status).toBe(202);
    const body = await first.json();
    expect(body).toEqual({ status: "check_email" });
    expect(h.mailer.sent).toHaveLength(1);
    const oldPath = confirmPath(h, "same@hello.ae");

    // Within the hour: the same answer, no second mail.
    h.clock.now += 59 * 60_000;
    const repeat = await post("SAME@hello.ae", "192.0.2.2");
    expect(repeat.status).toBe(202);
    expect(await repeat.json()).toEqual(body);
    expect(h.mailer.sent).toHaveLength(1);
    expect(confirmPath(h, "same@hello.ae")).toBe(oldPath);

    // After the hour: a new mail with a new token; the old link is dead, the new one works.
    h.clock.now += 2 * 60_000;
    const later = await post("same@hello.ae", "192.0.2.3");
    expect(later.status).toBe(202);
    expect(await later.json()).toEqual(body);
    expect(h.mailer.sent).toHaveLength(2);
    const newPath = confirmPath(h, "same@hello.ae");
    expect(newPath).not.toBe(oldPath);
    expect((await h.request("GET", oldPath)).headers.get("location")).toBe(`${SITE}/thanks?confirmed=0`);
    expect((await h.request("GET", newPath)).headers.get("location")).toBe(`${SITE}/thanks?confirmed=1&list=connector`);

    // Confirmed: the same answer again, nothing sent, however long after.
    h.clock.now += 2 * 3_600_000;
    const done = await post("same@hello.ae", "192.0.2.4");
    expect(done.status).toBe(202);
    expect(await done.json()).toEqual(body);
    expect(h.mailer.sent).toHaveLength(2);
    expect(await rows(h)).toHaveLength(1);

    // The other list is a row of its own, with its own mail.
    const other = await h.request("POST", "/v1/waitlist", { ip: "192.0.2.5", json: { email: "same@hello.ae", interest: "email" } });
    expect(other.status).toBe(202);
    expect(h.mailer.sent).toHaveLength(3);
    expect(await rows(h)).toHaveLength(2);
  });

  test("a JSON caller is never redirected, and a form post without an html Accept is answered 202", async () => {
    const h = await harness();
    const json = await h.request("POST", "/v1/waitlist", { json: { email: "j@hello.ae", interest: "email", return_to: `${SITE}/thanks` }, headers: { accept: "application/json, text/html" } });
    expect(json.status).toBe(202);
    expect(json.headers.get("location")).toBeNull();
    const f = form({ email: "k@hello.ae", interest: "email" });
    const noHtml = await h.request("POST", "/v1/waitlist", { body: f.body, headers: { "content-type": f.headers["content-type"] as string }, ip: "192.0.2.9" });
    expect(noHtml.status).toBe(202);
    expect(prefersHtml("text/html")).toBe(true);
    expect(prefersHtml("application/json")).toBe(false);
    expect(prefersHtml("*/*")).toBe(false);
    expect(prefersHtml(undefined)).toBe(false);
  });

  test("the Arabic locale gets the Arabic mail, anything else English", async () => {
    const h = await harness();
    await h.request("POST", "/v1/waitlist", { ip: "192.0.2.1", json: { email: "ar@hello.ae", interest: "connector", locale: "ar" } });
    await h.request("POST", "/v1/waitlist", { ip: "192.0.2.2", json: { email: "en@hello.ae", interest: "connector", locale: "en" } });
    await h.request("POST", "/v1/waitlist", { ip: "192.0.2.3", json: { email: "fr@hello.ae", interest: "connector", locale: "fr" } });
    const ar = h.mailer.last("ar@hello.ae", "waitlist_confirm");
    expect(ar?.subject).toMatch(/[؀-ۿ]/u);
    expect(ar?.text).toMatch(/[؀-ۿ]/u);
    expect(ar?.text).toContain("/v1/waitlist/confirm?token=");
    for (const to of ["en@hello.ae", "fr@hello.ae"]) {
      const m = h.mailer.last(to, "waitlist_confirm");
      expect(m?.subject).toBe("Confirm your address for the waitlist");
      expect(m?.text).not.toMatch(/[؀-ۿ]/u);
    }
    expect((await rows(h)).map((r) => r.locale)).toEqual(["ar", "en", "en"]);
  });

  test("audit rows are written for the join and the confirm and hold no plain address", async () => {
    const h = await harness();
    await join(h, { email: "Audit@Hello.AE", interest: "connector" });
    await h.request("GET", confirmPath(h, "audit@hello.ae"));
    await h.request("GET", "/v1/waitlist/confirm?token=abcdefghijklmnopqrstuvwxyz234567");
    const joins = await auditRows(h, "waitlistJoin");
    expect(joins).toHaveLength(1);
    expect(joins[0]?.target).toEqual({ email_sha256: sha256hex("waitlist:audit@hello.ae"), interest: "connector" });
    expect(joins[0]?.status).toBe(303);
    const confirms = await auditRows(h, "waitlistConfirm");
    expect(confirms.map((r) => r.target.outcome)).toEqual(["confirmed", "refused"]);
    const all = JSON.stringify(await h.db.query("select * from audit"));
    expect(all).not.toContain("audit@hello.ae");
    expect(all.toLowerCase()).not.toContain("audit%40hello");
    const token = new URL(`https://x${confirmPath(h, "audit@hello.ae")}`).searchParams.get("token") as string;
    expect(all).not.toContain(token);
  });
});

describe("exportWaitlist", () => {
  async function seed(h: Harness): Promise<void> {
    let n = 0;
    for (const [email, interest] of [["a@hello.ae", "connector"], ["b@hello.ae", "email"], ["c@hello.ae", "connector"], ["pending@hello.ae", "connector"], ["d,\"q\"@hello.ae", "email"], ["=cmd@hello.ae", "email"]] as const) {
      expect((await h.request("POST", "/v1/waitlist", { ip: `192.0.2.${++n}`, json: { email, interest, locale: n === 2 ? "ar" : "en" } })).status).toBe(202);
      h.clock.now += 1000;
    }
    for (const email of ["a@hello.ae", "b@hello.ae", "c@hello.ae", "d,\"q\"@hello.ae", "=cmd@hello.ae"]) {
      expect((await h.request("GET", confirmPath(h, email))).status).toBe(303);
      h.clock.now += 1000;
    }
  }

  test("the confirmed rows only, as CSV with the header, oldest first; interest filters; the export is audited", async () => {
    const h = await harness();
    await seed(h);
    const res = await h.request("GET", "/v1/ops/waitlist?format=csv", { token: OPERATOR_TOKEN });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toStartWith("text/csv");
    const lines = (await res.text()).split("\r\n");
    expect(lines[0]).toBe("email,interest,locale,confirmed_at");
    expect(lines.filter((l) => l !== "")).toHaveLength(6);
    expect(lines[1]).toStartWith("a@hello.ae,connector,en,2026-");
    expect(lines[2]).toStartWith("b@hello.ae,email,ar,2026-");
    expect(lines.join("\n")).not.toContain("pending@hello.ae");
    // Quoted when it holds a comma or a quote; a formula prefix is defused.
    expect(lines[4]).toStartWith('"d,""q""@hello.ae",email,en,');
    expect(lines[5]).toStartWith("'=cmd@hello.ae,email,en,");

    const only = await h.request("GET", "/v1/ops/waitlist?interest=connector&format=csv", { token: OPERATOR_TOKEN });
    expect((await only.text()).split("\r\n").filter((l) => l !== "").map((l) => l.split(",")[0])).toEqual(["email", "a@hello.ae", "c@hello.ae"]);
    expect((await h.request("GET", "/v1/ops/waitlist?interest=newsletter", { token: OPERATOR_TOKEN })).status).toBe(400);
    expect((await h.request("GET", "/v1/ops/waitlist?format=json", { token: OPERATOR_TOKEN })).status).toBe(400);

    const audit = await auditRows(h, "waitlistExport");
    expect(audit.map((r) => [r.actor, r.target.rows, r.target.interest])).toEqual([["operator", "5", undefined], ["operator", "2", "connector"]]);
    expect(JSON.stringify(audit)).not.toContain("hello.ae");
  });

  test("without ops:read it is refused: a tenant token and a session are 403, no credential is 401", async () => {
    const h = await harness();
    await seed(h);
    const token = await tenant(h, "t_x");
    expect((await h.request("GET", "/v1/ops/waitlist?format=csv", { token })).status).toBe(403);
    const session = await signup(h, "dev@hello.ae", "t-dev");
    expect((await h.request("GET", "/v1/ops/waitlist?format=csv", { session })).status).toBe(403);
    expect((await h.request("GET", "/v1/ops/waitlist?format=csv")).status).toBe(401);
  });

  test("csvField quotes and defuses", () => {
    expect(csvField("plain@x.ae")).toBe("plain@x.ae");
    expect(csvField("a,b")).toBe('"a,b"');
    expect(csvField('a"b')).toBe('"a""b"');
    expect(csvField("+1@x.ae")).toBe("'+1@x.ae");
    expect(csvField("@x")).toBe("'@x");
  });
});
