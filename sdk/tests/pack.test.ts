// The published shape of `@renoxium/sdk` (#376; docs/12-developer-experience.md,
// "Installing the CLI"): `npm pack` ships dist/ and nothing of the workspace,
// and a fresh `renox new` app outside the monorepo installs the tarball,
// type-checks against its declarations and runs a `bun test` with
// `@renoxium/sdk/fakes`. Everything here is offline: the tarball is a `file:`
// dependency, and tsc is the monorepo's own.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const sdk = resolve(import.meta.dir, "..");
const root = resolve(sdk, "..");
const cli = join(root, "cli", "src", "main.ts");
const tsc = join(root, "node_modules", ".bin", "tsc");
const version = (JSON.parse(readFileSync(join(sdk, "package.json"), "utf8")) as { version: string }).version;

/** A temporary directory outside the monorepo, so nothing resolves to the workspace. */
const scratch = mkdtempSync(join(tmpdir(), "renox-pack-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function run(cmd: string[], cwd: string): { code: number; out: string } {
  const r = Bun.spawnSync(cmd, {
    cwd,
    env: { ...process.env, PATH: `${resolve(process.execPath, "..")}:${process.env.PATH ?? ""}` },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: r.exitCode, out: `${r.stdout.toString()}\n${r.stderr.toString()}` };
}

describe("the published package (#376)", () => {
  let tarball = "";
  let files: string[] = [];

  test("npm pack ships dist/, README.md and LICENSE only: no src/, tests or node_modules", () => {
    expect(Bun.which("npm")).not.toBeNull();
    // `npm pack` runs `prepare` (bun run build), so the tarball holds a fresh build.
    const r = run(["npm", "pack", "--json", "--pack-destination", scratch], sdk);
    expect(r.code, r.out).toBe(0);
    const json = r.out.slice(r.out.indexOf("["), r.out.lastIndexOf("]") + 1);
    const [info] = JSON.parse(json) as { filename: string; files: { path: string }[] }[];
    expect(info).toBeDefined();
    tarball = join(scratch, info!.filename);
    expect(tarball.endsWith(`renoxium-sdk-${version}.tgz`)).toBe(true);
    expect(existsSync(tarball)).toBe(true);
    files = info!.files.map((f) => f.path).sort();
    const allowed = (p: string) => p === "package.json" || p === "README.md" || p === "LICENSE" || (p.startsWith("dist/") && /\.(js|d\.ts)$/u.test(p));
    expect(files.filter((p) => !allowed(p))).toEqual([]);
    expect(files).toContain("LICENSE");
    for (const sub of ["index", "kysely", "drizzle", "fakes", "test"]) {
      expect(files).toContain(`dist/${sub}.js`);
      expect(files).toContain(`dist/${sub}.d.ts`);
    }
    expect(files.some((p) => p.startsWith("src/") || p.startsWith("tests/") || p.includes("node_modules"))).toBe(false);
  });

  test("a renox new app outside the monorepo installs the tarball, type-checks and runs a test with @renoxium/sdk/fakes", () => {
    expect(tarball, "needs the tarball of the previous test").not.toBe("");
    // renox new, as a developer would run it (the CLI's `new` writes the app).
    const created = run(["bun", cli, "new", "app", "--template", "hello"], scratch);
    expect(created.code, created.out).toBe(0);
    const app = join(scratch, "app");
    // The app depends on the tarball instead of the registry: the same files a
    // `bun add @renoxium/sdk` would unpack.
    const pkg = JSON.parse(readFileSync(join(app, "package.json"), "utf8")) as { dependencies: Record<string, string> };
    expect(pkg.dependencies["@renoxium/sdk"]).toBe(`^${version}`);
    pkg.dependencies["@renoxium/sdk"] = `file:${tarball}`;
    writeFileSync(join(app, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
    const installed = run(["bun", "install"], app);
    expect(installed.code, installed.out).toBe(0);
    expect(existsSync(join(app, "node_modules", "@renoxium", "sdk", "dist", "index.d.ts"))).toBe(true);
    expect(existsSync(join(app, "node_modules", "@renoxium", "sdk", "src"))).toBe(false);

    // Type-check: the template's handler against `@renoxium/sdk`, and a module that
    // imports `@renoxium/sdk/fakes` (the declarations, not the workspace sources).
    mkdirSync(join(app, "lib"), { recursive: true });
    writeFileSync(
      join(app, "lib", "fakes-types.ts"),
      'import type { Ctx } from "@renoxium/sdk";\nimport { fakeStorage } from "@renoxium/sdk/fakes";\n\nexport const storage: Ctx["storage"] = fakeStorage("app");\nexport const files = fakeStorage("app").files.size;\n',
    );
    // tests/ needs bun-types, which a bare app does not install; tsc covers the app's own code.
    writeFileSync(join(app, "tsconfig.check.json"), JSON.stringify({ extends: "./tsconfig.json", exclude: ["node_modules", ".renox", "tests"] }, null, 2));
    const checked = run([tsc, "--noEmit", "-p", "tsconfig.check.json"], app);
    expect(checked.code, checked.out).toBe(0);

    // Run: `@renoxium/sdk/fakes` from the installed package under bun test.
    mkdirSync(join(app, "tests"), { recursive: true });
    writeFileSync(
      join(app, "tests", "fakes.test.ts"),
      [
        'import { expect, test } from "bun:test";',
        'import { fakeStorage } from "@renoxium/sdk/fakes";',
        "",
        'test("fakeStorage stores and lists a file", async () => {',
        '  const storage = fakeStorage("app");',
        '  const file = await storage.put("app/notes/a.txt", new TextEncoder().encode("hello"), { contentType: "text/plain" });',
        "  expect(file.bytes).toBe(5);",
        '  const page = await storage.list("app/notes/");',
        '  expect(page.items.map((f) => f.key)).toEqual(["app/notes/a.txt"]);',
        "  expect(storage.files.size).toBe(1);",
        "});",
        "",
      ].join("\n"),
    );
    const tested = run(["bun", "test", "tests/fakes.test.ts"], app);
    expect(tested.code, tested.out).toBe(0);
    expect(tested.out).toContain("1 pass");
  });
});
