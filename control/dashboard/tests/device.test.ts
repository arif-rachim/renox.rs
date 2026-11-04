// /device (#446): the code `renox login` puts in the URL is kept only when it
// is a user code (eight letters); anything else is dropped before it reaches
// the page. A signed-out visitor goes to /signin and comes back with the code.
import { expect, test } from "bun:test";

import { codeParam, load } from "../pages/device.ts";
import { dash, loaderCtx } from "./helpers.ts";

test("codeParam keeps XXXX-XXXX (any case, with or without the dash) and drops the rest", () => {
  expect(codeParam("bcdf-ghjk")).toBe("BCDF-GHJK");
  expect(codeParam("BCDFGHJK")).toBe("BCDF-GHJK");
  expect(codeParam(" BCDF-GHJK ")).toBe("BCDF-GHJK");
  for (const bad of [null, "", "BCDF", "BCDF-GHJ1", "<script>", "BCDF-GHJK-LMNP"]) expect(codeParam(bad)).toBe("");
});

test("a signed-out visitor goes to /signin with the code kept in next", async () => {
  const d = await dash();
  const r = await load(loaderCtx(d, "/device?code=bcdf-ghjk"));
  expect(r).toBeInstanceOf(Response);
  expect((r as Response).headers.get("location")).toBe(`/signin?next=${encodeURIComponent("/device?code=bcdf-ghjk")}`);
});
