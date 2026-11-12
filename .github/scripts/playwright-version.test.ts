// One pinned Playwright version for every workflow that installs Chromium
// (lighthouse.yml, journey.yml; #586): a bump changes them together.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(import.meta.dir, "../workflows");

test("every workflow that installs Playwright pins the same version", () => {
  const pins = new Map<string, string>();
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".yml"))) {
    const text = readFileSync(join(dir, f), "utf8");
    const m = /^\s*PLAYWRIGHT_VERSION:\s*"?([0-9]+\.[0-9]+\.[0-9]+)"?\s*$/mu.exec(text);
    if (m) pins.set(f, m[1]!);
    else expect(text).not.toContain("playwright@");
  }
  expect([...pins.keys()].sort()).toEqual(["journey.yml", "lighthouse.yml"]);
  expect(new Set(pins.values()).size).toBe(1);
});
