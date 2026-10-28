// MCP tools of the local platform server, F2 set (docs/20-ai-agents-mcp.md,
// sections 1 and 6): dev_status, dev_errors, run_check, run_tests,
// search_docs. Each is a fixed operation on the project folder the server
// was started in. Model input never becomes a shell command or a path:
// run_tests spawns `bun test` with a fixed argv (no shell), and its only
// input, a test-name filter, is checked against a character allowlist and
// passed as one argument.

import { existsSync, openSync, readFileSync, readSync, closeSync, statSync } from "node:fs";
import { join } from "node:path";

import { check } from "../commands/check.ts";
import { parseDotenv } from "../commands/dev.ts";
import { type Problem, problemFromMessage, problemOf, readDevState } from "./devstate.ts";
import { searchDocs } from "./docs.ts";

type JsonSchema = Record<string, unknown>;

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
}

export interface ToolResult {
  content: { type: "text"; text: string }[];
  structuredContent: Record<string, unknown>;
  isError: boolean;
}

export class ToolInputError extends Error {}

const noInput: JsonSchema = { type: "object", properties: {}, additionalProperties: false };
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export const TOOLS: ToolDef[] = [
  {
    name: "dev_status",
    title: "renox dev status",
    description: "Whether `renox dev` is running for this project; its URL, current artifact hash, route count, last build result, and worker restarts.",
    inputSchema: noInput,
    annotations: readOnly,
  },
  {
    name: "dev_errors",
    title: "renox dev errors",
    description:
      "The problems a developer would see from `renox dev`: the last build's problems ({code, message, file, line, column, hint}) and the latest error lines of the tenant log.",
    inputSchema: noInput,
    annotations: readOnly,
  },
  {
    name: "run_check",
    title: "renox check",
    description:
      "Runs `renox check` on the project: renox.toml schema, routes and route conflicts, manifest, SQL interpolation, undeclared fetch hosts, global-state writes. Returns structured problems.",
    inputSchema: noInput,
    annotations: readOnly,
  },
  {
    name: "run_tests",
    title: "Run the project's tests",
    description:
      "Runs `bun test` in the project folder (fixed command, no shell; 120 s timeout) and returns the pass/fail counts and the end of the output. `filter` is passed to --test-name-pattern.",
    inputSchema: {
      type: "object",
      properties: {
        filter: {
          type: "string",
          description: "Only run tests whose name matches; letters, digits, space, and _ . : / - only, at most 100 characters",
          pattern: "^[A-Za-z0-9 _.:/-]{1,100}$",
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "search_docs",
    title: "Search the Renox docs",
    description: "Full-text search over the Renox documentation (the docs:// resources). Returns matching lines with their document, section, and line number.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 2, maxLength: 200, description: "Words that must all appear on the line" },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "Maximum hits (default 10)" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: readOnly,
  },
];

const FILTER = /^[A-Za-z0-9 _.:/-]{1,100}$/u;
const TEST_TIMEOUT_MS = 120_000;
const OUTPUT_LIMIT = 32 * 1024;
const LOG_ERRORS = 20;

/** Values from the project's `.env` (8 bytes or longer) are replaced in tool output: secrets never reach the model. */
export function redactor(project: string): (text: string) => string {
  const env = join(project, ".env");
  const values = existsSync(env)
    ? Object.values(parseDotenv(readFileSync(env, "utf8")))
        .filter((v) => v.length >= 8)
        .sort((a, b) => b.length - a.length)
    : [];
  return (text) => values.reduce((t, v) => t.split(v).join("[redacted]"), text);
}

/** `value` with every string passed through `redact`. */
function redactDeep(value: unknown, redact: (s: string) => string): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, redact));
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v, redact)]));
  return value;
}

function onlyKeys(args: Record<string, unknown>, allowed: string[]): void {
  const extra = Object.keys(args).filter((k) => !allowed.includes(k));
  if (extra.length) throw new ToolInputError(`unknown argument${extra.length > 1 ? "s" : ""}: ${extra.join(", ")}`);
}

/** The last `bytes` of a file. */
function tail(path: string, bytes: number): string {
  const size = statSync(path).size;
  const n = Math.min(size, bytes);
  const buf = Buffer.alloc(n);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buf, 0, n, size - n);
  } finally {
    closeSync(fd);
  }
  return buf.toString("utf8");
}

async function devStatus(project: string): Promise<Record<string, unknown>> {
  const s = readDevState(project);
  if (!s) return { running: false, hint: "start it with `renox dev` in the project folder" };
  return {
    running: true,
    pid: s.pid,
    url: s.url,
    port: s.port,
    startedAt: s.startedAt,
    artifact: s.artifact,
    routes: s.routes,
    lastBuild: { ok: s.lastBuild.ok, at: s.lastBuild.at, ms: s.lastBuild.ms, problems: s.lastBuild.problems.length },
    workerRestarts: s.workerRestarts,
  };
}

async function devErrors(project: string): Promise<Record<string, unknown>> {
  const s = readDevState(project);
  const logPath = join(project, ".renox", "logs", "tenant.ndjson");
  const logErrors: { at?: string; message: string; request_id?: string | null; fields?: unknown }[] = [];
  if (existsSync(logPath)) {
    const lines = tail(logPath, 256 * 1024).split("\n");
    for (const line of lines.reverse()) {
      if (logErrors.length >= LOG_ERRORS) break;
      try {
        const l = JSON.parse(line) as { level?: string; message?: string; ts?: string; request_id?: string | null; fields?: unknown };
        if (l.level === "error")
          logErrors.push({
            message: String(l.message ?? ""),
            ...(l.ts ? { at: l.ts } : {}),
            ...(l.request_id !== undefined ? { request_id: l.request_id } : {}),
            ...(l.fields ? { fields: l.fields } : {}),
          });
      } catch {
        // a partial first line of the tail
      }
    }
  }
  return {
    running: s !== null,
    build: s ? { ok: s.lastBuild.ok, at: s.lastBuild.at, problems: s.lastBuild.problems } : null,
    logErrors: logErrors.reverse(),
  };
}

async function runCheck(project: string): Promise<Record<string, unknown>> {
  const { errors, findings } = await check(project);
  const problems: Problem[] = [
    ...errors.map((m) => problemFromMessage("check", m)),
    ...findings.map((f) => ({
      code: f.rule,
      message: f.message,
      file: f.file,
      line: f.line,
      column: f.column,
      severity: f.severity,
    })),
  ];
  const failed = errors.length + findings.filter((f) => f.severity === "error").length;
  return { ok: failed === 0, errors: failed, warnings: findings.length - findings.filter((f) => f.severity === "error").length, problems };
}

async function runTests(project: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  onlyKeys(args, ["filter"]);
  const filter = args.filter;
  if (filter !== undefined && (typeof filter !== "string" || !FILTER.test(filter)))
    throw new ToolInputError("filter: letters, digits, space, and _ . : / - only, 1 to 100 characters");
  const bun = Bun.which("bun");
  if (!bun) throw new ToolInputError("bun is not on PATH; install Bun to run the project's tests");
  const argv = [bun, "test", ...(filter ? ["--test-name-pattern", filter] : [])];
  const t0 = performance.now();
  const proc = Bun.spawn(argv, { cwd: project, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" } });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, TEST_TIMEOUT_MS);
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const exitCode = await proc.exited;
  clearTimeout(timer);
  const all = `${out}${err}`;
  const count = (re: RegExp): number => Number(re.exec(all)?.[1] ?? 0);
  return {
    ok: exitCode === 0 && !timedOut,
    // Redacted with every other string of the result, in callTool.
    exitCode,
    timedOut,
    ms: Math.round(performance.now() - t0),
    pass: count(/^\s*(\d+) pass$/mu),
    fail: count(/^\s*(\d+) fail$/mu),
    skip: count(/^\s*(\d+) skip$/mu),
    output: all.length > OUTPUT_LIMIT ? `[… ${all.length - OUTPUT_LIMIT} bytes cut]\n${all.slice(-OUTPUT_LIMIT)}` : all,
  };
}

async function searchDocsTool(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  onlyKeys(args, ["query", "limit"]);
  const { query, limit } = args;
  if (typeof query !== "string" || query.trim().length < 2 || query.length > 200) throw new ToolInputError("query: a string of 2 to 200 characters");
  if (limit !== undefined && (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 50))
    throw new ToolInputError("limit: an integer from 1 to 50");
  const hits = searchDocs(query, (limit as number | undefined) ?? 10);
  return { query, hits };
}

/** Runs tool `name`; null when there is no such tool. */
export async function callTool(name: string, args: Record<string, unknown>, project: string): Promise<ToolResult | null> {
  const def = TOOLS.find((t) => t.name === name);
  if (!def) return null;
  try {
    let value: Record<string, unknown>;
    if (name === "run_tests") value = await runTests(project, args);
    else if (name === "search_docs") value = await searchDocsTool(args);
    else {
      onlyKeys(args, []);
      value = name === "dev_status" ? await devStatus(project) : name === "dev_errors" ? await devErrors(project) : await runCheck(project);
    }
    const clean = redactDeep(value, redactor(project)) as Record<string, unknown>;
    return { content: [{ type: "text", text: JSON.stringify(clean, null, 2) }], structuredContent: clean, isError: false };
  } catch (e) {
    const p: Problem = e instanceof ToolInputError ? { code: "invalid_input", message: e.message } : problemOf(e);
    return { content: [{ type: "text", text: JSON.stringify({ error: p }) }], structuredContent: { error: p }, isError: true };
  }
}
