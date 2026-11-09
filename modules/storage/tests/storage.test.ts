// The storage module (#332): owner folders, the SVG sanitiser, limits, links.
import { expect, test } from "bun:test";

import { fakeStorage, fakeUpload } from "../../../sdk/src/fakes.ts";
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

test("uploadUrl signs a PUT into the owner's folder, caps maxBytes at the config, refuses SVG and bad input", async () => {
  const MB = 1024 * 1024;
  const c = ctx({ max_upload_bytes: 2 * MB });
  const s = await core.uploadUrl(c, "user_42", "My Photo.JPG", { contentType: "image/jpeg", maxBytes: 50 * MB });
  expect(s.key).toBe("storage/user_42/my-photo.jpg");
  expect(s.max_bytes).toBe(2 * MB);
  expect(s.url).toStartWith("/_files/storage/user_42/my-photo.jpg?");
  expect(s.url).toContain(`max=${2 * MB}`);
  expect(s.url).toContain("ct=image%2Fjpeg");
  // A smaller request stays as asked; the URL lives 600 seconds.
  const small = await core.uploadUrl(c, "user_42", "a.png", { contentType: "image/png", maxBytes: 1000, public: true });
  expect(small.max_bytes).toBe(1000);
  expect(small.url).toContain("pub=1");
  const ttl = Math.round((small.expires_at - Date.now()) / 1000);
  expect(ttl).toBeGreaterThan(590);
  expect(ttl).toBeLessThanOrEqual(600);
  // The PUT lands in the signed key (fakeUpload is the browser's PUT).
  const stored = await fakeUpload(c.storage as unknown as ReturnType<typeof fakeStorage>, small.url, new Uint8Array(1000), "image/png");
  expect(stored.key).toBe("storage/user_42/a.png");
  expect((await core.list(c, "user_42")).items.map((i) => i.key)).toContain("storage/user_42/a.png");

  // SVG is always refused, even with allow_svg: the sanitiser runs only on the action path.
  await expect(core.uploadUrl(ctx({ allow_svg: true }), "u", "logo.svg", { contentType: "image/svg+xml", maxBytes: 100 })).rejects.toMatchObject({ code: "SVG" });
  await expect(core.uploadUrl(ctx({ allow_svg: true }), "u", "logo.svg", { contentType: "Image/SVG+XML; charset=utf-8", maxBytes: 100 })).rejects.toMatchObject({ code: "SVG" });
  // Bad names and sizes are INVALID, and a path out of the folder cannot be named.
  await expect(core.uploadUrl(c, "../x", "a.png", { contentType: "image/png", maxBytes: 10 })).rejects.toMatchObject({ code: "INVALID" });
  await expect(core.uploadUrl(c, "u", "a.png", { contentType: "image/png", maxBytes: 0 })).rejects.toMatchObject({ code: "INVALID" });
  await expect(core.uploadUrl(c, "u", "a.png", { maxBytes: 10 })).rejects.toMatchObject({ code: "INVALID" });
});

test("uploadUrl: over the owner's quota is refused at signing, with maxBytes as the size; a replaced file counts once", async () => {
  const MB = 1024 * 1024;
  const c = ctx({ quota_mb: 1 });
  await core.upload(c, "u", "a.txt", new Uint8Array(600 * 1024), "text/plain");
  await expect(core.uploadUrl(c, "u", "b.txt", { contentType: "text/plain", maxBytes: 500 * 1024 })).rejects.toMatchObject({ code: "QUOTA" });
  expect((await core.uploadUrl(c, "u", "b.txt", { contentType: "text/plain", maxBytes: 400 * 1024 })).max_bytes).toBe(400 * 1024);
  // Replacing a.txt: its own bytes do not count against itself.
  expect((await core.uploadUrl(c, "u", "a.txt", { contentType: "text/plain", maxBytes: MB })).max_bytes).toBe(MB);
  // Another owner has a quota of their own.
  expect((await core.uploadUrl(c, "v", "a.txt", { contentType: "text/plain", maxBytes: MB })).key).toBe("storage/v/a.txt");
});
