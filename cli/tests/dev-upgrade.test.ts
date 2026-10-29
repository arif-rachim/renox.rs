// #284: `renox dev` proxies WebSocket upgrades and SSE streams to the
// worker without buffering: a WebSocket echo round trip through the proxy,
// and three SSE events sent 400 ms apart arrive about 400 ms apart (not
// together at the end). The terminal shows the connection lines.

import { expect, test } from "bun:test";
import { rmSync } from "node:fs";

import { startDev } from "../src/commands/dev.ts";
import { app } from "./authz-fixture.ts";
import { testWorker } from "./worker-env.ts";

const worker = testWorker();
if (worker) process.env.RENOX_WORKER_PATH = worker;

const FILES = {
  "renox.toml": `[app]\nname = "live"\ntimezone = "Asia/Dubai"\n`,
  "functions/ws/echo.ts": `export const ws = {
  async open(ctx) { await ctx.realtime.send(ctx.conn, "ready"); },
  async message(ctx) { await ctx.realtime.send(ctx.conn, "echo: " + ctx.data); },
};
`,
  "functions/sse/ticks.ts": `export const sse = {
  async open(ctx) {
    for (let i = 1; i <= 3; i++) {
      await ctx.realtime.send(ctx.conn, { text: String(i), event: "tick" });
      if (i < 3) await new Promise((r) => setTimeout(r, 400));
    }
  },
};
`,
};

test.skipIf(!worker)(
  "a WebSocket echo and an unbuffered SSE stream through the dev proxy",
  async () => {
    const dir = app(FILES);
    const port = 20000 + Math.floor(Math.random() * 20000);
    const lines: string[] = [];
    const dev = await startDev({ project: dir, port, log: (l) => lines.push(l) });
    try {
      // WebSocket: ready, then the echo of each message.
      const ws = new WebSocket(`ws://localhost:${port}/ws/echo`);
      const got: string[] = [];
      const want = 3;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`ws: got ${JSON.stringify(got)}`)), 10_000);
        ws.onmessage = (e) => {
          got.push(String(e.data));
          if (got[0] === "ready" && got.length === 1) {
            ws.send("one");
            ws.send("two");
          }
          if (got.length === want) {
            clearTimeout(timer);
            resolve();
          }
        };
        ws.onerror = () => reject(new Error("ws error"));
      });
      expect(got).toEqual(["ready", "echo: one", "echo: two"]);
      ws.close(1000, "done");

      // #118: a browser's cookie-bearing socket from the dev page itself is
      // let through; one from another site is refused before the handshake
      // (docs/24-threat-model.md A, "Cross-site WebSocket hijacking").
      const opened = (origin: string) =>
        new Promise<boolean>((resolve) => {
          const s = new WebSocket(`ws://localhost:${port}/ws/echo`, {
            headers: { origin, cookie: "renox_session=x" },
          } as unknown as string[]);
          s.onmessage = () => {
            s.close(1000);
            resolve(true);
          };
          s.onclose = () => resolve(false);
        });
      expect(await opened(`http://localhost:${port}`)).toBe(true);
      expect(await opened("https://evil.example")).toBe(false);

      // SSE: three events, each as it is sent.
      const res = await fetch(`http://localhost:${port}/sse/ticks`, { headers: { accept: "text/event-stream" } });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toStartWith("text/event-stream");
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      const arrivals: number[] = [];
      let text = "";
      const t0 = performance.now();
      while (arrivals.length < 3 && performance.now() - t0 < 10_000) {
        const { value, done } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
        const count = (text.match(/^event: tick$/gmu) ?? []).length;
        while (arrivals.length < count) arrivals.push(performance.now() - t0);
      }
      await reader.cancel();
      expect(text).toContain("data: 1\n");
      expect(text).toContain("data: 3\n");
      expect(arrivals).toHaveLength(3);
      // Sent 400 ms apart: unbuffered, the first and the last arrive at least ~700 ms apart.
      expect((arrivals[2] as number) - (arrivals[0] as number)).toBeGreaterThan(600);
      console.log(`dev proxy: SSE arrivals ${arrivals.map((a) => a.toFixed(0)).join(", ")} ms`);
      await Bun.sleep(200);
      const log = lines.join("\n");
      expect(log).toContain("ws open   /ws/echo");
      expect(log).toMatch(/ws close  \/ws\/echo 1000 done/u);
      expect(log).toContain("sse open  /sse/ticks");
      expect(log).toMatch(/sse close \/sse\/ticks/u);
      expect(log).toContain("WS      /ws/echo");
    } finally {
      await dev.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  },
  60_000,
);
