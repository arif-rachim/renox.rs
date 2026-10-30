// Backups of an app's database (docs/contracts/deploy-api.md 0.3 section 14).
// getBackups (#257): the owning node's replication status (node listener,
// GET /nodes/{node}/tenants/{tenant}/replication) plus the control plane's
// own record of the last failover. When the node does not answer within 2 s
// the answer is the last status seen, with `stale: true`.

import type { Context, Hono } from "hono";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { operation } from "../audit.ts";
import { appViews } from "../apps/repo.ts";
import { actorOf } from "../context.ts";
import { deploymentView, type Actor } from "../deployments/repo.ts";
import { ApiError, conflict, notFound } from "../errors.ts";
import { jsonBody, readBody } from "../http.ts";
import { ulid } from "../ids.ts";
import { logIngest } from "../ingest/logs.ts";
import { assertNotMoving } from "../ops/tenants.ts";
import { activate } from "../routes/activation.ts";
import { crossTenant } from "../tenancy/scope.ts";
import { tenantAuth } from "../auth/middleware.ts";
import type { Deps, Env } from "../context.ts";
import type { Db } from "../db/db.ts";
import { pathParam } from "../http.ts";
import { requireApp } from "../apps/repo.ts";
import { tenantDb } from "../tenancy/scope.ts";
import { lastFailover, nodeCall, nodeTarget } from "../workers/failover.ts";
import { recordReplication } from "../workers/health.ts";

/** How long getBackups waits for the node. */
export const STATUS_TIMEOUT_MS = 2_000;

/** docs/04-isolation-security.md "Per-tenant limits": the database quota per tier. */
export const DB_QUOTA_BYTES = { free: 100 * 1024 * 1024, paid: 10 * 1024 * 1024 * 1024 } as const;

interface NodeStatus {
  replication: "none" | "litestream";
  state: "off" | "starting" | "replicating" | "stopped";
  replica: { kind: "file" | "s3"; region?: string } | null;
  last_sync_at: number | null;
  lag_seconds: number | null;
  retention_hours: number;
  generations: { id: string; start: number; end: number }[];
  db: { size_bytes: number; quota_bytes: number; wal_bytes: number };
}

const lastSeen = new WeakMap<Deps, Map<string, NodeStatus>>();

/** The database id of an app (deploy-api.md section 3): its own, or the tenant's shared file. */
export async function databaseOf(db: Db, tenantId: string, app: string): Promise<string> {
  const rows = await db.query<{ database: string | null }>("select database from apps where tenant_id = $1 and name = $2", [tenantId, app]);
  return rows[0]?.database ?? tenantId;
}

/** The node that serves the tenant now (its route entries), or null. */
export async function owningNode(db: Db, tenantId: string): Promise<string | null> {
  const rows = await db.query<{ node_id: string }>(
    "select node_id from route_entries where tenant_id = $1 order by status, version desc limit 1",
    [tenantId],
  );
  return rows[0]?.node_id ?? null;
}

/** The node's replication status of `database`, or null when it did not answer. */
export async function nodeStatus(deps: Deps, db: Db, tenantId: string, database: string): Promise<NodeStatus | null> {
  const node = await owningNode(db, tenantId);
  if (node === null) return null;
  const target = await nodeTarget(deps, db, node);
  try {
    const res = await nodeCall(deps)(target, "GET", `/nodes/${node}/tenants/${tenantId}/replication?database=${encodeURIComponent(database)}`, undefined, STATUS_TIMEOUT_MS);
    if (res.status !== 200) return null;
    const status = res.body as NodeStatus;
    // The last report, for the operator console (getOpsTenant, #296).
    await recordReplication(db, tenantId, database, node, status, deps.now());
    return status;
  } catch {
    return null;
  }
}

export function registerBackups(app: Hono<Env>, deps: Deps): void {
  app.get("/v1/apps/:app/backups", operation(deps, "getBackups"), tenantAuth(deps, "apps:read"), async (c) => {
    const db = tenantDb(deps, c);
    const tenant = db.tenantId;
    const row = await requireApp(db, tenant, pathParam(c, "app", "AppName"));
    const database = await databaseOf(db, tenant, row.name);
    const tierRows = await db.query<{ tier: "free" | "paid" }>("select tier from tenants where id = $1", [tenant]);
    const quota = DB_QUOTA_BYTES[tierRows[0]?.tier ?? "free"];
    let seen = lastSeen.get(deps);
    if (seen === undefined) {
      seen = new Map();
      lastSeen.set(deps, seen);
    }
    const key = `${tenant}/${database}`;
    const fresh = await nodeStatus(deps, db, tenant, database);
    if (fresh !== null) seen.set(key, fresh);
    const s = fresh ?? seen.get(key) ?? null;
    const failover = await lastFailover(db, tenant);
    return c.json({
      app: row.name,
      database,
      replication: s?.replication ?? "none",
      state: s?.state ?? "off",
      replica: s?.replica ?? null,
      last_sync_at: s?.last_sync_at ?? null,
      lag_seconds: s?.lag_seconds ?? null,
      retention_hours: s?.retention_hours ?? 0,
      generations: s?.generations ?? [],
      db: { size_bytes: s?.db.size_bytes ?? 0, quota_bytes: quota, wal_bytes: s?.db.wal_bytes ?? 0 },
      last_failover: failover,
      stale: fresh === null,
    });
  });
}

// ---- Export, restore, import (#258) ----

/** deploy-api.md section 14: a signed export URL lives at most this long. */
export const EXPORT_MAX_SECONDS = 900;
/** Exports are deleted after a day. */
export const EXPORT_KEEP_MS = 24 * 3600 * 1000;

const unavailable = (field: string, reason: string) => new ApiError("RENOX_BACKUP_UNAVAILABLE", [{ field, reason }], { retryAfter: 30 });

/** The HMAC key of the API's own signed download URLs (stores that cannot presign). */
function signingKey(deps: Deps): Buffer {
  return createHmac("sha256", deps.config.masterKey ?? "renox-no-master-key").update("exports\n").digest();
}

export function signExport(deps: Deps, id: string, expires: number): string {
  return createHmac("sha256", signingKey(deps)).update(`${id}\n${expires}`).digest("hex");
}

async function audited(deps: Deps, c: Context<Env>, target: Record<string, string>): Promise<void> {
  c.set("auditTarget", target);
  void deps;
}

/** The node behind the tenant, with its listener, or 503. */
async function nodeOf(deps: Deps, db: Db, tenantId: string): Promise<{ node: string; target: Awaited<ReturnType<typeof nodeTarget>> }> {
  const node = await owningNode(db, tenantId);
  if (node === null) throw unavailable("node", "no node serves the tenant");
  const target = await nodeTarget(deps, db, node);
  if (target.listen_url === null || target.token === null) throw unavailable("node", "the node has no listener");
  return { node, target };
}

export function registerBackupActions(app: Hono<Env>, deps: Deps): void {
  app.post("/v1/apps/:app/backups/export", operation(deps, "exportBackup"), tenantAuth(deps, "apps:write"), async (c) => {
    const db = tenantDb(deps, c);
    const tenant = db.tenantId;
    const row = await requireApp(db, tenant, pathParam(c, "app", "AppName"));
    const { expires_in_seconds: seconds = EXPORT_MAX_SECONDS } = await jsonBody<{ expires_in_seconds?: number }>(c, "ExportRequest");
    await assertNotMoving(db, tenant);
    const database = await databaseOf(db, tenant, row.name);
    const { node, target } = await nodeOf(deps, db, tenant);
    if (target.listen_url === null) throw unavailable("node", "unreachable");
    let res: Response;
    try {
      res = await fetchNode(deps, target, "POST", `/nodes/${node}/tenants/${tenant}/snapshot?database=${encodeURIComponent(database)}`);
    } catch {
      throw unavailable("node", "unreachable");
    }
    if (res.status !== 200) throw unavailable("node", `snapshot answered ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (res.headers.get("x-renox-sha256") !== sha256) throw unavailable("snapshot", "checksum mismatch");
    const now = deps.now();
    const id = `exp_${ulid(now)}`;
    const key = `exports/${tenant}/${database}/${now}.db`;
    // #308: SSE-KMS with the export key (the bucket refuses anything else).
    const kms = deps.config.exportKmsKeyId ?? null;
    await deps.store.put(key, bytes, kms === null ? {} : { sseKmsKeyId: kms });
    const expires = now + seconds * 1000;
    await db.query("insert into exports (id, tenant_id, app, object_key, sha256, size_bytes, created_at, expires_at) values ($2, $1, $3, $4, $5, $6, $7, $8)", [
      tenant,
      id,
      row.name,
      key,
      sha256,
      bytes.length,
      now,
      now + EXPORT_KEEP_MS,
    ]);
    const url = deps.store.presign(key, seconds) ?? `https://api.${deps.config.platformDomain}/v1/exports/${id}?expires=${expires}&sig=${signExport(deps, id, expires)}`;
    await audited(deps, c, { app: row.name, size_bytes: String(bytes.length), sha256 });
    await platformLine(deps, db, tenant, row.name, "export", `export of ${database} (${bytes.length} bytes)`);
    return c.json({ url, expires_at: expires, created_at: now, size_bytes: bytes.length, sha256, masking: "none" }, 201);
  });

  // The download of a store that cannot presign (memory store, tests): only
  // with a valid, unexpired signature; the bare path is 404.
  app.get("/v1/exports/:id", async (c) => {
    const id = c.req.param("id");
    const expires = Number(c.req.query("expires"));
    const sig = c.req.query("sig") ?? "";
    if (!/^exp_[0-9A-Za-z]{26}$/u.test(id) || !Number.isFinite(expires) || !/^[0-9a-f]{64}$/u.test(sig)) throw notFound();
    const want = Buffer.from(signExport(deps, id, expires), "hex");
    if (!timingSafeEqual(want, Buffer.from(sig, "hex")) || deps.now() > expires) throw new ApiError("RENOX_TOKEN_SCOPE");
    const rows = await crossTenant(deps.db, "a signed export URL names its export, not a tenant").query<{ object_key: string }>("select object_key from exports where id = $1", [id]);
    const key = rows[0]?.object_key;
    const bytes = key === undefined ? null : await deps.store.get(key);
    if (bytes === null) throw notFound();
    return new Response(bytes as unknown as BodyInit, { headers: { "content-type": "application/vnd.sqlite3", "cache-control": "no-store", "content-disposition": `attachment; filename="${id}.db"` } });
  });

  app.post("/v1/apps/:app/backups/restore", operation(deps, "restoreBackup"), tenantAuth(deps, "apps:write"), async (c) => {
    const db = tenantDb(deps, c);
    const tenant = db.tenantId;
    const source = await requireApp(db, tenant, pathParam(c, "app", "AppName"));
    const body = await jsonBody<{ timestamp: number; target: "new_app"; name: string }>(c, "RestoreRequest");
    const taken = await crossTenant(db, "app names are unique across the platform").query("select 1 from apps where name = $1", [body.name]);
    if (taken.length > 0) throw conflict("name", "not available");
    const active = await db.query<{ hash: string }>("select hash from deployments where tenant_id = $1 and app = $2 and state = 'active'", [tenant, source.name]);
    const hash = active[0]?.hash;
    if (hash === undefined) throw conflict("app", "the source app has no active deployment");
    const sourceDb = await databaseOf(db, tenant, source.name);
    const database = `${tenant}.${body.name}`;
    const { node, target } = await nodeOf(deps, db, tenant);
    const res = await nodeCall(deps)(target, "POST", `/nodes/${node}/tenants/${tenant}/restore`, {
      type: "restore_request",
      schema_version: 0,
      tenant_id: tenant,
      database,
      source_database: sourceDb,
      timestamp: body.timestamp,
      reason: "restore",
      deadline_ms: 60_000,
    }, 61_000).catch(() => ({ status: 0, body: null }));
    if (res.status === 422) throw new ApiError("RENOX_RESTORE_POINT_UNKNOWN", [{ field: "timestamp", reason: "no generation covers it" }]);
    if (res.status !== 200) throw unavailable("restore", res.status === 0 ? "node unreachable" : `node answered ${res.status}`);
    const restored = res.body as { generation: string; restored_to: number | null };
    const now = deps.now();
    await db.transaction(async (tx) => {
      await tx.query("insert into apps (name, tenant_id, created_at, staging, database) values ($1, $2, $3, false, $4)", [body.name, tenant, now, database]);
      await tx.query("insert into secret_sets (app, tenant_id, version) values ($1, $2, 0)", [body.name, tenant]);
      const [d] = await tx.query<{ size_bytes: unknown; manifest: unknown }>("select size_bytes, manifest from deployments where tenant_id = $1 and app = $2 and hash = $3", [tenant, source.name, hash]);
      await tx.query("insert into deployments (tenant_id, app, hash, state, created_at, updated_at, size_bytes, manifest) values ($1, $2, $3, 'validated', $4, $4, $5, $6::text::jsonb)", [
        tenant,
        body.name,
        hash,
        now,
        d?.size_bytes ?? 0,
        JSON.stringify(d?.manifest ?? null),
      ]);
      for (const p of await tx.query<{ kind: string; value: string }>("select kind, value from permissions where tenant_id = $1 and app = $2 and hash = $3", [tenant, source.name, hash])) {
        await tx.query("insert into permissions (tenant_id, app, hash, kind, value, approved_at) values ($1, $2, $3, $4, $5, $6)", [tenant, body.name, hash, p.kind, p.value, now]);
      }
    });
    const by: Actor = { actor: actorOf(c.get("principal")), requestId: c.get("requestId"), now };
    const deployment = await activate(deps, db, body.name, hash, by);
    const [view] = await appViews(db, deps.config.platformDomain, [await requireApp(db, tenant, body.name)]);
    await audited(deps, c, { app: source.name, new_app: body.name, timestamp: String(body.timestamp), generation: restored.generation });
    await platformLine(deps, db, tenant, source.name, "restore", `restore of ${sourceDb} as of ${body.timestamp} into ${body.name}`);
    return c.json({ app: view, deployment: deploymentView(deployment), source_app: source.name, database, generation: restored.generation, restored_to: restored.restored_to }, 201);
  });

  app.post("/v1/apps/:app/db/import", operation(deps, "importDatabase"), tenantAuth(deps, "apps:write"), async (c) => {
    const db = tenantDb(deps, c);
    const tenant = db.tenantId;
    const row = await requireApp(db, tenant, pathParam(c, "app", "AppName"));
    const flags = await db.query<{ staging: boolean; database: string | null }>("select staging, database from apps where tenant_id = $1 and name = $2", [tenant, row.name]);
    if (flags[0]?.staging !== true || flags[0].database === null) throw new ApiError("RENOX_IMPORT_REJECTED", [{ field: "app", reason: "not a staging app" }]);
    await assertNotMoving(db, tenant);
    const tierRows = await db.query<{ tier: "free" | "paid" }>("select tier from tenants where id = $1", [tenant]);
    const bytes = await readBody(c, DB_QUOTA_BYTES[tierRows[0]?.tier ?? "free"]);
    const database = flags[0].database;
    const { node, target } = await nodeOf(deps, db, tenant);
    let res: Response;
    try {
      res = await fetchNode(deps, target, "PUT", `/nodes/${node}/tenants/${tenant}/import?database=${encodeURIComponent(database)}`, bytes);
    } catch {
      throw unavailable("node", "unreachable");
    }
    const answer = (await res.json().catch(() => null)) as { tables?: string[]; error?: { details?: { field: string; reason: string }[] } } | null;
    if (res.status === 422) throw new ApiError("RENOX_IMPORT_REJECTED", answer?.error?.details ?? [{ field: "file", reason: "refused by the node" }]);
    if (res.status === 413) throw new ApiError("RENOX_BODY_TOO_LARGE");
    if (res.status !== 200) throw unavailable("node", `import answered ${res.status}`);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await audited(deps, c, { app: row.name, size_bytes: String(bytes.length), sha256 });
    await platformLine(deps, db, tenant, row.name, "import", `import into ${database} (${bytes.length} bytes)`);
    return c.json({ app: row.name, database, size_bytes: bytes.length, sha256, tables: answer?.tables ?? [] });
  });
}

/** A raw call to a node listener (bodies that are not JSON). */
async function fetchNode(deps: Deps, target: { node_id: string; listen_url: string | null; token: string | null }, method: string, path: string, body?: Uint8Array): Promise<Response> {
  const hook = rawCalls.get(deps);
  if (hook !== undefined) return hook(target.node_id, method, path, body);
  return fetch(`${(target.listen_url as string).replace(/\/$/u, "")}${path}`, {
    method,
    headers: { authorization: `Bearer ${target.token as string}`, ...(body === undefined ? {} : { "content-type": "application/vnd.sqlite3" }) },
    body: body as unknown as BodyInit | undefined,
    signal: AbortSignal.timeout(120_000),
  });
}

/** Tests: the node behind snapshot and import. */
export type RawNodeCall = (node: string, method: string, path: string, body?: Uint8Array) => Promise<Response>;
const rawCalls = new WeakMap<Deps, RawNodeCall>();
export function setRawNodeCall(deps: Deps, call: RawNodeCall): void {
  rawCalls.set(deps, call);
}

/** One `source: platform` line for the app (deploy-api.md section 11). */
async function platformLine(deps: Deps, db: Db, tenantId: string, app: string, kind: string, message: string): Promise<void> {
  const rows = await db.query<{ hash: string }>("select hash from deployments where tenant_id = $1 and app = $2 and state = 'active'", [tenantId, app]);
  await logIngest(deps).store.append([
    { ts: deps.now(), tenant_id: tenantId, deployment_hash: rows[0]?.hash ?? "0".repeat(64), request_id: null, module: "platform", level: "info", message, fields: { kind }, source: "platform", node_id: "control-plane", app },
  ]);
}
