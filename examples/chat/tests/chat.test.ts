// examples/chat on the real worker (#282): two members of a room see each
// other's message as the fragment the server rendered; a non-member's
// socket to a private room is refused by the policy (closed with 1008);
// a signed-out upgrade is refused by the route's guard (403).

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { app, type TestApp } from "../../../sdk/src/test.ts";

const worker = process.env.RENOX_TEST_SPEC ?? process.env.RENOX_WORKER_PATH;
const t = worker ? await app({ project: join(import.meta.dir, "..") }) : (undefined as unknown as TestApp);
const PASSWORD = "correct horse battery";

async function user(name: string): Promise<TestApp> {
  const u = t.as(name);
  await u.action("/auth/register", "default", { email: `${name}@example.com`, password: PASSWORD, display_name: name });
  expect((await u.action("/auth/login", "default", { email: `${name}@example.com`, password: PASSWORD })).status).toBe(303);
  return u;
}

const idOf = (name: string) => t.db.query<{ id: string }>("select id from auth__users where email = ?", [`${name}@example.com`])[0]?.id as string;

describe.skipIf(!worker)("chat", () => {
  test("two users in a room see each other's message fragment", async () => {
    const lina = await user("Lina");
    const omar = await user("Omar");
    const index = await lina.page("/");
    expect(index.html).toContain('href="/rooms/general"');
    expect(index.html).not.toContain('href="/rooms/team"');
    const page = await lina.page("/rooms/general");
    expect(page.status).toBe(200);
    expect(page.html).toContain('data-socket="/ws/chat/general"');
    const a = await lina.ws("/ws/chat/general");
    const b = await omar.ws("/ws/chat/general");
    // Both subscribed (open ran) before the first message.
    await Bun.sleep(200);
    a.send(JSON.stringify({ text: "Salam <b>all</b>" }));
    const seenByOmar = await b.next();
    const seenByLina = await a.next();
    for (const m of [seenByOmar, seenByLina]) {
      expect(m).toContain('<div id="messages" hx-swap-oob="beforeend">');
      expect(m).toContain("<strong dir=\"auto\">Lina</strong>");
      // The text is escaped by the template.
      expect(m).toContain("Salam &lt;b&gt;all&lt;/b&gt;");
    }
    b.send(JSON.stringify({ text: "Hello Lina" }));
    expect(await a.next()).toContain("Hello Lina");
    a.close();
    b.close();
  });

  test("a private room: a non-member's socket is closed with 1008; a member joins", async () => {
    const sara = await user("Sara");
    const out = await sara.ws("/ws/chat/team");
    expect(await out.closed).toBe(1008);
    expect((await sara.page("/rooms/team")).status).toBe(403);
    const db = new Database(t.dbFile);
    db.exec("pragma busy_timeout = 5000");
    try {
      db.query("insert into app__members (room_id, user_id) values ('team', ?)").run(idOf("Sara"));
    } finally {
      db.close();
    }
    expect((await sara.page("/rooms/team")).status).toBe(200);
    const inside = await sara.ws("/ws/chat/team");
    await Bun.sleep(200);
    inside.send(JSON.stringify({ text: "only members read this" }));
    expect(await inside.next()).toContain("only members read this");
    inside.close();
  });

  test("signed out: the guard refuses the upgrade (403, no socket); an unknown room closes it", async () => {
    const anon = await t.as("anon").ws("/ws/chat/general");
    expect(await anon.closed).toBe(1006);
    const handshake = await t.as("anon").request("GET", "/ws/chat/general", {
      headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", origin: "https://chat.test" },
    });
    expect(handshake.status).toBe(403);
    const lina = t.as("Lina");
    const nowhere = await lina.ws("/ws/chat/nowhere");
    expect([1008, 1011]).toContain(await nowhere.closed);
  });
});
