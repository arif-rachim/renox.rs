// POST /v1/ingest/logs (ingestLogs, deploy-api.md section 11): tenant log
// lines from a node's HttpLogSink (#55), already redacted on the node.
//
// The per-tenant volume cap of docs/04-isolation-security.md ("Logs: volume
// per tenant per minute, rate limited, then sampled") and ops.md section 4
// (1,000 lines per minute free, 10,000 paid) is enforced here again: a node
// that does not apply it cannot flood the store. Over the cap, one line in
// SAMPLE_EVERY is kept and the rest are counted as dropped; ingestion never
// fails because of volume.
//
// Lines with `source: client` (browser events, client-events.md section 7) are
// outside that per-minute cap: they count toward the tenant's daily
// client-event counter only, which the usage view reads (#128).

import type { Context, Hono } from "hono";
import { operation } from "../audit.ts";
import { nodeAuth, nodeId } from "../auth/middleware.ts";
import { checkMessage } from "../contract.ts";
import type { Deps, Env } from "../context.ts";
import { ApiError, invalid } from "../errors.ts";
import { JSON_LIMIT, readBody } from "../http.ts";
import { recordClientEvents } from "../logs/client-events.ts";

/** ops.md section 4: lines per tenant per minute. */
export const LOG_LINES_PER_MINUTE = { free: 1_000, paid: 10_000 } as const;
/** Over the cap, one line in this many is kept. */
export const SAMPLE_EVERY = 10;
/** deploy-api.md Open 8: proposed retention. */
export const LOG_RETENTION_MS = 7 * 24 * 3600 * 1000;
const MINUTE_MS = 60_000;

export interface LogLine {
  ts: number;
  tenant_id: string;
  deployment_hash: string;
  request_id: string | null;
  module: string;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  fields: Record<string, unknown> | null;
  /** `platform` (deploy-api.md 0.3): written by the control plane itself; never accepted from a node. */
  source: "server" | "client" | "platform";
}

export interface LogBatch {
  type: "log_batch";
  schema_version: 0;
  node_id: string;
  lines: LogLine[];
}

/** A stored line: the line plus the node that sent it and the app it belongs to. */
export interface StoredLine extends LogLine {
  node_id: string;
  app: string;
}

/** A stored line with its place in the tenant's ingestion order (the `n` of the SSE id `<ts>-<n>`). */
export interface SeqLine extends StoredLine {
  seq: number;
}

export interface ReadOptions {
  /** Lines with `ts` at or after this. */
  since?: number;
  /** Lines stored after this sequence number. */
  afterSeq?: number;
  source?: "server" | "client" | "platform";
  deployment?: string;
  /** At most this many of the latest matching lines; default 100. */
  limit?: number;
}

/** Where accepted lines go; `GET /v1/apps/{app}/logs` (stream.ts) reads it. */
export interface LogStore {
  append(lines: StoredLine[]): Promise<void>;
  /** The matching lines of one app, oldest first, at most `limit` of the latest. */
  read(tenantId: string, app: string, opts?: ReadOptions): Promise<SeqLine[]>;
  /** Calls `fn` with each batch appended for `tenantId` until the returned function is called. */
  subscribe(tenantId: string, fn: (lines: SeqLine[]) => void): () => void;
  /** Every line of `tenantId` deleted (the erasure of #308); returns how many. */
  dropTenant(tenantId: string): Promise<number>;
}

/** Whether `line` passes the `source` and `deployment` filters of a read. */
export function matches(line: StoredLine, opts: Pick<ReadOptions, "source" | "deployment">): boolean {
  return (opts.source === undefined || line.source === opts.source) && (opts.deployment === undefined || line.deployment_hash === opts.deployment);
}

/** In-process store: per tenant, a bounded buffer within the retention window. */
export class MemoryLogStore implements LogStore {
  private readonly byTenant = new Map<string, SeqLine[]>();
  private readonly seqs = new Map<string, number>();
  private readonly listeners = new Map<string, Set<(lines: SeqLine[]) => void>>();
  constructor(
    private readonly now: () => number,
    private readonly perTenant = 50_000,
  ) {}
  async append(lines: StoredLine[]): Promise<void> {
    const cutoff = this.now() - LOG_RETENTION_MS;
    const added = new Map<string, SeqLine[]>();
    for (const line of lines) {
      let buf = this.byTenant.get(line.tenant_id);
      if (buf === undefined) {
        buf = [];
        this.byTenant.set(line.tenant_id, buf);
      }
      const seq = (this.seqs.get(line.tenant_id) ?? 0) + 1;
      this.seqs.set(line.tenant_id, seq);
      const stored = { ...line, seq };
      buf.push(stored);
      const batch = added.get(line.tenant_id);
      if (batch === undefined) added.set(line.tenant_id, [stored]);
      else batch.push(stored);
    }
    for (const [tenant, buf] of this.byTenant) {
      const kept = buf.filter((l) => l.ts >= cutoff).slice(-this.perTenant);
      this.byTenant.set(tenant, kept);
    }
    for (const [tenant, batch] of added) for (const fn of this.listeners.get(tenant) ?? []) fn(batch);
  }
  async read(tenantId: string, app: string, opts: ReadOptions = {}): Promise<SeqLine[]> {
    const lines = (this.byTenant.get(tenantId) ?? []).filter(
      (l) => l.app === app && (opts.since === undefined || l.ts >= opts.since) && (opts.afterSeq === undefined || l.seq > opts.afterSeq) && matches(l, opts),
    );
    return lines.slice(-(opts.limit ?? 100));
  }
  async dropTenant(tenantId: string): Promise<number> {
    const n = this.byTenant.get(tenantId)?.length ?? 0;
    this.byTenant.delete(tenantId);
    this.seqs.delete(tenantId);
    return n;
  }
  subscribe(tenantId: string, fn: (lines: SeqLine[]) => void): () => void {
    let set = this.listeners.get(tenantId);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(tenantId, set);
    }
    set.add(fn);
    return () => void set.delete(fn);
  }
}

const DAY_MS = 86_400_000;

/** Client lines per tenant since 00:00 UTC (client-events.md section 7); read by the usage view. */
export class DailyClientCounter {
  private day = -1;
  private readonly counts = new Map<string, number>();

  add(tenant: string, n: number, now: number): void {
    this.roll(now);
    this.counts.set(tenant, (this.counts.get(tenant) ?? 0) + n);
  }

  usedToday(tenant: string, now: number): number {
    this.roll(now);
    return this.counts.get(tenant) ?? 0;
  }

  private roll(now: number): void {
    const d = Math.floor(now / DAY_MS);
    if (d === this.day) return;
    this.day = d;
    this.counts.clear();
  }
}

/** Limits of the follow streams of `GET /v1/apps/{app}/logs`; fields so tests can shorten them. */
export const FOLLOW_STREAMS_PER_TENANT = 5;
export const STREAM_KEEPALIVE_MS = 15_000;

/** Per-tenant line counts in fixed one-minute windows, and what was dropped over the cap. */
export class VolumeCap {
  private window = -1;
  private readonly counts = new Map<string, number>();
  /** Lines dropped by sampling, per tenant, since the process started. */
  readonly dropped = new Map<string, number>();

  /** Whether the next line of `tenant` is kept. */
  take(tenant: string, tier: "free" | "paid", now: number): boolean {
    const w = Math.floor(now / MINUTE_MS);
    if (w !== this.window) {
      this.window = w;
      this.counts.clear();
    }
    const n = (this.counts.get(tenant) ?? 0) + 1;
    this.counts.set(tenant, n);
    const cap = LOG_LINES_PER_MINUTE[tier];
    if (n <= cap || (n - cap) % SAMPLE_EVERY === 0) return true;
    this.dropped.set(tenant, (this.dropped.get(tenant) ?? 0) + 1);
    return false;
  }
}

interface LogIngest {
  store: LogStore;
  cap: VolumeCap;
  /** Client lines today, per tenant; they never touch `cap`. */
  clientToday: DailyClientCounter;
  stream: {
    keepAliveMs: number;
    maxFollowPerTenant: number;
    /** Open follow streams per tenant. */
    open: Map<string, number>;
  };
}

const ingests = new WeakMap<Deps, LogIngest>();

/** The log store and volume cap of this API process. */
export function logIngest(deps: Deps): LogIngest {
  let s = ingests.get(deps);
  if (s === undefined) {
    s = {
      store: new MemoryLogStore(deps.now),
      cap: new VolumeCap(),
      clientToday: new DailyClientCounter(),
      stream: { keepAliveMs: STREAM_KEEPALIVE_MS, maxFollowPerTenant: FOLLOW_STREAMS_PER_TENANT, open: new Map() },
    };
    ingests.set(deps, s);
  }
  return s;
}

async function batchBody(c: Context<Env>): Promise<LogBatch> {
  if (!/^application\/json(;|$)/u.test(c.req.header("content-type") ?? "")) throw invalid("content-type", "must be application/json");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readBody(c, JSON_LIMIT)));
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw invalid("body", "not valid UTF-8 JSON");
  }
  return checkMessage<LogBatch>("log_batch", value);
}

export function registerLogIngest(app: Hono<Env>, deps: Deps): void {
  const { db } = deps;

  app.post("/v1/ingest/logs", operation(deps, "ingestLogs"), nodeAuth(deps), async (c) => {
    const node = nodeId(c);
    const batch = await batchBody(c);
    if (batch.node_id !== node) throw new ApiError("RENOX_TOKEN_SCOPE");
    // deploy-api.md 0.3 section 11: only the control plane writes `platform` lines.
    if (batch.lines.some((l) => l.source === "platform")) throw invalid("lines.source", "platform lines are written by the control plane only");
    const { store, cap, clientToday } = logIngest(deps);

    // The deployments the lines name, with their app and the tenant's tier (a node token spans tenants).
    const tenants = [...new Set(batch.lines.map((l) => l.tenant_id))];
    const rows = await db.query<{ tenant_id: string; hash: string; app: string; tier: "free" | "paid" }>(
      `select d.tenant_id, d.hash, d.app, t.tier from deployments d join tenants t on t.id = d.tenant_id
       where d.tenant_id = any($1::text[]) and d.hash = any($2::text[])`,
      [tenants, [...new Set(batch.lines.map((l) => l.deployment_hash))]],
    );
    const known = new Map(rows.map((r) => [`${r.tenant_id} ${r.hash}`, r]));
    const unknown = batch.lines.flatMap((l, i) => (known.has(`${l.tenant_id} ${l.deployment_hash}`) ? [] : [i]));
    if (unknown.length > 0) {
      throw new ApiError(
        "RENOX_VALIDATION",
        unknown.slice(0, 50).map((i) => ({ field: `lines.${i}.deployment_hash`, reason: "not a deployment of this tenant" })),
      );
    }

    const now = deps.now();
    const seen = new Set<string>();
    const accepted: StoredLine[] = [];
    let duplicates = 0;
    for (const line of batch.lines) {
      const key = JSON.stringify([line.ts, line.request_id, line.message]);
      if (seen.has(key)) {
        duplicates += 1;
        continue;
      }
      seen.add(key);
      const d = known.get(`${line.tenant_id} ${line.deployment_hash}`) as (typeof rows)[number];
      // Client events count toward the daily counter only (client-events.md section 7).
      if (line.source === "client") clientToday.add(line.tenant_id, 1, now);
      else if (!cap.take(line.tenant_id, d.tier, now)) continue;
      accepted.push({ ...line, node_id: node, app: d.app });
    }
    // Browser errors are grouped by fingerprint (#128); a grouping failure never fails the ingest.
    const fingerprints = await recordClientEvents(db, accepted).catch((e: unknown) => {
      deps.log.error("client error grouping failed", { request_id: c.get("requestId"), node_id: node, error: String(e) });
      return new Map<StoredLine, string>();
    });
    // The fingerprint travels with the stored line (deploy-api.md section 11): the node's line has none.
    const stored = accepted.map((l) => (fingerprints.has(l) ? { ...l, fields: { ...l.fields, fingerprint: fingerprints.get(l) } } : l));
    await store.append(stored);
    const dropped = batch.lines.length - duplicates - accepted.length;
    if (dropped > 0) deps.log.warn("log lines sampled over the tenant cap", { request_id: c.get("requestId"), node_id: node, dropped });
    return c.json({ accepted: accepted.length, duplicates }, 202);
  });
}
