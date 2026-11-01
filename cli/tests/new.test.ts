// `renox new` (#376): the app it writes depends on the SDK at the CLI's own
// version, so a CLI release and the `renox` package it scaffolds always match
// (docs/12-developer-experience.md, "Installing the CLI").
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CLI_VERSION, newApp } from "../src/commands/new.ts";

const scratch = mkdtempSync(join(tmpdir(), "renox-new-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

test("the new app depends on renox at the CLI's version", () => {
  const packageVersion = (JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as { version: string }).version;
  expect(CLI_VERSION).toBe(packageVersion);
  expect(packageVersion).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/u);
  const dir = newApp("app", "blank", scratch);
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { dependencies: Record<string, string> };
  expect(pkg.dependencies).toEqual({ renox: `^${packageVersion}` });
});
