// The design system (packages/ui/README.md): the dashboard's copy of
// renox-ui.css equals the source, the layout loads it before app.css, and
// neither stylesheet uses a physical direction (the Arabic pages mirror
// through logical properties, #336) or loads anything from another origin.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { loadsAnything, physicalLines } from "../../../packages/ui/lint.ts";

const read = (p: string) => readFileSync(join(import.meta.dir, "..", p), "utf8");
const SOURCE = read("../../packages/ui/renox-ui.css");

test("public/renox-ui.css is packages/ui/renox-ui.css, unchanged", () => {
  expect(read("public/renox-ui.css")).toBe(SOURCE);
});

test("the layout loads the design system first, then the dashboard's layer", () => {
  const layout = read("pages/_layouts/main.html");
  const ui = layout.indexOf('href="/renox-ui.css"');
  expect(ui).toBeGreaterThan(-1);
  expect(layout.indexOf('href="/app.css"')).toBeGreaterThan(ui);
});

test("the lint finds what it must refuse", () => {
  expect(physicalLines("a { margin-left: 1px; }\n.b{ left: 0 }\n.c { width: 2px }\n.d { text-align: right }")).toHaveLength(4);
  expect(physicalLines("a { margin-inline-start: 1px; inline-size: 2px; inset-inline-start: 0 }\n@media (max-width: 40rem) {")).toEqual([]);
  expect(loadsAnything("a { background: url(x.png) }")).toBe(true);
});

test("no physical directions and no other origin in either stylesheet", () => {
  for (const css of [SOURCE, read("public/app.css")]) {
    expect(physicalLines(css)).toEqual([]);
    expect(loadsAnything(css)).toBe(false);
  }
});
