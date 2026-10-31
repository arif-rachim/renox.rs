// Database screen (docs/19-platform-wireframes.md 3.8; deploy-api.md 0.3
// section 14; #258): the header (size, quota, WAL, replication status and
// lag), the Backups panel (restore points over the generations, "Restore to
// new app"), and the Export panel. An export is downloaded by the browser
// through the signed URL the API answers: the dashboard never proxies the
// bytes. The Tables and Query panels of the wireframe are F7 (`admin`).

import type { Api, Result } from "./api.ts";
import { EN, type Tr } from "./i18n.ts";
import { ago, bytes, clock, percent, round } from "./view.ts";

/** `getBackups` (deploy-api.yaml). */
export interface Backups {
  app: string;
  database: string;
  replication: "litestream" | "none";
  state: string;
  replica: { kind: string; region: string } | null;
  last_sync_at: number | null;
  lag_seconds: number | null;
  retention_hours: number;
  generations: { id: string; start: number; end: number }[];
  db: { size_bytes: number; quota_bytes: number; wal_bytes: number };
  last_failover: { at: number; from_node: string; to_node: string; generation: string | null } | null;
  stale: boolean;
}

/** `exportBackup`. */
export interface Export {
  url: string;
  expires_at: number;
  created_at: number;
  size_bytes: number;
  sha256: string;
  masking: string;
}

/** `restoreBackup`. */
export interface Restored {
  app: { name: string; hostnames?: string[] };
  deployment: { hash: string; state: string };
  source_app: string;
  database: string;
  generation: string;
  restored_to: number | null;
}

const path = (app: string, rest: string) => `/v1/apps/${encodeURIComponent(app)}${rest}`;

export const getBackups = (api: Api, app: string): Promise<Result<Backups>> => api.json("GET", path(app, "/backups"));
export const exportBackup = (api: Api, app: string): Promise<Result<Export>> => api.json("POST", path(app, "/backups/export"), {});
export const restoreBackup = (api: Api, app: string, timestamp: number, name: string): Promise<Result<Restored>> =>
  api.json("POST", path(app, "/backups/restore"), { timestamp, target: "new_app", name });

/** `<input type="datetime-local">` value for a time, in UTC (the page says so). */
export const localValue = (ms: number): string => new Date(ms).toISOString().slice(0, 19);

/** A `datetime-local` value read as UTC, or null. */
export function parseLocal(raw: string): number | null {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d)?$/u.test(raw)) return null;
  const ms = Date.parse(`${raw.length === 16 ? `${raw}:00` : raw}Z`);
  return Number.isNaN(ms) ? null : ms;
}

export interface Generation {
  id: string;
  from: string;
  to: string;
  min: string;
  max: string;
}

export interface DatabaseView {
  database: string;
  size: string;
  quota: string;
  pct: number;
  wal: string;
  replication: string;
  replicating: boolean;
  /** "lag 0.5 s, synced 3 s ago", or null when there is no replica. */
  sync: string | null;
  stale: boolean;
  retention: string;
  generations: Generation[];
  /** The newest restorable time, the picker's default. */
  latest: string | null;
  last_failover: string | null;
}

export function databaseView(b: Backups, now: number, tr: Tr = EN): DatabaseView {
  const generations = [...b.generations]
    .sort((x, y) => y.end - x.end)
    .map((g) => ({ id: g.id, from: clock(g.start).slice(0, 19), to: clock(g.end).slice(0, 19), min: localValue(g.start), max: localValue(g.end) }));
  const sync =
    b.replication === "none"
      ? null
      : tr("dash.database.sync", {
          lag: b.lag_seconds === null ? tr("dash.database.lag_unknown") : tr("dash.database.lag", { s: round(b.lag_seconds) }),
          synced: b.last_sync_at === null ? tr("dash.database.never_synced") : tr("dash.database.synced", { ago: ago(b.last_sync_at, now, tr) }),
        });
  const f = b.last_failover;
  return {
    database: b.database,
    size: bytes(b.db.size_bytes),
    quota: bytes(b.db.quota_bytes),
    pct: percent(b.db.size_bytes, b.db.quota_bytes),
    wal: bytes(b.db.wal_bytes),
    replication: b.replication === "none" ? tr("dash.database.no_replica") : tr("dash.database.litestream", { kind: b.replica?.kind ?? "?", region: b.replica?.region ?? "?", state: b.state }),
    replicating: b.replication !== "none" && b.state === "replicating",
    sync,
    stale: b.stale,
    retention: b.retention_hours > 0 ? tr("dash.database.hours", { h: b.retention_hours }) : "—",
    generations,
    latest: generations[0]?.max ?? null,
    last_failover:
      f === null
        ? null
        : f.generation === null
          ? tr("dash.database.failover", { ago: ago(f.at, now, tr), from: f.from_node, to: f.to_node })
          : tr("dash.database.failover_generation", { ago: ago(f.at, now, tr), from: f.from_node, to: f.to_node, generation: f.generation }),
  };
}
