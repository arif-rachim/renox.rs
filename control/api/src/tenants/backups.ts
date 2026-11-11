// Backups of an app's database (docs/contracts/deploy-api.md 0.3 section 14).
// getBackups (#257): the owning node's replication status (node listener,
// GET /nodes/{node}/tenants/{tenant}/replication) plus the control plane's
// own record of the last failover. When the node does not answer within 2 s
// the answer is the last status seen, with `stale: true`.

import type { Context, Hono } from "hono";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { operation, writeAudit } from "../audit.ts";
import { appViews } from "../apps/repo.ts";
import { actorOf } from "../context.ts";
import { artifactKey, deploymentView, findDeployment, type Actor } from "../deployments/repo.ts";
import { ApiError, conflict, notFound } from "../errors.ts";
import { jsonBody, readBody } from "../http.ts";
import { ulid } from "../ids.ts";
import { logIngest } from "../ingest/logs.ts";
import { assertNotMoving } from "../ops/tenants.ts";
import { activate } from "../routes/activation.ts";
import { crossTenant } from "../tenancy/scope.ts";
import { masterKeys } from "../secrets/master.ts";
import { tenantAuth } from "../auth/middleware.ts";
import type { Deps, Env } from "../context.ts";
import { num, type Db } from "../db/db.ts";
import { pathParam } from "../http.ts";
import { requireApp } from "../apps/repo.ts";
import { holdingApps } from "../apps/busy.ts";
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
  const rows = await db.query<{ database: string | null }>("select database from apps where tenant_id = $1 and name = $2 and deleted_at is null", [tenantId, app]);
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

/** The HMAC key of the API's own signed download URLs (stores that cannot presign), from one master key's text. */
function signingKey(masterText: string): Buffer {
  return createHmac("sha256", masterText).update("exports\n").digest();
}

/** The master keys' texts, current first (#451); the fixed fallback without a master key. */
function signingTexts(deps: Deps): string[] {
  const keys = masterKeys(deps);
  return keys === null ? ["renox-no-master-key"] : keys.all().map((k) => k.text);
}

const signWith = (text: string, id: string, expires: number): string => createHmac("sha256", signingKey(text)).update(`${id}\n${expires}`).digest("hex");

export function signExport(deps: Deps, id: string, expires: number): string {
  return signWith(signingTexts(deps)[0] as string, id, expires);
}

/**
 * Whether `sig` signs the export under the current master key or, during a
 * rotation (#451), the previous one: a URL lives 15 minutes and is not
 * stored, so there is nothing to re-seal.
 */
export function exportSignatureValid(deps: Deps, id: string, expires: number, sig: string): boolean {
  const got = Buffer.from(sig, "hex");
  return signingTexts(deps).some((t) => {
    const want = Buffer.from(signWith(t, id, expires), "hex");
    return want.length === got.length && timingSafeEqual(want, got);
  });
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

/** What every export answers (deploy-api.md 0.8 section 14); `exportFiles` adds `files`, `exportBackup` adds `masking`. */
export interface ExportAnswer {
  url: string;
  expires_at: number;
  created_at: number;
  size_bytes: number;
  sha256: string;
  kind: "database" | "files" | "artifact";
  hash?: string;
}

export interface StoreExportInput {
  tenant: string;
  app: string;
  database: string;
  kind: "database" | "files" | "artifact";
  /** The deployment of an `artifact` export; null otherwise. */
  hash: string | null;
  /** The key's ending after `<created_at>.`: `db`, `files.tar.gz`, `artifact.tar.gz`. */
  suffix: string;
  body: Uint8Array;
  /** The checksum the source claims for `body`; null when the control plane read the source itself (artifact). A different one stores nothing. */
  expectedSha: string | null;
  seconds: number;
}

/**
 * Stores one export under `exports/<tenant>/<database>/<now>.<suffix>`: checks
 * the SHA-256 against `expectedSha` first (503 and nothing stored otherwise),
 * puts the object, inserts the `exports` row and signs the URL. The object
 * store takes whole objects (no streaming put), so the body is held in memory
 * as `exportBackup` always did.
 */
export async function storeExport(deps: Deps, db: Db, input: StoreExportInput): Promise<ExportAnswer> {
  const { tenant, app, database, kind, hash, suffix, body, expectedSha, seconds } = input;
  const sha256 = createHash("sha256").update(body).digest("hex");
  if (expectedSha !== null && expectedSha !== sha256) throw unavailable(kind === "database" ? "snapshot" : kind, "checksum mismatch");
  const now = deps.now();
  const id = `exp_${ulid(now)}`;
  const key = `exports/${tenant}/${database}/${now}.${suffix}`;
  // #308: SSE-KMS with the export key (the bucket refuses anything else).
  const kms = deps.config.exportKmsKeyId ?? null;
  await deps.store.put(key, body, kms === null ? {} : { sseKmsKeyId: kms });
  const expires = now + seconds * 1000;
  await db.query("insert into exports (id, tenant_id, app, object_key, sha256, size_bytes, created_at, expires_at, kind, hash) values ($2, $1, $3, $4, $5, $6, $7, $8, $9, $10)", [
    tenant,
    id,
    app,
    key,
    sha256,
    body.length,
    now,
    now + EXPORT_KEEP_MS,
    kind,
    hash,
  ]);
  const url = deps.store.presign(key, seconds) ?? `https://api.${deps.config.platformDomain}/v1/exports/${id}?expires=${expires}&sig=${signExport(deps, id, expires)}`;
  return { url, expires_at: expires, created_at: now, size_bytes: body.length, sha256, kind, ...(hash === null ? {} : { hash }) };
}

/** The content type and file name suffix of the API download, by the row's `kind` (0.11.2, #703). */
const EXPORT_DOWNLOAD: Record<string, { type: string; suffix: string }> = {
  database: { type: "application/vnd.sqlite3", suffix: "db" },
  files: { type: "application/x-tar+gzip", suffix: "files.tar.gz" },
  artifact: { type: "application/gzip", suffix: "artifact.tar.gz" },
};

/** Rows an expiry run handles at most. */
export const EXPORT_SWEEP_LIMIT = 500;

/**
 * The export expiry sweep (0.11.2, #703), hourly: for each `exports` row past
 * its `expires_at` (at most 500 per run, oldest first) the object is deleted
 * from the store, then the row; a missing object is not an error, a store that
 * fails keeps the row for the next run. One `exportsExpired` audit row names
 * the count per kind, never a key. Answers the number of rows deleted.
 */
export async function sweepExports(deps: Deps): Promise<number> {
  const now = deps.now();
  const due = await deps.db.query<{ id: string; object_key: string; kind: string }>("select id, object_key, kind from exports where expires_at < $1 order by expires_at, id limit $2", [now, EXPORT_SWEEP_LIMIT]);
  const counts: Record<string, number> = {};
  let deleted = 0;
  for (const row of due) {
    try {
      await deps.store.delete(row.object_key);
      await deps.db.query("delete from exports where id = $1", [row.id]);
    } catch (e) {
      deps.log.warn("export expiry failed", { export_id: row.id, error: e instanceof Error ? e.name : "error" });
      continue;
    }
    counts[row.kind] = (counts[row.kind] ?? 0) + 1;
    deleted++;
  }
  if (deleted > 0)
    await writeAudit(deps.db, { at: now, tenantId: null, actor: "platform", action: "exportsExpired", target: Object.fromEntries(Object.entries(counts).map(([k, n]) => [k, String(n)])), status: 200, requestId: `req_${ulid(now)}` });
  return deleted;
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
    const stored = await storeExport(deps, db, { tenant, app: row.name, database, kind: "database", hash: null, suffix: "db", body: bytes, expectedSha: res.headers.get("x-renox-sha256"), seconds });
    await audited(deps, c, { app: row.name, size_bytes: String(stored.size_bytes), sha256: stored.sha256 });
    await platformLine(deps, db, tenant, row.name, "export", `export of ${database} (${stored.size_bytes} bytes)`);
    return c.json({ ...stored, masking: "none" }, 201);
  });

  // 0.8 (#671): the app's files as a tar.gz from the owning node.
  app.post("/v1/apps/:app/files/export", operation(deps, "exportFiles"), tenantAuth(deps, "apps:write"), async (c) => {
    const db = tenantDb(deps, c);
    const tenant = db.tenantId;
    const row = await requireApp(db, tenant, pathParam(c, "app", "AppName"));
    const { expires_in_seconds: seconds = EXPORT_MAX_SECONDS } = await jsonBody<{ expires_in_seconds?: number }>(c, "ExportRequest");
    await assertNotMoving(db, tenant);
    const database = await databaseOf(db, tenant, row.name);
    const { node, target } = await nodeOf(deps, db, tenant);
    let res: Response;
    try {
      res = await fetchNode(deps, target, "GET", `/nodes/${node}/tenants/${tenant}/files?database=${encodeURIComponent(database)}`);
    } catch {
      throw unavailable("node", "unreachable");
    }
    if (res.status === 503 && ((await res.clone().json().catch(() => null)) as { error?: { code?: string } } | null)?.error?.code === "RENOX_TENANT_MOVING") {
      throw new ApiError("RENOX_TENANT_MOVING", undefined, { retryAfter: 30 });
    }
    if (res.status !== 200) throw unavailable("node", `files answered ${res.status}`);
    const header = res.headers.get("x-renox-files");
    if (header === null || !/^(0|[1-9][0-9]{0,15})$/u.test(header)) throw unavailable("files", "the node did not count the files");
    const files = Number(header);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const stored = await storeExport(deps, db, { tenant, app: row.name, database, kind: "files", hash: null, suffix: "files.tar.gz", body: bytes, expectedSha: res.headers.get("x-renox-sha256"), seconds });
    await audited(deps, c, { app: row.name, size_bytes: String(stored.size_bytes), sha256: stored.sha256, files: String(files) });
    await platformLine(deps, db, tenant, row.name, "export", `export of the files of ${database} (${files} files, ${stored.size_bytes} bytes)`);
    return c.json({ ...stored, files }, 201);
  });

  // 0.8 (#671): a copy of a deployment's artifact; the artifact object itself is never signed or deleted here.
  app.post("/v1/apps/:app/deployments/:hash/export", operation(deps, "exportArtifact"), tenantAuth(deps, "apps:write"), async (c) => {
    const db = tenantDb(deps, c);
    const tenant = db.tenantId;
    const row = await requireApp(db, tenant, pathParam(c, "app", "AppName"));
    const hash = pathParam(c, "hash", "Sha256");
    // The 404 first: a hash that is not the app's answers 404 whatever the body.
    const deployment = await findDeployment(db, tenant, row.name, hash);
    if (deployment === null || (deployment.state !== "active" && deployment.state !== "superseded")) throw notFound();
    const { expires_in_seconds: seconds = EXPORT_MAX_SECONDS } = await jsonBody<{ expires_in_seconds?: number }>(c, "ExportRequest");
    const database = await databaseOf(db, tenant, row.name);
    let bytes: Uint8Array | null;
    try {
      bytes = await deps.store.get(artifactKey(hash));
    } catch {
      throw unavailable("store", "unreachable");
    }
    if (bytes === null) throw unavailable("artifact", "the artifact object is missing");
    // The artifact object is the uncompressed tar (section 7); the export is its gzip (0.10.1, #674).
    const gz = bytes[0] === 0x1f && bytes[1] === 0x8b ? bytes : Bun.gzipSync(new Uint8Array(bytes));
    let stored: ExportAnswer;
    try {
      stored = await storeExport(deps, db, { tenant, app: row.name, database, kind: "artifact", hash, suffix: "artifact.tar.gz", body: gz, expectedSha: null, seconds });
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw unavailable("store", "the copy could not be written");
    }
    await audited(deps, c, { app: row.name, hash, size_bytes: String(stored.size_bytes), sha256: stored.sha256 });
    await platformLine(deps, db, tenant, row.name, "export", `export of the artifact ${hash} (${stored.size_bytes} bytes)`);
    return c.json(stored, 201);
  });

  // The download of a store that cannot presign (memory store, tests): only
  // with a valid, unexpired signature; the bare path is 404.
  app.get("/v1/exports/:id", async (c) => {
    const id = c.req.param("id");
    const expires = Number(c.req.query("expires"));
    const sig = c.req.query("sig") ?? "";
    if (!/^exp_[0-9A-Za-z]{26}$/u.test(id) || !Number.isFinite(expires) || !/^[0-9a-f]{64}$/u.test(sig)) throw notFound();
    if (!exportSignatureValid(deps, id, expires, sig) || deps.now() > expires) throw new ApiError("RENOX_TOKEN_SCOPE");
    // An expired row is 404 even before the sweep has deleted it (0.11.2, #703).
    const rows = await crossTenant(deps.db, "a signed export URL names its export, not a tenant").query<{ object_key: string; app: string; kind: string; created_at: unknown }>("select object_key, app, kind, created_at from exports where id = $1 and expires_at >= $2", [id, deps.now()]);
    const row = rows[0];
    const bytes = row === undefined ? null : await deps.store.get(row.object_key);
    if (row === undefined || bytes === null) throw notFound();
    const { type, suffix } = EXPORT_DOWNLOAD[row.kind] ?? (EXPORT_DOWNLOAD.database as { type: string; suffix: string });
    return new Response(bytes as unknown as BodyInit, { headers: { "content-type": type, "cache-control": "no-store", "content-disposition": `attachment; filename="${row.app}-${num(row.created_at)}.${suffix}"` } });
  });

  app.post("/v1/apps/:app/backups/restore", operation(deps, "restoreBackup"), tenantAuth(deps, "apps:write"), async (c) => {
    const db = tenantDb(deps, c);
    const tenant = db.tenantId;
    const source = await requireApp(db, tenant, pathParam(c, "app", "AppName"));
    const body = await jsonBody<{ timestamp: number; target: "new_app"; name: string }>(c, "RestoreRequest");
    const taken = await crossTenant(db, "app names are unique across the platform").query("select 1 from apps where name = $1", [body.name]);
    if (taken.length > 0) throw conflict("name", "not available");
    // 0.7 (#537): a renamed app keeps its database id `<tenant_id>.<old name>`; a restore never writes over it.
    if ((await db.query("select 1 from apps where tenant_id = $1 and database = $2", [tenant, `${tenant}.${body.name}`])).length > 0) throw conflict("name", "not available");
    // 0.7 (#536): the source app cannot be deleted while its restore runs.
    return holdingApps(deps, tenant, [source.name], "restore in progress", async () => {
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
  });

  app.post("/v1/apps/:app/db/import", operation(deps, "importDatabase"), tenantAuth(deps, "apps:write"), async (c) => {
    const db = tenantDb(deps, c);
    const tenant = db.tenantId;
    const row = await requireApp(db, tenant, pathParam(c, "app", "AppName"));
    const flags = await db.query<{ staging: boolean; database: string | null }>("select staging, database from apps where tenant_id = $1 and name = $2 and deleted_at is null", [tenant, row.name]);
    if (flags[0]?.staging !== true || flags[0].database === null) throw new ApiError("RENOX_IMPORT_REJECTED", [{ field: "app", reason: "not a staging app" }]);
    await assertNotMoving(db, tenant);
    const database = flags[0].database;
    // 0.7 (#536): the app cannot be deleted while its import runs.
    return holdingApps(deps, tenant, [row.name], "import in progress", async () => {
      const tierRows = await db.query<{ tier: "free" | "paid" }>("select tier from tenants where id = $1", [tenant]);
      const bytes = await readBody(c, DB_QUOTA_BYTES[tierRows[0]?.tier ?? "free"]);
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
