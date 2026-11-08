// The dispatch board (F7-122): a page of columns by status, and a WebSocket per
// branch that pushes every changed card. Two dispatchers of one branch see a
// transition made in one session on the other's board without a reload; a
// dispatcher of another branch is refused at the upgrade (403) and receives
// nothing of it. Runs on the local worker with the seed's users.
import { describe, expect, test } from "bun:test";
import { snapshot, app } from "@renoxium/sdk/test";
import type { WsStream } from "@renoxium/sdk/test";

const t = await app();
const PASSWORD = "correct horse battery";

async function signIn(jar: string, email: string, next = "/dispatch") {
  const u = t.as(jar);
  const res = await u.action("/auth/login", "default", { email, password: PASSWORD, next });
  expect(res.status).toBe(303);
  return u;
}

const dina = await signIn("dina", "dispatcher.dubai@fixit.example");
const mona = await signIn("mona", "manager.dubai@fixit.example");
const owner = await signIn("owner", "owner@fixit.example");
const sami = await signIn("sami", "dispatcher.sharjah@fixit.example");
const accountant = await signIn("accountant", "accountant.dubai@fixit.example");
const ali = await signIn("ali", "ali.dubai@fixit.example");
const anonymous = t.as("anonymous");

const rows = (sql: string, params: (string | number | null)[] = []) => t.db.query<Record<string, unknown>>(sql, params);

/** The next frame that carries a card (the change feed's JSON frames are skipped), or null. */
async function nextCard(ws: WsStream, ms = 3000): Promise<string | null> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const m = await ws.next(Math.max(100, end - Date.now()));
    if (m === null) return null;
    if (m.includes("hx-swap-oob")) return m;
  }
  return null;
}

/** Every frame that arrives within `ms`. */
async function drain(ws: WsStream, ms: number): Promise<string[]> {
  const out: string[] = [];
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const m = await ws.next(Math.max(50, end - Date.now()));
    if (m !== null) out.push(m);
  }
  return out;
}

/** An upgrade request, without opening a socket: the status the cell answers it with. */
const upgrade = (u: typeof dina, path: string) =>
  u.request("GET", path, { headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", origin: "https://home-services.test" } });

describe("the board page", () => {
  test("columns by status, with the branch's cards and the socket of its branch", async () => {
    const res = await dina.page("/dispatch");
    expect(res.status).toBe(200);
    expect(res.html).toContain('data-socket="/ws/dispatch/dubai"');
    for (const status of ["new", "scheduled", "en_route", "in_progress", "done"]) expect(res.html).toContain(`id="col-${status}"`);
    // New jobs are all shown, in their column; the unscheduled one has no technician.
    expect(res.html).toMatch(/id="col-new"[^]*id="job-jb_seed_01"[^]*id="col-scheduled"/u);
    expect(res.html).toMatch(/id="col-en_route"[^]*id="job-jb_seed_09"[^]*id="col-in_progress"/u);
    // Today's and tomorrow's scheduled work; cancelled and invoiced jobs are not on the board.
    expect(res.html).toContain('id="job-jb_seed_06"');
    expect(res.html).not.toContain('id="job-jb_seed_13"');
    expect(res.html).not.toContain('id="job-jb_seed_14"');
    // The Sharjah branch's jobs are not here.
    expect(res.html).not.toContain("jb_seed_15");
    expect(res.html).not.toContain("jb_seed_17");
    expect(res.html).toContain("Ali Hassan");
    expect(res.html).toContain("Bilal Raza");
    snapshot(res.html.replace(/<small dir="ltr">[^<]*<\/small>/gu, "<small></small>"), { role: "dispatch board, dispatcher, en" });
  });

  test("the Sharjah dispatcher's board is Sharjah's", async () => {
    const res = await sami.page("/dispatch");
    expect(res.html).toContain('data-socket="/ws/dispatch/sharjah"');
    expect(res.html).toContain('id="job-jb_seed_15"');
    expect(res.html).not.toContain('id="job-jb_seed_01"');
  });

  test("the board needs job.dispatch: an accountant, a technician and a visitor are refused", async () => {
    expect((await accountant.page("/dispatch")).status).toBe(403);
    expect((await ali.page("/dispatch")).status).toBe(403);
    expect((await anonymous.page("/dispatch")).status).toBe(403);
  });

  test("the board in Arabic, right to left", async () => {
    const res = await mona.page("/dispatch?lang=ar");
    expect(res.status).toBe(200);
    expect(res.html).toContain('<html lang="ar" dir="rtl"');
    expect(res.html).toContain("لوحة التوزيع");
  });
});

describe("the live board", () => {
  test("normal case: a transition in one session reaches the other dispatcher's socket, without a reload", async () => {
    const a = await dina.ws("/ws/dispatch/dubai");
    const b = await mona.ws("/ws/dispatch/dubai");
    const c = await owner.ws("/ws/dispatch/dubai");
    // All three have subscribed (open ran) before the change.
    await Bun.sleep(300);
    const res = await dina.action("/jobs/jb_seed_06", "status", { to: "en_route", note: "Leaving the workshop" });
    expect(res.status).toBe(303);
    for (const ws of [a, b, c]) {
      const card = await nextCard(ws);
      expect(card).not.toBeNull();
      // The card leaves its old place and is put first in its new column, with its data escaped by the template.
      expect(card).toContain('<div id="job-jb_seed_06" hx-swap-oob="delete"></div>');
      expect(card).toContain('<div id="col-en_route" hx-swap-oob="afterbegin">');
      expect(card).toContain("J-000006");
      expect(card).toContain("Peter Nowak");
      expect(card).toContain("Pest control");
      expect(card).toContain("Ali Hassan");
    }
    a.close();
    b.close();
    c.close();
  });

  test("the change feed also reaches the board's topic as { table, rowid, op }", async () => {
    const ws = await dina.ws("/ws/dispatch/dubai");
    await Bun.sleep(300);
    expect((await dina.action("/jobs/jb_seed_09", "status", { to: "in_progress" })).status).toBe(303);
    const frames = await drain(ws, 1500);
    const feed = frames.filter((f) => f.startsWith("{")).map((f) => JSON.parse(f) as { table: string; op: string });
    expect(feed.length).toBeGreaterThan(0);
    expect(feed.every((f) => f.table === "app__jobs")).toBe(true);
    expect(feed.some((f) => f.op === "update")).toBe(true);
    expect(frames.some((f) => f.includes('id="col-in_progress"') && f.includes("J-000009"))).toBe(true);
    ws.close();
  });

  test("creating, scheduling and cancelling push cards too", async () => {
    const ws = await dina.ws("/ws/dispatch/dubai");
    await Bun.sleep(300);
    const res = await dina.action("/jobs/new", "create", { site_id: "st_dxb_05a", service: String(rows("select id from app__services where code = 'HANDYMAN'")[0]?.id), priority: "urgent", description: "Burst pipe" });
    expect(res.status).toBe(303);
    const id = (res.headers.get("location") ?? "").replace("/jobs/", "");
    const made = await nextCard(ws);
    expect(made).toContain('<div id="col-new" hx-swap-oob="afterbegin">');
    expect(made).toContain(`id="job-${id}"`);
    expect(made).toContain("priority-urgent");
    expect((await dina.action(`/jobs/${id}`, "cancel", { note: "Fixed by the owner" })).status).toBe(303);
    const cancelled = await nextCard(ws);
    expect(cancelled).toContain('<div id="col-cancelled" hx-swap-oob="afterbegin">');
    ws.close();
  });

  test("a card's text is escaped: a customer name cannot add markup to the board", async () => {
    const ws = await dina.ws("/ws/dispatch/dubai");
    await Bun.sleep(300);
    const db = new (await import("bun:sqlite")).Database(t.dbFile);
    db.exec("pragma busy_timeout = 5000");
    db.run("update app__customers set name = 'Eve <img src=x onerror=alert(1)>' where id = 'cu_dxb_05'");
    db.close();
    expect((await dina.action("/jobs/jb_seed_04", "status", { to: "cancelled" })).status).toBe(303);
    const card = await nextCard(ws);
    expect(card).toContain("Eve &lt;img src=x onerror=alert(1)&gt;");
    expect(card).not.toContain("<img");
    ws.close();
  });
});

describe("one branch's board is closed to the others", () => {
  test("error case: a Sharjah dispatcher cannot open /ws/dispatch/dubai: 403 on the upgrade", async () => {
    const refused = await upgrade(sami, "/ws/dispatch/dubai");
    expect(refused.status).toBe(403);
    const out = await sami.ws("/ws/dispatch/dubai");
    expect(await out.closed).toBe(1006);
    // Their own branch's socket opens.
    const own = await sami.ws("/ws/dispatch/sharjah");
    await Bun.sleep(300);
    expect(await Promise.race([own.closed, Bun.sleep(500).then(() => "open")])).toBe("open");
    own.close();
  });

  test("a Dubai dispatcher cannot open Sharjah's either, nor a branch that does not exist", async () => {
    expect((await upgrade(dina, "/ws/dispatch/sharjah")).status).toBe(403);
    expect((await upgrade(dina, "/ws/dispatch/atlantis")).status).toBe(403);
  });

  test("an accountant, a technician and a visitor are refused", async () => {
    expect((await upgrade(accountant, "/ws/dispatch/dubai")).status).toBe(403);
    expect((await upgrade(ali, "/ws/dispatch/dubai")).status).toBe(403);
    expect((await upgrade(anonymous, "/ws/dispatch/dubai")).status).toBe(403);
  });

  test("Sharjah's socket receives nothing of a Dubai transition, and Dubai's nothing of Sharjah's", async () => {
    const shj = await sami.ws("/ws/dispatch/sharjah");
    const dxb = await dina.ws("/ws/dispatch/dubai");
    await Bun.sleep(300);
    expect((await dina.action("/jobs/jb_seed_02", "status", { to: "cancelled" })).status).toBe(303);
    expect(await nextCard(dxb)).toContain("J-000002");
    expect(await drain(shj, 800)).toEqual([]);
    expect((await sami.action("/jobs/jb_seed_16", "status", { to: "cancelled" })).status).toBe(303);
    expect(await nextCard(shj)).toContain("J-000016");
    expect((await drain(dxb, 800)).join("")).not.toContain("J-000016");
    shj.close();
    dxb.close();
  });
});
