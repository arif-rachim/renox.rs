// `renox mcp` (#48): the local platform MCP server. The protocol checks go
// through the official MCP TypeScript SDK client, which validates every
// response against the MCP schemas (the same client the MCP Inspector uses);
// the Inspector CLI run itself is opt-in (RENOX_MCP_INSPECTOR, below).
//
// docs/24-threat-model.md, agents rows (prompt injection through tool
// input): the tools run fixed operations only; model input never becomes a
// shell command or a file path (run_tests filter, resources/read URIs).
// docs/20-ai-agents-mcp.md, "Security of the platform MCP": secrets are never
// readable through MCP (.env values are redacted from tool output).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { DOCS, searchDocs } from "../src/mcp/docs.ts";
import { clearDevState, type DevState, problemFromMessage, writeDevState } from "../src/mcp/devstate.ts";
import { createServer, INVALID_REQUEST, METHOD_NOT_FOUND, PROTOCOL_VERSIONS } from "../src/mcp/server.ts";

const CLI = join(import.meta.dir, "..");
const MAIN = join(CLI, "src", "main.ts");
const DOCS_DIR = join(CLI, "..", "docs");

let tmp: string;
let project: string;
let client: Client;

const text = (r: unknown): string => ((r as { content: { text: string }[] }).content[0] as { text: string }).text;
const structured = <T = Record<string, unknown>>(r: unknown): T => (r as { structuredContent: T }).structuredContent;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "renox-mcp-"));
  project = join(tmp, "app");
  cpSync(join(CLI, "tests", "fixtures", "full"), project, { recursive: true });
  writeFileSync(join(project, ".env"), "API_TOKEN=sk_test_0123456789abcdef\nSHORT=abc\n");
  client = new Client({ name: "renox-test", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: [MAIN, "mcp", "--project", project], stderr: "ignore" }),
  );
});

afterAll(async () => {
  await client.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("protocol", () => {
  test("initialize negotiates the newest version and advertises tools and resources only", () => {
    expect(client.getServerVersion()).toMatchObject({ name: "renox", version: "0.1.0" });
    const caps = client.getServerCapabilities();
    expect(caps?.tools).toBeDefined();
    expect(caps?.resources).toMatchObject({ subscribe: false });
    expect(caps?.prompts).toBeUndefined();
    expect(client.getInstructions()).toContain("docs://00-overview.md");
  });

  test("an older client version is echoed; an unknown one gets the newest", async () => {
    const s = createServer(project);
    const init = async (v: string) =>
      ((await s.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: v, capabilities: {} } })) as {
        result: { protocolVersion: string };
      }).result.protocolVersion;
    expect(await init("2025-03-26")).toBe("2025-03-26");
    expect(await init("1999-01-01")).toBe(PROTOCOL_VERSIONS[0]);
  });

  test("ping, notifications, malformed messages, and calls before initialize", async () => {
    const s = createServer(project);
    expect(await s.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" })).toMatchObject({ error: { code: INVALID_REQUEST } });
    expect(await s.handle({ jsonrpc: "2.0", id: 2, method: "ping" })).toEqual({ jsonrpc: "2.0", id: 2, result: {} });
    expect(await s.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    expect(await s.handle({ id: 3, method: "ping" })).toMatchObject({ id: 3, error: { code: INVALID_REQUEST } });
    expect(await s.handle([{ jsonrpc: "2.0", id: 4, method: "ping" }])).toMatchObject({ error: { code: INVALID_REQUEST } });
    await s.handle({ jsonrpc: "2.0", id: 5, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    expect(await s.handle({ jsonrpc: "2.0", id: 6, method: "prompts/list" })).toMatchObject({ error: { code: METHOD_NOT_FOUND } });
  });

  test("a line that is not JSON gets a parse error and the server keeps serving", async () => {
    const proc = Bun.spawn([process.execPath, MAIN, "mcp", "--project", project], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    proc.stdin.write("{nope\n");
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })}\n`);
    await proc.stdin.end();
    const lines = (await new Response(proc.stdout).text()).trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toEqual([
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } },
      { jsonrpc: "2.0", id: 1, result: {} },
    ]);
    expect(await proc.exited).toBe(0);
  });
});

describe("tools", () => {
  test("the F2 tool set, each with an object input schema", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["dev_status", "dev_errors", "run_check", "run_tests", "search_docs"]);
    for (const t of tools) expect(t.inputSchema.type).toBe("object");
  });

  test("run_check returns structured problems with file, line, and code", async () => {
    const r = await client.callTool({ name: "run_check", arguments: {} });
    expect(r.isError).toBe(false);
    const s = structured<{ ok: boolean; problems: { code: string; file: string; line: number }[] }>(r);
    expect(s.ok).toBe(false);
    expect(s.problems).toContainEqual(expect.objectContaining({ code: "sql-interpolation", file: "functions/api/unsafe.ts", line: 4 }));
    expect(JSON.parse(text(r))).toEqual(s);
  });

  test("search_docs finds a rule with its document and line", async () => {
    const r = await client.callTool({ name: "search_docs", arguments: { query: "global scope", limit: 3 } });
    const s = structured<{ hits: { uri: string; line: number; snippet: string }[] }>(r);
    expect(s.hits.length).toBeGreaterThan(0);
    for (const h of s.hits) expect(h.snippet.toLowerCase()).toContain("global");
    expect(s.hits.map((h) => h.uri)).toContain("docs://07-app-model.md");
    expect(searchDocs("x")).toEqual([]);
  });

  test("dev_status and dev_errors read .renox/dev.json of a live renox dev only; secrets are redacted", async () => {
    const off = await client.callTool({ name: "dev_status", arguments: {} });
    expect(structured(off)).toMatchObject({ running: false });
    mkdirSync(join(project, ".renox", "logs"), { recursive: true });
    const problem = problemFromMessage("build", "functions/api/items.ts:3:7: Expected \";\" but found \"x\"");
    writeDevState(project, {
      pid: process.pid,
      port: 8787,
      url: "http://localhost:8787",
      startedAt: "2026-10-28T00:00:00.000Z",
      artifact: "a".repeat(64),
      routes: 2,
      lastBuild: { ok: false, at: "2026-10-28T00:00:01.000Z", ms: 12, problems: [problem] },
      workerRestarts: 0,
    });
    writeFileSync(
      join(project, ".renox", "logs", "tenant.ndjson"),
      `${[
        { level: "info", message: "fine" },
        { level: "error", message: "charge failed for sk_test_0123456789abcdef", request_id: "r1" },
      ]
        .map((l) => JSON.stringify(l))
        .join("\n")}\n`,
    );
    // A browser event renox dev recorded (#127), and a CSP report the worker logged.
    writeFileSync(
      join(project, ".renox", "logs", "browser.ndjson"),
      `${JSON.stringify({ ts: "2026-10-28T00:00:02.000Z", level: "error", request_id: "r1", message: "js.error: TypeError: cart is undefined", fields: { source: "client", kind: "js.error", url: "/products/42", code: null, detail: { message: "TypeError: cart is undefined", source: "/products/42", line: 7, column: 5, stack: [] } } })}\n`,
    );
    const on = structured(await client.callTool({ name: "dev_status", arguments: {} }));
    expect(on).toMatchObject({ running: true, url: "http://localhost:8787", lastBuild: { ok: false, problems: 1 } });
    const errs = await client.callTool({ name: "dev_errors", arguments: {} });
    expect(structured(errs)).toEqual({
      running: true,
      build: { ok: false, at: "2026-10-28T00:00:01.000Z", problems: [{ code: "build", file: "functions/api/items.ts", line: 3, column: 7, message: 'Expected ";" but found "x"' }] },
      logErrors: [{ message: "charge failed for [redacted]", request_id: "r1" }],
      browserErrors: [
        {
          kind: "js.error",
          message: "js.error: TypeError: cart is undefined",
          request_id: "r1",
          url: "/products/42",
          code: null,
          detail: { message: "TypeError: cart is undefined", source: "/products/42", line: 7, column: 5, stack: [] },
          at: "2026-10-28T00:00:02.000Z",
        },
      ],
    });
    expect(text(errs)).not.toContain("sk_test_0123456789abcdef");
    // A stale file from a dead process reads as not running.
    writeDevState(project, { ...(JSON.parse(readFileSync(join(project, ".renox", "dev.json"), "utf8")) as DevState), pid: 2 ** 22 + 12345 });
    expect(structured(await client.callTool({ name: "dev_status", arguments: {} }))).toMatchObject({ running: false });
    clearDevState(project);
  });

  test("run_tests runs bun test in the project with a fixed argv and reports counts", async () => {
    mkdirSync(join(project, "tests"), { recursive: true });
    writeFileSync(
      join(project, "tests", "a.test.ts"),
      'import { test, expect } from "bun:test";\ntest("adds", () => expect(1 + 1).toBe(2));\ntest("prints the token", () => { console.log(process.env.LEAK ?? "sk_test_0123456789abcdef"); });\ntest("fails", () => expect(1).toBe(2));\n',
    );
    const all = structured<{ ok: boolean; pass: number; fail: number; output: string }>(await client.callTool({ name: "run_tests", arguments: {} }));
    expect(all).toMatchObject({ ok: false, pass: 2, fail: 1 });
    expect(all.output).not.toContain("sk_test_0123456789abcdef");
    const one = structured(await client.callTool({ name: "run_tests", arguments: { filter: "adds" } }));
    expect(one).toMatchObject({ ok: true, pass: 1, fail: 0 });
  }, 60_000);

  test("model input never reaches a shell: a filter outside the allowlist is refused and nothing runs", async () => {
    const marker = join(project, "pwned");
    for (const filter of [`$(touch ${marker})`, "a; touch pwned", "`touch pwned`", "x\ny", "a".repeat(101)]) {
      const r = await client.callTool({ name: "run_tests", arguments: { filter } });
      expect(r.isError).toBe(true);
      expect(structured(r)).toMatchObject({ error: { code: "invalid_input" } });
    }
    expect(existsSync(marker)).toBe(false);
    const extra = await client.callTool({ name: "run_check", arguments: { cmd: "rm -rf /" } });
    expect(structured(extra)).toEqual({ error: { code: "invalid_input", message: "unknown argument: cmd" } });
    await expect(client.callTool({ name: "shell", arguments: { cmd: "id" } })).rejects.toThrow(/unknown tool: shell/u);
  });
});

describe("resources", () => {
  test("every docs/*.md and docs/contracts/*.md is a docs:// resource, embedded byte for byte", async () => {
    const onDisk = [
      ...readdirSync(DOCS_DIR).filter((f) => f.endsWith(".md")),
      ...readdirSync(join(DOCS_DIR, "contracts"))
        .filter((f) => f.endsWith(".md"))
        .map((f) => `contracts/${f}`),
    ].sort();
    expect(Object.keys(DOCS).sort()).toEqual(onDisk);
    const { resources } = await client.listResources();
    expect(resources.filter((r) => r.uri.startsWith("docs://")).map((r) => r.uri.slice(7)).sort()).toEqual(onDisk);
    for (const path of ["00-overview.md", "contracts/ops.md"]) {
      const { contents } = await client.readResource({ uri: `docs://${path}` });
      expect(contents[0]).toEqual({ uri: `docs://${path}`, mimeType: "text/markdown", text: readFileSync(join(DOCS_DIR, path), "utf8") });
    }
  });

  test("config://effective, routes://, and the ctx types", async () => {
    const config = JSON.parse(((await client.readResource({ uri: "config://effective" })).contents[0] as { text: string }).text);
    expect(config).toMatchObject({ ok: true, config: { app: { name: "full" } } });
    const routes = JSON.parse(((await client.readResource({ uri: "routes://" })).contents[0] as { text: string }).text);
    expect(routes.ok).toBe(true);
    expect(routes.conflicts).toEqual([]);
    expect(routes.routes.map((r: { method: string; path: string }) => `${r.method} ${r.path}`)).toContain("GET /api/items");
    const types = (await client.readResource({ uri: "types://renox/ctx.d.ts" })).contents[0] as { text: string };
    expect(types.text).toContain("export interface LoaderContext");
    expect((await client.listResourceTemplates()).resourceTemplates).toEqual([]);
  });

  test("an unknown URI, including a path traversal, is resource-not-found and never touches the file system", async () => {
    for (const uri of ["docs://../../package.json", "docs:///etc/passwd", "docs://__proto__", "file:///etc/passwd", "routes://x"])
      await expect(client.readResource({ uri })).rejects.toThrow(/resource not found/u);
  });

  test("a broken renox.toml is reported in the resource, not as a protocol error", async () => {
    const broken = join(tmp, "broken");
    mkdirSync(broken);
    writeFileSync(join(broken, "renox.toml"), "[app\n");
    const s = createServer(broken);
    await s.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    const r = (await s.handle({ jsonrpc: "2.0", id: 2, method: "resources/read", params: { uri: "config://effective" } })) as {
      result: { contents: { text: string }[] };
    };
    expect(JSON.parse((r.result.contents[0] as { text: string }).text)).toMatchObject({ ok: false, problems: [{ code: "config" }] });
  });
});

test("the compiled binary carries the docs (it does not ship docs/)", async () => {
  const bin = join(tmp, "renox");
  const build = Bun.spawnSync(["bun", "build", "--compile", MAIN, "--outfile", bin], { cwd: CLI, stdout: "ignore", stderr: "pipe" });
  expect(build.exitCode).toBe(0);
  const empty = join(tmp, "elsewhere");
  mkdirSync(empty);
  const c = new Client({ name: "renox-test", version: "0.0.0" });
  await c.connect(new StdioClientTransport({ command: bin, args: ["mcp"], cwd: empty, stderr: "ignore" }));
  const { contents } = await c.readResource({ uri: "docs://13-decisions.md" });
  expect((contents[0] as { text: string }).text).toBe(readFileSync(join(DOCS_DIR, "13-decisions.md"), "utf8"));
  await c.close();
}, 60_000);

/** The MCP Inspector's CLI mode against the server (opt-in: RENOX_MCP_INSPECTOR=<path to mcp-inspector>). */
test.skipIf(!process.env.RENOX_MCP_INSPECTOR)("MCP Inspector CLI: tools/list, tools/call, resources/list, resources/read", () => {
  const inspector = process.env.RENOX_MCP_INSPECTOR as string;
  const run = (...args: string[]): unknown => {
    const r = Bun.spawnSync([inspector, "--cli", process.execPath, MAIN, "mcp", "--project", project, ...args], { stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode).toBe(0);
    return JSON.parse(r.stdout.toString());
  };
  expect((run("--method", "tools/list") as { tools: unknown[] }).tools).toHaveLength(5);
  for (const tool of ["dev_status", "dev_errors", "run_check"])
    expect(run("--method", "tools/call", "--tool-name", tool)).toMatchObject({ isError: false });
  expect(run("--method", "tools/call", "--tool-name", "search_docs", "--tool-arg", "query=csrf")).toMatchObject({ isError: false });
  const { resources } = run("--method", "resources/list") as { resources: { uri: string }[] };
  for (const { uri } of resources) expect((run("--method", "resources/read", "--uri", uri) as { contents: unknown[] }).contents).toHaveLength(1);
}, 300_000);
