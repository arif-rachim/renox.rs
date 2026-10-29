// #127: the committed crates/renox-gateway/assets/renox-client.js is the
// build of sdk/client/src, and stays within 4 KB gzipped. Run
// `bun sdk/client/build.ts` after changing the script.
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ASSET, build, debugIdOf, MAX_GZIP_BYTES } from "../build.ts";

test("the committed asset is the current build, within 4 KB gzipped, with no source map reference", async () => {
  const out = await build(mkdtempSync(join(tmpdir(), "renox-client-")));
  const built = readFileSync(out, "utf8");
  expect(readFileSync(ASSET, "utf8")).toBe(built);
  expect(Bun.gzipSync(new TextEncoder().encode(built)).length).toBeLessThanOrEqual(MAX_GZIP_BYTES);
  expect(built).not.toContain("sourceMappingURL");
  expect(() => new Function(built)).not.toThrow();
});

// #268: the debug id depends on the script only, never on where it was
// built: a short and a long output path give the same bytes, so the
// committed asset matches a build on any machine.
test("two builds in different directories are byte-identical, debug id included", async () => {
  const short = readFileSync(await build(mkdtempSync(join(tmpdir(), "c-"))), "utf8");
  const long = readFileSync(await build(mkdtempSync(join(tmpdir(), "renox-client-a-much-longer-directory-name-"))), "utf8");
  expect(long).toBe(short);
  expect(short).toMatch(/\/\/# debugId=[0-9A-F]{32}\n?$/u);
});

// The check keeps its point: another script (one byte of source changed
// and not rebuilt) has another id, so the committed asset no longer matches.
test("the debug id follows the script's bytes", () => {
  expect(debugIdOf("a();\n")).toBe(debugIdOf("a();\n//# debugId=0000\n"));
  expect(debugIdOf("a();\n")).not.toBe(debugIdOf("b();\n"));
});
