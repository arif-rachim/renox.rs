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
  /** Sends a request to the app. */
  request(method: string, path: string, init?: { token?: string; json?: unknown; body?: BodyInit; headers?: Record<string, string> }): Promise<Response>;
}

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
  const deps: Deps = {
    db,
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
    },
  };
  const app = createApp(deps, modules);
  const request: Harness["request"] = (method, path, init = {}) => {
    const headers: Record<string, string> = { ...init.headers };
    if (init.token !== undefined) headers.authorization = `Bearer ${init.token}`;
    let body = init.body;
    if (init.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(init.json);
    }
    return Promise.resolve(app.request(path, { method, headers, body }));
  };
  return { app, deps, db, store, log, clock, request };
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
