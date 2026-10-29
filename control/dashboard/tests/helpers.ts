// Test harness: the dashboard's loaders and actions against the real control
// API (control/api, in process on PGlite), through a fake `ctx` whose `fetch`
// reaches the API only at its public origin, as ADR D23 has it; any other
// host is refused the way the runtime refuses it (`RENOX_FETCH_BLOCKED`).
// `db` is bun:sqlite with the dashboard's own migration.
import { Database } from "bun:sqlite";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FetchBlockedError, type ActionContext, type Ctx, type DbStatements, type ExecuteResult, type LoaderContext, type Param, type Row } from "renox";

import { logIngest, type StoredLine } from "../../api/src/ingest/logs.ts";
import { harness, type Harness } from "../../api/tests/helpers.ts";
import { startDev } from "../../../cli/src/commands/dev.ts";

export const API_ORIGIN = "https://api.renox.app";
export const DASH = "https://dashboard.renox.test";
/** A test-only key; long enough for lib/session.ts. */
export const SECRETS = Object.freeze({ DASHBOARD_KEY: "test-dashboard-key-0123456789abcdef" });

/** Appends lines to the API's log store, as `POST /v1/ingest/logs` would. */
export async function addLogs(h: Harness, lines: Omit<StoredLine, "node_id">[]): Promise<void> {
  await logIngest(h.deps).store.append(lines.map((l) => ({ ...l, node_id: "node-1" })));
}

export async function apiHarness(): Promise<Harness> {
  return harness();
}

export function dashDb(): Database {
  const sqlite = new Database(":memory:", { strict: false });
  sqlite.exec(readFileSync(join(import.meta.dir, "../migrations/001_sessions.sql"), "utf8"));
  return sqlite;
}

type Bind = string | number | bigint | boolean | null | Uint8Array;

export function statements(sqlite: Database): DbStatements {
  const bind = (params: readonly Param[] = []): Bind[] => params.map((p) => p as Bind);
  return {
    query: async <T extends Row = Row>(sql: string, params?: readonly Param[]) => sqlite.query(sql).all(...bind(params)) as T[],
    queryOne: async <T extends Row = Row>(sql: string, params?: readonly Param[]) => (sqlite.query(sql).get(...bind(params)) as T | null) ?? null,
    execute: async (sql: string, params?: readonly Param[]): Promise<ExecuteResult> => {
      const r = sqlite.query(sql).run(...bind(params));
      return { changes: r.changes, lastInsertRowid: r.lastInsertRowid };
    },
  };
}

export interface Calls {
  /** Every request the dashboard sent: method, URL, and the Authorization header. */
  sent: { method: string; url: string; authorization: string | null; body: string | null }[];
}

/** The tenant `fetch`: the API's public origin goes to the harness; anything else is blocked. */
function apiFetch(h: Harness, calls: Calls) {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const body = req.body === null ? null : await req.text();
    calls.sent.push({ method: req.method, url: req.url, authorization: req.headers.get("authorization"), body });
    if (url.origin !== API_ORIGIN) throw new FetchBlockedError(`${url.host} is not allowed`, { host: url.host, reason: "not_allowlisted" });
    return h.request(req.method, `${url.pathname}${url.search}`, {
      headers: Object.fromEntries(req.headers),
      ...(body === null ? {} : { body }),
    });
  };
}

export interface Dash {
  h: Harness;
  sqlite: Database;
  calls: Calls;
  sessionId: string;
  secrets: Readonly<Record<string, string>>;
  /** Overrides the next contexts' `fetch` (an unreachable API). */
  fetch?: Ctx["fetch"];
}

export async function dash(opts: { secrets?: Readonly<Record<string, string>> } = {}): Promise<Dash> {
  return { h: await apiHarness(), sqlite: dashDb(), calls: { sent: [] }, sessionId: "AAAAAAAAAAAAAAAAAAAAAA", secrets: opts.secrets ?? SECRETS };
}

const noop = (): void => {};

function base(d: Dash, method: string, path: string, params: Ctx["params"]): Ctx {
  const req = new Request(`${DASH}${path}`, { method });
  return {
    req,
    url: new URL(req.url),
    params,
    headers: req.headers,
    db: { ...statements(d.sqlite), transaction: async (fn) => fn(statements(d.sqlite)) },
    fetch: d.fetch ?? apiFetch(d.h, d.calls),
    secrets: d.secrets,
    log: { debug: noop, info: noop, warn: noop, error: noop },
    deadline: { remainingMs: () => 30_000 },
    module: "app",
    config: Object.freeze({}),
    services: Object.freeze({}),
    events: { emit: () => Promise.reject(new Error("no events in unit tests")) },
    hooks: { run: () => Promise.resolve({ halt: false }) },
    password: { hash: () => Promise.reject(new Error("no password op in unit tests")), verify: () => Promise.resolve(false) },
  };
}

export function loaderCtx(d: Dash, path: string, opts: { params?: Ctx["params"]; fragment?: string | null } = {}): LoaderContext {
  return { ...base(d, "GET", path, opts.params ?? {}), fragment: opts.fragment ?? null, session: { id: d.sessionId }, setLocale: noop };
}

export function actionCtx(d: Dash, path: string, action: string, fields: Record<string, string>, opts: { params?: Ctx["params"] } = {}): ActionContext {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  const c = base(d, "POST", `${path}?/${action}`, opts.params ?? {});
  return { ...c, db: statements(d.sqlite), action, form, fragment: "page", session: { id: d.sessionId }, setLocale: noop };
}

const APP = join(import.meta.dir, "..");

/**
 * The dashboard under `renox dev` on the real worker, with the loaders of
 * `stubs` (page file → data) replaced by one that returns `data`: what the
 * real loader returned in process against the real control API. The worker
 * cannot reach a local control API (tenant `fetch` blocks loopback, ADR D23),
 * so only that hop is replaced; the templates, layout, partials, assets, CSP
 * and the renderer are the real ones. The rest of each page module (its
 * actions, its other exports) is kept as it is.
 */
export async function devWithData(stubs: Record<string, unknown>): Promise<{ base: string; stop: () => Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), "renox-dashboard-render-"));
  cpSync(APP, dir, { recursive: true, filter: (p) => !/\/(node_modules|\.renox|tests)(\/|$)/u.test(p.slice(APP.length)) });
  cpSync(join(APP, "node_modules/renox"), join(dir, "node_modules/renox"), { recursive: true, dereference: true });
  writeFileSync(join(dir, ".env"), `DASHBOARD_KEY=${SECRETS.DASHBOARD_KEY}\nRENOX_API_URL=${API_ORIGIN}\n`);
  for (const [page, data] of Object.entries(stubs)) {
    const file = join(dir, page);
    const source = readFileSync(file, "utf8");
    if (!source.includes("export async function load(")) throw new Error(`${page} has no load to stub`);
    writeFileSync(
      file,
      `${source.replace("export async function load(", "async function liveLoad(")}\n` +
        `// Test stub (tests/helpers.ts, devWithData): the loader's data, captured in process.\n` +
        `void liveLoad;\nexport async function load() {\n  return JSON.parse(${JSON.stringify(JSON.stringify(data))});\n}\n`,
    );
  }
  const port = 20000 + Math.floor(Math.random() * 20000);
  const dev = await startDev({ project: dir, port, log: () => {} });
  return { base: `http://localhost:${port}`, stop: () => dev.stop() };
}

/** Node with Playwright's Chromium (`PLAYWRIGHT_PATH`, or a `playwright` package Node resolves), or null without one. */
function playwright(): string | null {
  const name = process.env.PLAYWRIGHT_PATH ?? "playwright";
  if (Bun.which("node") === null) return null;
  const r = Bun.spawnSync(["node", "-e", `require.resolve(${JSON.stringify(name)})`], { stdout: "ignore", stderr: "ignore" });
  return r.exitCode === 0 ? name : null;
}

const SHOOT = `
const { chromium } = require(process.argv[2]);
const [out, base, ...shots] = process.argv.slice(3);
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  for (const shot of shots) {
    const [name, path] = shot.split("=");
    const r = await page.goto(base + path, { waitUntil: "networkidle" });
    if (r === null || r.status() !== 200) errors.push(path + ": HTTP " + (r === null ? "none" : r.status()));
    await page.screenshot({ path: out + "/" + name + ".png", fullPage: true });
  }
  await browser.close();
  console.log(JSON.stringify({ errors }));
})().catch((e) => { console.log(JSON.stringify({ errors: [String(e)] })); });
`;

/**
 * Full-page Chromium screenshots of `shots` (name → path under `base`) into
 * `out`/<name>.png, with every console error and uncaught exception
 * (CSP violations included). Null when Node or Playwright is missing; the
 * caller's HTML assertions still run.
 */
export async function screenshots(base: string, shots: Record<string, string>, out: string): Promise<{ errors: string[]; files: string[] } | null> {
  const pw = playwright();
  if (pw === null) return null;
  const script = join(mkdtempSync(join(tmpdir(), "renox-shoot-")), "shoot.cjs");
  writeFileSync(script, SHOOT);
  // Async spawn: the dev proxy runs in this process and must keep serving.
  const p = Bun.spawn(["node", script, pw, out, base, ...Object.entries(shots).map(([n, path]) => `${n}=${path}`)], { stdout: "pipe", stderr: "inherit" });
  const text = await new Response(p.stdout).text();
  await p.exited;
  const { errors } = JSON.parse(text.trim().split("\n").pop() ?? "{}") as { errors: string[] };
  return { errors, files: Object.keys(shots).map((n) => join(out, `${n}.png`)).filter((f) => existsSync(f)) };
}
