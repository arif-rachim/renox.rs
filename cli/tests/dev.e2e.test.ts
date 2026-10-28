// `renox dev` end to end against the prebuilt worker. Runs only when
// RENOX_WORKER_PATH is set (always in CI, #186; locally: cargo build -p
// renox-cell --bin renox-worker and point it at target/debug/renox-worker).
import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startDev } from "../src/commands/dev.ts";
import { newApp } from "../src/commands/new.ts";
import { testWorker } from "./worker-env.ts";

const worker = testWorker();

test.skipIf(!worker)(
  "renox dev serves the hello app and a file edit is live within 1 s",
  async () => {
    const dir = newApp("devtest", "hello", mkdtempSync(join(tmpdir(), "renox-dev-")));
    writeFileSync(join(dir, ".env"), "GREETING=salaam-alaikum-123\n");
    const port = 20000 + Math.floor(Math.random() * 20000);
    const lines: string[] = [];
    const dev = await startDev({ project: dir, port, log: (l) => lines.push(l) });
    try {
      const r1 = await fetch(`http://localhost:${port}/api/hello`);
      expect(r1.status).toBe(200);
      expect(await r1.json()).toEqual({ ok: true });

      const file = join(dir, "functions/api/hello.ts");
      const reload = dev.nextReload();
      const edited = Date.now();
      writeFileSync(file, readFileSync(file, "utf8").replace("ok: true", 'ok: "edited"'));
      const { ms } = await reload;
      let body: unknown;
      for (;;) {
        body = await (await fetch(`http://localhost:${port}/api/hello`)).json();
        if ((body as { ok: unknown }).ok === "edited" || Date.now() - edited > 1000) break;
        await Bun.sleep(10);
      }
      const live = Date.now() - edited;
      expect(body).toEqual({ ok: "edited" });
      expect(live).toBeLessThan(1000);
      console.log(`renox dev: rebuild ${ms} ms, edit to new response ${live} ms`);

      // Secrets from .env are written 0600 and never printed.
      const mode = (await import("node:fs")).statSync(join(dir, ".renox/data/dev/secrets.json")).mode & 0o777;
      expect(mode).toBe(0o600);
      expect(lines.join("\n")).not.toContain("salaam-alaikum-123");
    } finally {
      await dev.stop();
    }
  },
  60_000,
);

/** Reads server-sent events from `url` until `stop()`; `next(name)` waits for one. */
function events(url: string): { next: (name: string, ms?: number) => Promise<unknown>; stop: () => void } {
  const ctl = new AbortController();
  const seen: { event: string; data: unknown }[] = [];
  const waiting: { name: string; resolve: (d: unknown) => void }[] = [];
  void (async () => {
    const res = await fetch(url, { signal: ctl.signal });
    const dec = new TextDecoder();
    let buf = "";
    try {
      for await (const chunk of res.body as ReadableStream<Uint8Array>) {
        buf += dec.decode(chunk);
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const event = /^event: (.*)$/mu.exec(block)?.[1];
          const data = /^data: (.*)$/mu.exec(block)?.[1];
          if (!event) continue;
          const parsed = data ? JSON.parse(data) : null;
          const w = waiting.findIndex((x) => x.name === event);
          if (w >= 0) waiting.splice(w, 1)[0]?.resolve(parsed);
          else seen.push({ event, data: parsed });
        }
      }
    } catch {
      // Aborted.
    }
  })();
  return {
    next: (name, ms = 5000) => {
      const i = seen.findIndex((s) => s.event === name);
      if (i >= 0) return Promise.resolve(seen.splice(i, 1)[0]?.data);
      return Promise.race([
        new Promise((resolve) => waiting.push({ name, resolve })),
        Bun.sleep(ms).then(() => {
          throw new Error(`no ${name} event within ${ms} ms; seen ${JSON.stringify(seen)}`);
        }),
      ]);
    },
    stop: () => ctl.abort(),
  };
}

test.skipIf(!worker)(
  "renox dev with pages: dev client injected, template edit swaps the fragment, overlay on error, types regenerated (#43)",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "renox-dev-pages-"));
    cpSync(join(import.meta.dir, "fixtures/pages"), dir, { recursive: true });
    writeFileSync(join(dir, "pages/box.html"), '<html><body><h1>Box</h1><div id="box" r-fragment="box">v1</div></body></html>\n');
    const port = 20000 + Math.floor(Math.random() * 20000);
    const lines: string[] = [];
    const dev = await startDev({ project: dir, port, log: (l) => lines.push(l) });
    const base = `http://localhost:${port}`;
    const sse = events(`${base}/__renox/dev/events`);
    try {
      const page = await fetch(`${base}/box`);
      expect(page.status).toBe(200);
      const html = await page.text();
      // The injected script carries the response's CSP nonce (#47).
      const nonce = /'nonce-([^']+)'/u.exec(page.headers.get("content-security-policy") ?? "")?.[1];
      expect(nonce).toBeDefined();
      expect(html).toContain(`<script src="/__renox/dev/client.js" nonce="${nonce}" defer></script></body>`);
      expect(await (await fetch(`${base}/__renox/dev/client.js`)).text()).toContain("EventSource");
      // A fragment response is not touched.
      const frag = await (await fetch(`${base}/box`, { headers: { "hx-request": "true", "hx-target": "box" } })).text();
      expect(frag).toBe('<div id="box">v1</div>');
      // .renox/types was written by the first build.
      expect(readFileSync(join(dir, ".renox/types/routes.d.ts"), "utf8")).toContain('"pages/box": "box";');

      // Template-only edit: a `templates` event naming the fragment target.
      const file = join(dir, "pages/box.html");
      const edited = performance.now();
      writeFileSync(file, readFileSync(file, "utf8").replace("v1", "v2"));
      expect(await sse.next("templates")).toEqual({ targets: ["box"] });
      const after = await (await fetch(`${base}/box`, { headers: { "hx-request": "true", "hx-target": "box" } })).text();
      expect(after).toBe('<div id="box">v2</div>');
      console.log(`renox dev: template edit to swapped fragment ${Math.round(performance.now() - edited)} ms`);

      // A broken template: an `error` event with file and line; the last good artifact keeps serving.
      writeFileSync(file, "<p>ok</p>\n<p>{{ range(3) }}</p>\n");
      const err = (await sse.next("error")) as { problems: { file: string; line: number; message: string }[] };
      expect(err.problems[0]).toMatchObject({ file: "pages/box.html", line: 2 });
      expect((await fetch(`${base}/box`)).status).toBe(200);

      // Fixed again: the browser swaps (the overlay hides on that event).
      writeFileSync(file, '<html><body><h1>Box</h1><div id="box" r-fragment="box">v3</div></body></html>\n');
      expect(await sse.next("templates")).toEqual({ targets: ["box"] });

      // A code change reloads.
      const ts = join(dir, "pages/logout.ts");
      writeFileSync(ts, readFileSync(ts, "utf8").replace("303", "302"));
      expect(await sse.next("reload")).toEqual({});
    } finally {
      sse.stop();
      await dev.stop();
    }
  },
  60_000,
);
