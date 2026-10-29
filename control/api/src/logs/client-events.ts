// Browser errors in the tenant's logs (#128; deploy-api.md sections 11 and
// 11.1, client-events.md): grouping at ingestion, the group endpoints, and
// the daily client-event quota the usage view reports.
//
//   GET  /v1/apps/{app}/client-errors                 listClientErrors      (logs:read)
//   GET  /v1/apps/{app}/client-errors/{fingerprint}   getClientError        (logs:read)
//   POST /v1/apps/{app}/client-errors/{fingerprint}   setClientErrorStatus  (apps:write)
//
// Events arrive as log lines with `source: "client"` (ingest/logs.ts calls
// recordClientEvents for the accepted ones). Each is stored with its raw
// frames; original positions are looked up in the private sourcemaps of the
// event's deployment when a group or event is read, never at the origin.

import type { Hono } from "hono";
import { operation } from "../audit.ts";
import { tenantAuth } from "../auth/middleware.ts";
import type { Deps, Env } from "../context.ts";
import { jsonb, num, numOrNull, type Db } from "../db/db.ts";
import { ApiError, invalid } from "../errors.ts";
import { jsonBody, pathParam } from "../http.ts";
import { requireApp } from "../apps/repo.ts";
import type { StoredLine } from "../ingest/logs.ts";
import { Symbolicator, type Original } from "../sourcemaps/symbolicate.ts";
import { tenantDb } from "../tenancy/scope.ts";
import { fingerprintOf, framesOf, type RawFrame } from "./grouping.ts";

/** Events kept per group (the contract's "last 20 events"). */
export const EVENTS_KEPT = 20;
/** client-events.md section 7: events per day, free and paid (10 % of the daily log allowance; proposed). */
export const CLIENT_EVENTS_DAILY_CAP = { free: 144_000, paid: 1_440_000 } as const;
/** The dashboard warns from this share of the cap. */
export const WARNING_SHARE = 0.8;

const STATUSES = ["open", "resolved", "ignored"] as const;
type Status = (typeof STATUSES)[number];

const FINGERPRINT = /^[0-9a-f]{16}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const CURSOR = /^[0-9]{1,16}\.[0-9a-f]{16}$/u;

const symbolicators = new WeakMap<Deps, Symbolicator>();
const symbolicator = (deps: Deps): Symbolicator => {
  let s = symbolicators.get(deps);
  if (s === undefined) {
    s = new Symbolicator(deps.store);
    symbolicators.set(deps, s);
  }
  return s;
};

const cut = (s: string, n: number): string => (s.length <= n ? s : s.slice(0, n));
const intOr = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : fallback);

/** The quota the usage view reports (deploy-api.md section 11): events today against the daily cap. */
export async function clientEventsQuota(db: Db, tenantId: string, usedToday: number): Promise<{ used_today: number; daily_cap: number; warning: boolean }> {
  const rows = await db.query<{ tier: "free" | "paid" }>("select tier from tenants where id = $1", [tenantId]);
  const cap = CLIENT_EVENTS_DAILY_CAP[rows[0]?.tier ?? "free"];
  return { used_today: Math.min(usedToday, cap), daily_cap: cap, warning: usedToday >= cap * WARNING_SHARE };
}

/**
 * Groups the accepted `source: client` lines of one ingest batch: one group
 * per fingerprint, counts per deployment, the last EVENTS_KEPT events, and
 * regression detection (a resolved group seen on a newer deployment reopens).
 * Lines whose `fields.kind` is missing are not events and are skipped.
 * Returns each recorded line's fingerprint, which the caller stores in
 * `fields.fingerprint` so the Logs page can link the line to its group.
 */
export async function recordClientEvents(db: Db, lines: readonly StoredLine[]): Promise<Map<StoredLine, string>> {
  const events = lines.filter((l) => l.source === "client" && typeof l.fields?.kind === "string");
  const fingerprints = new Map<StoredLine, string>();
  if (events.length === 0) return fingerprints;
  await db.transaction(async (tx) => {
    const created = new Map<string, number>();
    for (const tenant of new Set(events.map((e) => e.tenant_id))) {
      const hashes = [...new Set(events.filter((e) => e.tenant_id === tenant).map((e) => e.deployment_hash))];
      for (const r of await tx.query<{ hash: string; created_at: unknown }>("select hash, created_at from deployments where tenant_id = $1 and hash = any($2::text[])", [tenant, hashes])) {
        created.set(`${tenant} ${r.hash}`, num(r.created_at));
      }
    }
    for (const e of events) {
      const fields = e.fields as Record<string, unknown>;
      const kind = fields.kind as string;
      const frames = framesOf(e);
      const fingerprint = fingerprintOf(kind, e, frames);
      fingerprints.set(e, fingerprint);
      const top = frames[0] ?? null;
      const message = cut(e.message, 2048);
      const deployedAt = created.get(`${e.tenant_id} ${e.deployment_hash}`) ?? 0;
      const existing = (
        await tx.query<{ status: Status; resolved_after: unknown }>("select status, resolved_after from client_error_groups where tenant_id = $1 and app = $2 and fingerprint = $3 for update", [e.tenant_id, e.app, fingerprint])
      )[0];
      if (existing === undefined) {
        await tx.query(
          `insert into client_error_groups (tenant_id, app, fingerprint, kind, message, top_frame, top_deployment, status, first_seen, last_seen, count)
           values ($1, $2, $3, $4, $5, $6::text::jsonb, $7, 'open', $8, $8, 1)`,
          [e.tenant_id, e.app, fingerprint, kind, message, top === null ? null : jsonb(top), e.deployment_hash, e.ts],
        );
      } else {
        const resolvedAfter = numOrNull(existing.resolved_after);
        const regress = existing.status === "resolved" && resolvedAfter !== null && deployedAt > resolvedAfter;
        await tx.query(
          `update client_error_groups set kind = $4, message = $5, top_frame = $6::text::jsonb, top_deployment = $7, count = count + 1,
             first_seen = least(first_seen, $8), last_seen = greatest(last_seen, $8),
             status = case when $9 then 'open' else status end, regressed = case when $9 then true else regressed end,
             resolved_after = case when $9 then null else resolved_after end
           where tenant_id = $1 and app = $2 and fingerprint = $3`,
          [e.tenant_id, e.app, fingerprint, kind, message, top === null ? null : jsonb(top), e.deployment_hash, e.ts, regress],
        );
      }
      await tx.query(
        `insert into client_error_deployments (tenant_id, app, fingerprint, deployment_hash, count) values ($1, $2, $3, $4, 1)
         on conflict (app, fingerprint, deployment_hash) do update set count = client_error_deployments.count + 1`,
        [e.tenant_id, e.app, fingerprint, e.deployment_hash],
      );
      await tx.query(
        `insert into client_error_events (tenant_id, app, fingerprint, ts, client_ts, deployment_hash, request_id, message, url, ua, frames)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::text::jsonb)`,
        [e.tenant_id, e.app, fingerprint, e.ts, intOr(fields.client_ts, e.ts), e.deployment_hash, e.request_id, message, cut(typeof fields.url === "string" ? fields.url : "/", 2048), typeof fields.ua === "string" ? cut(fields.ua, 64) : "other", jsonb(frames)],
      );
      await tx.query(
        `delete from client_error_events where tenant_id = $1 and app = $2 and fingerprint = $3
           and id not in (select id from client_error_events where tenant_id = $1 and app = $2 and fingerprint = $3 order by id desc limit ${EVENTS_KEPT})`,
        [e.tenant_id, e.app, fingerprint],
      );
    }
  });
  return fingerprints;
}

type GroupRow = {
  fingerprint: string;
  kind: string;
  message: string;
  top_frame: RawFrame | null;
  top_deployment: string | null;
  status: Status;
  first_seen: unknown;
  last_seen: unknown;
  count: unknown;
  regressed: boolean;
};

interface Frame extends RawFrame {
  original: Original | null;
}

async function withOriginal(deps: Deps, tenant: string, hash: string | null, f: RawFrame): Promise<Frame> {
  const original = hash === null ? null : await symbolicator(deps).original(tenant, hash, f.file, f.line, f.column);
  return { file: f.file, line: f.line, column: f.column, function: f.function, original };
}

async function groupViews(deps: Deps, db: Db, tenant: string, app: string, rows: GroupRow[]): Promise<Record<string, unknown>[]> {
  if (rows.length === 0) return [];
  const counts = await db.query<{ fingerprint: string; deployment_hash: string; count: unknown }>(
    `select cd.fingerprint, cd.deployment_hash, cd.count from client_error_deployments cd
       join deployments d on d.app = cd.app and d.hash = cd.deployment_hash
      where cd.tenant_id = $1 and cd.app = $2 and cd.fingerprint = any($3::text[]) order by d.created_at desc, cd.deployment_hash`,
    [tenant, app, rows.map((r) => r.fingerprint)],
  );
  return Promise.all(
    rows.map(async (r) => ({
      fingerprint: r.fingerprint,
      kind: r.kind,
      message: r.message,
      status: r.status,
      first_seen: num(r.first_seen),
      last_seen: num(r.last_seen),
      count: num(r.count),
      regressed: r.regressed,
      deployments: counts.filter((c) => c.fingerprint === r.fingerprint).map((c) => ({ deployment_hash: c.deployment_hash, count: num(c.count) })),
      top_frame: r.top_frame === null ? null : await withOriginal(deps, tenant, r.top_deployment, r.top_frame),
    })),
  );
}

const GROUP_COLUMNS = "g.fingerprint, g.kind, g.message, g.top_frame, g.top_deployment, g.status, g.first_seen, g.last_seen, g.count, g.regressed";

export function registerClientErrors(app: Hono<Env>, deps: Deps): void {
  /** A fingerprint that cannot exist is "not found", like every malformed id in a path (http.ts pathParam). */
  const fingerprintParam = (value: string): string => {
    if (!FINGERPRINT.test(value)) throw new ApiError("RENOX_NOT_FOUND");
    return value;
  };

  app.get("/v1/apps/:app/client-errors", operation(deps, "listClientErrors"), tenantAuth(deps, "logs:read"), async (c) => {
    const db = tenantDb(deps, c);
    const tenant = db.tenantId;
    const name = (await requireApp(db, tenant, pathParam(c, "app", "AppName"))).name;
    const status = c.req.query("status");
    if (status !== undefined && !(STATUSES as readonly string[]).includes(status)) throw invalid("status", "must be open, resolved or ignored");
    const since = c.req.query("since");
    if (since !== undefined && !/^[0-9]{1,16}$/u.test(since)) throw invalid("since", "must be Unix milliseconds");
    const deployment = c.req.query("deployment");
    if (deployment !== undefined && !HASH.test(deployment)) throw invalid("deployment", "must be a deployment hash");
    const limitRaw = c.req.query("limit");
    if (limitRaw !== undefined && !/^[0-9]{1,3}$/u.test(limitRaw)) throw invalid("limit", "must be 1 to 100");
    const limit = limitRaw === undefined ? 20 : Number(limitRaw);
    if (limit < 1 || limit > 100) throw invalid("limit", "must be 1 to 100");
    const cursor = c.req.query("cursor");
    if (cursor !== undefined && !CURSOR.test(cursor)) throw invalid("cursor", "not a cursor of this endpoint");

    // Only constant fragments are added to the SQL; every value is a parameter.
    const params: unknown[] = [tenant, name];
    const where: string[] = ["g.tenant_id = $1", "g.app = $2"];
    const bind = (v: unknown): string => {
      params.push(v);
      return `$${params.length}`;
    };
    if (status !== undefined) where.push(`g.status = ${bind(status)}`);
    if (since !== undefined) where.push(`g.last_seen >= ${bind(Number(since))}`);
    if (deployment !== undefined) where.push(`exists (select 1 from client_error_deployments x where x.tenant_id = $1 and x.app = g.app and x.fingerprint = g.fingerprint and x.deployment_hash = ${bind(deployment)})`);
    if (cursor !== undefined) {
      const [at, fp] = cursor.split(".") as [string, string];
      where.push(`(g.last_seen < ${bind(Number(at))} or (g.last_seen = ${bind(Number(at))} and g.fingerprint < ${bind(fp)}))`);
    }
    const rows = await db.query<GroupRow>(`select ${GROUP_COLUMNS} from client_error_groups g where ${where.join(" and ")} order by g.last_seen desc, g.fingerprint desc limit ${limit + 1}`, params);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return c.json({ groups: await groupViews(deps, db, tenant, name, page), next_cursor: rows.length > limit && last !== undefined ? `${num(last.last_seen)}.${last.fingerprint}` : null });
  });

  const requireGroup = async (db: ReturnType<typeof tenantDb>, name: string, fingerprint: string): Promise<GroupRow> => {
    const rows = await db.query<GroupRow>(`select ${GROUP_COLUMNS} from client_error_groups g where g.tenant_id = $1 and g.app = $2 and g.fingerprint = $3`, [db.tenantId, name, fingerprint]);
    const row = rows[0];
    if (row === undefined) throw new ApiError("RENOX_NOT_FOUND");
    return row;
  };

  app.get("/v1/apps/:app/client-errors/:fingerprint", operation(deps, "getClientError"), tenantAuth(deps, "logs:read"), async (c) => {
    const db = tenantDb(deps, c);
    const tenant = db.tenantId;
    const name = (await requireApp(db, tenant, pathParam(c, "app", "AppName"))).name;
    const fingerprint = fingerprintParam(c.req.param("fingerprint"));
    const row = await requireGroup(db, name, fingerprint);
    const events = await db.query<{ ts: unknown; client_ts: unknown; deployment_hash: string; request_id: string | null; message: string; url: string; ua: string; frames: RawFrame[] }>(
      "select ts, client_ts, deployment_hash, request_id, message, url, ua, frames from client_error_events where tenant_id = $1 and app = $2 and fingerprint = $3 order by id desc limit " + EVENTS_KEPT,
      [tenant, name, fingerprint],
    );
    return c.json({
      group: (await groupViews(deps, db, tenant, name, [row]))[0],
      events: await Promise.all(
        events.map(async (e) => ({
          ts: num(e.ts),
          client_ts: num(e.client_ts),
          deployment_hash: e.deployment_hash,
          request_id: e.request_id,
          message: e.message,
          url: e.url,
          ua: e.ua,
          frames: await Promise.all(e.frames.map((f) => withOriginal(deps, tenant, e.deployment_hash, f))),
        })),
      ),
    });
  });

  app.post("/v1/apps/:app/client-errors/:fingerprint", operation(deps, "setClientErrorStatus"), tenantAuth(deps, "apps:write"), async (c) => {
    const db = tenantDb(deps, c);
    const tenant = db.tenantId;
    const name = (await requireApp(db, tenant, pathParam(c, "app", "AppName"))).name;
    const fingerprint = fingerprintParam(c.req.param("fingerprint"));
    const body = await jsonBody<{ status: Status }>(c, "SetClientErrorStatusRequest");
    c.set("auditTarget", { status: body.status });
    await requireGroup(db, name, fingerprint);
    // A resolved group reopens when an event comes from a deployment created after the one active now.
    const active = await db.query<{ created_at: unknown }>("select created_at from deployments where tenant_id = $1 and app = $2 and state = 'active'", [tenant, name]);
    const after = body.status === "resolved" ? (numOrNull(active[0]?.created_at) ?? deps.now()) : null;
    await db.query("update client_error_groups set status = $4, regressed = false, resolved_after = $5 where tenant_id = $1 and app = $2 and fingerprint = $3", [tenant, name, fingerprint, body.status, after]);
    return c.json((await groupViews(deps, db, tenant, name, [await requireGroup(db, name, fingerprint)]))[0]);
  });
}
