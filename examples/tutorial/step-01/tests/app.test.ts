// `renox test` runs this file on the local worker, with a fresh database.
import { describe, expect, test } from "bun:test";
import type { TestApp } from "@renoxium/sdk/test";

// `renox test` sets RENOX_TEST_SPEC; any other `bun test` skips this file.
const run = process.env.RENOX_TEST_SPEC !== undefined;
const t = run ? await (await import("@renoxium/sdk/test")).app() : ({} as TestApp);

describe.skipIf(!run)("the app", () => {
  test("the home page renders", async () => {
    const res = await t.page("/");
    expect(res.status).toBe(200);
    expect(res.html).toContain("Team board");
  });

  test('GET /api/health answers {"ok":true}', async () => {
    const res = await t.request("GET", "/api/health");
    expect(res.json()).toEqual({ ok: true });
  });
});
