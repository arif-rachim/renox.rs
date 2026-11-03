// The design system (packages/ui/README.md): the dashboard's copy of
// renox-ui.css equals the source, the layout loads it before app.css, and
// neither stylesheet uses a physical direction (the Arabic pages mirror
// through logical properties, #336) or loads anything from another origin.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { contrast, contrastFailures, loadsAnything, physicalLines } from "../../../packages/ui/lint.ts";

const read = (p: string) => readFileSync(join(import.meta.dir, "..", p), "utf8");
const bytes = (p: string) => readFileSync(join(import.meta.dir, "..", p));
const SOURCE = read("../../packages/ui/renox-ui.css");

test("public/renox-ui.css is packages/ui/renox-ui.css, unchanged", () => {
  expect(read("public/renox-ui.css")).toBe(SOURCE);
});

/** ADR D27: the one web font is self-hosted, subset, under 40 KB, with its licence beside it. */
test("the display font and its licence are the system's copies, and the font is within budget", () => {
  expect(bytes("public/doto-black.woff2")).toEqual(bytes("../../packages/ui/doto-black.woff2"));
  expect(read("public/doto-OFL.txt")).toBe(read("../../packages/ui/doto-OFL.txt"));
  expect(bytes("public/doto-black.woff2").byteLength).toBeLessThanOrEqual(40 * 1024);
  expect(read("public/doto-OFL.txt")).toContain("SIL Open Font License, Version 1.1");
  expect(SOURCE).toMatch(/src:\s*url\(\/doto-black\.woff2\)\s*format\("woff2"\)/u);
  expect(SOURCE).toContain("font-display: swap");
});

test("every text and ground pair of the tokens meets WCAG 2.2 AA, in light and in dark", () => {
  expect(contrastFailures(SOURCE)).toEqual([]);
  expect(contrast("#ffffff", "#000000")).toBeCloseTo(21, 0);
  const low = contrastFailures(":root { --rx-ink: #888888; --rx-paper: #999999; }");
  expect(low).toContain("light --rx-ink on --rx-paper: 1.24 < 4.5");
  expect(low).toContain("light --rx-muted on --rx-paper: token missing");
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
  expect(loadsAnything("a { background: url(//cdn.example/x.png) }")).toBe(true);
  expect(loadsAnything("@import 'x.css';")).toBe(true);
  // The one allowed load: a root-relative file of this origin (the display font, D27).
  expect(loadsAnything('@font-face { src: url(/doto-black.woff2) format("woff2"); }')).toBe(false);
});

test("no physical directions and no other origin in either stylesheet", () => {
  for (const css of [SOURCE, read("public/app.css")]) {
    expect(physicalLines(css)).toEqual([]);
    expect(loadsAnything(css)).toBe(false);
  }
});
