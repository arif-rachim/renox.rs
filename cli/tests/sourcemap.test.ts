// Source map decoding for stack symbolication in `renox dev` (gate note on #43).
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { decode, lookup, Symbolicator } from "../src/lib/sourcemap.ts";

test("a bundled module's stack frame maps back to the TypeScript line", async () => {
  const dir = mkdtempSync(join(tmpdir(), "renox-map-"));
  mkdirSync(join(dir, "pages"));
  const ts = 'type T = { a: number };\n\nexport function load(): T {\n  throw new Error("boom");\n}\n';
  writeFileSync(join(dir, "pages/x.ts"), ts);
  const r = await Bun.build({ entrypoints: [join(dir, "pages/x.ts")], root: dir, sourcemap: "external", target: "browser", format: "esm" });
  const out = r.outputs.find((o) => o.kind === "entry-point");
  const map = r.outputs.find((o) => o.kind === "sourcemap");
  if (!out || !map) throw new Error("no output");
  const js = await out.text();
  const line = js.split("\n").findIndex((l) => l.includes("throw new Error")) + 1;
  const col = (js.split("\n")[line - 1] ?? "").indexOf("throw") + 1;
  const decoded = decode(JSON.parse(await map.text()));
  expect(lookup(decoded, line, col)).toMatchObject({ line: 4 });
  const maps = join(dir, "maps");
  mkdirSync(join(maps, "pages"), { recursive: true });
  writeFileSync(join(maps, "pages/x.js.map"), await map.text());
  const s = new Symbolicator(() => maps);
  expect(s.stack(`Error: boom\n    at load (file:///pages/x.js:${line}:${col})`)).toMatch(/at load \(.*x\.ts:4:\d+\)/u);
  expect(s.stack("at f (file:///pages/none.js:1:1)")).toBe("at f (file:///pages/none.js:1:1)");
});
