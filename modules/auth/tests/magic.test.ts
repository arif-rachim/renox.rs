// Magic links (#240; docs/24-threat-model.md F4, "Magic link and reset
// token replay"): one mail through auth.send_mail (the mailer fixture
// records it), the same answer for an unknown email, single use, 15-minute
// expiry, bound to the user agent family, 5 sends per email per 15 min, and
// no token or secret in the tenant log.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

// The SDK helper by path: a module tree has no node_modules (its hash covers every file).
import { app, type TestApp } from "../../../sdk/src/test.ts";

const MODULE = join(import.meta.dir, "..");
const worker = process.env.RENOX_TEST_SPEC ?? process.env.RENOX_WORKER_PATH;
const t = worker ? await app({ project: MODULE }) : (undefined as unknown as TestApp);

const notice = (html: string) => /<p class="notice" id="notice"[^>]*>([^<]*)<\/p>/u.exec(html)?.[1];
const mails = () => t.db.query<{ mail_to: string; template: string; url: string }>("select mail_to, template, url from mailer__sent order by seq");
const pathOf = (url: string) => new URL(url).pathname + new URL(url).search;

describe.skipIf(!worker)("magic links", () => {
  test("a link for a known email, the same answer for an unknown one", async () => {
    await t.as("setup").action("/auth/register", "default", { email: "mia@example.com", password: "correct horse battery" });
    const known = await t.as("mia").action("/auth/magic", "default", { email: "mia@example.com" });
    const unknown = await t.as("mia").action("/auth/magic", "default", { email: "nobody@example.com" });
    expect(notice(known.html)).toBeDefined();
    expect(notice(known.html)).toBe(notice(unknown.html));
    expect(mails().map((m) => [m.mail_to, m.template])).toEqual([["mia@example.com", "magic_link"]]);
    expect(mails()[0]?.url).toMatch(/^https:\/\/test\.localhost\/auth\/magic\/[0-9a-f]{64}$/u);
  });

  test("the link signs in once; a second use is refused", async () => {
    const url = pathOf(mails().at(-1)?.url as string);
    const first = await t.as("mia").request("GET", url);
    expect(first.status).toBe(303);
    expect(first.headers.getSetCookie().some((c) => c.startsWith("__Host-renox_auth="))).toBe(true);
    expect((await t.as("mia").page("/private")).status).toBe(200);
    const again = await t.as("mia-2").request("GET", url);
    expect(again.status).toBe(400);
    expect(again.headers.getSetCookie().some((c) => c.startsWith("__Host-renox_auth="))).toBe(false);
  });

  test("another user agent family, or an expired link, is refused", async () => {
    await t.as("mia").action("/auth/magic", "default", { email: "mia@example.com" });
    const url = pathOf(mails().at(-1)?.url as string);
    const firefox = await t.as("mia-firefox").request("GET", url, { headers: { "user-agent": "Mozilla/5.0 Firefox/130.0" } });
    expect(firefox.status).toBe(400);
    await t.as("mia").action("/auth/magic", "default", { email: "mia@example.com" });
    const late = pathOf(mails().at(-1)?.url as string);
    const rw = new Database(t.dbFile);
    rw.exec("pragma busy_timeout = 5000");
    rw.exec("update auth__tokens set expires_at = unixepoch() - 1 where used_at is null");
    rw.close();
    expect((await t.as("mia-late").request("GET", late)).status).toBe(400);
  });

  test("at most 5 links per email per 15 minutes; the answer does not change", async () => {
    const before = mails().length;
    let last = "";
    for (let i = 0; i < 6; i++) last = notice((await t.as("spam").action("/auth/magic", "default", { email: "mia@example.com" })).html) ?? "";
    // 3 were sent above in this window; 2 more, then nothing.
    expect(mails().length - before).toBe(2);
    expect(last).toContain("If an account exists");
  });

  test("no token and no secret in the tenant log", async () => {
    const log = JSON.stringify(t.logs());
    for (const m of mails()) expect(log).not.toContain(m.url.split("/").pop() as string);
    expect(log).not.toContain("test-google-secret-do-not-log-7f3a");
  });
});
