// The npm packages of D30 (#440): `@renoxium/cli` (one bundled file for Bun)
// and `create-renox`, built by cli/scripts/pack-npm.ts into a temp directory.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PINNED_WORKER } from "../src/worker/verify.ts";

const CLI = join(import.meta.dir, "..");
const root = mkdtempSync(join(tmpdir(), "renox-npm-"));
const out = join(root, "npm");
const version = (JSON.parse(readFileSync(join(CLI, "package.json"), "utf8")) as { version: string }).version;
afterAll(() => rmSync(root, { recursive: true, force: true }));

// The environment of a user without a worker: nothing here may download or run one.
const env = { ...process.env, RENOX_WORKER_PATH: "", HOME: root, RENOX_RELEASE_BASE: "http://127.0.0.1:1" };

const run = (cmd: string[], cwd = root) => {
  const p = Bun.spawnSync(cmd, { cwd, env, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
};

interface Pkg {
  name: string;
  version: string;
  scripts?: unknown;
  bin: Record<string, string>;
  files: string[];
  engines: { bun: string };
  license: string;
  type: string;
  repository: unknown;
  homepage: string;
  dependencies?: Record<string, string>;
}
const pkg = (dir: string): Pkg => JSON.parse(readFileSync(join(out, dir, "package.json"), "utf8")) as Pkg;

beforeAll(() => {
  const p = run(["bun", join(CLI, "scripts/pack-npm.ts"), "--out", out]);
  expect(p.err).toBe("");
  expect(p.code).toBe(0);
  // How a user's node_modules resolves `@renoxium/cli` for create-renox.
  mkdirSync(join(out, "node_modules/@renoxium"), { recursive: true });
  symlinkSync(join(out, "cli"), join(out, "node_modules/@renoxium/cli"));
}, 120_000);

describe("package.json", () => {
  test("@renoxium/cli", () => {
    const p = pkg("cli");
    const sdk = JSON.parse(readFileSync(join(CLI, "..", "sdk/package.json"), "utf8")) as Pkg;
    expect(p.name).toBe("@renoxium/cli");
    expect(p.version).toBe(version);
    expect(p.license).toBe("Apache-2.0");
    expect(p.type).toBe("module");
    expect(p.bin).toEqual({ renox: "bin/renox.js" });
    expect(p.files).toEqual(["bin/", "README.md", "LICENSE"]);
    expect(p.engines).toEqual({ bun: ">=1.4.0" });
    expect(p.homepage).toBeTruthy();
    expect(p.repository).toBeTruthy();
    expect((p.repository as { url: string }).url).toBe((sdk.repository as { url: string }).url);
    expect("scripts" in p).toBe(false);
  });

  test("create-renox", () => {
    const p = pkg("create-renox");
    expect(p.name).toBe("create-renox");
    expect(p.version).toBe(version);
    expect(p.license).toBe("Apache-2.0");
    expect(p.bin).toEqual({ "create-renox": "bin/create-renox.js" });
    expect(p.files).toEqual(["bin/", "README.md", "LICENSE"]);
    expect(p.engines).toEqual({ bun: ">=1.4.0" });
    expect(p.dependencies).toEqual({ "@renoxium/cli": version });
    expect("scripts" in p).toBe(false);
  });

  test("both carry the README and the root LICENSE", () => {
    for (const d of ["cli", "create-renox"]) {
      expect(existsSync(join(out, d, "README.md"))).toBe(true);
      expect(readFileSync(join(out, d, "LICENSE"), "utf8")).toBe(readFileSync(join(CLI, "..", "LICENSE"), "utf8"));
    }
  });
});

describe("the bundle", () => {
  test("starts with the bun shebang, once, and is executable", () => {
    const file = join(out, "cli/bin/renox.js");
    const text = readFileSync(file, "utf8");
    expect(text.startsWith("#!/usr/bin/env bun\n")).toBe(true);
    expect(text.split("\n").filter((l) => l.startsWith("#!"))).toHaveLength(1);
    expect(statSync(file).mode & 0o111).not.toBe(0);
  });

  test("--version prints what the source prints", () => {
    const r = run(["bun", join(out, "cli/bin/renox.js"), "--version"]);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe(`renox ${version} (renox-worker ${PINNED_WORKER.version})`);
    expect(r.out).toBe(run(["bun", join(CLI, "src/main.ts"), "--version"]).out);
  });

  test("renox new creates an app", () => {
    const dir = mkdtempSync(join(root, "new-"));
    const r = run(["bun", join(out, "cli/bin/renox.js"), "new", "demo", "--template", "hello"], dir);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(existsSync(join(dir, "demo/renox.toml"))).toBe(true);
  });
});

describe("create-renox", () => {
  const bin = (): string => join(out, "create-renox/bin/create-renox.js");

  test("without an app name: usage, exit 2", () => {
    const r = run(["bun", bin()]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("usage: bun create renox <app> [--template <name>]");
  });

  test("runs renox new from @renoxium/cli", () => {
    const dir = mkdtempSync(join(root, "create-"));
    const r = run(["bun", bin(), "demo", "--template", "hello"], dir);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(existsSync(join(dir, "demo/renox.toml"))).toBe(true);
  });
});

describe("npm pack", () => {
  test.skipIf(!Bun.which("npm"))("lists only package.json, README.md, LICENSE and bin/", () => {
    for (const [d, bins] of [
      ["cli", ["bin/renox.js"]],
      ["create-renox", ["bin/create-renox.js"]],
    ] as const) {
      const r = run(["npm", "pack", "--dry-run", "--json"], join(out, d));
      expect(r.code).toBe(0);
      const files = (JSON.parse(r.out) as { files: { path: string }[] }[])[0]?.files.map((f) => f.path).sort();
      expect(files).toEqual(["LICENSE", "README.md", ...bins, "package.json"].sort());
    }
  });
});
