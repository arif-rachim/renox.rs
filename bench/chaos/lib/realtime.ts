// Realtime clients for the chaos scenarios (#312): SSE and WebSocket
// clients that reconnect the way a browser does (SSE with `Last-Event-ID`),
// and a TCP proxy between them and a node that can cut every client link
// at once while the node and its hub keep running.

import type { Socket, TCPSocketListener } from "bun";

import { freePort } from "./stack.ts";

/**
 * A TCP proxy from a loopback port to `127.0.0.1:<target>`. `cut()` closes
 * every proxied connection and refuses new ones until `restore()`; the
 * clients see their link drop, the node sees its peers go away.
 */
export class CutProxy {
  private open = true;
  private readonly pairs = new Set<{ client: Socket<Pair>; upstream: Socket<Pair> | null }>();

  private constructor(
    readonly port: number,
    private readonly listener: TCPSocketListener<Pair>,
  ) {}

  static async start(target: number): Promise<CutProxy> {
    const port = await freePort();
    const holder: { proxy?: CutProxy } = {};
    const listener = Bun.listen<Pair>({
      hostname: "127.0.0.1",
      port,
      socket: {
        open(client) {
          const proxy = holder.proxy as CutProxy;
          if (!proxy.open) {
            client.end();
            return;
          }
          const pair: Pair = { client, upstream: null, pending: [] };
          client.data = pair;
          proxy.pairs.add(pair);
          void Bun.connect<Pair>({
            hostname: "127.0.0.1",
            port: target,
            data: pair,
            socket: {
              open(up) {
                pair.upstream = up;
                for (const b of pair.pending) up.write(b);
                pair.pending = [];
              },
              data(_up, chunk) {
                pair.client.write(chunk);
              },
              close() {
                pair.client.end();
                proxy.pairs.delete(pair);
              },
              error() {
                pair.client.end();
              },
            },
          }).catch(() => client.end());
        },
        data(client, chunk) {
          const pair = client.data;
          if (pair.upstream === null) pair.pending.push(Buffer.from(chunk));
          else pair.upstream.write(chunk);
        },
        close(client) {
          client.data?.upstream?.end();
          holder.proxy?.pairs.delete(client.data);
        },
        error(client) {
          client.data?.upstream?.end();
        },
      },
    });
    const proxy = new CutProxy(port, listener);
    holder.proxy = proxy;
    return proxy;
  }

  /** Every client link drops now; new ones are refused until `restore()`. */
  cut(): number {
    this.open = false;
    const n = this.pairs.size;
    for (const p of this.pairs) {
      p.client.terminate();
      p.upstream?.terminate();
    }
    this.pairs.clear();
    return n;
  }

  restore(): void {
    this.open = true;
  }

  stop(): void {
    this.cut();
    this.listener.stop(true);
  }
}

interface Pair {
  client: Socket<Pair>;
  upstream: Socket<Pair> | null;
  pending: Buffer[];
}

/** What one client saw: the payload sequence numbers in order, and its connections. */
export interface ClientLog {
  kind: "sse" | "ws";
  /** Payload sequence numbers in arrival order. */
  seqs: number[];
  /** Successful connections (the first one plus the reconnects). */
  connects: number;
  /** Failed connection attempts (the proxy refusing while cut). */
  refusedAttempts: number;
  /** Connect answers with `RENOX_REALTIME_LIMIT`. */
  limitRefusals: number;
  /** Seconds each successful connection lived, measured by the client. */
  lifetimes: number[];
  /** Per successful connection, the index in `seqs` of its first message. */
  starts: number[];
}

const RETRY_MS = 200;

/** Parses one SSE message block; `null` for a comment or a block without data. */
function parseSse(block: string): { id: number | null; data: string } | null {
  let id: number | null = null;
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("id:")) id = Number(line.slice(3).trim());
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /u, ""));
  }
  return data.length === 0 ? null : { id, data: data.join("\n") };
}

/**
 * An SSE client on `url` with `host`: on a dropped link it reconnects every
 * 200 ms with the last `id:` it saw as `Last-Event-ID`, until `close()`.
 */
export class SseClient {
  readonly log: ClientLog = { kind: "sse", seqs: [], connects: 0, refusedAttempts: 0, limitRefusals: 0, lifetimes: [], starts: [] };
  lastEventId: number | null = null;
  private running = true;
  private abort: AbortController | null = null;
  private readonly done: Promise<void>;

  constructor(url: string, host: string, onSeq: (seq: number) => void = () => {}) {
    this.done = (async () => {
      while (this.running) {
        this.abort = new AbortController();
        const headers: Record<string, string> = { host, accept: "text/event-stream" };
        if (this.lastEventId !== null) headers["last-event-id"] = String(this.lastEventId);
        let opened = 0;
        try {
          const r = await fetch(url, { headers, signal: this.abort.signal });
          if (r.status !== 200 || r.body === null) {
            if ((await r.text()).includes("RENOX_REALTIME_LIMIT")) this.log.limitRefusals++;
            this.log.refusedAttempts++;
          } else {
            this.log.connects++;
            this.log.starts.push(this.log.seqs.length);
            opened = performance.now();
            const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
            let buf = "";
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              buf += value;
              let i: number;
              while ((i = buf.indexOf("\n\n")) >= 0) {
                const m = parseSse(buf.slice(0, i));
                buf = buf.slice(i + 2);
                if (m === null) continue;
                if (m.id !== null) this.lastEventId = m.id;
                const seq = Number(m.data);
                if (Number.isInteger(seq)) {
                  this.log.seqs.push(seq);
                  onSeq(seq);
                }
              }
            }
          }
        } catch {
          if (opened === 0) this.log.refusedAttempts++;
        }
        if (opened > 0) this.log.lifetimes.push((performance.now() - opened) / 1000);
        if (this.running) await Bun.sleep(RETRY_MS);
      }
    })();
  }

  async close(): Promise<void> {
    this.running = false;
    this.abort?.abort();
    await this.done;
  }
}

/** A WebSocket client on `url` with `host`: on a dropped link it reconnects every 200 ms, until `close()`. */
export class WsClient {
  readonly log: ClientLog = { kind: "ws", seqs: [], connects: 0, refusedAttempts: 0, limitRefusals: 0, lifetimes: [], starts: [] };
  private running = true;
  private socket: WebSocket | null = null;
  private readonly done: Promise<void>;

  constructor(url: string, host: string, onSeq: (seq: number) => void = () => {}) {
    this.done = (async () => {
      while (this.running) {
        await new Promise<void>((settle) => {
          // Bun's WebSocket takes request headers; the node routes on Host.
          const ws = new WebSocket(url, { headers: { host } } as unknown as string[]);
          this.socket = ws;
          let opened = 0;
          ws.onopen = () => {
            opened = performance.now();
            this.log.connects++;
            this.log.starts.push(this.log.seqs.length);
          };
          ws.onmessage = (e) => {
            const seq = Number(String(e.data));
            if (Number.isInteger(seq)) {
              this.log.seqs.push(seq);
              onSeq(seq);
            }
          };
          ws.onclose = (e) => {
            if (opened > 0) this.log.lifetimes.push((performance.now() - opened) / 1000);
            else {
              this.log.refusedAttempts++;
              if (String(e.reason).includes("RENOX_REALTIME_LIMIT")) this.log.limitRefusals++;
            }
            settle();
          };
        });
        if (this.running) await Bun.sleep(RETRY_MS);
      }
    })();
  }

  async close(): Promise<void> {
    this.running = false;
    this.socket?.close(1000);
    await this.done;
  }
}

/**
 * The gaps of a sequence that should be `first..last` without holes:
 * how many numbers are missing, and how many arrived twice.
 */
export function gaps(seqs: number[]): { missing: number; duplicates: number; first: number; last: number } {
  if (seqs.length === 0) return { missing: 0, duplicates: 0, first: 0, last: 0 };
  const seen = new Set<number>();
  let duplicates = 0;
  for (const s of seqs) {
    if (seen.has(s)) duplicates++;
    seen.add(s);
  }
  const first = Math.min(...seen);
  const last = Math.max(...seen);
  return { missing: last - first + 1 - seen.size, duplicates, first, last };
}
