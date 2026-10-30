// The email module (#328): the queue, suppression, the providers' requests,
// retries on 5xx (a throw for the outbox) and a final 4xx, bounce feedback.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import * as core from "../lib/core.ts";

function ctx(fetchFn: core.FetchFn, config: core.EmailCtx["config"] = { provider: "resend", from: "shop@hello.ae" }) {
  const db = new Database(":memory:");
  for (const f of ["001_init.sql", "002_templates.sql", "003_reputation.sql"]) db.exec(readFileSync(join(import.meta.dir, "../migrations", f), "utf8"));
  const emitted: unknown[] = [];
  const c: core.EmailCtx = {
    db: {
      async query<T>(sql: string, p: unknown[] = []) {
        return db.query(sql).all(...(p as never[])) as T[];
      },
      async queryOne<T>(sql: string, p: unknown[] = []) {
        return (db.query(sql).get(...(p as never[])) ?? null) as T | null;
      },
      async execute(sql: string, p: unknown[] = []) {
        return { changes: db.query(sql).run(...(p as never[])).changes };
      },
    },
    fetch: fetchFn,
    secrets: { EMAIL_RESEND_KEY: "re_test", EMAIL_SES_ACCESS_KEY: "AKID", EMAIL_SES_SECRET_KEY: "secret" },
    config,
    events: { emit: async (_n, p) => void emitted.push(p) },
    log: { info() {}, warn() {} },
  };
  return { c, emitted };
}

test("send queues and emits; bad input and suppressed addresses are refused", async () => {
  const { c, emitted } = ctx(async () => new Response("{}"));
  const { id } = await core.sendRaw(c, { to: "Buyer@Example.com", subject: "Your order", text: "Thanks" });
  expect(emitted).toEqual([{ message_id: id }]);
  expect(await core.status(c, id)).toMatchObject({ status: "queued", attempts: 0 });
  await expect(core.sendRaw(c, { to: "nope", subject: "x", text: "y" })).rejects.toMatchObject({ code: "INVALID" });
  await expect(core.sendRaw(c, { to: "a@b.ae", subject: "two\nlines", text: "y" })).rejects.toMatchObject({ code: "INVALID" });
  await core.suppress(c, "a@b.ae", "manual");
  await expect(core.sendRaw(c, { to: "A@B.ae", subject: "x", text: "y" })).rejects.toMatchObject({ code: "SUPPRESSED" });
  await core.unsuppress(c, "a@b.ae");
  expect(await core.suppressed(c, "a@b.ae")).toBe(false);
});

test("Resend: sent; a 5xx throws for the outbox to retry; a 4xx is final", async () => {
  const seen: { url: string; init?: RequestInit }[] = [];
  let status = 200;
  const { c } = ctx(async (url, init) => (seen.push({ url, init }), status === 200 ? Response.json({ id: "re_1" }) : new Response("{}", { status })));
  const a = await core.sendRaw(c, { to: "x@y.ae", subject: "Hi", text: "Body" });
  expect(await core.deliverQueued(c, a.id as string)).toMatchObject({ ok: true, id: "re_1" });
  expect(seen[0]?.url).toBe("https://api.resend.com/emails");
  expect(JSON.parse(String(seen[0]?.init?.body))).toEqual({ from: "shop@hello.ae", to: ["x@y.ae"], subject: "Hi", text: "Body" });
  expect((seen[0]?.init?.headers as Record<string, string>).authorization).toBe("Bearer re_test");
  expect(await core.status(c, a.id)).toMatchObject({ status: "sent", attempts: 1 });
  status = 503;
  const b = await core.sendRaw(c, { to: "x@y.ae", subject: "Hi", text: "Body" });
  await expect(core.deliverQueued(c, b.id as string)).rejects.toThrow("resend 503");
  expect(await core.status(c, b.id)).toMatchObject({ status: "queued", attempts: 1 });
  status = 422;
  expect(await core.deliverQueued(c, b.id as string)).toMatchObject({ ok: false, retry: false });
  expect(await core.status(c, b.id)).toMatchObject({ status: "failed", attempts: 2 });
});

test("SES v2 is signed with SigV4 for the region", async () => {
  const seen: RequestInit[] = [];
  const { c } = ctx(async (_u, init) => (seen.push(init as RequestInit), Response.json({ MessageId: "ses-1" })), { provider: "ses", from: "shop@hello.ae", ses_region: "me-central-1" });
  const a = await core.sendRaw(c, { to: "x@y.ae", subject: "Hi", html: "<p>Body</p>" });
  expect(await core.deliverQueued(c, a.id as string)).toMatchObject({ ok: true, id: "ses-1" });
  const auth = (seen[0]?.headers as Record<string, string>).authorization as string;
  expect(auth).toMatch(/^AWS4-HMAC-SHA256 Credential=AKID\/\d{8}\/me-central-1\/ses\/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=[0-9a-f]{64}$/u);
  const same = await core.sesAuthorization("AKID", "secret", "me-central-1", "20261030T120000Z", "email.me-central-1.amazonaws.com", "/v2/email/outbound-emails", "{}");
  expect(same).toBe(await core.sesAuthorization("AKID", "secret", "me-central-1", "20261030T120000Z", "email.me-central-1.amazonaws.com", "/v2/email/outbound-emails", "{}"));
});

test("a bounce suppresses the address and a queued message to it is not sent", async () => {
  let calls = 0;
  const { c } = ctx(async () => (calls++, Response.json({ id: "x" })));
  const a = await core.sendRaw(c, { to: "gone@y.ae", subject: "Hi", text: "Body" });
  expect(await core.recordFeedback(c, { type: "email.bounced", data: { to: ["Gone@y.ae"] } })).toEqual({ suppressed: "gone@y.ae" });
  expect(await core.deliverQueued(c, a.id as string)).toBeNull();
  expect(await core.status(c, a.id)).toMatchObject({ status: "suppressed" });
  expect(calls).toBe(0);
});

// #328 F67-B: the bilingual templates, the before_send hook point, auth's mails.
import * as hooks from "../hooks.ts";
import { renderMail } from "../lib/templates.ts";

test("templates: both languages side by side, the recipient's first; values escaped; only safe links (snapshots ltr and rtl)", () => {
  const data = { display_name: "Sara <b>", url: "https://shop.renox.app/auth/reset#token=abc", expires_minutes: 15 };
  const en = renderMail("password_reset", data, "en");
  const ar = renderMail("password_reset", data, "ar");
  expect(en?.subject).toBe("Reset your password");
  expect(ar?.subject).toBe("إعادة تعيين كلمة المرور");
  expect(en?.html).toContain('<html lang="en" dir="ltr">');
  expect(ar?.html).toContain('<html lang="ar" dir="rtl">');
  expect(en?.html.indexOf('lang="en" dir="ltr"')).toBeLessThan(en?.html.indexOf('lang="ar" dir="rtl"') as number);
  expect(ar?.html.indexOf('<td lang="ar"')).toBeLessThan(ar?.html.indexOf('<td lang="en"') as number);
  expect(en?.html).toContain("Sara &lt;b&gt;");
  expect(en?.html).not.toContain("<b>");
  expect(en?.text).toContain("https://shop.renox.app/auth/reset#token=abc");
  expect(renderMail("password_reset", { ...data, url: "javascript:alert(1)" }, "en")?.html).not.toContain("javascript:");
  expect(renderMail("nope", {}, "en")).toBeNull();
  expect(en?.html).toMatchSnapshot("password_reset ltr");
  expect(ar?.html).toMatchSnapshot("password_reset rtl");
});

test("send from a template stores the template and locale; email.before_send can stop a message; reply_to reaches the provider", async () => {
  let seen: Record<string, unknown> = {};
  const { c } = ctx(async (_u, init) => {
    seen = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ id: "re_9" }));
  });
  let halt = false;
  const runs: unknown[] = [];
  c.hooks = { run: async (name, args) => (runs.push([name, args]), { halt }) };
  const r = await core.sendTemplate(c, "a@b.ae", "welcome", { display_name: "Ali" }, { locale: "ar", reply_to: "help@shop.ae" });
  expect(runs).toEqual([["email.before_send", { template: "welcome", locale: "ar", to_domain: "b.ae" }]]);
  const row = await c.db.queryOne<{ template: string; locale: string; subject: string; reply_to: string }>("select template, locale, subject, reply_to from email__messages where id = ?", [r.id]);
  expect(row).toEqual({ template: "welcome", locale: "ar", subject: "أهلًا بك", reply_to: "help@shop.ae" });
  await core.deliverQueued(c, r.id as string);
  expect(seen).toMatchObject({ to: ["a@b.ae"], reply_to: "help@shop.ae", subject: "أهلًا بك" });
  halt = true;
  expect(await core.sendTemplate(c, "a@b.ae", "welcome", {})).toEqual({ id: null, cancelled: true });
  expect((await c.db.query("select id from email__messages")).length).toBe(1);
  await expect(core.sendTemplate(c, "a@b.ae", "no_such", {})).rejects.toMatchObject({ code: "INVALID" });
});

test("auth.send_mail fills from the templates; a suppressed address is skipped quietly; a bounce emits email.bounced", async () => {
  const { c, emitted } = ctx(async () => new Response("{}"));
  await hooks.hooks["auth.send_mail"].handle(c, { to: "new@shop.ae", template: "verify_email", args: { url: "https://shop.renox.app/auth/verify#t=1", expires_minutes: 15, display_name: "New" } });
  const row = await c.db.queryOne<{ template: string; subject: string }>("select template, subject from email__messages");
  expect(row).toEqual({ template: "verify_email", subject: "Confirm your email address" });
  await core.recordFeedback(c, { type: "email.bounced", data: { to: ["new@shop.ae"] } });
  expect(emitted.at(-1)).toEqual({ address: "new@shop.ae" });
  await hooks.hooks["auth.send_mail"].handle(c, { to: "new@shop.ae", template: "password_reset", args: {} });
  expect((await c.db.query("select id from email__messages")).length).toBe(1);
});

// #123: the sending reputation.
import * as reputation from "../src/reputation/reputation.ts";

test("complaints above the threshold pause this tenant's sending and say why; resume lifts it; a new sender's daily cap", async () => {
  const { c, emitted } = ctx(async () => new Response(JSON.stringify({ id: "re_1" })));
  for (let i = 0; i < 100; i++) {
    const { id } = await core.sendRaw(c, { to: `r${i}@example.com`, subject: "Hi", text: "Body" });
    await core.deliverQueued(c, id as string);
  }
  await core.recordFeedback(c, { type: "email.complained", data: { to: ["r1@example.com"] } });
  await core.recordFeedback(c, { type: "email.complained", data: { to: ["r2@example.com"] } });
  expect(await reputation.paused(c.db)).toBeNull();
  await core.recordFeedback(c, { type: "email.complained", data: { to: ["r3@example.com"] } });
  expect(await reputation.paused(c.db)).toMatchObject({ reason: "complaints 3 of 100" });
  expect(emitted).toContainEqual({ reason: "complaints 3 of 100" });
  await expect(core.sendRaw(c, { to: "next@example.com", subject: "Hi", text: "x" })).rejects.toMatchObject({ code: "PAUSED" });
  await core.resume(c);
  expect((await core.sendRaw(c, { to: "next@example.com", subject: "Hi", text: "x" })).id).not.toBeNull();
  // The cap of a sender in its first week is 200 a day; after 30 days it is lifted.
  const day = 86_400_000;
  expect(reputation.dailyCap(null)).toBe(200);
  expect(reputation.dailyCap(Date.now() - 2 * day)).toBe(200);
  expect(reputation.dailyCap(Date.now() - 10 * day)).toBe(2000);
  expect(reputation.dailyCap(Date.now() - 40 * day)).toBeNull();
});
