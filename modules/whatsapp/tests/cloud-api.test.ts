// The Cloud API client and the send handler against a fake Cloud API in
// the test process (#290; tenant fetch cannot reach a local fake): the
// request shapes, retries on a 5xx (the handler throws, so the outbox
// retries), a 4xx is final, the webhook signature, parsing, the sealed OTP.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import * as api from "../lib/cloud-api.ts";
import { deliverQueued, receive, type WaCtx } from "../lib/core.ts";
import * as otp from "../lib/otp.ts";

const CFG: api.ApiConfig = { token: "tok", phoneId: "1234567890", version: "v21.0" };

/** A fake Cloud API: records requests, answers with `status` (a list, one per call). */
function fakeApi(statuses: number[] = [200]) {
  const calls: { url: string; auth: string | null; body: Record<string, unknown> }[] = [];
  const fetch: api.FetchFn = async (url, init) => {
    calls.push({ url, auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    const status = statuses.length > 1 ? (statuses.shift() as number) : (statuses[0] as number);
    if (status === 200) return Response.json({ messaging_product: "whatsapp", messages: [{ id: `wamid.${calls.length}` }] });
    return Response.json({ error: { code: status === 400 ? 131026 : 1, message: "x" } }, { status });
  };
  return { fetch, calls };
}

/** A ctx over an in-memory copy of the module's schema. */
function fakeCtx(fetch: api.FetchFn): WaCtx & { sqlite: Database; emitted: unknown[] } {
  const sqlite = new Database(":memory:");
  sqlite.exec(readFileSync(join(import.meta.dir, "../migrations/001_init.sql"), "utf8"));
  const emitted: unknown[] = [];
  const params = (p: unknown[] = []) => p as (string | number | null)[];
  return {
    sqlite,
    emitted,
    db: {
      query: async <T>(sql: string, p?: unknown[]) => sqlite.query(sql).all(...params(p)) as T[],
      queryOne: async <T>(sql: string, p?: unknown[]) => (sqlite.query(sql).get(...params(p)) ?? null) as T | null,
      execute: async (sql: string, p?: unknown[]) => ({ changes: sqlite.query(sql).run(...params(p)).changes }),
    },
    fetch,
    secrets: { WHATSAPP_TOKEN: "tok", WHATSAPP_PHONE_ID: "1234567890", WHATSAPP_APP_SECRET: "s3cret" },
    config: { api_version: "v21.0" },
    events: { emit: async (name, payload) => void emitted.push({ name, payload }) },
    log: { info: () => {}, warn: () => {} },
  };
}

describe("cloud api", () => {
  test("a template send: the endpoint, the bearer token, the components", async () => {
    const f = fakeApi();
    const r = await api.sendTemplate(f.fetch, CFG, "+971501234567", "order_shipped", "en", ["#42", "Tuesday"]);
    expect(r).toEqual({ ok: true, waId: "wamid.1" });
    expect(f.calls[0]?.url).toBe("https://graph.facebook.com/v21.0/1234567890/messages");
    expect(f.calls[0]?.auth).toBe("Bearer tok");
    expect(f.calls[0]?.body).toEqual({
      messaging_product: "whatsapp",
      to: "971501234567",
      type: "template",
      template: { name: "order_shipped", language: { code: "en" }, components: [{ type: "body", parameters: [{ type: "text", text: "#42" }, { type: "text", text: "Tuesday" }] }] },
    });
  });

  test("5xx, 429 and a network failure are retried; a 4xx is final", async () => {
    expect(await api.sendText(fakeApi([503]).fetch, CFG, "+971501234567", "hi")).toMatchObject({ ok: false, retry: true, status: 503 });
    expect(await api.sendText(fakeApi([429]).fetch, CFG, "+971501234567", "hi")).toMatchObject({ ok: false, retry: true });
    expect(await api.sendText(async () => Promise.reject(new TypeError("down")), CFG, "+971501234567", "hi")).toMatchObject({ ok: false, retry: true, status: 0 });
    expect(await api.sendText(fakeApi([400]).fetch, CFG, "+971501234567", "hi")).toEqual({ ok: false, retry: false, status: 400, error: "400 (131026)" });
  });

  test("phones, the wa.me link", () => {
    expect(api.normalizePhone("+971 50 123 4567")).toBe("+971501234567");
    expect(api.normalizePhone("00971-50-123-4567")).toBe("+971501234567");
    expect(api.normalizePhone("0501234567")).toBeNull();
    expect(api.chatLink("+971501234567", "I want #42")).toBe("https://wa.me/971501234567?text=I%20want%20%2342");
  });

  test("the webhook signature: right, wrong, missing", async () => {
    const body = '{"entry":[]}';
    const sig = `sha256=${await api.hmacHex("app", body)}`;
    expect(await api.verifySignature("app", body, sig)).toBe(true);
    expect(await api.verifySignature("app", `${body} `, sig)).toBe(false);
    expect(await api.verifySignature("other", body, sig)).toBe(false);
    expect(await api.verifySignature("app", body, null)).toBe(false);
    expect(await api.verifySignature("", body, sig)).toBe(false);
  });

  test("a sealed OTP opens only with the same secret", async () => {
    const s = await otp.seal("k1", "123456");
    expect(s).toStartWith("seal:");
    expect(s).not.toContain("123456");
    expect(await otp.unseal("k1", s)).toBe("123456");
    expect(await otp.unseal("k2", s)).toBeNull();
  });
});

describe("the send handler", () => {
  const queued = (ctx: ReturnType<typeof fakeCtx>, kind: string, body: string) => {
    ctx.sqlite.query("insert into whatsapp__messages (id, direction, kind, phone, body, status, at, updated_at) values ('m1', 'out', ?, '+971501234567', ?, 'queued', 1, 1)").run(kind, body);
  };
  const row = (ctx: ReturnType<typeof fakeCtx>) => ctx.sqlite.query("select status, wa_id, body, error from whatsapp__messages where id = 'm1'").get();

  test("a 5xx throws (the outbox retries); the next attempt sends", async () => {
    const f = fakeApi([500, 200]);
    const ctx = fakeCtx(f.fetch);
    queued(ctx, "text", "hello");
    await expect(deliverQueued(ctx, "m1")).rejects.toThrow("500");
    expect(row(ctx)).toMatchObject({ status: "queued", error: "500 (1)" });
    expect(await deliverQueued(ctx, "m1")).toEqual({ ok: true, waId: "wamid.2" });
    expect(row(ctx)).toMatchObject({ status: "sent", wa_id: "wamid.2", error: null });
    // Delivered once: a duplicate event does nothing.
    expect(await deliverQueued(ctx, "m1")).toBeNull();
    expect(f.calls).toHaveLength(2);
  });

  test("a 4xx fails the message for good; an OTP's sealed code is cleared either way", async () => {
    const f = fakeApi([400]);
    const ctx = fakeCtx(f.fetch);
    queued(ctx, "otp", await otp.seal("s3cret", "654321"));
    expect(await deliverQueued(ctx, "m1")).toMatchObject({ ok: false, retry: false });
    expect(row(ctx)).toMatchObject({ status: "failed", body: "" });
    expect((f.calls[0]?.body as { text: { body: string } }).text.body).toContain("654321");
  });

  test("inbound messages are stored once; statuses only move forward", async () => {
    const ctx = fakeCtx(fakeApi().fetch);
    queued(ctx, "text", "hello");
    ctx.sqlite.query("update whatsapp__messages set status = 'sent', wa_id = 'wamid.out' where id = 'm1'").run();
    const delivery = { entry: [{ changes: [{ value: { messages: [{ id: "wamid.in", from: "971509999999", timestamp: "1700000000", type: "text", text: { body: "Is #42 in stock?" } }], statuses: [{ id: "wamid.out", status: "read", timestamp: "1700000001" }, { id: "wamid.out", status: "delivered", timestamp: "1700000000" }] } }] }] };
    expect(await receive(ctx, api.parseWebhook(delivery))).toHaveLength(1);
    expect(await receive(ctx, api.parseWebhook(delivery))).toHaveLength(0);
    expect(ctx.sqlite.query("select phone, body, status from whatsapp__messages where direction = 'in'").all()).toEqual([{ phone: "+971509999999", body: "Is #42 in stock?", status: "received" }]);
    expect(row(ctx)).toMatchObject({ status: "read" });
    expect(ctx.emitted).toHaveLength(1);
  });
});
