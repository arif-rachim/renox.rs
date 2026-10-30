// The live Logs view (#307) against the real control API in process: the
// SSE route subscribes the connection to a topic of its own only after the
// API answered the signed-in user's token for the app, the follower job
// publishes new lines that pass the page's filters as rows of
// partials/log-rows and queues its next run, closing the page stops it, and
// a member of another tenant is refused before any subscription.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { CloseContext, JobContext, RealtimeContext } from "renox";

import { assertScoped, createApp_, tenant } from "../../api/tests/helpers.ts";
import { sse } from "../functions/sse/logs.ts";
import { run } from "../jobs/log-follower.ts";
import { MAX_FOLLOW_MS } from "../lib/live-logs.ts";
import { actions as signinActions } from "../pages/signin.ts";
import { actionCtx, addLogs, dash, loaderCtx, type Dash } from "./helpers.ts";

setDefaultTimeout(30_000);
afterEach(assertScoped);

interface Seen {
  subscribed: string[];
  published: { topic: string; payload: Record<string, unknown> }[];
  enqueued: { name: string; payload: Record<string, unknown>; runAt: number | null }[];
}

/** A ctx of the realtime route or the job, with its realtime and jobs calls recorded. */
function ctxOf(d: Dash, path: string, seen: Seen) {
  const base = loaderCtx(d, path);
  return {
    ...base,
    conn: { id: "conn_1", transport: "sse" as const },
    realtime: {
      ...base.realtime,
      subscribe: async (_c: unknown, topic: string) => void seen.subscribed.push(topic),
      publish: async (topic: string, payload: unknown) => (seen.published.push({ topic, payload: payload as Record<string, unknown> }), 1),
    },
    jobs: {
      ...base.jobs,
      enqueue: async (name: string, payload: Record<string, unknown>, o?: { runAt?: number | Date }) => {
        seen.enqueued.push({ name, payload, runAt: o?.runAt === undefined ? null : Number(o.runAt) });
        return "01JOBROW000000000000000000";
      },
    },
  };
}

async function signedIn(tenantId: string, app: string): Promise<Dash> {
  const d = await dash();
  const token = await tenant(d.h, tenantId);
  await createApp_(d.h, token, app);
  expect(await signinActions.default(actionCtx(d, "/signin", "default", { token, next: "/apps" }))).toBeInstanceOf(Response);
  return d;
}

const fresh = (): Seen => ({ subscribed: [], published: [], enqueued: [] });
const line = (ts: number, level: "info" | "warn" | "error", message: string) => ({
  ts,
  tenant_id: "t_live",
  app: "live",
  deployment_hash: "0".repeat(64),
  request_id: `01JBQ3Z7M8K5V6W9X2Y4A1B3C${ts % 10}`,
  module: "functions/api/x",
  level,
  message,
  fields: null,
  source: "server" as const,
});

describe("live logs", () => {
  test("open subscribes a topic of its own and queues the follower; the job publishes new lines that pass the filters", async () => {
    const d = await signedIn("t_live", "live");
    const seen = fresh();
    await sse.open(ctxOf(d, "/sse/logs?app=live&level=warn&source=all", seen) as unknown as RealtimeContext);
    expect(seen.subscribed).toHaveLength(1);
    const topic = seen.subscribed[0] as string;
    expect(topic).toMatch(/^logs:live:[0-9a-f]{32}$/u);
    expect(seen.enqueued).toEqual([{ name: "log-follower", payload: { topic }, runAt: null }]);
    const now = Date.now();
    await addLogs(d.h, [line(now + 10, "info", "quiet line"), line(now + 20, "error", "<b>boom</b>")]);
    const job = { ...ctxOf(d, "/", seen), job: { id: "01JOBROW000000000000000000", name: "log-follower", tick: null, attempt: 1, payload: { topic } } };
    await run(job as unknown as JobContext);
    expect(seen.published).toHaveLength(1);
    const rows = seen.published[0]?.payload as { fragment: string; event: string; data: { lines: { message: string; level: string }[] } };
    expect(seen.published[0]?.topic).toBe(topic);
    expect(rows.fragment).toBe("partials/log-rows");
    expect(rows.event).toBe("log-rows");
    // level=warn keeps the error and drops the info line; the message stays raw data (the renderer escapes it).
    expect(rows.data.lines.map((l) => l.message)).toEqual(["<b>boom</b>"]);
    expect(seen.enqueued[1]?.name).toBe("log-follower");
    expect(seen.enqueued[1]?.runAt).toBeGreaterThan(now);
    // The next run sends nothing already sent.
    await run(job as unknown as JobContext);
    expect(seen.published).toHaveLength(1);
    expect(seen.enqueued).toHaveLength(3);
  });

  test("closing the page stops the follower, and so does the 15-minute limit", async () => {
    const d = await signedIn("t_live", "live");
    const seen = fresh();
    await sse.open(ctxOf(d, "/sse/logs?app=live", seen) as unknown as RealtimeContext);
    const topic = seen.subscribed[0] as string;
    await sse.close({ ...ctxOf(d, "/sse/logs?app=live", seen), close: { code: 1000, reason: null } } as unknown as CloseContext);
    const job = { ...ctxOf(d, "/", seen), job: { id: "01JOBROW000000000000000000", name: "log-follower", tick: null, attempt: 1, payload: { topic } } };
    await run(job as unknown as JobContext);
    expect(seen.published).toEqual([{ topic, payload: { text: "closed", event: "log-end" } }]);
    expect(seen.enqueued).toHaveLength(1);

    await sse.open(ctxOf(d, "/sse/logs?app=live", seen) as unknown as RealtimeContext);
    const second = seen.subscribed[1] as string;
    d.sqlite.query("update app__log_followers set started_at = ? where topic = ?").run(Date.now() - MAX_FOLLOW_MS - 1, second);
    await run({ ...job, job: { ...job.job, payload: { topic: second } } } as unknown as JobContext);
    expect(seen.published.at(-1)).toEqual({ topic: second, payload: { text: "expired", event: "log-end" } });
    expect(d.sqlite.query("select count(*) as n from app__log_followers").get()).toEqual({ n: 0 });
  });

  test("a member of another tenant, or a visitor without a sign-in, is refused before any subscription", async () => {
    const d = await signedIn("t_live", "live");
    const other = await dash();
    const otherToken = await tenant(d.h, "t_other");
    const o: Dash = { ...d, sessionId: "BBBBBBBBBBBBBBBBBBBBBB", calls: other.calls };
    expect(await signinActions.default(actionCtx(o, "/signin", "default", { token: otherToken, next: "/apps" }))).toBeInstanceOf(Response);
    const seen = fresh();
    await expect(sse.open(ctxOf(o, "/sse/logs?app=live", seen) as unknown as RealtimeContext)).rejects.toThrow("live logs: the control API answered 404");
    const anon: Dash = { ...d, sessionId: "CCCCCCCCCCCCCCCCCCCCCC" };
    await expect(sse.open(ctxOf(anon, "/sse/logs?app=live", seen) as unknown as RealtimeContext)).rejects.toThrow("sign in first");
    expect(seen.subscribed).toEqual([]);
    expect(seen.enqueued).toEqual([]);
  });
});
