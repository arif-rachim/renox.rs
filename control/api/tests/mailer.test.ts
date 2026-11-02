// The Resend mailer (#385) against a fake Resend on loopback: delivery with
// the configured sender and one idempotency key per message, the retry rules,
// the bound on a request, the configuration, and that the API key and the
// message (whose links hold single-use tokens) reach no log line, error or
// response after a failure (docs/24-threat-model.md: "Secrets in logs,
// errors, bundle, responses"; "Account takeover of a tenant developer").

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MailDeliveryError, mailerFor, NullMailer, OutboxDirMailer, ResendMailer, type Mail } from "../src/auth/mailer.ts";
import { ConfigError, DEFAULTS, loadConfig } from "../src/config.ts";
import { memoryLogger } from "../src/log.ts";
import { assertScoped, harness, PASSWORD } from "./helpers.ts";

afterEach(assertScoped);

const KEY = "re_TestKeyNotReal_0123456789";
const FROM = "Renoxium <no-reply@renoxium.com>";

interface Received {
  auth: string | null;
  idempotency: string | null;
  body: { from: string; to: string[]; subject: string; text: string };
}

/** The fake Resend: answers each request with the next scripted reply (default 200). */
const fake = {
  received: [] as Received[],
  script: [] as Array<{ status: number; headers?: Record<string, string>; delayMs?: number }>,
  /** Idempotency keys already answered with 200: a repeat is not delivered again. */
  delivered: new Set<string>(),
  server: undefined as ReturnType<typeof Bun.serve> | undefined,
  get url(): string {
    return `http://127.0.0.1:${this.server?.port}`;
  },
};

beforeAll(() => {
  fake.server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname !== "/emails" || req.method !== "POST") return new Response("not found", { status: 404 });
      const step = fake.script.shift() ?? { status: 200 };
      if (step.delayMs !== undefined) await Bun.sleep(step.delayMs);
      if (req.headers.get("authorization") !== `Bearer ${KEY}`) return Response.json({ name: "invalid_api_key" }, { status: 403 });
      const body = (await req.json()) as Received["body"];
      const idempotency = req.headers.get("idempotency-key");
      // Echo the message in error answers, as an API might: the mailer must never surface it.
      if (step.status !== 200) return Response.json({ name: "error", message: `refused ${body.text}` }, { status: step.status, headers: step.headers });
      if (idempotency !== null && fake.delivered.has(idempotency)) return Response.json({ id: "dup" });
      if (idempotency !== null) fake.delivered.add(idempotency);
      fake.received.push({ auth: req.headers.get("authorization"), idempotency, body });
      return Response.json({ id: `msg_${fake.received.length}` });
    },
  });
});
afterAll(() => fake.server?.stop(true));
beforeEach(() => {
  fake.received = [];
  fake.script = [];
  fake.delivered.clear();
});

const waits: number[] = [];
const mailer = (opts: Partial<ConstructorParameters<typeof ResendMailer>[0]> = {}) =>
  new ResendMailer({ apiKey: KEY, from: FROM, apiUrl: fake.url, timeoutMs: 300, sleep: async (ms) => void waits.push(ms), ...opts });
const MAIL: Mail = { to: "u@example.ae", kind: "password_reset", subject: "Reset your password", text: "https://dashboard.renoxium.com/reset#token=abcdefghijklmnopqrstuvwxyz234567" };

describe("ResendMailer", () => {
  beforeEach(() => void waits.splice(0));

  test("delivers with the configured sender, the bearer key and an idempotency key", async () => {
    await mailer().send(MAIL);
    expect(fake.received).toHaveLength(1);
    const [r] = fake.received;
    expect(r?.body).toEqual({ from: FROM, to: ["u@example.ae"], subject: MAIL.subject, text: MAIL.text });
    expect(r?.auth).toBe(`Bearer ${KEY}`);
    expect(r?.idempotency).toMatch(/^password_reset\/[0-9a-f-]{36}$/u);
  });

  test("two messages get two idempotency keys", async () => {
    const m = mailer();
    await m.send(MAIL);
    await m.send(MAIL);
    expect(new Set(fake.received.map((r) => r.idempotency)).size).toBe(2);
  });

  test("500 then 200: retried with the same idempotency key and delivered once", async () => {
    fake.script = [{ status: 500 }, { status: 200 }];
    await mailer().send(MAIL);
    expect(fake.received).toHaveLength(1);
    expect(waits).toEqual([500]);
  });

  test("a lost answer (200 the client never saw) is retried without a second delivery", async () => {
    // The first attempt is delivered but answers after the client's timeout.
    fake.script = [{ status: 200, delayMs: 600 }, { status: 200 }];
    await mailer().send(MAIL);
    await Bun.sleep(400);
    expect(fake.received).toHaveLength(1);
  });

  test("429 with Retry-After: waits that long (capped), then delivers", async () => {
    fake.script = [{ status: 429, headers: { "retry-after": "2" } }, { status: 429, headers: { "retry-after": "60" } }, { status: 200 }];
    await mailer().send(MAIL);
    expect(waits).toEqual([2000, 5000]);
    expect(fake.received).toHaveLength(1);
  });

  test("422 is final: one attempt, MailDeliveryError with the status", async () => {
    fake.script = [{ status: 422 }];
    const err = await mailer().send(MAIL).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MailDeliveryError);
    expect((err as MailDeliveryError).status).toBe(422);
    expect((err as MailDeliveryError).attempts).toBe(1);
    expect(waits).toEqual([]);
  });

  test("a timeout is retried; exponential backoff; after the last attempt the error names kind and status only", async () => {
    fake.script = [{ status: 200, delayMs: 600 }, { status: 503 }, { status: 503 }, { status: 503 }];
    const err = (await mailer().send(MAIL).catch((e: unknown) => e)) as MailDeliveryError;
    expect(err).toBeInstanceOf(MailDeliveryError);
    expect(err.attempts).toBe(4);
    expect(err.status).toBe(503);
    expect(waits).toEqual([500, 1000, 2000]);
    expect(err.message).toBe("mail password_reset not delivered after 4 attempt(s): HTTP 503");
    const all = `${err.message} ${err.stack ?? ""} ${JSON.stringify(err)}`;
    expect(all).not.toContain(KEY);
    expect(all).not.toContain("abcdefghijklmnopqrstuvwxyz234567");
    await Bun.sleep(400);
  });

  test("a refused connection is retried and then reported as no answer", async () => {
    const err = (await mailer({ apiUrl: "http://127.0.0.1:1", attempts: 2 }).send(MAIL).catch((e: unknown) => e)) as MailDeliveryError;
    expect(err.status).toBeNull();
    expect(err.message).toContain("no answer");
  });

  test("the mailer's JSON names the provider and the sender, never the key", () => {
    const m = new ResendMailer({ apiKey: KEY, from: FROM });
    expect(JSON.stringify(m)).toBe(JSON.stringify({ provider: "resend", from: FROM }));
    expect(JSON.stringify(m)).not.toContain(KEY);
  });
});

describe("in the API", () => {
  test("a sign-up's verification and a password reset arrive through Resend from CONTROL_MAIL_FROM", async () => {
    const h = await harness();
    h.deps.mailer = mailer();
    expect((await h.request("POST", "/v1/account/signup", { json: { email: "new@example.ae", password: PASSWORD, tenant_id: "t-mail", dpa_accepted: true } })).status).toBe(202);
    expect((await h.request("POST", "/v1/account/password-reset", { ip: "203.0.113.77", json: { email: "new@example.ae" } })).status).toBe(202);
    expect(fake.received.map((r) => [r.body.from, r.body.to[0]])).toEqual([
      [FROM, "new@example.ae"],
      [FROM, "new@example.ae"],
    ]);
    expect(fake.received[0]?.body.text).toMatch(/signup\/verify#token=[a-z2-7]{32}/u);
    expect(fake.received[1]?.body.text).toMatch(/#token=[a-z2-7]{32}/u);
  }, 30_000);

  test("Resend down: the request still succeeds, and no log line or response holds the key or the message", async () => {
    const h = await harness();
    h.deps.mailer = mailer({ attempts: 2 });
    fake.script = [{ status: 500 }, { status: 500 }];
    const res = await h.request("POST", "/v1/account/signup", { json: { email: "down@example.ae", password: PASSWORD, tenant_id: "t-down", dpa_accepted: true } });
    expect(res.status).toBe(202);
    const text = await res.text();
    const logs = h.log.lines.join("\n");
    expect(logs).toContain("mail send failed");
    expect(logs).toContain("verify_email");
    for (const out of [logs, text]) {
      expect(out).not.toContain(KEY);
      expect(out).not.toContain("#token=");
      expect(out).not.toContain("refused ");
    }
  }, 30_000);
});

describe("configuration", () => {
  test("defaults: CONTROL_MAIL_PROVIDER unset keeps today's mailer (outbox with a dir, otherwise none)", async () => {
    const log = memoryLogger();
    expect(DEFAULTS.mailFrom).toBe("Renoxium <no-reply@renoxium.com>");
    const none = loadConfig({}).mail;
    expect(none).toEqual({ provider: "none", from: DEFAULTS.mailFrom });
    const dropped = mailerFor(none!, log);
    expect(dropped).toBeInstanceOf(NullMailer);
    await dropped.send(MAIL);
    expect(log.lines.join("\n")).not.toContain("#token=");
    const dir = mkdtempSync(join(tmpdir(), "outbox-"));
    try {
      const outbox = mailerFor(loadConfig({ CONTROL_MAIL_OUTBOX_DIR: dir }).mail!, log);
      expect(outbox).toBeInstanceOf(OutboxDirMailer);
      await outbox.send(MAIL);
      expect(readdirSync(dir)).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const resend = mailerFor(loadConfig({ CONTROL_MAIL_PROVIDER: "resend", CONTROL_RESEND_API_KEY: KEY }).mail!, log);
    expect(resend).toBeInstanceOf(ResendMailer);
    expect(log.lines.join("\n")).not.toContain(KEY);
    expect(log.lines.join("\n")).toContain('"provider":"resend"');
  });

  test("resend: the key, the sender and the URL are read; the default URL is Resend's", () => {
    const c = loadConfig({ CONTROL_MAIL_PROVIDER: "resend", CONTROL_RESEND_API_KEY: KEY, CONTROL_MAIL_FROM: "Ops <ops@renoxium.com>" });
    expect(c.mail).toEqual({ provider: "resend", from: "Ops <ops@renoxium.com>", apiUrl: "https://api.resend.com", apiKey: KEY });
  });

  test("refusals; no refusal repeats the key", () => {
    const bad: Array<Record<string, string>> = [
      { CONTROL_MAIL_PROVIDER: "resend" },
      { CONTROL_MAIL_PROVIDER: "resend", CONTROL_RESEND_API_KEY: "sk_live_notresend1234" },
      { CONTROL_MAIL_PROVIDER: "resend", CONTROL_RESEND_API_KEY: KEY, CONTROL_RESEND_API_URL: "http://api.resend.com" },
      { CONTROL_MAIL_PROVIDER: "resend", CONTROL_RESEND_API_KEY: KEY, CONTROL_RESEND_API_URL: "https://u:p@api.resend.com" },
      { CONTROL_MAIL_PROVIDER: "outbox" },
      { CONTROL_MAIL_PROVIDER: "smtp" },
      { CONTROL_MAIL_FROM: "Renoxium <no-reply@renoxium.com>\r\nBcc: x@evil.test" },
      { CONTROL_MAIL_FROM: "not an address" },
    ];
    for (const env of bad) {
      let err: unknown;
      try {
        loadConfig(env);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ConfigError);
      expect(String(err)).not.toContain(KEY);
      expect(String(err)).not.toContain("sk_live_notresend1234");
    }
    expect(loadConfig({ CONTROL_MAIL_PROVIDER: "resend", CONTROL_RESEND_API_KEY: KEY, CONTROL_RESEND_API_URL: "http://127.0.0.1:9999" }).mail?.provider).toBe("resend");
  });
});
