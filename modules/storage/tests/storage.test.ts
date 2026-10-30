// The storage module (#332): owner folders, the SVG sanitiser, limits, links.
import { expect, test } from "bun:test";

import { fakeStorage } from "../../../sdk/src/fakes.ts";
import * as core from "../lib/core.ts";

const ctx = (config: core.StorageCtx["config"] = {}) => ({ storage: fakeStorage("storage") as unknown as core.StorageCtx["storage"], config });

test("an upload goes to the owner's folder with a safe name; another owner's name cannot escape", async () => {
  const c = ctx();
  const f = await core.upload(c, "user_42", "My Photo (1).PNG", new Uint8Array([1, 2]), "image/png", { public: true });
  expect(f.key).toBe("storage/user_42/my-photo-1-.png");
  expect(f.public).toBe(true);
  expect(() => core.keyOf("../x", "a.png")).toThrow("owner");
  expect(() => core.keyOf("user_42", "..")).toThrow("name");
  const page = await core.list(c, "user_42");
  expect(page.items.map((i) => i.key)).toEqual(["storage/user_42/my-photo-1-.png"]);
  expect((await core.link(c, "user_42", "my-photo-1-.png", 600)).url).toStartWith("/_files/storage/user_42/");
  expect(await core.remove(c, "user_42", "my-photo-1-.png")).toBe(true);
  await expect(core.upload(ctx({ max_upload_bytes: 1 }), "u", "a.txt", new Uint8Array(2), "text/plain")).rejects.toMatchObject({ code: "TOO_LARGE" });
});

test("SVG: refused unless allowed; sanitised of scripts, handlers, foreign objects and external references", async () => {
  const evil = `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script><foreignObject><iframe src="https://x"></iframe></foreignObject><a href="javascript:alert(3)"><rect fill="url(https://evil/x)" onclick="x()"/></a><use href="#ok"/></svg>`;
  await expect(core.upload(ctx(), "u", "logo.svg", new TextEncoder().encode(evil), "image/svg+xml")).rejects.toMatchObject({ code: "SVG" });
  const f = await core.upload(ctx({ allow_svg: true }), "u", "logo.svg", new TextEncoder().encode(evil), "image/svg+xml");
  expect(f.content_type).toBe("image/svg+xml");
  const clean = core.sanitizeSvg(evil) as string;
  for (const bad of ["<script", "onload", "onclick", "foreignObject", "iframe", "javascript:", "https://evil"]) expect(clean).not.toContain(bad);
  expect(clean).toContain('href="#ok"');
  expect(core.sanitizeSvg("<html><script/></html>")).toBeNull();
});
