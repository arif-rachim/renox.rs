// Test harness: the dashboard's loaders and actions against the real control
// API (control/api, in process on PGlite), through a fake `ctx` whose `fetch`
// reaches the API only at its public origin, as ADR D23 has it; any other
// host is refused the way the runtime refuses it (`RENOX_FETCH_BLOCKED`).
// `db` is bun:sqlite with the dashboard's own migration.
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Hono } from "hono";
import { FetchBlockedError, type ActionContext, type Ctx, type DbStatements, type ExecuteResult, type LoaderContext, type Param, type Row } from "renox";

import { operation } from "../../api/src/audit.ts";
import { tenantAuth } from "../../api/src/auth/middleware.ts";
import type { Deps, Env } from "../../api/src/context.ts";
import { logIngest, type StoredLine } from "../../api/src/ingest/logs.ts";
import { harness, type Harness } from "../../api/tests/helpers.ts";

export const API_ORIGIN = "https://api.renox.app";
export const DASH = "https://dashboard.renox.test";
/** A test-only key; long enough for lib/session.ts. */
export const SECRETS = Object.freeze({ DASHBOARD_KEY: "test-dashboard-key-0123456789abcdef" });

/**
 * `GET /v1/apps/{app}/logs` (streamLogs, deploy-api.md section 11, "Reading
 * logs") is in the contract but not served by control/api yet; this test
 * stand-in answers it from the API's own log store in the contract's shape
 * (non-follow: the lines since `since`, or the last 100, then close), so the
 * Logs page is tested against the documented response.
 */
export function logsStandIn(app: Hono<Env>, deps: Deps): void {
  app.get("/v1/apps/:app/logs", operation(deps, "streamLogs"), tenantAuth(deps, "logs:read"), async (c) => {
    const p = c.get("principal") as { tenantId: string };
    const since = c.req.query("since");
    const source = c.req.query("source") ?? "all";
    const deployment = c.req.query("deployment");
    const lines = await logIngest(deps).store.read(p.tenantId, c.req.param("app"), { ...(since === undefined ? {} : { since: Number(since) }), limit: since === undefined ? 100 : 10_000 });
    const body = lines
      .filter((l) => (source === "all" || l.source === source) && (deployment === undefined || l.deployment_hash === deployment))
      .map(({ node_id: _n, app: _a, ...line }, i) => `event: log\nid: ${line.ts}-${i}\ndata: ${JSON.stringify(line)}\n\n`)
      .join("");
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  });
}

/** Appends lines to the API's log store, as `POST /v1/ingest/logs` would. */
export async function addLogs(h: Harness, lines: Omit<StoredLine, "node_id">[]): Promise<void> {
  await logIngest(h.deps).store.append(lines.map((l) => ({ ...l, node_id: "node-1" })));
}

export async function apiHarness(): Promise<Harness> {
  return harness([logsStandIn]);
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
  };
}

export function loaderCtx(d: Dash, path: string, opts: { params?: Ctx["params"]; fragment?: string | null } = {}): LoaderContext {
  return { ...base(d, "GET", path, opts.params ?? {}), fragment: opts.fragment ?? null, session: { id: d.sessionId } };
}

export function actionCtx(d: Dash, path: string, action: string, fields: Record<string, string>, opts: { params?: Ctx["params"] } = {}): ActionContext {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  const c = base(d, "POST", `${path}?/${action}`, opts.params ?? {});
  return { ...c, db: statements(d.sqlite), action, form, fragment: "page", session: { id: d.sessionId } };
}
