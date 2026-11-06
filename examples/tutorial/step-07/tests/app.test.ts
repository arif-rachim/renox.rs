// `renox test` runs this file on the local worker, with a fresh database.
import { describe, expect, test } from "bun:test";
import { app } from "@renoxium/sdk/test";

const t = await app();

describe("the app", () => {
  test("the home page renders", async () => {
    const res = await t.page("/");
    expect(res.status).toBe(200);
    expect(res.html).toContain("Open the board");
  });

  test('GET /api/health answers {"ok":true}', async () => {
    const res = await t.request("GET", "/api/health");
    expect(res.json()).toEqual({ ok: true });
  });
});
