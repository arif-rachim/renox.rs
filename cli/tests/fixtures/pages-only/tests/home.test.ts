import { expect, test } from "bun:test";
import { app } from "@renoxium/sdk/test";

const t = await app();

test("the home page renders", async () => {
  const res = await t.page("/");
  expect(res.status).toBe(200);
  expect(res.html).toContain("Pages only");
});
