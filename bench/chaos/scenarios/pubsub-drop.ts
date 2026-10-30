// pubsub-drop (#312): every realtime client's link drops mid-stream while
// the node and the tenant's hub keep running, twice. docs/23's realtime row
// ("WebSocket message flood / oversized frame") names this scenario: a drop
// costs each client one reconnect; an SSE
// client that reconnects with `Last-Event-ID` inside the hub's replay buffer
// (ops.md section 18: the last 100 events or 60 s, whichever is shorter)
// misses nothing; outside it, the newest events of the buffer are replayed,
// the older ones are gone, and nothing announces the gap (the client
// re-reads its state). WebSocket has no replay: a WebSocket client misses
// what was published while it was away.
//
// The cut is a TCP proxy between the clients and the node (lib/realtime.ts).
// The cell cannot be evicted instead: an open connection holds it in flight,
// and the replay buffer is the cell's own hub, so a hub that goes away takes
// its buffer with it.

import { CutProxy, type ClientLog, gaps, SseClient, WsClient } from "../lib/realtime.ts";
import { type Check, type Outcome, verdictOf } from "../lib/result.ts";
import { type AppSpec, type Node, type Stack, until, withStack } from "../lib/stack.ts";

const SSE_CLIENTS = 20;
const WS_CLIENTS = 20;
const RATE = 50;
/** ~50 events at 50 per second: inside the 100-event buffer. */
const SHORT_CUT_MS = 1000;
/** ~200 events: past the 100-event buffer. */
const LONG_CUT_MS = 4000;
const STEADY_MS = 3000;
/** Events published after `restore()` before a client is back: its 200 ms retry plus the connect, at most 1 s. */
const RECONNECT_SLACK = RATE;

const APP: AppSpec = {
  version: 1,
  routes: [
    { kind: "sse", path: "/sse/room", module: "functions/sse/room" },
    { kind: "ws", path: "/ws/room", module: "functions/ws/room" },
    { kind: "function", method: "POST", path: "/api/publish", module: "functions/api/publish", export: "POST" },
  ],
  modules: {
    "functions/sse/room": `export const sse = { async open(ctx) { await ctx.realtime.subscribe(ctx.conn, "room:1"); } };\n`,
    "functions/ws/room": `export const ws = { async open(ctx) { await ctx.realtime.subscribe(ctx.conn, "room:1"); } };\n`,
    "functions/api/publish": `export async function POST(ctx) {
  const { seq } = await ctx.req.json();
  return Response.json({ n: await ctx.realtime.publish("room:1", { text: String(seq) }) });
}\n`,
  },
  files: {
    "policies/app/default.cedar": `permit (principal, action == Renox::Action::"realtime.subscribe", resource is Renox::Topic)\nwhen { resource.name like "room:*" };\n`,
  },
};

/** Publishes `1, 2, …` at RATE per second straight to the node (the publisher is server side; only client links are cut). */
class Publisher {
  seq = 0;
  readonly statuses = new Map<number, number>();
  private running = true;
  private readonly done: Promise<void>;

  constructor(n: Node, host: string) {
    const started = performance.now();
    this.done = (async () => {
      while (this.running) {
        const seq = ++this.seq;
        let status = 0;
        try {
          const r = await fetch(`http://127.0.0.1:${n.port}/api/publish`, {
            method: "POST",
            headers: { host, "content-type": "application/json" },
            body: JSON.stringify({ seq }),
            signal: AbortSignal.timeout(3000),
          });
          status = r.status;
          await r.arrayBuffer();
        } catch {
          status = 0;
        }
        this.statuses.set(status, (this.statuses.get(status) ?? 0) + 1);
        const next = started + (seq * 1000) / RATE;
        await Bun.sleep(Math.max(0, next - performance.now()));
      }
    })();
  }

  get failures(): number {
    return [...this.statuses.entries()].filter(([s]) => s !== 200).reduce((a, [, n]) => a + n, 0);
  }

  summary(): string {
    return [...this.statuses.entries()].map(([s, n]) => `${n}×${s}`).join(", ");
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.done;
  }
}

/** The realtime records of `tenant` among those the nodes sent (`recordMeters`). */
const realtimeRecords = (s: Stack, tenant: string): Record<string, unknown>[] =>
  s.meterRecords.filter((r) => r.tenant_id === tenant && /^(WS|SSE) /u.test(String(r.route)));


export async function run(worker: string): Promise<Outcome> {
  return withStack(worker, { realtimeUserConnections: SSE_CLIENTS + WS_CLIENTS + 10, recordMeters: true }, async (s: Stack) => {
    const t = await s.tenant("t-chaos-rt", APP);
    const n = await s.ownerOf(t);
    const proxy = await CutProxy.start(n.port);
    const sse = Array.from({ length: SSE_CLIENTS }, () => new SseClient(`http://127.0.0.1:${proxy.port}/sse/room`, t.host));
    const ws = Array.from({ length: WS_CLIENTS }, () => new WsClient(`ws://127.0.0.1:${proxy.port}/ws/room`, t.host));
    const clients = [...sse, ...ws];
    const connected = (k: number) => until(`${clients.length} clients on connection ${k}`, 30_000, async () => (clients.every((c) => c.log.connects >= k) ? true : null));
    await connected(1);
    const pub = new Publisher(n, t.host);
    await until("every client receiving", 30_000, async () => (clients.every((c) => c.log.seqs.length > 0) ? true : null));
    // The stream before the first cut starts where every client has its first message.
    const start = Math.max(...clients.map((c) => c.log.seqs[0] as number));
    await Bun.sleep(STEADY_MS);

    const cut = async (ms: number, k: number): Promise<{ from: number; to: number; dropped: number }> => {
      const from = pub.seq;
      const dropped = proxy.cut();
      await Bun.sleep(ms);
      const to = pub.seq;
      proxy.restore();
      await connected(k);
      await Bun.sleep(STEADY_MS);
      return { from, to, dropped };
    };
    const short = await cut(SHORT_CUT_MS, 2);
    const long = await cut(LONG_CUT_MS, 3);
    // The clients leave while the topic is live: the node sees an SSE client
    // go at its next write, a publish here (on a quiet topic, the 15 s
    // keep-alive). Then the publisher stops.
    await Promise.all(clients.map((c) => c.close()));
    await Bun.sleep(500);
    await pub.stop();
    const end = pub.seq;
    proxy.stop();
    // A record is written at each connection's close and the node posts them every 200 ms.
    const records = await until("one meter record per connection", 15_000, async () => {
      const r = realtimeRecords(s, t.id);
      return r.length >= clients.reduce((a, c) => a + c.log.connects, 0) ? r : null;
    }).catch(() => realtimeRecords(s, t.id));

    const logs = clients.map((c) => c.log);
    const sseLogs = logs.filter((l) => l.kind === "sse");
    const wsLogs = logs.filter((l) => l.kind === "ws");
    // What each connection received; a client has three (the first and one per cut).
    const conns = (l: ClientLog): number[][] => l.starts.map((at, k) => l.seqs.slice(at, l.starts[k + 1] ?? l.seqs.length));
    // Missing between connection k - 1 and k (negative: events received twice).
    const boundary = (l: ClientLog, k: number): number => {
      const c = conns(l);
      const prev = c[k - 1] ?? [];
      const next = c[k] ?? [];
      return prev.length === 0 || next.length === 0 ? Number.NaN : (next[0] as number) - (prev[prev.length - 1] as number) - 1;
    };
    // Every connection's own stream (for SSE the replay, then live) has no hole and no repeat.
    const clean = (l: ClientLog): boolean => conns(l).every((c) => {
      const g = gaps(c);
      return g.missing === 0 && g.duplicates === 0 && c.every((x, i) => i === 0 || x > (c[i - 1] as number));
    });
    const shortSse = sseLogs.map((l) => boundary(l, 1));
    const longSse = sseLogs.map((l) => boundary(l, 2));
    const shortWs = wsLogs.map((l) => boundary(l, 1));
    const longWs = wsLogs.map((l) => boundary(l, 2));
    const reconnects = logs.map((l) => l.connects - 1);
    const limit = logs.reduce((a, l) => a + l.limitRefusals, 0) + records.filter((r) => r.status === "busy").length;
    const meterSecs = records.reduce((a, r) => a + Number(r.realtime_conn_seconds ?? 0), 0);
    const clientSecs = logs.reduce((a, l) => a + l.lifetimes.reduce((x, y) => x + y, 0), 0);
    const meterError = clientSecs === 0 ? 1 : Math.abs(meterSecs - clientSecs) / clientSecs;
    const connections = logs.reduce((a, l) => a + l.connects, 0);
    const byRoute = (prefix: string) => records.filter((r) => String(r.route).startsWith(prefix));
    const max = (xs: number[]): number => (xs.length === 0 ? 0 : Math.max(...xs));
    const min = (xs: number[]): number => (xs.length === 0 ? 0 : Math.min(...xs));
    const range = (xs: number[]): string => `${min(xs)}–${max(xs)}`;
    const inside = (xs: number[], lo: number, hi: number): boolean => xs.every((x) => x >= lo && x <= hi);
    const shortEvents = short.to - short.from;
    const longEvents = long.to - long.from;
    // A client can be a few events behind the publisher when its link drops.
    const BEHIND = 5;

    const checks: Check[] = [
      { name: "the publisher sees nothing", ok: pub.failures === 0, detail: `publishes: ${pub.summary()}` },
      { name: "each cut drops every client link", ok: short.dropped >= clients.length && long.dropped >= clients.length, detail: `proxied connections closed: ${short.dropped} and ${long.dropped} (${clients.length} clients)` },
      { name: "each client reconnects exactly once per cut", ok: reconnects.every((r) => r === 2), detail: `reconnects per client: min ${min(reconnects)}, max ${max(reconnects)} (2 cuts)` },
      {
        name: "SSE inside the replay buffer: nothing missed",
        ok: inside(shortSse, 0, 0) && sseLogs.every(clean),
        detail: `${shortEvents} events published during the ${SHORT_CUT_MS / 1000} s cut; missing across the reconnect per client ${range(shortSse)}; every connection's stream without hole or repeat: ${sseLogs.every(clean)}`,
      },
      {
        name: "SSE past the buffer: the newest 100 replayed, the older ones gone",
        ok: inside(longSse, longEvents - 100 - BEHIND, longEvents - 100 + RECONNECT_SLACK),
        detail: `${longEvents} events during the ${LONG_CUT_MS / 1000} s cut; missing across the reconnect per client ${range(longSse)} (expected ${longEvents - 100}, plus what was published before the client was back)`,
      },
      {
        name: "WebSocket: no replay, a clean stream after each reconnect",
        ok: inside(shortWs, shortEvents - BEHIND, shortEvents + RECONNECT_SLACK) && inside(longWs, longEvents - BEHIND, longEvents + RECONNECT_SLACK) && wsLogs.every(clean),
        detail: `missing across the reconnects per client ${range(shortWs)} of ${shortEvents} and ${range(longWs)} of ${longEvents} published during the cuts; every connection's stream without hole or repeat: ${wsLogs.every(clean)}`,
      },
      { name: "no RENOX_REALTIME_LIMIT", ok: limit === 0, detail: `${limit} (client refusals plus \`busy\` records)` },
      {
        name: "the meter records sum to the connection seconds",
        ok: records.length === connections && meterError <= 0.05,
        detail: `${records.length} records (${byRoute("WS ").length} WS, ${byRoute("SSE ").length} SSE) for ${connections} connections; realtime_conn_seconds ${meterSecs.toFixed(1)} s, client-measured ${clientSecs.toFixed(1)} s (${(meterError * 100).toFixed(1)} %)`,
      },
    ];
    return {
      scenario: "pubsub-drop",
      title: "Realtime client links dropped",
      failureModes: ["WebSocket message flood / oversized frame"],
      description: `${SSE_CLIENTS} SSE and ${WS_CLIENTS} WebSocket clients on one topic through a TCP proxy, ${RATE} messages per second published by a function; every client link cut for ${SHORT_CUT_MS / 1000} s (inside the 100-event replay buffer), then for ${LONG_CUT_MS / 1000} s (past it), the node and its hub running throughout`,
      verdict: verdictOf(checks),
      result: `${end} messages published (${pub.summary()}); SSE missed ${range(shortSse)} of ${shortEvents} inside the buffer and ${range(longSse)} of ${longEvents} past it; every client reconnected ${min(reconnects)}–${max(reconnects)} times; meter ${meterSecs.toFixed(1)} s vs ${clientSecs.toFixed(1)} s measured`,
      target: "one reconnect per drop; SSE contiguous inside the replay buffer; past it, the buffer's events only and no error; no RENOX_REALTIME_LIMIT; meter seconds = connection seconds (±5 %)",
      alerts: [],
      checks,
      metrics: {
        published: end,
        short_cut_events: shortEvents,
        long_cut_events: longEvents,
        sse_missed_short_max: max(shortSse),
        sse_missed_long_min: min(longSse),
        sse_missed_long_max: max(longSse),
        ws_missed_short_max: max(shortWs),
        ws_missed_long_max: max(longWs),
        connections,
        meter_records: records.length,
        meter_records_ws: byRoute("WS ").length,
        meter_records_sse: byRoute("SSE ").length,
        meter_conn_seconds: Number(meterSecs.toFixed(3)),
        client_conn_seconds: Number(clientSecs.toFixed(3)),
      },
      notes: [
        "The replay buffer is 100 events or 60 s, whichever is shorter (ops.md section 18): at 50 messages per second it holds 2 s, so the long cut is past it although it is well under 60 s.",
        "Past the buffer no event names the gap (#281 implements none; the contract says the client re-reads its state); the SSE `id:` jumps.",
        "The clients close while messages are still published: on a quiet topic the node sees an SSE client leave only at its next 15 s keep-alive (ops.md section 18), so that connection is metered until then.",
        "The cut is of the client links only; a worker restart takes the hub and its buffer with it (ids restart at 1), which no scenario here asserts.",
      ],
    };
  });
}
