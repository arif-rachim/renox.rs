// Test harness: one PGlite instance per test process (starting one takes
// seconds), migrated once, emptied before each test.

import type { Hono } from "hono";
import { createApp, type RouteModule } from "../src/app.ts";
import type { Deps, Env } from "../src/context.ts";
import { openPglite } from "../src/db/pglite.ts";
import { openPostgres } from "../src/db/postgres.ts";
import { migrate } from "../src/db/migrate.ts";
import type { Db } from "../src/db/db.ts";
import { memoryLogger } from "../src/log.ts";
import { MemoryObjectStore } from "../src/storage/object-store.ts";
import { createTenantToken, newTokenValue, sha256hex } from "../src/auth/tokens.ts";
import { MemoryMailer } from "../src/auth/mailer.ts";
import { guardDb } from "../src/tenancy/scope.ts";
import { CSRF_HEADER, SESSION_COOKIE } from "../src/auth/sessions.ts";

let shared: Promise<Db> | undefined;

/**
 * The shared test database: PGlite, or a real Postgres when
 * CONTROL_TEST_HARNESS_URL names an empty database (its public schema is
 * dropped and recreated).
 */
export function testDb(): Promise<Db> {
  const url = process.env.CONTROL_TEST_HARNESS_URL;
  shared ??= (async () => {
    const db = url === undefined ? await openPglite() : openPostgres(url);
    if (url !== undefined) await db.exec("drop schema public cascade; create schema public;");
    await migrate(db);
    return db;
  })();
  return shared;
}

export const OPERATOR_TOKEN = newTokenValue("op");
/** A 32-byte master key (base64) used by tests only. */
export const TEST_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");

export interface Harness {
  app: Hono<Env>;
  deps: Deps;
  db: Db;
  store: MemoryObjectStore;
  log: ReturnType<typeof memoryLogger>;
  clock: { now: number };
  mailer: MemoryMailer;
  /**
   * Statements a tenant request ran on the raw database instead of through
   * withTenant (src/tenancy/scope.ts). Every test that sends a request checks
   * this stays empty (#113, "no query without tenant").
   */
  unscoped: string[];
  /** Sends a request to the app. `session` sends the cookie and, on a mutating method, the CSRF header. */
  request(method: string, path: string, init?: RequestInit_): Promise<Response>;
}

export interface Session {
  cookie: string;
  csrf: string;
}

export interface RequestInit_ {
  token?: string;
  session?: Session;
  json?: unknown;
  body?: BodyInit;
  headers?: Record<string, string>;
  /** The client address the server reports. */
  ip?: string;
}

/** Harnesses created by the running test; assertScoped checks them after the test. */
export const harnesses: Harness[] = [];

export async function harness(modules: RouteModule[] = []): Promise<Harness> {
  const db = await testDb();
  const tables = await db.query<{ tablename: string }>(
    "select tablename from pg_tables where schemaname = 'public' and tablename <> 'schema_migrations'",
  );
  await db.exec(`truncate ${tables.map((t) => `"${t.tablename}"`).join(", ")} restart identity cascade`);
  for (const { sequencename } of await db.query<{ sequencename: string }>("select sequencename from pg_sequences where schemaname = 'public'")) {
    await db.exec(`alter sequence "${sequencename}" restart`);
  }
  const store = new MemoryObjectStore();
  const log = memoryLogger();
  const clock = { now: 1_793_318_400_000 };
  const mailer = new MemoryMailer();
  const unscoped: string[] = [];
  const deps: Deps = {
    db: guardDb(db, (sql) => unscoped.push(sql)),
    mailer,
    store,
    log,
    now: () => clock.now,
    config: {
      port: 0,
      databaseUrl: "pglite:memory",
      operatorTokenSha256: sha256hex(OPERATOR_TOKEN),
      platformDomain: "renox.app",
      s3: null,
      masterKey: TEST_MASTER_KEY,
      dashboardUrl: "https://dashboard.renox.test",
      mailOutboxDir: null,
    },
  };
  const app = createApp(deps, modules);
  const request: Harness["request"] = (method, path, init = {}) => {
    const headers: Record<string, string> = { ...init.headers };
    if (init.token !== undefined) headers.authorization = `Bearer ${init.token}`;
    if (init.session !== undefined) {
      headers.cookie = [headers.cookie, `${SESSION_COOKIE}=${init.session.cookie}`].filter(Boolean).join("; ");
      if (method !== "GET" && method !== "HEAD") headers[CSRF_HEADER] ??= init.session.csrf;
    }
    let body = init.body;
    if (init.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(init.json);
    }
    const ip = init.ip ?? "192.0.2.10";
    return Promise.resolve(app.request(path, { method, headers, body }, { requestIP: () => ({ address: ip }) }));
  };
  const h = { app, deps, db, store, log, clock, mailer, unscoped, request };
  harnesses.push(h);
  return h;
}

/** Creates a tenant with a `*` token and returns the token value. */
export async function tenant(h: Harness, id: string, tier: "free" | "paid" = "free"): Promise<string> {
  await h.db.query("insert into tenants (id, name, tier, created_at) values ($1, $2, $3, $4)", [id, id, tier, h.clock.now]);
  return (await createTenantToken(h.db, id, "test", ["*"], 30, h.clock.now)).token;
}

/** A token with `scopes` for an existing tenant. */
export async function scopedToken(h: Harness, tenantId: string, scopes: string[], days = 30): Promise<string> {
  return (await createTenantToken(h.db, tenantId, "scoped", scopes, days, h.clock.now)).token;
}

/** Creates an app for `token`'s tenant through the API. */
export async function createApp_(h: Harness, token: string, name: string): Promise<void> {
  const res = await h.request("POST", "/v1/apps", { token, json: { name } });
  if (res.status !== 201) throw new Error(`createApp ${name}: ${res.status} ${await res.text()}`);
}

/** Registers a node token directly and returns the value. */
export async function nodeToken(h: Harness, nodeId: string): Promise<string> {
  const value = newTokenValue("node");
  await h.db.query("insert into node_tokens (node_id, token_sha256, created_at) values ($1, $2, $3)", [nodeId, sha256hex(value), h.clock.now]);
  return value;
}

/** A node token and a registered, healthy node. */
export async function registeredNode(h: Harness, nodeId: string): Promise<string> {
  const token = await nodeToken(h, nodeId);
  const res = await h.request("POST", "/v1/nodes/register", {
    token,
    json: { type: "node_register", schema_version: 0, node_id: nodeId, worker_version: "0.1.0", region: "me-central-1", max_cells: 100 },
  });
  if (res.status !== 200) throw new Error(`register ${nodeId}: ${res.status} ${await res.text()}`);
  return token;
}

/** Reads Server-Sent Events from a streaming response. */
export function sseReader(res: Response): { next(timeoutMs?: number): Promise<{ event: string; data: unknown }>; close(): Promise<void> } {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buf = "";
  return {
    async next(timeoutMs = 2000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        let end = buf.indexOf("\n\n");
        while (end !== -1) {
          const block = buf.slice(0, end);
          buf = buf.slice(end + 2);
          const lines = block.split("\n").filter((l) => l !== "" && !l.startsWith(":"));
          if (lines.length > 0) {
            const event = lines.find((l) => l.startsWith("event:"))?.slice(6).trim() ?? "message";
            const data = lines.filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
            return { event, data: JSON.parse(data) as unknown };
          }
          end = buf.indexOf("\n\n");
        }
        const left = deadline - Date.now();
        if (left <= 0) throw new Error("no event before the timeout");
        const chunk = await Promise.race([reader.read(), Bun.sleep(left).then(() => null)]);
        if (chunk === null) throw new Error("no event before the timeout");
        if (chunk.done) throw new Error("stream ended");
        buf += decoder.decode(chunk.value, { stream: true });
      }
    },
    close: () => reader.cancel(),
  };
}

export async function auditRows(h: Harness): Promise<Record<string, unknown>[]> {
  return h.db.query("select tenant_id, actor, action, target, status from audit order by id");
}

export const PASSWORD = "correct horse battery";

/** The `name=value` of a Set-Cookie header of `res`, or null. */
export function setCookie(res: Response, name: string): string | null {
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(";");
    const eq = (pair as string).indexOf("=");
    if ((pair as string).slice(0, eq) === name) return (pair as string).slice(eq + 1);
  }
  return null;
}

/** The single-use token in the last email of `kind` to `to`. */
export function mailToken(h: Harness, to: string, kind: Parameters<MemoryMailer["last"]>[1]): string {
  const mail = h.mailer.last(to, kind);
  const m = mail === undefined ? null : /#token=([a-z2-7]{32})/u.exec(mail.text);
  if (m === null) throw new Error(`no ${kind} mail with a token to ${to}`);
  return m[1] as string;
}

/** Signs in through the API and returns the session. */
export async function login(h: Harness, email: string, password = PASSWORD, extra: Record<string, unknown> = {}, ip?: string): Promise<Session> {
  const res = await h.request("POST", "/v1/account/login", { json: { email, password, ...extra }, ...(ip === undefined ? {} : { ip }) });
  if (res.status !== 200) throw new Error(`login ${email}: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { csrf: string };
  return { cookie: setCookie(res, SESSION_COOKIE) as string, csrf: body.csrf };
}

/** Signs up through the API (a new tenant when `tenantId` is given), verifies the address unless told not to, and signs in. */
export async function signup(h: Harness, email: string, tenantId?: string, verify = true): Promise<Session> {
  const res = await h.request("POST", "/v1/account/signup", { json: { email, password: PASSWORD, ...(tenantId === undefined ? {} : { tenant_id: tenantId }) } });
  if (res.status !== 202) throw new Error(`signup ${email}: ${res.status} ${await res.text()}`);
  if (verify) {
    const v = await h.request("POST", "/v1/account/verify", { json: { token: mailToken(h, email, "verify_email") } });
    if (v.status !== 200) throw new Error(`verify ${email}: ${v.status}`);
  }
  return login(h, email);
}

/** Adds an existing user to a tenant with `role`, directly. */
export async function addMember(h: Harness, tenantId: string, email: string, role: string): Promise<string> {
  const [u] = await h.db.query<{ id: string }>("select id from users where email = $1", [email]);
  await h.db.query("insert into memberships (tenant_id, user_id, role, created_at) values ($1, $2, $3, $4)", [tenantId, (u as { id: string }).id, role, h.clock.now]);
  return (u as { id: string }).id;
}

/**
 * Registered with afterEach by every test file: no tenant request of the test
 * ran a statement outside withTenant (#113, the repository layer;
 * docs/24-threat-model.md E, IDOR row).
 */
export function assertScoped(): void {
  const unscoped = harnesses.flatMap((h) => h.unscoped);
  harnesses.length = 0;
  if (unscoped.length > 0) throw new Error(`statements outside withTenant during a tenant request:\n${unscoped.join("\n")}`);
}
