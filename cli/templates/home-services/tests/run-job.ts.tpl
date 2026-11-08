// Runs a scheduled job of the app now, as the scheduler would. The worker has no
// `t.job()`: a tick of the job is written the way `renox jobs run` writes one
// (the worker may be writing, so the lock is taken first), and a signed message
// from a number nobody knows wakes the outbox (it commits an event), which runs
// the tick. The same technique as `sweep()` in notifications.test.ts, for any job.
import { Database } from "bun:sqlite";
import { expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { app } from "@renoxium/sdk/test";

type App = Awaited<ReturnType<typeof app>>;

const ENV = Object.fromEntries(
  readFileSync(join(import.meta.dir, "..", ".env.test"), "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
) as Record<string, string>;

async function hmac(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

let seq = 0;

/** Runs `jobs/<name>.ts` once and waits until its run is done (a failing run stays in the outbox and fails the test with its row). */
export async function runJob(t: App, name: string): Promise<void> {
  const id = `01HJ${crypto.randomUUID().replace(/-/gu, "").slice(0, 22).toUpperCase()}`; // 26 characters, like the platform's ULIDs
  const pending = () => t.db.query<Record<string, unknown>>("select * from renox__outbox where id = ?", [id]);
  const db = new Database(t.dbFile);
  try {
    db.transaction(() => {
      db.query("insert into renox__outbox (id, target, name, payload, module, created_at, attempts, next_at) values (?, 'app', ?, 'null', 'app', ?, 0, ?)").run(id, `job:${name}`, Date.now(), Date.now());
      db.query("insert into renox__outbox_meta (key, value) values (?, ?) on conflict (key) do update set value = excluded.value").run(`job_tick:app:${name}`, Date.now());
    }).immediate();
  } finally {
    db.close();
  }
  const raw = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ id: `wamid.job${++seq}${Date.now()}`, from: "971500000000", timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: `wake ${seq}` } }] } }] }] });
  const woke = await t.request("POST", "/whatsapp/webhook/whatsapp", { headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${await hmac(ENV.WHATSAPP_APP_SECRET as string, raw)}` }, body: raw });
  expect(woke.status).toBe(200);
  for (let i = 0; i < 200 && pending().length > 0; i++) await Bun.sleep(50);
  expect(pending()).toEqual([]);
}
