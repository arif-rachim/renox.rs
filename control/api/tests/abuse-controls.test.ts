// The abuse controls batch F67-D added to #123 (deploy-api.md 0.5 sections
// 11.2, 21, 22; docs/24-threat-model.md "Abuse of the platform" and F,
// "Tenant dependencies vulnerable"):
// - Safe Browsing on activation, daily, and on a report; unsafe phishing or
//   malware takes the tenant down at once, the owner is emailed, the other
//   tenant on the node is untouched; getOpsTenant shows the verdicts;
// - the CAPTCHA with the provider before anything is stored, failing closed;
// - 20 sign-ups per ASN per day;
// - the 4-hour takedown SLA alert and the reporter's 90 days;
// - the daily OSV re-scan of active deployments, keeping the last answer
//   when OSV is down;
// - no custom domain for a new free tenant, kept past 7 days by an abuse flag.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { contentHash } from "@renox/artifact-validate";

import { REPORTER_KEPT_MS, SLA_MS, sweepAbuse } from "../src/abuse/takedown.ts";
import { rescanActive, RESCAN_MS, setOsvFetch, currentOsvFetch } from "../src/deployments/advisories.ts";
import { checkTenant, currentSafeBrowsingFetch, DAY_MS, lookup, setSafeBrowsingFetch, sweepSafeBrowsing } from "../src/safe-browsing/check.ts";
import { asnIn, asnOf, captcha, currentCaptchaFetch, parseAsnTable, setCaptchaFetch } from "../src/signup/friction.ts";
import { check } from "../src/contract.ts";
import { helloArtifact, upload } from "./artifacts.ts";
import { assertScoped, auditRows, harness, OPERATOR_TOKEN, PASSWORD, registeredNode, signup, tenant, type Harness } from "./helpers.ts";

afterEach(assertScoped);

const KEY = "AIzaTestSafeBrowsingKey0123456789abcdef";

/** Sets environment variables for one test and puts them back. */
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) if (v === undefined) delete process.env[k];
  else process.env[k] = v;
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

/** A Safe Browsing fake: hostnames in `unsafe` match with their threat; the calls are counted. */
function fakeGoogle(unsafe: Record<string, string>) {
  const calls: { url: string; hosts: string[] }[] = [];
  const f = async (url: string, init: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init.body)) as { threatInfo: { threatEntries: { url: string }[] } };
    const hosts = body.threatInfo.threatEntries.map((e) => new URL(e.url).hostname);
    calls.push({ url, hosts });
    return Response.json({ matches: hosts.filter((h) => h in unsafe).map((h) => ({ threatType: unsafe[h], platformType: "ANY_PLATFORM", threat: { url: `https://${h}/` } })) });
  };
  return { f, calls };
}

/** A tenant with a signed-up owner, an active app on node-1, and its hostname. */
async function liveTenant(h: Harness, id: string, app: string): Promise<{ token: string; host: string; email: string }> {
  const email = `owner@${id}.test`;
  const session = await signup(h, email, id);
  const made = await h.request("POST", "/v1/tokens", { session, json: { name: "t", scopes: ["*"], expires_in_days: 30 } });
  const token = ((await made.json()) as { token: string }).token;
  expect((await h.request("POST", "/v1/apps", { token, json: { name: app } })).status).toBe(201);
  const files = helloArtifact((m) => ((m.app as Record<string, unknown>).name = app));
  expect((await upload(h, token, app, files)).status).toBe(201);
  expect((await h.request("POST", `/v1/apps/${app}/activate`, { token, json: { hash: contentHash(files) } })).status).toBe(200);
  const host = (await h.db.query<{ hostname: string }>("select hostname from route_entries where tenant_id = $1 limit 1", [id]))[0]?.hostname as string;
  return { token, host, email };
}

const statusOf = async (h: Harness, id: string) => (await h.db.query<{ status: string }>("select distinct status from route_entries where tenant_id = $1", [id])).map((r) => r.status);

describe("Safe Browsing", () => {
  test("without a key nothing is asked and every verdict is unknown", async () => {
    const g = fakeGoogle({});
    const saved = currentSafeBrowsingFetch();
    setSafeBrowsingFetch(g.f);
    try {
      const r = await lookup(["a.renox.app"], "");
      expect(r.get("a.renox.app")).toEqual({ verdict: "unknown", threats: [] });
      expect(g.calls).toHaveLength(0);
    } finally {
      setSafeBrowsingFetch(saved);
    }
  });

  test("Google unreachable or refusing: unknown, never safe", async () => {
    const saved = currentSafeBrowsingFetch();
    try {
      setSafeBrowsingFetch(async () => {
        throw new Error("down");
      });
      expect((await lookup(["a.renox.app"], KEY)).get("a.renox.app")?.verdict).toBe("unknown");
      setSafeBrowsingFetch(async () => new Response("quota", { status: 429 }));
      expect((await lookup(["a.renox.app"], KEY)).get("a.renox.app")?.verdict).toBe("unknown");
    } finally {
      setSafeBrowsingFetch(saved);
    }
  });

  test("the daily check: an unsafe phishing hostname is taken down at once, audited, its owner emailed; the other tenant on the node is untouched; getOpsTenant shows the verdicts (#123 acceptance 1)", async () => {
    const h = await harness();
    await registeredNode(h, "node-1");
    const saved = currentSafeBrowsingFetch();
    await withEnv({ RENOX_SAFE_BROWSING_KEY: undefined }, async () => {
      const bad = await liveTenant(h, "t-sbbad", "bankcopy");
      const good = await liveTenant(h, "t-sbgood", "bakery");
      const g = fakeGoogle({ [bad.host]: "SOCIAL_ENGINEERING" });
      setSafeBrowsingFetch(g.f);
      try {
        process.env.RENOX_SAFE_BROWSING_KEY = KEY;
        expect(await sweepSafeBrowsing(h.deps)).toBe(2);
        expect(g.calls).toHaveLength(1);
        expect(g.calls[0]?.hosts.sort()).toEqual([bad.host, good.host].sort());
        // Taken down: the bad tenant's entries are suspended; the good one's stay active.
        expect(await statusOf(h, "t-sbbad")).toEqual(["suspended"]);
        expect(await statusOf(h, "t-sbgood")).toEqual(["active"]);
        const [ticket] = await h.db.query<Record<string, unknown>>("select * from abuse_tickets where hostname = $1", [bad.host]);
        expect(ticket).toMatchObject({ tenant_id: "t-sbbad", category: "phishing", state: "taken_down", safe_browsing: "unsafe", reporter_email: null });
        expect(String(ticket?.reason)).toContain("SOCIAL_ENGINEERING");
        const audit = (await auditRows(h)).filter((r) => r.action === "setAbuseTicket");
        expect(audit.at(-1)).toMatchObject({ actor: "platform", target: { ticket: ticket?.id, to: "taken_down" } });
        expect(h.mailer.last(bad.email, "abuse_takedown")?.text).toContain(bad.host);
        expect(h.mailer.last(good.email, "abuse_takedown")).toBeUndefined();
        // The operator console: verdicts per hostname and the open ticket.
        const ops = (await (await h.request("GET", "/v1/ops/tenants/t-sbbad", { token: OPERATOR_TOKEN })).json()) as Record<string, any>;
        expect(ops.safe_browsing).toEqual([{ hostname: bad.host, verdict: "unsafe", checked_at: h.clock.now }]);
        // Taken down, so no longer an open ticket.
        expect(ops.abuse_tickets).toEqual([]);
        check("OpsTenant", ops);
        const okOps = (await (await h.request("GET", "/v1/ops/tenants/t-sbgood", { token: OPERATOR_TOKEN })).json()) as Record<string, any>;
        expect(okOps.safe_browsing).toEqual([{ hostname: good.host, verdict: "safe", checked_at: h.clock.now }]);
        // Checked within the day: not asked again; a day later only the served hostname is asked.
        expect(await sweepSafeBrowsing(h.deps)).toBe(0);
        h.clock.now += DAY_MS;
        expect(await sweepSafeBrowsing(h.deps)).toBe(1);
        expect(g.calls.at(-1)?.hosts).toEqual([good.host]);
        // The key goes only in the request's query string, never a log line.
        expect(g.calls[0]?.url).toContain(`key=${KEY}`);
        expect(h.log.lines.join("\n")).not.toContain(KEY);
      } finally {
        setSafeBrowsingFetch(saved);
      }
    });
  });

  test("on activation the tenant's hostnames are checked; unwanted software is recorded, not taken down", async () => {
    const h = await harness();
    await registeredNode(h, "node-1");
    const saved = currentSafeBrowsingFetch();
    const g = fakeGoogle({});
    setSafeBrowsingFetch(g.f);
    try {
      await withEnv({ RENOX_SAFE_BROWSING_KEY: KEY }, async () => {
        const t = await liveTenant(h, "t-sbact", "shoes");
        // The activation's check runs off the request path; wait for its row.
        for (let i = 0; i < 100 && (await h.db.query("select 1 from safe_browsing_checks where hostname = $1", [t.host])).length === 0; i++) await Bun.sleep(10);
        expect((await h.db.query<{ verdict: string }>("select verdict from safe_browsing_checks where hostname = $1", [t.host]))[0]?.verdict).toBe("safe");
        const g2 = fakeGoogle({ [t.host]: "UNWANTED_SOFTWARE" });
        setSafeBrowsingFetch(g2.f);
        await checkTenant(h.deps, "t-sbact");
        expect((await h.db.query<{ verdict: string }>("select verdict from safe_browsing_checks where hostname = $1", [t.host]))[0]?.verdict).toBe("unsafe");
        expect(await statusOf(h, "t-sbact")).toEqual(["active"]);
        expect(await h.db.query("select 1 from abuse_tickets where hostname = $1", [t.host])).toHaveLength(0);
      });
    } finally {
      setSafeBrowsingFetch(saved);
    }
  });

  test("a report of an unsafe hostname: phishing is taken down at once; spam stays open with the verdict", async () => {
    const h = await harness();
    await registeredNode(h, "node-1");
    const saved = currentSafeBrowsingFetch();
    try {
      await withEnv({ RENOX_SAFE_BROWSING_KEY: undefined }, async () => {
        const a = await liveTenant(h, "t-rpa", "loginpage");
        const b = await liveTenant(h, "t-rpb", "newsletter");
        setSafeBrowsingFetch(fakeGoogle({ [a.host]: "SOCIAL_ENGINEERING", [b.host]: "SOCIAL_ENGINEERING" }).f);
        process.env.RENOX_SAFE_BROWSING_KEY = KEY;
        const report = async (host: string, category: string, ip: string) =>
          (await (await h.request("POST", "/v1/abuse", { ip, json: { url: `https://${host}/`, category, description: "Seen in a mass mailing today", captcha_token: "t" } })).json()) as { ticket_id: string };
        const ra = await report(a.host, "phishing", "203.0.113.20");
        const rb = await report(b.host, "spam", "203.0.113.21");
        const ticket = async (id: string) => (await h.db.query<Record<string, unknown>>("select state, safe_browsing from abuse_tickets where id = $1", [id]))[0];
        expect(await ticket(ra.ticket_id)).toEqual({ state: "taken_down", safe_browsing: "unsafe" });
        expect(await statusOf(h, "t-rpa")).toEqual(["suspended"]);
        expect(await ticket(rb.ticket_id)).toEqual({ state: "open", safe_browsing: "unsafe" });
        expect(await statusOf(h, "t-rpb")).toEqual(["active"]);
      });
    } finally {
      setSafeBrowsingFetch(saved);
    }
  });
});

describe("CAPTCHA", () => {
  const provider = (good: string) => {
    const seen: string[] = [];
    const f = async (_url: string, init: RequestInit): Promise<Response> => {
      const form = new URLSearchParams(String(init.body));
      seen.push(form.toString());
      return Response.json({ success: form.get("response") === good && form.get("secret") === "captcha-secret-test" });
    };
    return { f, seen };
  };

  test("off without a secret; with one: missing, rejected, failing closed when the provider is down, ok", async () => {
    const saved = currentCaptchaFetch();
    try {
      expect(await captcha(undefined, null, {})).toBe("off");
      const env = { RENOX_CAPTCHA_SECRET: "captcha-secret-test" };
      setCaptchaFetch(provider("good").f);
      expect(await captcha(undefined, "192.0.2.1", env)).toBe("missing");
      expect(await captcha("bad", "192.0.2.1", env)).toBe("rejected");
      expect(await captcha("good", "192.0.2.1", env)).toBe("ok");
      setCaptchaFetch(async () => {
        throw new Error("down");
      });
      expect(await captcha("good", "192.0.2.1", env)).toBe("rejected");
    } finally {
      setCaptchaFetch(saved);
    }
  });

  test("sign-up and reportAbuse check the token with the provider before anything is stored; the secret is never logged", async () => {
    const h = await harness();
    const saved = currentCaptchaFetch();
    const p = provider("human-token");
    setCaptchaFetch(p.f);
    try {
      await withEnv({ RENOX_CAPTCHA_SECRET: "captcha-secret-test" }, async () => {
        const body = (extra: Record<string, unknown>) => ({ email: "c@shop.ae", password: PASSWORD, tenant_id: "t-cap", dpa_accepted: true, ...extra });
        const none = await h.request("POST", "/v1/account/signup", { ip: "203.0.113.30", json: body({}) });
        expect(none.status).toBe(400);
        expect(JSON.stringify(await none.json())).toContain("captcha_token");
        expect((await h.request("POST", "/v1/account/signup", { ip: "203.0.113.31", json: body({ captcha_token: "bot-token" }) })).status).toBe(400);
        expect(await h.db.query("select 1 from users where email = 'c@shop.ae'")).toHaveLength(0);
        expect(await h.db.query("select 1 from tenants where id = 't-cap'")).toHaveLength(0);
        expect((await h.request("POST", "/v1/account/signup", { ip: "203.0.113.32", json: body({ captcha_token: "human-token" }) })).status).toBe(202);
        expect(await h.db.query("select 1 from tenants where id = 't-cap'")).toHaveLength(1);
        expect(p.seen.at(-1)).toContain("remoteip=203.0.113.32");
        const rep = { url: "https://x.renox.app/", category: "spam", description: "Unsolicited messages sent in bulk" };
        expect((await h.request("POST", "/v1/abuse", { ip: "203.0.113.33", json: { ...rep, captcha_token: "bot-token" } })).status).toBe(400);
        expect(await h.db.query("select 1 from abuse_tickets")).toHaveLength(0);
        expect((await h.request("POST", "/v1/abuse", { ip: "203.0.113.33", json: { ...rep, captcha_token: "human-token" } })).status).toBe(202);
        expect(h.log.lines.join("\n")).not.toContain("captcha-secret-test");
      });
    } finally {
      setCaptchaFetch(saved);
    }
  });
});

describe("sign-ups per ASN", () => {
  const TSV = ["1.0.0.0\t1.0.0.255\t13335\tUS\tCLOUDFLARENET", "198.51.100.0\t198.51.100.255\t64500\tAE\tEXAMPLE-BOTNET", "203.0.113.0\t203.0.113.255\t64501\tAE\tEXAMPLE-ISP", "2001:db8::\t2001:db8:ffff:ffff:ffff:ffff:ffff:ffff\t64502\tAE\tEXAMPLE-V6", "10.0.0.0\t10.255.255.255\t0\tNone\tNot routed", "garbage"].join("\n");

  test("the iptoasn table: IPv4, IPv6, a mapped IPv4, not routed and outside answer null", () => {
    const t = parseAsnTable(TSV);
    expect(asnIn(t, "198.51.100.77")).toBe(64500);
    expect(asnIn(t, "1.0.0.1")).toBe(13335);
    expect(asnIn(t, "2001:db8::1")).toBe(64502);
    expect(asnIn(t, "2001:db8:1:2:3:4:5:6")).toBe(64502);
    expect(asnIn(t, "::ffff:203.0.113.9")).toBe(64501);
    expect(asnIn(t, "10.1.2.3")).toBeNull();
    expect(asnIn(t, "192.0.2.1")).toBeNull();
    expect(asnIn(t, "2001:db9::1")).toBeNull();
    expect(asnIn(t, "not an ip")).toBeNull();
    expect(asnOf("198.51.100.77", "")).toBeNull();
  });

  test("20 sign-ups per ASN per day from many addresses, then 429; another ASN is not held back (#123 acceptance 4)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "renox-asn-"));
    try {
      const path = join(dir, "ip2asn.tsv");
      writeFileSync(path, TSV);
      await withEnv({ RENOX_ASN_DB: path }, async () => {
        const h = await harness();
        const statuses: number[] = [];
        for (let i = 1; i <= 25; i++) statuses.push((await h.request("POST", "/v1/account/signup", { ip: `198.51.100.${i}`, json: { email: `asn${i}@example.ae`, password: PASSWORD, tenant_id: `t-asn-${i}`, dpa_accepted: true } })).status);
        expect(statuses.slice(0, 20).every((s) => s === 202)).toBe(true);
        expect(statuses.slice(20).every((s) => s === 429)).toBe(true);
        expect((await h.db.query<{ n: number }>("select count(*)::int as n from tenants where id like 't-asn-%'"))[0]?.n).toBe(20);
        expect((await h.request("POST", "/v1/account/signup", { ip: "203.0.113.5", json: { email: "real@example.ae", password: PASSWORD, tenant_id: "t-asn-real", dpa_accepted: true } })).status).toBe(202);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the takedown SLA", () => {
  test("a phishing ticket still open 4 h after the report is alerted once; spam has no SLA; a takedown in time is not late; reporters' addresses go after 90 days", async () => {
    const h = await harness();
    const report = async (category: string, host: string) =>
      ((await (await h.request("POST", "/v1/abuse", { ip: `203.0.113.${40 + host.length}`, json: { url: `https://${host}/`, category, description: "Reported by a customer today", captcha_token: "t", reporter_email: "r@x.ae" } })).json()) as { ticket_id: string }).ticket_id;
    const start = h.clock.now;
    const late = await report("phishing", "late.renox.app");
    const spam = await report("spam", "spam.renox.app");
    const quick = await report("malware", "quick-one.renox.app");
    // bigint columns come back as strings from Postgres and as numbers from PGlite.
    const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
    const sla = async (id: string) => {
      const r = (await h.db.query<{ sla_due_at: unknown; sla_breached_at: unknown }>("select sla_due_at, sla_breached_at from abuse_tickets where id = $1", [id]))[0];
      return { sla_due_at: n(r?.sla_due_at), sla_breached_at: n(r?.sla_breached_at) };
    };
    expect(await sla(late)).toEqual({ sla_due_at: start + SLA_MS, sla_breached_at: null });
    expect(await sla(spam)).toEqual({ sla_due_at: null, sla_breached_at: null });
    h.clock.now = start + 3_600_000;
    expect((await h.request("POST", `/v1/ops/abuse/${quick}`, { token: OPERATOR_TOKEN, json: { state: "dismissed", reason: "Not malware, a false report" } })).status).toBe(200);
    h.clock.now = start + SLA_MS - 1;
    expect(await sweepAbuse(h.deps)).toEqual([]);
    h.clock.now = start + SLA_MS;
    expect(await sweepAbuse(h.deps)).toEqual([late]);
    expect(await sweepAbuse(h.deps)).toEqual([]);
    const alert = h.log.lines.filter((l) => l.includes("abuse takedown SLA missed"));
    expect(alert).toHaveLength(1);
    expect(alert[0]).toContain(late);
    expect(alert[0]).not.toContain("r@x.ae");
    expect(await sla(late)).toEqual({ sla_due_at: start + SLA_MS, sla_breached_at: start + SLA_MS });
    // The operator's list keeps the contract's AbuseTicket shape.
    const list = (await (await h.request("GET", "/v1/ops/abuse", { token: OPERATOR_TOKEN })).json()) as { items: Record<string, unknown>[] };
    for (const t of list.items) check("AbuseTicket", t);
    expect(await h.db.query("select 1 from abuse_tickets where reporter_email is not null")).toHaveLength(3);
    h.clock.now = start + REPORTER_KEPT_MS;
    await sweepAbuse(h.deps);
    expect(await h.db.query("select 1 from abuse_tickets where reporter_email is not null")).toHaveLength(0);
  });
});

describe("the daily OSV re-scan", () => {
  const SBOM = JSON.stringify({ bomFormat: "CycloneDX", specVersion: "1.5", components: [{ type: "library", name: "lodash", version: "4.17.20", purl: "pkg:npm/lodash@4.17.20" }] });
  const withSbom = (name: string) =>
    helloArtifact((m, f) => {
      (m.artifact as Record<string, unknown>).version = 1;
      (m.app as Record<string, unknown>).name = name;
      f.set("sbom.cdx.json", new TextEncoder().encode(SBOM));
    });

  test("an active deployment is re-scanned after a day and gets a new advisory; OSV down keeps the last answer; an inactive one is left (#123 acceptance 5)", async () => {
    const h = await harness();
    await registeredNode(h, "node-1");
    const saved = currentOsvFetch();
    try {
      setOsvFetch(async () => Response.json({ results: [{}] }));
      const token = await tenant(h, "t-osv");
      for (const app of ["live", "idle"]) expect((await h.request("POST", "/v1/apps", { token, json: { name: app } })).status).toBe(201);
      const live = withSbom("live");
      const idle = withSbom("idle");
      expect((await upload(h, token, "live", live)).status).toBe(201);
      expect((await upload(h, token, "idle", idle)).status).toBe(201);
      expect((await h.request("POST", "/v1/apps/live/activate", { token, json: { hash: contentHash(live) } })).status).toBe(200);
      const items = async (app: string, hash: string) => (await (await h.request("GET", `/v1/apps/${app}/deployments/${hash}/advisories`, { token })).json()) as { checked_at: number; items: { id: string }[] };
      expect((await items("live", contentHash(live))).items).toEqual([]);
      // Within the day: nothing is due.
      expect(await rescanActive(h.deps)).toBe(0);
      // A day later OSV knows a new advisory for lodash 4.17.20.
      h.clock.now += RESCAN_MS;
      const osv = async (url: string): Promise<Response> =>
        url.endsWith("/querybatch") ? Response.json({ results: [{ vulns: [{ id: "GHSA-35jh-r3h4-6jhm" }] }] }) : Response.json({ id: "GHSA-35jh-r3h4-6jhm", summary: "Command Injection in lodash", database_specific: { severity: "HIGH" } });
      expect(await rescanActive(h.deps, h.clock.now, osv)).toBe(1);
      const after = await items("live", contentHash(live));
      expect(after.checked_at).toBe(h.clock.now);
      expect(after.items).toEqual([expect.objectContaining({ package: "lodash", version: "4.17.20", id: "GHSA-35jh-r3h4-6jhm", severity: "high" })]);
      expect((await items("idle", contentHash(idle))).items).toEqual([]);
      // Another day, OSV down: the advisory stays and the check is retried next run.
      h.clock.now += RESCAN_MS;
      expect(await rescanActive(h.deps, h.clock.now, async () => new Response("down", { status: 503 }))).toBe(0);
      const kept = await items("live", contentHash(live));
      expect(kept.items).toHaveLength(1);
      expect(kept.checked_at).toBe(h.clock.now - RESCAN_MS);
    } finally {
      setOsvFetch(saved);
    }
  });
});

describe("no custom domain for a new free tenant", () => {
  test("409 no_custom_domain in its first 7 days; allowed after them; an abuse flag keeps it (deploy-api.md 0.5 section 21)", async () => {
    const h = await harness();
    const token = await tenant(h, "t-newdom");
    expect((await h.request("POST", "/v1/apps", { token, json: { name: "fresh" } })).status).toBe(201);
    const add = (hostname: string) => h.request("POST", "/v1/apps/fresh/domains", { token, json: { hostname } });
    const refused = await add("shop.example.ae");
    expect(refused.status).toBe(409);
    expect(JSON.stringify(await refused.json())).toContain("no_custom_domain");
    // Day 8 with an abuse ticket from day 6: still restricted.
    await h.db.query("insert into abuse_tickets (id, hostname, tenant_id, category, description, state, reported_at, updated_at) values ('abt_flag', 'fresh.renox.app', 't-newdom', 'spam', 'Bulk mail from the site', 'reviewing', $1, $1)", [h.clock.now + 6 * DAY_MS]);
    h.clock.now += 8 * DAY_MS;
    expect((await add("shop.example.ae")).status).toBe(409);
    // Dismissed: the flag is gone and the domain can be added.
    await h.db.query("update abuse_tickets set state = 'dismissed' where id = 'abt_flag'");
    expect((await add("shop.example.ae")).status).toBe(201);
  });
});
