// The email module (#328): the queue, suppression, the providers' requests,
// retries on 5xx (a throw for the outbox) and a final 4xx, bounce feedback.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import * as core from "../lib/core.ts";

function ctx(fetchFn: core.FetchFn, config: core.EmailCtx["config"] = { provider: "resend", from: "shop@hello.ae" }) {
  const db = new Database(":memory:");
  db.exec(readFileSync(join(import.meta.dir, "../migrations/001_init.sql"), "utf8"));
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
  const { id } = await core.send(c, { to: "Buyer@Example.com", subject: "Your order", text: "Thanks" });
  expect(emitted).toEqual([{ message_id: id }]);
  expect(await core.status(c, id)).toMatchObject({ status: "queued", attempts: 0 });
  await expect(core.send(c, { to: "nope", subject: "x", text: "y" })).rejects.toMatchObject({ code: "INVALID" });
  await expect(core.send(c, { to: "a@b.ae", subject: "two\nlines", text: "y" })).rejects.toMatchObject({ code: "INVALID" });
  await core.suppress(c, "a@b.ae", "manual");
  await expect(core.send(c, { to: "A@B.ae", subject: "x", text: "y" })).rejects.toMatchObject({ code: "SUPPRESSED" });
  await core.unsuppress(c, "a@b.ae");
  expect(await core.suppressed(c, "a@b.ae")).toBe(false);
});

test("Resend: sent; a 5xx throws for the outbox to retry; a 4xx is final", async () => {
  const seen: { url: string; init?: RequestInit }[] = [];
  let status = 200;
  const { c } = ctx(async (url, init) => (seen.push({ url, init }), status === 200 ? Response.json({ id: "re_1" }) : new Response("{}", { status })));
  const a = await core.send(c, { to: "x@y.ae", subject: "Hi", text: "Body" });
  expect(await core.deliverQueued(c, a.id)).toMatchObject({ ok: true, id: "re_1" });
  expect(seen[0]?.url).toBe("https://api.resend.com/emails");
  expect(JSON.parse(String(seen[0]?.init?.body))).toEqual({ from: "shop@hello.ae", to: ["x@y.ae"], subject: "Hi", text: "Body" });
  expect((seen[0]?.init?.headers as Record<string, string>).authorization).toBe("Bearer re_test");
  expect(await core.status(c, a.id)).toMatchObject({ status: "sent", attempts: 1 });
  status = 503;
  const b = await core.send(c, { to: "x@y.ae", subject: "Hi", text: "Body" });
  await expect(core.deliverQueued(c, b.id)).rejects.toThrow("resend 503");
  expect(await core.status(c, b.id)).toMatchObject({ status: "queued", attempts: 1 });
  status = 422;
  expect(await core.deliverQueued(c, b.id)).toMatchObject({ ok: false, retry: false });
  expect(await core.status(c, b.id)).toMatchObject({ status: "failed", attempts: 2 });
});

test("SES v2 is signed with SigV4 for the region", async () => {
  const seen: RequestInit[] = [];
  const { c } = ctx(async (_u, init) => (seen.push(init as RequestInit), Response.json({ MessageId: "ses-1" })), { provider: "ses", from: "shop@hello.ae", ses_region: "me-central-1" });
  const a = await core.send(c, { to: "x@y.ae", subject: "Hi", html: "<p>Body</p>" });
  expect(await core.deliverQueued(c, a.id)).toMatchObject({ ok: true, id: "ses-1" });
  const auth = (seen[0]?.headers as Record<string, string>).authorization as string;
  expect(auth).toMatch(/^AWS4-HMAC-SHA256 Credential=AKID\/\d{8}\/me-central-1\/ses\/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=[0-9a-f]{64}$/u);
  const same = await core.sesAuthorization("AKID", "secret", "me-central-1", "20261030T120000Z", "email.me-central-1.amazonaws.com", "/v2/email/outbound-emails", "{}");
  expect(same).toBe(await core.sesAuthorization("AKID", "secret", "me-central-1", "20261030T120000Z", "email.me-central-1.amazonaws.com", "/v2/email/outbound-emails", "{}"));
});

test("a bounce suppresses the address and a queued message to it is not sent", async () => {
  let calls = 0;
  const { c } = ctx(async () => (calls++, Response.json({ id: "x" })));
  const a = await core.send(c, { to: "gone@y.ae", subject: "Hi", text: "Body" });
  expect(await core.recordFeedback(c, { type: "email.bounced", data: { to: ["Gone@y.ae"] } })).toEqual({ suppressed: "gone@y.ae" });
  expect(await core.deliverQueued(c, a.id)).toBeNull();
  expect(await core.status(c, a.id)).toMatchObject({ status: "suppressed" });
  expect(calls).toBe(0);
});
