// `renox test` runs this file on the same worker as `renox dev`, with a
// fresh database for the file (@renoxium/sdk/test).

import { expect, test } from "bun:test";
import { app } from "@renoxium/sdk/test";

const t = await app();

test('GET /api/hello answers {"ok":true}', async () => {
  const res = await t.request("GET", "/api/hello");
  expect(res.status).toBe(200);
  expect(res.json()).toEqual({ ok: true });
});

test("the home page renders", async () => {
  const res = await t.page("/");
  expect(res.status).toBe(200);
  expect(res.html).toContain("is running");
});
