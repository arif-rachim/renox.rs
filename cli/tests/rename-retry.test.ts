// renameRetry (Windows: EPERM while a scanner holds a just-written file) and
// renox test's check that @renoxium/sdk is installed.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { requireSdkInstalled } from "../src/commands/test.ts";
import { EnvironmentError } from "../src/errors.ts";
import { removeRetry, renameRetry } from "../src/lib/rename.ts";

const root = mkdtempSync(join(tmpdir(), "renox-rename-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("a plain rename moves the folder", () => {
  const from = join(root, "a.tmp");
  mkdirSync(from);
  writeFileSync(join(from, "f"), "x");
  renameRetry(from, join(root, "a"));
  expect(readFileSync(join(root, "a", "f"), "utf8")).toBe("x");
  expect(existsSync(from)).toBe(false);
});

test("contentAddressed: a target that already exists is kept and the temporary folder removed", () => {
  const to = join(root, "hash1");
  mkdirSync(to);
  writeFileSync(join(to, "f"), "same");
  const from = join(root, "hash1.tmp");
  mkdirSync(from);
  writeFileSync(join(from, "f"), "same");
  renameRetry(from, to, { contentAddressed: true });
  expect(readFileSync(join(to, "f"), "utf8")).toBe("same");
  expect(existsSync(from)).toBe(false);
});

test("a missing source is not retried: ENOENT is thrown at once", () => {
  const t0 = performance.now();
  expect(() => renameRetry(join(root, "nope"), join(root, "nope2"))).toThrow();
  expect(performance.now() - t0).toBeLessThan(200);
});

test("renox test without bun install: names bun install", () => {
  const app = join(root, "app");
  mkdirSync(app);
  writeFileSync(join(app, "package.json"), JSON.stringify({ dependencies: { "@renoxium/sdk": "^0.1.6" } }));
  const missing = (): string => {
    throw new Error("Cannot find module");
  };
  let err: unknown;
  try {
    requireSdkInstalled(app, missing);
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(EnvironmentError);
  expect((err as EnvironmentError).hint).toContain("bun install");
  // Installed: no error.
  expect(() => requireSdkInstalled(app, () => "/x/package.json")).not.toThrow();
  // No dependency on the SDK, or no package.json: not checked.
  writeFileSync(join(app, "package.json"), JSON.stringify({}));
  expect(() => requireSdkInstalled(app, missing)).not.toThrow();
  expect(() => requireSdkInstalled(join(root, "none"), missing)).not.toThrow();
});

test("removeRetry removes a folder, and a missing path is fine", () => {
  const d = join(root, "gone");
  mkdirSync(join(d, "sub"), { recursive: true });
  writeFileSync(join(d, "sub", "f"), "x");
  removeRetry(d);
  expect(existsSync(d)).toBe(false);
  expect(() => removeRetry(join(root, "never-was"))).not.toThrow();
});
