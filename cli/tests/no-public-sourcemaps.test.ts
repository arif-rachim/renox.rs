// `renox check` fails when a source map is under public/ (#128): public/ is
// served from the app's origin, source maps are private (deploy-api.md
// section 4). Proves docs/24-threat-model.md B, "Secrets in logs, errors,
// bundle, responses" for the one file type that holds the sources.
import { expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { noPublicSourcemaps } from "../src/check/no-public-sourcemaps.ts";
import { check } from "../src/commands/check.ts";

const repo = join(import.meta.dir, "../..");

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "renox-pubmap-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

test("a .map anywhere under public/ is an error naming the file", () => {
  const dir = project({ "public/app.js": "x", "public/app.js.map": "{}", "public/islands/cart.js.map": "{}", "public/styles.css.map": "{}" });
  const found = noPublicSourcemaps(dir);
  expect(found.map((f) => f.file)).toEqual(["public/app.js.map", "public/islands/cart.js.map", "public/styles.css.map"]);
  expect(found.every((f) => f.rule === "public-sourcemap" && f.severity === "error")).toBe(true);
  expect(found[0]?.message).toContain("renox deploy");
});

test("no public/ folder, or no .map in it, is clean; a .map elsewhere is not this rule's business", () => {
  expect(noPublicSourcemaps(project({ "functions/x.ts": "" }))).toEqual([]);
  expect(noPublicSourcemaps(project({ "public/app.js": "x", "public/notes.map.txt": "x", "src/a.js.map": "{}" }))).toEqual([]);
});

test("a symbolic link is not followed", () => {
  const dir = project({ "public/a.js": "x", "outside/b.js.map": "{}" });
  symlinkSync(join(dir, "outside"), join(dir, "public/link"));
  expect(noPublicSourcemaps(dir)).toEqual([]);
});

test("renox check reports it and exits with the validation code", async () => {
  const dir = mkdtempSync(join(tmpdir(), "renox-pubmap-hello-"));
  cpSync(join(repo, "examples/hello"), dir, { recursive: true, filter: (src) => !src.includes("node_modules") && !src.includes("_spike") && !src.includes(".renox") });
  mkdirSync(join(dir, "public"), { recursive: true });
  writeFileSync(join(dir, "public/app.js.map"), "{}");
  const { findings } = await check(dir, {});
  expect(findings.filter((f) => f.rule === "public-sourcemap").map((f) => [f.file, f.severity])).toEqual([["public/app.js.map", "error"]]);
});
