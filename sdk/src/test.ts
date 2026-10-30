// `renox/test` (#238; docs/12-developer-experience.md, "renox test"):
// helpers for `tests/*.test.ts` of an app or a module, run by `renox test`
// on the same prebuilt renox-worker as `renox dev`, one temporary tenant
// file per test file.
//
//   import { app, snapshot } from "renox/test";
//   const t = await app();                         // fresh worker + tenant file for this file
//   await t.service("notes").add("hello");         // through the broker (a test-only route)
//   const { html } = await t.as("bob").page("/notes/");
//   snapshot(html, { role: "admin" });
//
// Bun-only (bun:test, bun:sqlite): not part of the runtime-neutral SDK
// surface, and never loaded by tenant code in production.

import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** The harness engine (`cli/src/lib/test-harness.ts`), loaded from the CLI that runs the tests. */
interface Harness {
  prepare(project: string, seeds?: string[], worker?: string): Promise<Spec>;
  startTestWorker(spec: Spec): Promise<Worker>;
  changeModule(project: string, name: string, source: string, scratch?: { project: string; db: string }, worker?: string, version?: string): Promise<ModuleChange & { db: string }>;
  evaluatePolicies(spec: Spec, casesFrom?: string): Promise<{ file: string; case: PolicyCase; result: { allow: boolean; reason: string }; ok: boolean }[]>;
  SERVICE_PATH: string;
}
interface Spec {
  project: string;
  artifacts: string;
  hash: string;
  worker: string;
  seeds: string[];
}
interface Worker {
  base: string;
  host: string;
  db: string;
  logs(): Record<string, unknown>[];
  meters(): Record<string, unknown>[];
  stop(): Promise<void>;
}

/** What installing or upgrading a module reported (`renox check` and the migration plan). */
export interface ModuleChange {
  check: { errors: { message: string; file?: string }[]; findings: { rule: string; severity: string; message: string; file: string }[] };
  migrate: { ok: boolean; module?: string; error?: string; modules: { module: string; applied: string[]; skipped: string[] }[] } | null;
  project: string;
}

async function harness(): Promise<Harness> {
  const path = process.env.RENOX_TEST_HARNESS ?? join(import.meta.dir, "../../cli/src/lib/test-harness.ts");
  if (!existsSync(path)) throw new Error("renox/test: run the tests with `renox test` (RENOX_TEST_HARNESS is not set)");
  return (await import(path)) as Harness;
}

/** The spec `renox test` prepared, or one built now for the current project (`bun test` with RENOX_WORKER_PATH). */
async function spec(h: Harness, project: string): Promise<Spec> {
  const file = process.env.RENOX_TEST_SPEC;
  if (file) return JSON.parse(readFileSync(file, "utf8")) as Spec;
  const worker = process.env.RENOX_WORKER_PATH;
  if (!worker) throw new Error("renox/test: run the tests with `renox test`, or set RENOX_WORKER_PATH");
  return h.prepare(project, [], worker);
}

/** A response with its body read. */
export interface Reply {
  status: number;
  headers: Headers;
  html: string;
  json<T = unknown>(): T;
}

export interface RequestInitLite {
  headers?: Record<string, string>;
  body?: string | Record<string, unknown>;
}

/** A service proxy: `service("notes").add("x")` resolves with the service's value or throws its error. */
export type ServiceProxy = Record<string, (...args: unknown[]) => Promise<unknown>>;

/** The error a service threw, as the broker reported it. */
export class ServiceError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
    readonly details: unknown,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

export interface TestApp {
  /** Any request; a JSON object `body` is sent as JSON. */
  request(method: string, path: string, init?: RequestInitLite): Promise<Reply>;
  /** GET a page as this app's current user (its own cookie jar: session and CSRF). */
  page(path: string, options?: { user?: string }): Promise<Reply>;
  /** POST a page action (`?/<name>`) with the form and the session's CSRF token. */
  action(path: string, name: string, form: Record<string, string>, options?: { user?: string }): Promise<Reply>;
  /** Call an installed module's service through the broker. */
  service(module: string): ServiceProxy;
  /** Read-only SQL on the tenant file, for assertions. */
  db: { query<T = Record<string, unknown>>(sql: string, params?: (string | number | null)[]): T[] };
  /** The tenant file itself (to age a row in an expiry test, open it with bun:sqlite). */
  dbFile: string;
  /** The same app as another user: a separate session (cookie jar). */
  as(user: string): TestApp;
  /** Read a cookie of this user's jar, or plant one (an attacker's token, a forged state). */
  cookie(name: string, value?: string): string | undefined;
  /** Open a WebSocket route as this user (its cookies, the app's origin); read messages with `next`. */
  ws(path: string, options?: { headers?: Record<string, string> }): Promise<WsStream>;
  /** Open an SSE route (`GET`, `Accept: text/event-stream`) as this user; read its events with `next`. */
  sse(path: string, options?: { headers?: Record<string, string> }): Promise<SseStream>;
  /** Tenant log lines so far. */
  logs(): Record<string, unknown>[];
  /** Meter records so far (flushed about every second). */
  meters(): Record<string, unknown>[];
  stop(): Promise<void>;
}

/** One SSE event as received (ops.md section 18, "On the wire"). */
export interface SseEvent {
  id: string | null;
  event: string | null;
  data: string;
}

/** An open SSE connection of a test. */
export interface SseStream {
  status: number;
  headers: Headers;
  /** The next event, or null when none arrives within `ms` (default 2000) or the stream ended. */
  next(ms?: number): Promise<SseEvent | null>;
  /** Events received so far and not yet returned by `next`. */
  pending(): SseEvent[];
  close(): void;
}

/** Reads `body` as an SSE stream: comments and `retry:` are skipped. */
function sseStream(res: Response, abort: AbortController): SseStream {
  const queue: SseEvent[] = [];
  const waiters: ((e: SseEvent | null) => void)[] = [];
  let ended = false;
  const push = (e: SseEvent | null) => {
    const w = waiters.shift();
    if (w) w(e);
    else if (e) queue.push(e);
  };
  void (async () => {
    const reader = res.body?.getReader();
    if (!reader) return;
    const dec = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let cut: number;
        while ((cut = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          let id: string | null = null;
          let event: string | null = null;
          const data: string[] = [];
          for (const line of block.split("\n")) {
            if (line.startsWith(":")) continue;
            const i = line.indexOf(":");
            const field = i < 0 ? line : line.slice(0, i);
            const v = i < 0 ? "" : line.slice(i + 1).replace(/^ /u, "");
            if (field === "id") id = v;
            else if (field === "event") event = v;
            else if (field === "data") data.push(v);
          }
          if (data.length || event !== null) push({ id, event, data: data.join("\n") });
        }
      }
    } catch {
      // aborted
    }
    ended = true;
    while (waiters.length) push(null);
  })();
  return {
    status: res.status,
    headers: res.headers,
    next(ms = 2000) {
      const e = queue.shift();
      if (e) return Promise.resolve(e);
      if (ended) return Promise.resolve(null);
      return new Promise((resolve) => {
        const w = (x: SseEvent | null) => {
          clearTimeout(timer);
          resolve(x);
        };
        const timer = setTimeout(() => {
          const i = waiters.indexOf(w);
          if (i >= 0) waiters.splice(i, 1);
          resolve(null);
        }, ms);
        waiters.push(w);
      });
    },
    pending: () => queue.splice(0),
    close: () => abort.abort(),
  };
}

/** An open WebSocket of a test. */
export interface WsStream {
  /** The next text message, or null when none arrives within `ms` (default 2000) or the socket closed. */
  next(ms?: number): Promise<string | null>;
  send(text: string): void;
  /** Resolves with the close code (1008 for a refused subscribe, 1011 for a throwing `open`). */
  closed: Promise<number>;
  close(): void;
}

function wsStream(socket: WebSocket): Promise<WsStream> {
  const queue: string[] = [];
  const waiters: ((m: string | null) => void)[] = [];
  let ended = false;
  let resolveClosed: (code: number) => void = () => {};
  const closed = new Promise<number>((r) => (resolveClosed = r));
  socket.addEventListener("message", (e) => {
    const text = typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data as ArrayBuffer);
    const w = waiters.shift();
    if (w) w(text);
    else queue.push(text);
  });
  socket.addEventListener("close", (e) => {
    ended = true;
    while (waiters.length) (waiters.shift() as (m: string | null) => void)(null);
    resolveClosed(e.code);
  });
  const stream: WsStream = {
    next(ms = 2000) {
      const m = queue.shift();
      if (m !== undefined) return Promise.resolve(m);
      if (ended) return Promise.resolve(null);
      return new Promise((resolve) => {
        const w = (x: string | null) => {
          clearTimeout(timer);
          resolve(x);
        };
        const timer = setTimeout(() => {
          const i = waiters.indexOf(w);
          if (i >= 0) waiters.splice(i, 1);
          resolve(null);
        }, ms);
        waiters.push(w);
      });
    },
    send: (text) => socket.send(text),
    closed,
    close: () => socket.close(),
  };
  return new Promise((resolve) => {
    if (socket.readyState === WebSocket.OPEN) resolve(stream);
    socket.addEventListener("open", () => resolve(stream));
    socket.addEventListener("close", () => resolve(stream));
  });
}

type Jar = Map<string, string>;

function remember(jar: Jar, res: Response): void {
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(";");
    const eq = (pair ?? "").indexOf("=");
    if (eq > 0) jar.set((pair as string).slice(0, eq).trim(), (pair as string).slice(eq + 1).trim());
  }
}

/**
 * A fresh worker and tenant file for this test file (stopped after it):
 * migrations applied, then `seeds/*.sql` and `renox test --seed` files.
 */
export async function app(options: { project?: string } = {}): Promise<TestApp> {
  const h = await harness();
  const s = await spec(h, options.project ?? process.env.RENOX_TEST_PROJECT ?? process.cwd());
  const w = await h.startTestWorker(s);
  afterAll(() => w.stop());
  const jars = new Map<string, Jar>();
  const jarOf = (user: string): Jar => {
    let j = jars.get(user);
    if (j === undefined) {
      j = new Map();
      jars.set(user, j);
    }
    return j;
  };
  const sqlite = new Database(w.db, { readonly: true });
  afterAll(() => sqlite.close());
  const make = (user: string): TestApp => {
    const send = async (method: string, path: string, init: RequestInitLite = {}): Promise<Reply> => {
      const jar = jarOf(user);
      const headers: Record<string, string> = { host: w.host, accept: "text/html", ...init.headers };
      // An explicit `cookie` header is sent as given (a replayed token); else the user's jar.
      if (jar.size && init.headers?.cookie === undefined) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
      let body: string | undefined;
      if (typeof init.body === "string") body = init.body;
      else if (init.body !== undefined) {
        body = JSON.stringify(init.body);
        headers["content-type"] ??= "application/json";
      }
      const res = await fetch(`${w.base}${path}`, { method, headers, redirect: "manual", ...(body !== undefined ? { body } : {}) });
      remember(jar, res);
      const text = await res.text();
      return { status: res.status, headers: res.headers, html: text, json: <T>() => JSON.parse(text) as T };
    };
    const self: TestApp = {
      request: send,
      async ws(path, o = {}) {
        const jar = jarOf(user);
        const headers: Record<string, string> = { host: w.host, origin: `https://${w.host}`, ...o.headers };
        if (jar.size && o.headers?.cookie === undefined) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
        // Bun's WebSocket takes request headers (the cookie, the Host the cell routes by).
        const socket = new WebSocket(`${w.base.replace(/^http/u, "ws")}${path}`, { headers } as unknown as string[]);
        afterAll(() => socket.close());
        return wsStream(socket);
      },
      async sse(path, o = {}) {
        const jar = jarOf(user);
        const headers: Record<string, string> = { host: w.host, accept: "text/event-stream", ...o.headers };
        if (jar.size && o.headers?.cookie === undefined) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
        const abort = new AbortController();
        const res = await fetch(`${w.base}${path}`, { headers, redirect: "manual", signal: abort.signal });
        afterAll(() => abort.abort());
        return sseStream(res, abort);
      },
      page: (path, o) => (o?.user ? make(o.user) : self).request("GET", path),
      async action(path, name, form, o) {
        const as = o?.user ? make(o.user) : self;
        const jar = jarOf(o?.user ?? user);
        if (!jar.has("__Host-renox_csrf")) await as.request("GET", path);
        const token = jar.get("__Host-renox_csrf") ?? "";
        const body = new URLSearchParams({ ...form }).toString();
        return as.request("POST", `${path}?/${name}`, { headers: { "content-type": "application/x-www-form-urlencoded", "x-renox-csrf": token }, body });
      },
      service: (module) =>
        new Proxy({} as ServiceProxy, {
          get: (_t, service) => async (...args: unknown[]) => {
            const r = await send("POST", h.SERVICE_PATH, { body: { module, service: String(service), args } });
            const out = r.json<{ ok: boolean; value?: unknown; error?: { message: string; code: string | null; details: unknown } }>();
            if (!out.ok) throw new ServiceError(out.error?.message ?? "service failed", out.error?.code ?? null, out.error?.details ?? null);
            return out.value;
          },
        }),
      db: { query: <T>(sql: string, params: (string | number | null)[] = []) => sqlite.query(sql).all(...params) as T[] },
      dbFile: w.db,
      as: (other) => make(other),
      cookie: (name, value) => {
        const jar = jarOf(user);
        if (value !== undefined) jar.set(name, value);
        return jar.get(name);
      },
      logs: () => w.logs(),
      meters: () => w.meters(),
      stop: () => w.stop(),
    };
    return self;
  };
  return make("anonymous");
}

/**
 * The page's HTML without what changes per request (request id, deployment,
 * nonces, CSRF tokens, session ids), matched against the snapshot named by
 * `role`. Returns the normalized HTML.
 */
export function snapshot(html: string, options: { role: string }): string {
  const normalized = html
    .replace(/(<meta name="renox-request-id" content=")[^"]*/gu, "$1<request-id>")
    .replace(/(<meta name="renox-deployment" content=")[^"]*/gu, "$1<deployment>")
    .replace(/nonce="[^"]*"/gu, 'nonce="<nonce>"')
    .replace(/(name="_csrf"[^>]*value=")[^"]*/gu, "$1<csrf>")
    .replace(/(value=")[^"]*("[^>]*name="_csrf")/gu, "$1<csrf>$2")
    .replace(/("x-renox-csrf"\s*:\s*")[^"]*/gu, "$1<csrf>")
    .replace(/\b[0-9A-HJKMNP-TV-Z]{26}\b/gu, "<ulid>")
    .replace(/(\?v=)[0-9a-f]{16}/gu, "$1<version>");
  expect(normalized).toMatchSnapshot(`role: ${options.role}`);
  return normalized;
}

/** One policy test case (`policies/tests/*.json`, #283): evaluated by the engine the cell builds. */
export interface PolicyCase {
  principal: { type: string; id: string; roles?: string[]; attrs?: Record<string, unknown> };
  action: string;
  /** `type` is an entity type of the app (`"Doc"`) or a module's (`"auth:Account"`), with its declared attributes. */
  resource?: { type: string; id?: string; [attr: string]: unknown };
  context?: Record<string, unknown>;
  expected: "allow" | "deny";
  description?: string;
}

const isCase = (v: unknown): v is PolicyCase => {
  const c = v as PolicyCase;
  return (
    typeof c === "object" &&
    c !== null &&
    typeof c.action === "string" &&
    typeof c.principal?.type === "string" &&
    typeof c.principal?.id === "string" &&
    (c.resource === undefined || typeof c.resource?.type === "string") &&
    (c.expected === "allow" || c.expected === "deny")
  );
};

/**
 * Reads `policies/tests/*.json` (each an array of cases, or `{ cases: [...] }`)
 * and registers one test per case that evaluates it with the engine the
 * cell builds (`renox-worker check-policies`, #283) and expects its
 * `expected` decision. A file that is not in this format fails. `renox
 * test` also runs the project's cases before the test files.
 */
export function policyCases(dir = join(process.env.RENOX_TEST_PROJECT ?? process.cwd(), "policies", "tests")): PolicyCase[] {
  if (!existsSync(dir)) return [];
  const out: PolicyCase[] = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
    const raw = JSON.parse(readFileSync(join(dir, f), "utf8")) as unknown;
    const list = Array.isArray(raw) ? raw : (raw as { cases?: unknown[] }).cases;
    if (!Array.isArray(list) || !list.every(isCase)) throw new Error(`policies/tests/${f}: expected [{ principal, action, resource, expected: "allow" | "deny" }]`);
    for (const c of list) out.push(c);
  }
  if (out.length === 0) return out;
  // One evaluation for all the cases of `dir`, shared by their tests.
  const project = join(dir, "..", "..");
  let outcomes: Promise<Awaited<ReturnType<Harness["evaluatePolicies"]>>> | undefined;
  const evaluated = () => {
    outcomes ??= (async () => {
      const h = await harness();
      return h.evaluatePolicies(await spec(h, process.env.RENOX_TEST_PROJECT ?? project), project);
    })();
    return outcomes;
  };
  out.forEach((c, i) => {
    const who = `${c.principal.type}::${c.principal.id}${c.principal.roles?.length ? ` (${c.principal.roles.join(", ")})` : ""}`;
    test(`policy: ${c.description ?? `${who} ${c.action} ${c.resource?.type ?? ""}`} -> ${c.expected}`, async () => {
      const o = (await evaluated())[i];
      expect(o?.result.allow ? "allow" : "deny").toBe(c.expected);
    });
  });
  return out;
}

/** `policyCases` of the current project (`policies/tests/*.json`). */
export const policies = (): PolicyCase[] => policyCases();

/** A module change on a scratch copy of the app: install, then upgrade with the returned handle. */
export interface ModuleHandle extends ModuleChange {
  /** Re-install from `source`; `version` defaults to `^<version of its module.toml>`. */
  upgrade(source: string, version?: string): Promise<ModuleHandle>;
}

/**
 * `installModule("notes", "path:fixtures/notes@1")`: `renox add` + `renox
 * build` + `renox migrate` on a scratch copy of the app and a scratch
 * tenant file. `upgrade(source)` does it again on the same copy and file:
 * what `renox check` reports then (drift, broken contracts) is the upgrade
 * test.
 */
export async function installModule(name: string, source: string, options: { project?: string; version?: string } = {}): Promise<ModuleHandle> {
  const h = await harness();
  const project = options.project ?? process.env.RENOX_TEST_PROJECT ?? process.cwd();
  const worker = process.env.RENOX_WORKER_PATH ?? (process.env.RENOX_TEST_SPEC ? (JSON.parse(readFileSync(process.env.RENOX_TEST_SPEC, "utf8")) as Spec).worker : undefined);
  const wrap = (r: ModuleChange & { db: string }): ModuleHandle => ({
    ...r,
    upgrade: async (next, version) => wrap(await h.changeModule(project, name, next, { project: r.project, db: r.db }, worker, version)),
  });
  return wrap(await h.changeModule(project, name, source, undefined, worker, options.version));
}

/** Alias of `ModuleHandle.upgrade` for symmetry: `upgradeModule(installed, "path:…@2")`. */
export const upgradeModule = (installed: ModuleHandle, source: string, version?: string): Promise<ModuleHandle> => installed.upgrade(source, version);
