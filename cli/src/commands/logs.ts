// renox logs [--follow] [--since <time>] [--source all|server|client]
//            [--deployment <hash>] [--app <name>] [--json]
//
// Reads GET /v1/apps/{app}/logs (docs/contracts/deploy-api.md section 11), a
// Server-Sent Events stream of `log` events whose data is one `log_line`
// (redacted on the node). Without --follow: the last 100 lines (or those
// since --since), then exit 0. With --follow the stream stays open; when it
// drops, or nothing (not even the 15 s keep-alive) arrives for 45 s, the CLI
// reconnects with `Last-Event-ID`, backing off from 1 s to 30 s, so no line
// is lost or shown twice. 401, 403 and 404 end it at once; 10 failed
// reconnects in a row end it with exit 3.

import { EnvironmentError, EXIT, UserError } from "../errors.ts";
import { readProject } from "../lib/project.ts";
import { apiAuth, apiRequest, cliErrorOf, defaultIo, errorBody, type Io } from "./login.ts";

const USAGE = "usage: renox logs [--follow] [--since <ms|10m|2h|1d>] [--source all|server|client] [--deployment <hash>] [--app <name>] [--json]";
const APP = /^[a-z][a-z0-9-]{0,49}$/u;
/** Silence after which the stream is taken for dead (three keep-alives missed). */
export const IDLE_MS = 45_000;
export const MAX_RECONNECTS = 10;

export interface LogLine {
  ts: number;
  deployment_hash: string;
  request_id: string | null;
  module: string;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  fields: Record<string, unknown> | null;
  source: "server" | "client";
}

/** One line for the terminal: time, level, module, message, request id. */
export function formatLine(l: LogLine): string {
  const fields = l.fields === null || Object.keys(l.fields).length === 0 ? "" : ` ${JSON.stringify(l.fields)}`;
  const id = l.request_id === null ? "" : `  (${l.request_id})`;
  return `${new Date(l.ts).toISOString()}  ${l.level.padEnd(5)}  ${l.source === "client" ? "[browser] " : ""}${l.module}  ${l.message}${fields}${id}`;
}

/** `--since`: Unix ms, or a duration back from now (`30s`, `10m`, `2h`, `1d`). */
export function parseSince(value: string, now: number): number {
  if (/^\d{10,}$/u.test(value)) return Number(value);
  const m = /^(\d{1,6})(s|m|h|d)$/u.exec(value);
  if (m === null) throw new UserError(`--since ${JSON.stringify(value)} is not a time`, { hint: "Unix time in ms, or a duration such as 10m, 2h, 1d" });
  const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "s" | "m" | "h" | "d"];
  return Math.max(0, now - Number(m[1]) * unit);
}

interface Event {
  event: string;
  id: string | undefined;
  data: string;
}

/** Splits an SSE byte stream into events (comments and unknown fields are dropped). */
export async function* sseEvents(body: ReadableStream<Uint8Array>, onChunk: () => void = () => {}): AsyncGenerator<Event> {
  const decoder = new TextDecoder();
  let buffer = "";
  let event: Event = { event: "message", id: undefined, data: "" };
  let hasData = false;
  for await (const chunk of body) {
    onChunk();
    buffer += decoder.decode(chunk, { stream: true });
    let nl = buffer.search(/\r\n|\r|\n/u);
    while (nl >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + (buffer.startsWith("\r\n", nl) ? 2 : 1));
      if (line === "") {
        if (hasData) yield event;
        event = { event: "message", id: undefined, data: "" };
        hasData = false;
      } else if (!line.startsWith(":")) {
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /u, "");
        if (field === "event") event.event = value;
        else if (field === "id") event.id = value;
        else if (field === "data") {
          event.data = hasData ? `${event.data}\n${value}` : value;
          hasData = true;
        }
      }
      nl = buffer.search(/\r\n|\r|\n/u);
    }
  }
}

interface Options {
  app: string;
  follow: boolean;
  since: number | undefined;
  source: string;
  deployment: string | undefined;
  json: boolean;
}

function query(o: Options): string {
  const q = new URLSearchParams();
  if (o.follow) q.set("follow", "true");
  if (o.since !== undefined) q.set("since", String(o.since));
  if (o.source !== "all") q.set("source", o.source);
  if (o.deployment !== undefined) q.set("deployment", o.deployment);
  const s = q.toString();
  return s === "" ? "" : `?${s}`;
}

/** One connection: prints its lines; returns the last event id, and whether it ended cleanly. */
async function stream(io: Io, o: Options, lastId: string | undefined): Promise<{ lastId: string | undefined; lines: number }> {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    if (!o.follow) return;
    clearTimeout(timer);
    timer = setTimeout(() => abort.abort(new Error(`no data for ${IDLE_MS / 1000} s`)), IDLE_MS);
  };
  arm();
  let lines = 0;
  try {
    const res = await apiRequest(io, "GET", `/v1/apps/${o.app}/logs${query(o)}`, {
      headers: { accept: "text/event-stream", ...(lastId === undefined ? {} : { "last-event-id": lastId }) },
      signal: abort.signal,
    });
    if (res.status !== 200) throw cliErrorOf(res.status, await errorBody(res));
    if (res.body === null) return { lastId, lines };
    for await (const e of sseEvents(res.body, arm)) {
      if (e.event !== "log") continue;
      if (e.id !== undefined) lastId = e.id;
      lines++;
      if (o.json) io.out(e.data);
      else {
        try {
          io.out(formatLine(JSON.parse(e.data) as LogLine));
        } catch {
          io.out(e.data);
        }
      }
    }
    return { lastId, lines };
  } catch (e) {
    if (e instanceof UserError || (e instanceof EnvironmentError && !o.follow)) throw e;
    if (e instanceof EnvironmentError) throw Object.assign(e, { lastId, lines });
    if (!o.follow) throw new EnvironmentError(`the log stream broke: ${(e as Error).message}`);
    throw Object.assign(new EnvironmentError(`the log stream broke: ${abort.signal.aborted ? (abort.signal.reason as Error).message : (e as Error).message}`), { lastId, lines });
  } finally {
    clearTimeout(timer);
  }
}

export async function run(args: string[], io: Io = defaultIo(), project: string = process.cwd()): Promise<number> {
  const o: Options = { app: "", follow: false, since: undefined, source: "all", deployment: undefined, json: false };
  let app: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--follow" || a === "-f") o.follow = true;
    else if (a === "--json") o.json = true;
    else if (a === "--since") o.since = parseSince(args[++i] ?? "", Date.now());
    else if (a === "--source") {
      o.source = args[++i] ?? "";
      if (!["all", "server", "client"].includes(o.source)) throw new UserError(`--source ${JSON.stringify(o.source)}: use all, server or client`, { hint: USAGE });
    } else if (a === "--deployment") {
      o.deployment = args[++i] ?? "";
      if (!/^[0-9a-f]{64}$/u.test(o.deployment)) throw new UserError("--deployment takes a full 64-character hash", { hint: USAGE });
    } else if (a === "--app") {
      app = args[++i] ?? "";
      if (!APP.test(app)) throw new UserError(`--app ${JSON.stringify(app)} is not an app name`, { hint: USAGE });
    } else throw new UserError(`unknown argument ${JSON.stringify(a)}`, { hint: USAGE });
  }
  apiAuth(io.env);
  o.app = app ?? readProject(project).app.name;
  if (!o.follow) {
    await stream(io, o, undefined);
    return EXIT.OK;
  }
  let lastId: string | undefined;
  let failures = 0;
  let backoff = 1000;
  for (;;) {
    try {
      const r = await stream(io, o, lastId);
      lastId = r.lastId;
      failures = r.lines > 0 ? 0 : failures + 1;
      if (r.lines > 0) backoff = 1000;
    } catch (e) {
      if (!(e instanceof EnvironmentError)) throw e;
      const partial = e as EnvironmentError & { lastId?: string; lines?: number };
      if (partial.lastId !== undefined) lastId = partial.lastId;
      if ((partial.lines ?? 0) > 0) {
        failures = 0;
        backoff = 1000;
      } else failures++;
      if (failures >= MAX_RECONNECTS) throw new EnvironmentError(`${e.message}; gave up after ${MAX_RECONNECTS} reconnects`, { hint: "check the control plane and your network, then run `renox logs --follow` again" });
      console.error(`renox logs: ${e.message}; reconnecting in ${backoff / 1000} s`);
    }
    await io.sleep(backoff);
    backoff = Math.min(backoff * 2, 30_000);
  }
}
