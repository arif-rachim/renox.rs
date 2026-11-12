// The failure reason on the rows of inbox/outbox/message and the mode() service (#771):
// a failed send shows its reason, a token-looking value is redacted, the text is capped at 200
// characters, and mode() follows the config.
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type * as api from "../lib/cloud-api.ts";
import { deliverQueued, ERROR_MAX, inbox, message, mode, outbox, sendTemplate, type WaCtx } from "../lib/core.ts";
import * as services from "../services.ts";

function fakeCtx(fetch: api.FetchFn, config: WaCtx["config"] = {}, secrets: WaCtx["secrets"] = { WHATSAPP_TOKEN: "tok", WHATSAPP_PHONE_ID: "1234567890", WHATSAPP_APP_SECRET: "s3cret" }): WaCtx & { sqlite: Database } {
  const sqlite = new Database(":memory:");
  sqlite.exec(readFileSync(join(import.meta.dir, "../migrations/001_init.sql"), "utf8"));
  const params = (p: unknown[] = []) => p as (string | number | null)[];
  return {
    sqlite,
    db: {
      query: async <T>(sql: string, p?: unknown[]) => sqlite.query(sql).all(...params(p)) as T[],
      queryOne: async <T>(sql: string, p?: unknown[]) => (sqlite.query(sql).get(...params(p)) ?? null) as T | null,
      execute: async (sql: string, p?: unknown[]) => ({ changes: sqlite.query(sql).run(...params(p)).changes }),
    },
    fetch,
    secrets,
    config,
    events: { emit: async () => {} },
    log: { info: () => {}, warn: () => {} },
  };
}

const failing: api.FetchFn = async () => Response.json({ error: { code: 131026, message: "Message undeliverable" } }, { status: 400 });

describe("error on message rows", () => {
  test("a failed send shows its reason on outbox, inbox and message; a queued or inbound row has null", async () => {
    const ctx = fakeCtx(failing);
    const { id } = await sendTemplate(ctx, "+971501234567", "order_shipped", [], "en");
    expect(await outbox(ctx)).toEqual([expect.objectContaining({ id, status: "queued", error: null })]);
    await deliverQueued(ctx, id);
    expect(await outbox(ctx)).toEqual([expect.objectContaining({ id, status: "failed", error: "400 (131026)" })]);
    expect(await inbox(ctx, { phone: "+971501234567" })).toEqual([expect.objectContaining({ id, error: "400 (131026)" })]);
    expect(await message(ctx, id)).toMatchObject({ id, status: "failed", error: "400 (131026)" });
    ctx.sqlite.query("insert into whatsapp__messages (id, direction, kind, phone, body, status, at, updated_at) values ('in1', 'in', 'text', '+971509999999', 'hi', 'received', 5, 5)").run();
    expect(await inbox(ctx, { direction: "in" })).toEqual([expect.objectContaining({ id: "in1", error: null })]);
  });

  test("the reason of a send the outbox is still retrying shows too", async () => {
    const ctx = fakeCtx(async () => Response.json({}, { status: 503 }));
    const { id } = await sendTemplate(ctx, "+971501234567", "order_shipped", [], "en");
    await expect(deliverQueued(ctx, id)).rejects.toThrow("503");
    expect(await message(ctx, id)).toMatchObject({ status: "queued", error: "503" });
  });

  test("a token-looking value or a held secret in the stored reason is redacted", async () => {
    const ctx = fakeCtx(failing);
    const plant = (id: string, error: string) => ctx.sqlite.query("insert into whatsapp__messages (id, direction, kind, phone, body, status, error, at, updated_at) values (?, 'out', 'text', '+971501234567', 'x', 'failed', ?, 1, 1)").run(id, error);
    plant("a", "401 Bearer EAAGm0PX4ZCpsBAKZC1234567890abcdefghijkl invalid");
    plant("b", "190: Invalid OAuth access token EAAGm0PX4ZCpsBAKZC1234567890abcdefghijkl.");
    plant("c", "bad key s3cret in header");
    for (const id of ["a", "b", "c"]) {
      const e = ((await message(ctx, id)) as { error: string }).error;
      expect(e).toContain("[redacted]");
      expect(e).not.toMatch(/EAAGm0|1234567890abcdef|s3cret/u);
    }
    expect(((await message(ctx, "a")) as { error: string }).error).toBe("401 Bearer [redacted] invalid");
  });

  test("the reason is capped at 200 characters", async () => {
    const ctx = fakeCtx(failing);
    ctx.sqlite.query("insert into whatsapp__messages (id, direction, kind, phone, body, status, error, at, updated_at) values ('long', 'out', 'text', '+971501234567', 'x', 'failed', ?, 1, 1)").run("too long, ".repeat(100));
    const e = ((await message(ctx, "long")) as { error: string }).error;
    expect(ERROR_MAX).toBe(200);
    expect(e.length).toBe(200);
  });
});

describe("mode()", () => {
  test("follows the config, through the service too", () => {
    expect(mode(fakeCtx(failing, {}))).toEqual({ sandbox: false });
    expect(mode(fakeCtx(failing, { sandbox: false }))).toEqual({ sandbox: false });
    expect(mode(fakeCtx(failing, { sandbox: true }, {}))).toEqual({ sandbox: true });
    expect(services.mode(fakeCtx(failing, { sandbox: true }))).toEqual({ sandbox: true });
  });
});
