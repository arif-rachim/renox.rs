// `renox dev` end to end against the prebuilt worker. Runs only when
// RENOX_WORKER_PATH is set (CI after #36; locally: cargo build -p
// renox-cell --bin renox-worker and point it at target/debug/renox-worker).
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startDev } from "../src/commands/dev.ts";
import { newApp } from "../src/commands/new.ts";

const worker = process.env.RENOX_WORKER_PATH;

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
