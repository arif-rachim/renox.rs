// #127: the committed crates/renox-gateway/assets/renox-client.js is the
// build of sdk/client/src, and stays within 4 KB gzipped. Run
// `bun sdk/client/build.ts` after changing the script.
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ASSET, build, MAX_GZIP_BYTES } from "../build.ts";

test("the committed asset is the current build, within 4 KB gzipped, with no source map reference", async () => {
  const out = await build(mkdtempSync(join(tmpdir(), "renox-client-")));
  const built = readFileSync(out, "utf8");
  expect(readFileSync(ASSET, "utf8")).toBe(built);
  expect(Bun.gzipSync(new TextEncoder().encode(built)).length).toBeLessThanOrEqual(MAX_GZIP_BYTES);
  expect(built).not.toContain("sourceMappingURL");
  expect(() => new Function(built)).not.toThrow();
});
