// The audit module's services (#288): record one event, read the trail
// (the module's events merged with the platform's authorization decisions
// from renox__authz_audit_v1), export it through a hook, and prune past
// the retention. Reading is the sensitive action `audit.read`: every read
// leaves its own row in the platform table.

import { redact } from "./lib/redact.ts";

interface Ctx {
  db: {
    query<T>(sql: string, params?: unknown[]): Promise<T[]>;
    execute(sql: string, params?: unknown[]): Promise<{ changes: number }>;
  };
  config: { retain_days?: number };
  authz: { require(action: string): Promise<void> };
  hooks: { run(name: string, args: unknown): Promise<unknown> };
}

export type ActorKind = "user" | "agent" | "system";
export type Result = "ok" | "denied" | "failed";

export interface AuditInput {
  action: string;
  actor: { kind: ActorKind; id: string; client?: string };
  resource?: { type: string; id?: string | null };
  result?: Result;
  details?: Record<string, unknown>;
  request_id?: string;
}

export interface AuditEvent {
  id: string;
  /** Unix ms. */
  at: number;
  /** `module`: recorded through `record` or a listener; `authz`: a platform decision on a sensitive action. */
  kind: "module" | "authz";
  actor_kind: ActorKind;
  actor_id: string;
  client: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  result: Result | "allow" | "deny";
  details: Record<string, unknown>;
  request_id: string | null;
  source: string;
}

const ACTORS: readonly ActorKind[] = ["user", "agent", "system"];
const RESULTS: readonly Result[] = ["ok", "denied", "failed"];
const NAME = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/u;
const MAX_DETAILS = 16 * 1024;
export const PAGE_MAX = 200;
export const FLOOR_DAYS = 30;

const ulidish = (): string => {
  const b = new Uint8Array(10);
  crypto.getRandomValues(b);
  return `${Date.now().toString(36).padStart(9, "0")}${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}`;
};

/** Checks an event; the error message names the field. */
export function validate(e: unknown): AuditInput {
  const o = e as Partial<AuditInput> | null;
  if (typeof o !== "object" || o === null) throw new TypeError("audit.record: an event object");
  if (typeof o.action !== "string" || !NAME.test(o.action) || o.action.length > 128) throw new TypeError("audit.record: action is <module>.<verb>");
  const a = o.actor;
  if (typeof a !== "object" || a === null || !ACTORS.includes(a.kind) || typeof a.id !== "string" || a.id === "" || a.id.length > 128) throw new TypeError("audit.record: actor is { kind: user | agent | system, id }");
  if (a.client !== undefined && (typeof a.client !== "string" || a.client.length > 200)) throw new TypeError("audit.record: actor.client is a string");
  if (o.resource !== undefined && (typeof o.resource !== "object" || o.resource === null || typeof o.resource.type !== "string")) throw new TypeError("audit.record: resource is { type, id? }");
  if (o.result !== undefined && !RESULTS.includes(o.result)) throw new TypeError("audit.record: result is ok, denied, or failed");
  if (o.details !== undefined && (typeof o.details !== "object" || o.details === null || Array.isArray(o.details))) throw new TypeError("audit.record: details is an object");
  return o as AuditInput;
}

/** Appends one event; returns its id. Called by modules and the app, and by the listeners (hooks.ts). */
export async function record(ctx: Ctx, event: unknown, source = "record"): Promise<{ id: string }> {
  const e = validate(event);
  const details = JSON.stringify(redact(e.details ?? {}));
  if (details.length > MAX_DETAILS) throw new RangeError(`audit.record: details are at most ${MAX_DETAILS} bytes`);
  const id = ulidish();
  await ctx.db.execute(
    "insert into audit__events (id, at, actor_kind, actor_id, client, action, resource_type, resource_id, result, details, request_id, source) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [id, Date.now(), e.actor.kind, e.actor.id, e.actor.client ?? null, e.action, e.resource?.type ?? null, e.resource?.id ?? null, e.result ?? "ok", details, e.request_id ?? null, source],
  );
  return { id };
}

export interface Filter {
  /** Only this actor (a user id, an agent's user id, or `system:<module>`). */
  actor?: string;
  /** Only this action, or a prefix ending in `.` (`org.`). */
  action?: string;
  /** Unix ms, inclusive. */
  since?: number;
  until?: number;
  /** Include the platform's decisions (default true). */
  platform?: boolean;
  /** Page size (1 to 200, default 50) and the `next` cursor of the previous page. */
  limit?: number;
  cursor?: string | null;
}

export interface Page {
  events: AuditEvent[];
  /** Pass as `cursor` for the next page; null on the last one. */
  next: string | null;
}

const cursorOf = (e: AuditEvent): string => `${e.at}:${e.kind}:${e.id}`;
const KIND_RANK = { authz: 0, module: 1 } as const;

function parseCursor(c: unknown): { at: number; rank: number; id: string } | null {
  if (typeof c !== "string") return null;
  const m = /^(\d{1,16}):(module|authz):([0-9a-z]{1,64})$/u.exec(c);
  return m ? { at: Number(m[1]), rank: KIND_RANK[m[2] as "module" | "authz"], id: m[3] as string } : null;
}

/** The trail, newest first: own events and the platform's decisions in one order (at, kind, id), paged. */
export async function query(ctx: Ctx, filter: Filter = {}): Promise<Page> {
  await ctx.authz.require("audit.read");
  return read(ctx, filter);
}

async function read(ctx: Ctx, filter: Filter): Promise<Page> {
  const limit = Math.min(Math.max(Math.trunc(Number(filter.limit ?? 50)) || 50, 1), PAGE_MAX);
  const cur = parseCursor(filter.cursor);
  const where: string[] = [];
  const params: unknown[] = [];
  if (typeof filter.actor === "string") {
    where.push("actor_id = ?");
    params.push(filter.actor);
  }
  if (typeof filter.action === "string") {
    if (filter.action.endsWith(".")) {
      where.push("substr(action, 1, ?) = ?");
      params.push(filter.action.length, filter.action);
    } else {
      where.push("action = ?");
      params.push(filter.action);
    }
  }
  if (typeof filter.since === "number") {
    where.push("at >= ?");
    params.push(filter.since);
  }
  if (typeof filter.until === "number") {
    where.push("at <= ?");
    params.push(filter.until);
  }
  if (cur !== null) {
    where.push("(at < ? or (at = ? and (rank < ? or (rank = ? and id < ?))))");
    params.push(cur.at, cur.at, cur.rank, cur.rank, cur.id);
  }
  const own = `select id, at, 1 as rank, 'module' as kind, actor_kind, actor_id, client, action, resource_type, resource_id, result, details, request_id, source from audit__events`;
  const platform = `select printf('%016d', id) as id, at, 0 as rank, 'authz' as kind,
      case when principal like 'system:%' then 'system' else 'user' end as actor_kind,
      principal as actor_id, null as client, action, resource_type, resource_id, result,
      json_object('policy', policy) as details, null as request_id, 'authz' as source
    from renox__authz_audit_v1`;
  const union = filter.platform === false ? own : `${own} union all ${platform}`;
  const sql = `select * from (${union}) ${where.length ? `where ${where.join(" and ")}` : ""} order by at desc, rank desc, id desc limit ?`;
  const rows = await ctx.db.query<Omit<AuditEvent, "details"> & { details: string; rank: number }>(sql, [...params, limit + 1]);
  const events = rows.slice(0, limit).map(({ rank: _rank, ...r }) => ({ ...r, details: JSON.parse(r.details) as Record<string, unknown> }));
  const last = events[events.length - 1];
  return { events, next: rows.length > limit && last !== undefined ? cursorOf(last) : null };
}

/** Runs `audit.export` once per page of the filter's events (F7 reports, the F6 erasure task #120); returns the count. */
export async function exportEvents(ctx: Ctx, filter: Filter = {}, purpose = "export"): Promise<{ events: number; pages: number }> {
  await ctx.authz.require("audit.read");
  let cursor: string | null = null;
  let page = 0;
  let count = 0;
  for (;;) {
    const p: Page = await read(ctx, { ...filter, limit: PAGE_MAX, cursor });
    await ctx.hooks.run("audit.export", { events: p.events, page, last: p.next === null, purpose });
    count += p.events.length;
    page++;
    if (p.next === null) return { events: count, pages: page };
    cursor = p.next;
  }
}

/** Deletes own events older than `retain_days` (never fewer than 30: the trigger refuses younger rows). */
export async function prune(ctx: Ctx): Promise<{ deleted: number }> {
  const days = Math.max(Number(ctx.config.retain_days ?? 365), FLOOR_DAYS);
  const r = await ctx.db.execute("delete from audit__events where at < ?", [Date.now() - days * 86_400_000]);
  return { deleted: r.changes };
}
