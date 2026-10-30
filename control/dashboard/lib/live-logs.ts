// The live Logs view (#307): what the SSE route and the follower job share.
// A follower is a row of app__log_followers: the page's topic, its
// connection, the session whose token reads the API, the app and filters,
// and the newest line already sent. The job reads the lines after `since`
// once a second, publishes them, and queues its next run until the page
// closes or 15 minutes have passed.

import type { DbStatements, Fetch, Secrets } from "renox";

import { Api, apiBase, type LogLine } from "./api.ts";
import { currentToken } from "./session.ts";

/** A follower runs at most this long; the page then falls back to its poll. */
export const MAX_FOLLOW_MS = 15 * 60_000;
/** Time between two runs of a follower. */
export const STEP_MS = 1_000;
/** Lines one run publishes at most. */
export const MAX_BATCH = 200;
export const JOB = "log-follower";

export type Follower = {
  topic: string;
  conn_id: string;
  session_id: string;
  app: string;
  filters: string;
  since: number;
  started_at: number;
};

const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

/** `logs:<app>:<128 random bits>`: one topic per open page. */
export const newTopic = (app: string): string => `logs:${app}:${hex(crypto.getRandomValues(new Uint8Array(16)))}`;

export async function follower(db: DbStatements, topic: string): Promise<Follower | null> {
  return db.queryOne<Follower>("select * from app__log_followers where topic = ?", [topic]);
}

export async function addFollower(db: DbStatements, f: Follower): Promise<void> {
  await db.execute(
    "insert into app__log_followers (topic, conn_id, session_id, app, filters, since, started_at) values (?, ?, ?, ?, ?, ?, ?)",
    [f.topic, f.conn_id, f.session_id, f.app, f.filters, f.since, f.started_at],
  );
}

export async function dropFollower(db: DbStatements, topic: string): Promise<void> {
  await db.execute("delete from app__log_followers where topic = ?", [topic]);
}

export async function dropConn(db: DbStatements, connId: string): Promise<void> {
  await db.execute("delete from app__log_followers where conn_id = ?", [connId]);
}

/** What one run of a follower does: `stop` (the row is gone or dropped) or the new lines and the next `since`. */
export type Step = { stop: true; reason: "closed" | "expired" | "signed_out" } | { stop: false; lines: LogLine[]; since: number };

export async function step(db: DbStatements, fetch: Fetch, secrets: Secrets, topic: string, now: number): Promise<Step> {
  const f = await follower(db, topic);
  if (f === null) return { stop: true, reason: "closed" };
  if (now - f.started_at > MAX_FOLLOW_MS) {
    await dropFollower(db, topic);
    return { stop: true, reason: "expired" };
  }
  const token = await currentToken(db, secrets, f.session_id, now);
  if (token === null) {
    await dropFollower(db, topic);
    return { stop: true, reason: "signed_out" };
  }
  const filters = JSON.parse(f.filters) as { source?: "all" | "server" | "client"; deployment?: string };
  const r = await new Api(fetch, token, apiBase(secrets)).logs(f.app, { since: f.since + 1, ...(filters.source ? { source: filters.source } : {}), ...(filters.deployment ? { deployment: filters.deployment } : {}) });
  if (!r.ok) return { stop: false, lines: [], since: f.since };
  const lines = r.value.filter((l) => l.ts > f.since).slice(-MAX_BATCH);
  const since = lines.reduce((m, l) => Math.max(m, l.ts), f.since);
  if (since !== f.since) await db.execute("update app__log_followers set since = ? where topic = ?", [since, topic]);
  return { stop: false, lines, since };
}
