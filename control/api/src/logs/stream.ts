// GET /v1/apps/{app}/logs (streamLogs, deploy-api.md section 11, "Reading
// logs"): the tenant's log lines as Server-Sent Events, read from the store
// that POST /v1/ingest/logs fills.
//
// Without `follow` the stream sends the last 100 matching lines (or those
// since `since`) and closes. With `follow=true` it stays open, sends lines as
// they are ingested, writes `: keep-alive` every 15 s, and a reconnect with
// `Last-Event-ID` resumes after that line. The id is `<ts>-<n>` where `n` is
// the line's place in the tenant's ingestion order, so it is the resume key.
// A tenant may hold at most FOLLOW_STREAMS_PER_TENANT follow streams (429
// RENOX_RATE_LIMITED above it) so it cannot keep the process busy.

import type { Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { requireApp } from "../apps/repo.ts";
import { operation } from "../audit.ts";
import { tenantAuth } from "../auth/middleware.ts";
import type { Deps, Env } from "../context.ts";
import { ApiError, invalid } from "../errors.ts";
import { pathParam } from "../http.ts";
import { logIngest, matches, type ReadOptions, type SeqLine } from "../ingest/logs.ts";
import { tenantDb } from "../tenancy/scope.ts";

/** Lines replayed when `since` or `Last-Event-ID` is given (no `since` and no id: the last 100). */
export const REPLAY_LIMIT = 10_000;
const DEFAULT_TAIL = 100;

interface Query {
  follow: boolean;
  filter: Pick<ReadOptions, "since" | "source" | "deployment">;
  afterSeq: number | undefined;
}

function query(c: Context<Env>): Query {
  const follow = c.req.query("follow");
  if (follow !== undefined && follow !== "true" && follow !== "false") throw invalid("follow", "must be true or false");
  const since = c.req.query("since");
  if (since !== undefined && !/^[0-9]{1,16}$/u.test(since)) throw invalid("since", "must be Unix milliseconds");
  const source = c.req.query("source") ?? "all";
  if (source !== "all" && source !== "server" && source !== "client") throw invalid("source", "must be all, server or client");
  const deployment = c.req.query("deployment");
  if (deployment !== undefined && !/^[0-9a-f]{64}$/u.test(deployment)) throw invalid("deployment", "must be a deployment hash");
  const last = c.req.header("last-event-id");
  let afterSeq: number | undefined;
  if (last !== undefined) {
    const m = /^[0-9]{1,16}-([0-9]{1,16})$/u.exec(last);
    if (m === null) throw invalid("last-event-id", "must be an id from this stream");
    afterSeq = Number(m[1]);
  }
  return {
    follow: follow === "true",
    filter: { ...(since === undefined ? {} : { since: Number(since) }), ...(source === "all" ? {} : { source }), ...(deployment === undefined ? {} : { deployment }) },
    afterSeq,
  };
}

/** One `log` event: the line as the contract's `log_line`, without the store's own fields. */
function event(l: SeqLine): { event: string; id: string; data: string } {
  const { node_id: _n, app: _a, seq, ...line } = l;
  return { event: "log", id: `${l.ts}-${seq}`, data: JSON.stringify(line) };
}

export function registerLogStream(app: Hono<Env>, deps: Deps): void {
  app.get("/v1/apps/:app/logs", operation(deps, "streamLogs"), tenantAuth(deps, "logs:read"), async (c) => {
    const t = tenantDb(deps, c);
    const tenant = t.tenantId;
    const name = (await requireApp(t, tenant, pathParam(c, "app", "AppName"))).name;
    const q = query(c);
    const { store, stream: limits } = logIngest(deps);

    if (q.follow) {
      if ((limits.open.get(tenant) ?? 0) >= limits.maxFollowPerTenant) throw new ApiError("RENOX_RATE_LIMITED", undefined, { retryAfter: 5 });
      limits.open.set(tenant, (limits.open.get(tenant) ?? 0) + 1);
    }
    c.header("cache-control", "no-store");
    c.header("x-accel-buffering", "no");

    return streamSSE(c, async (out) => {
      let released = false;
      let unsubscribe = (): void => {};
      let keepAlive: ReturnType<typeof setInterval> | undefined;
      const release = (): void => {
        if (released) return;
        released = true;
        unsubscribe();
        if (keepAlive !== undefined) clearInterval(keepAlive);
        if (q.follow) limits.open.set(tenant, Math.max(0, (limits.open.get(tenant) ?? 1) - 1));
      };
      out.onAbort(release);
      try {
        // Lines that arrive while the backlog is read are queued, then sent after it.
        let sent = q.afterSeq ?? 0;
        let backlog = true;
        const queued: SeqLine[] = [];
        const send = async (lines: SeqLine[]): Promise<void> => {
          for (const l of lines) {
            if (l.app !== name || l.seq <= sent || !matches(l, q.filter) || (q.filter.since !== undefined && l.ts < q.filter.since)) continue;
            sent = l.seq;
            await out.writeSSE(event(l));
          }
        };
        if (q.follow) {
          unsubscribe = store.subscribe(tenant, (lines) => {
            if (backlog) queued.push(...lines);
            else void send(lines).catch(release);
          });
        }
        const replay = q.filter.since !== undefined || q.afterSeq !== undefined;
        const opts: ReadOptions = { ...q.filter, ...(q.afterSeq === undefined ? {} : { afterSeq: q.afterSeq }), limit: replay ? REPLAY_LIMIT : DEFAULT_TAIL };
        const lines = await store.read(tenant, name, opts);
        for (const l of lines) await out.writeSSE(event(l));
        sent = Math.max(sent, ...lines.map((l) => l.seq));
        backlog = false;
        await send(queued.splice(0));
        if (!q.follow) return;
        keepAlive = setInterval(() => void out.write(": keep-alive\n\n").catch(release), limits.keepAliveMs);
        await new Promise<void>((resolve) => out.onAbort(resolve));
      } finally {
        release();
      }
    });
  });
}
