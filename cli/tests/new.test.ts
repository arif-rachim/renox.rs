// `renox new` (#376, #377): the app it writes depends on the SDK at the CLI's
// own version, so a CLI release and the `renox` package it scaffolds always
// match (docs/12-developer-experience.md, "Installing the CLI"); and every
// template gets the agent files `AGENTS.md`, `CLAUDE.md` and `.mcp.json`
// (docs/12, "Build with an AI agent").
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
