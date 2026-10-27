import { expect, test } from "bun:test";
import { type Ctx, defineHandlers, type Handler } from "../src/index.ts";

test("defineHandlers returns the handlers unchanged and keeps their keys", async () => {
  const GET: Handler = () => Response.json({ ok: true });
  const module = defineHandlers({ GET });
  expect(module.GET).toBe(GET);
  expect(Object.keys(module)).toEqual(["GET"]);
  const res = await module.GET({} as Ctx);
  expect(await res.json()).toEqual({ ok: true });
});
