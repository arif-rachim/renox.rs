// `renox new` (#376, #377): the app it writes depends on the SDK at the CLI's
// own version, so a CLI release and the `@renoxium/sdk` package it scaffolds always
// match (docs/12-developer-experience.md, "Installing the CLI"); and every
// template gets the agent files `AGENTS.md`, `CLAUDE.md` and `.mcp.json`
// (docs/12, "Build with an AI agent").
import { afterAll, expect, test } from "bun:test";
import { type Dirent, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { CLI_VERSION, newApp } from "../src/commands/new.ts";

const scratch = mkdtempSync(join(tmpdir(), "renox-new-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

test("the new app depends on @renoxium/sdk at the CLI's version", () => {
  const packageVersion = (JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as { version: string }).version;
  expect(CLI_VERSION).toBe(packageVersion);
  expect(packageVersion).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/u);
  const dir = newApp("app", "blank", scratch);
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { dependencies: Record<string, string> };
  expect(pkg.dependencies).toEqual({ "@renoxium/sdk": `^${packageVersion}` });
});

test("every template writes AGENTS.md, CLAUDE.md and .mcp.json (snapshots)", () => {
  for (const template of ["blank", "hello"]) {
    const dir = newApp(`agents-${template}`, template, scratch);
    const read = (f: string) => readFileSync(join(dir, f), "utf8");
    expect(read("AGENTS.md")).toMatchSnapshot("AGENTS.md");
    expect(read("CLAUDE.md")).toMatchSnapshot("CLAUDE.md");
    expect(read(".mcp.json")).toMatchSnapshot(".mcp.json");
    // Claude Code and Cursor read this object; the server is the local one on the app folder.
    const mcp = JSON.parse(read(".mcp.json")) as { mcpServers: Record<string, { command: string; args: string[] }> };
    expect(mcp.mcpServers.renox).toEqual({ command: "renox", args: ["mcp", "--project", "."] });
    expect(read("CLAUDE.md")).toContain("Read `AGENTS.md` first");
    // The claims AGENTS.md makes about the CLI and the SDK, checked against this repository.
    const agents = read("AGENTS.md");
    for (const cmd of ["renox dev", "renox check", "renox test", "renox deploy", "renox add", "renox mcp --project ."]) expect(agents).toContain(cmd);
    for (const tool of ["dev_status", "dev_errors", "run_check", "run_tests", "search_docs", "authz_explain", "list_policies", "list_tools"]) expect(agents).toContain(tool);
    expect(agents).toContain("https://renoxium.com/llms.txt");
    // The template's own files are still there.
    expect(existsSync(join(dir, "renox.toml"))).toBe(true);
    expect(existsSync(join(dir, template === "hello" ? "functions/api/hello.ts" : "functions/api/health.ts"))).toBe(true);
  }
});

test("--template tutorial writes examples/tutorial/step-01, file for file (#430)", () => {
  const step01 = join(import.meta.dir, "../../examples/tutorial/step-01");
  const dir = newApp("board", "tutorial", scratch);
  const files = (root: string): string[] =>
    (readdirSync(root, { recursive: true, withFileTypes: true }) as Dirent[])
      .filter((d) => d.isFile())
      .map((d) => relative(root, join(d.parentPath, d.name)))
      .sort();
  expect(files(dir)).toEqual(files(step01));
  for (const f of files(step01)) {
    const want = readFileSync(join(step01, f), "utf8");
    const got = readFileSync(join(dir, f), "utf8");
    // The checkpoint pins the SDK of the CLI release it was written with; a new app pins this CLI's.
    if (f === "package.json") expect(got.replace(/"@renoxium\/sdk": "[^"]+"/u, "")).toBe(want.replace(/"@renoxium\/sdk": "[^"]+"/u, ""));
    else expect(got, f).toBe(want);
  }
});

test("--template home-services writes examples/home-services, and the new app passes renox check (#566)", async () => {
  const { EXAMPLE_DIR, templateFiles } = await import("../../examples/home-services/sync-template.ts");
  const dir = newApp("fixit", "home-services", scratch);
  const files = (readdirSync(dir, { recursive: true, withFileTypes: true }) as Dirent[])
    .filter((d) => d.isFile())
    .map((d) => relative(dir, join(d.parentPath, d.name)).split("\\").join("/"))
    .sort();
  // The example's files, plus what `renox new` writes for every app.
  const own = ["package.json", "tsconfig.json", ".gitignore", "AGENTS.md", "CLAUDE.md", ".mcp.json"];
  expect(files).toEqual([...templateFiles(), ...own].sort());
  for (const f of templateFiles()) {
    const want = readFileSync(join(EXAMPLE_DIR, f));
    const got = readFileSync(join(dir, f));
    // renox.toml carries the new app's name; every other file, binaries included, is the example's byte for byte.
    if (f === "renox.toml") expect(got.toString("utf8")).toBe(want.toString("utf8").replace('name = "home-services"', 'name = "fixit"'));
    else expect(got.equals(want), f).toBe(true);
  }
  expect(readFileSync(join(dir, "README.md"), "utf8")).toStartWith("# Home services");
  const worker = process.env.RENOX_WORKER_PATH;
  if (!worker) return;
  // What `bun install` would put in node_modules, then the check with types (it generates renox:modules from renox.lock).
  const { mkdirSync, symlinkSync } = await import("node:fs");
  const repo = join(import.meta.dir, "../..");
  mkdirSync(join(dir, "node_modules/@renoxium"), { recursive: true });
  symlinkSync(join(repo, "sdk"), join(dir, "node_modules/@renoxium/sdk"));
  for (const pkg of ["typescript", "bun-types"]) symlinkSync(join(repo, "node_modules", pkg), join(dir, "node_modules", pkg));
  const { check } = await import("../src/commands/check.ts");
  const report = await check(dir, { types: "include" });
  expect(report.errors.map((e) => e.message)).toEqual([]);
  expect(report.findings).toEqual([]);
}, 180_000);
