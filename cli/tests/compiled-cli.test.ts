// The compiled `renox` (#448): `renox test` runs the real `bun` and refuses
// to run inside another `renox test` (the 0.1.1 binary spawned itself without
// end), the official modules come from the copy embedded in the binary and
// are checked against their digest, and `renox add` of an official module
// offers its missing official dependencies in the same approval prompt.

import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { addModule } from "../src/commands/add.ts";
import { bunBinary, harnessFile, refuseNested } from "../src/commands/test.ts";
import type { Embedded } from "../src/lib/embedded.ts";
import { readTree } from "../src/lib/hash.ts";
import { readLock } from "../src/lib/modules/lock.ts";
import { extractModules, modulesDigest, officialModulesDir, REPO_MODULES } from "../src/lib/modules/official.ts";
import { EXIT } from "../src/errors.ts";

test("renox test runs `bun` from PATH; without it, exit 3 with the install hint", () => {
  expect(bunBinary(() => "/usr/local/bin/bun", "/home/u/.renox/bin/renox")).toBe("/usr/local/bin/bun");
  const e = (() => {
    try {
      bunBinary(() => null, "/home/u/.renox/bin/renox");
    } catch (x) {
      return x as { exitCode: number; message: string; hint?: string };
    }
  })();
  expect(e?.exitCode).toBe(EXIT.ENVIRONMENT);
  expect(e?.message).toContain("`bun` is not on PATH");
  expect(e?.hint).toContain("bun.sh/install");
  // A `bun` on PATH that is this very renox binary would loop: refused.
  expect(() => bunBinary(() => "/opt/renox", "/opt/renox")).toThrow("is this renox binary");
});

test("a renox test started inside another one refuses to start (exit 3)", () => {
  expect(() => refuseNested({})).not.toThrow();
  expect(() => refuseNested({ RENOX_TEST_DEPTH: "1" })).toThrow("refusing to run tests recursively");
});

test("from source the harness is the source file; a compiled CLI writes its bundle next to the spec", () => {
  expect(harnessFile("/nowhere", null)).toEndWith("src/lib/test-harness.ts");
  const dir = mkdtempSync(join(tmpdir(), "renox-harness-"));
  const file = harnessFile(join(dir, "t"), { version: "x", modulesDigest: "", modules: {}, harness: "export const SERVICE_PATH = '/x';\n" });
  expect(readFileSync(file, "utf8")).toContain("SERVICE_PATH");
  rmSync(dir, { recursive: true });
});

/** The embedded form of the repository's modules, as scripts/compile.ts writes it. */
function embeddedModules(): Embedded {
  const files = readTree(REPO_MODULES);
  return { version: "test", modulesDigest: modulesDigest(files), modules: Object.fromEntries([...files].map(([p, b]) => [p, Buffer.from(b).toString("base64")])), harness: "" };
}

test("the embedded modules are extracted once, checked against their digest, and extracted again when changed", () => {
  const e = embeddedModules();
  const cache = mkdtempSync(join(tmpdir(), "renox-official-"));
  const dir = extractModules(e, cache);
  expect(existsSync(join(dir, "auth", "module.toml"))).toBe(true);
  expect(modulesDigest(readTree(REPO_MODULES))).toBe(e.modulesDigest);
  // A tampered copy is replaced on the next use.
  writeFileSync(join(dir, "auth", "module.toml"), "[module]\nname = \"evil\"\n");
  const again = extractModules(e, cache);
  expect(readFileSync(join(again, "auth", "module.toml"), "utf8")).toBe(readFileSync(join(REPO_MODULES, "auth", "module.toml"), "utf8"));
  // A copy that does not match its digest is refused before anything is resolved.
  expect(() => extractModules({ ...e, modulesDigest: "0".repeat(64) }, mkdtempSync(join(tmpdir(), "renox-official-")))).toThrow("do not match their digest");
  const xdg = mkdtempSync(join(tmpdir(), "renox-xdg-"));
  expect(officialModulesDir({ XDG_CACHE_HOME: xdg }, e)).toStartWith(join(xdg, "renox", "modules"));
  rmSync(xdg, { recursive: true });
  expect(officialModulesDir({ RENOX_OFFICIAL_MODULES: "/x" }, e)).toBe("/x");
  expect(officialModulesDir({}, null)).toBe(REPO_MODULES);
  rmSync(cache, { recursive: true });
});

test("renox add org (official) offers auth and i18n in the same prompt and installs all three", async () => {
  const dir = mkdtempSync(join(tmpdir(), "renox-add-deps-"));
  writeFileSync(join(dir, "renox.toml"), '[app]\nname = "deps"\ntimezone = "Asia/Dubai"\n');
  let asked = "";
  const lines: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => lines.push(a.join(" "));
  try {
    const code = await addModule(dir, "org", {}, async (q) => {
      asked = q;
      return true;
    });
    expect(code).toBe(EXIT.OK);
  } finally {
    console.log = log;
  }
  const deps = Object.keys((Bun.TOML.parse(readFileSync(join(REPO_MODULES, "org", "module.toml"), "utf8")) as { dependencies?: Record<string, string> }).dependencies ?? {});
  expect(deps).toContain("auth");
  expect(asked).toStartWith("Approve and install org and ");
  for (const d of deps) expect(asked).toContain(d);
  expect(lines.join("\n")).toContain("org needs auth, which is not installed; it is installed with it:");
  const toml = readFileSync(join(dir, "renox.toml"), "utf8");
  for (const d of ["org", ...deps]) expect(toml).toMatch(new RegExp(`^${d} = `, "mu"));
  expect((readLock(dir).entries ?? []).map((e) => e.name).sort()).toEqual(["org", ...deps].sort().filter((n, i, a) => a.indexOf(n) === i));
  rmSync(dir, { recursive: true });
});

test("declining the prompt writes nothing, the dependencies included", async () => {
  const dir = mkdtempSync(join(tmpdir(), "renox-add-deps-"));
  const toml = '[app]\nname = "deps"\ntimezone = "Asia/Dubai"\n';
  writeFileSync(join(dir, "renox.toml"), toml);
  const log = console.log;
  console.log = () => {};
  try {
    expect(await addModule(dir, "org", {}, async () => false)).toBe(EXIT.USER);
  } finally {
    console.log = log;
  }
  expect(readFileSync(join(dir, "renox.toml"), "utf8")).toBe(toml);
  expect(existsSync(join(dir, "renox.lock"))).toBe(false);
  rmSync(dir, { recursive: true });
});

test("a module outside the app resolves the app's @renoxium/sdk through the package's exports (where Bun.resolveSync cannot)", async () => {
  const { fromExports } = await import("../src/lib/build.ts");
  const app = mkdtempSync(join(tmpdir(), "renox-sdk-exports-"));
  const pkg = join(app, "node_modules", "@renoxium", "sdk");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(pkg, "dist"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@renoxium/sdk", exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" }, "./test": { default: "./dist/test.js" } } }));
  writeFileSync(join(pkg, "dist", "index.js"), "export {};\n");
  writeFileSync(join(pkg, "dist", "test.js"), "export {};\n");
  mkdirSync(join(app, "functions", "api"), { recursive: true });
  expect(fromExports("@renoxium/sdk", app)).toBe(join(pkg, "dist", "index.js"));
  expect(fromExports("@renoxium/sdk/test", join(app, "functions", "api"))).toBe(join(pkg, "dist", "test.js"));
  expect(fromExports("@renoxium/sdk/kysely", app)).toBeNull();
  expect(fromExports("@renoxium/sdk", tmpdir())).toBeNull();
  rmSync(app, { recursive: true });
});
