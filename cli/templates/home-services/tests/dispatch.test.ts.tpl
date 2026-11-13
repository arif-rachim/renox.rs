// The dispatch board (F7-122): a page of columns by status, and a WebSocket per
// branch that pushes every changed card. Two dispatchers of one branch see a
// transition made in one session on the other's board without a reload; a
// dispatcher of another branch is refused at the upgrade (403) and receives
// nothing of it. Runs on the local worker with the seed's users.
import { describe, expect, test } from "bun:test";
import { snapshot, app } from "@renoxium/sdk/test";
import type { WsStream } from "@renoxium/sdk/test";

import { phoneSignIn } from "./outbox";

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

  test("a customer's cancel on /my (#778) removes the card from the board over the WebSocket", async () => {
    // A self-booking of Peter Nowak's (cu_dxb_02) waiting for the dispatcher; Peter signs in by phone.
    const { Database } = await import("bun:sqlite");
    const write = (sql: string, params: (string | number | null)[]) => {
      const db = new Database(t.dbFile);
      db.exec("pragma busy_timeout = 5000");
      try {
        db.run(sql, params);
      } finally {
        db.close();
      }
    };
    const at = Math.floor(Date.now() / 1000);
    write(
      "insert into app__jobs (id, branch_id, customer_id, site_id, quote_id, number, status, priority, service_id, description, scheduled_start, scheduled_end, technician_user_id, booking_id, created_by, created_at, updated_at, source) values ('jb_ws_customer', 'br_dubai', 'cu_dxb_02', 'st_dxb_02a', null, 'J-000981', 'new', 'normal', ?, '', ?, ?, null, null, 'u_dxb_dispatcher', ?, ?, 'self_booking')",
      [Number(rows("select id from app__services where code = 'HANDYMAN'")[0]?.id), at + 3 * 86_400, at + 3 * 86_400 + 3600, at, at],
    );
    const peter = t.as("peter");
    expect((await phoneSignIn(peter, rows, write, "+971521110002", "/my")).status).toBe(303);
    expect((await dina.page("/dispatch")).html).toContain('id="job-jb_ws_customer"');
    const ws = await dina.ws("/ws/dispatch/dubai");
    await Bun.sleep(300);
    expect((await peter.action("/my/visits/jb_ws_customer", "cancel", { reason: "no_longer_needed" })).status).toBe(303);
    const card = await nextCard(ws);
    // The card leaves its column; the board has no cancelled column, so it is gone without a reload.
    expect(card).toContain('<div id="job-jb_ws_customer" hx-swap-oob="delete"></div>');
    expect(card).toContain('<div id="col-cancelled" hx-swap-oob="afterbegin">');
    expect((await dina.page("/dispatch")).html).not.toContain('id="col-cancelled"');
    expect((await dina.page("/dispatch")).html).not.toContain('id="job-jb_ws_customer"');
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

// The board on a busy day (#728): a column renders at most 30 cards, the rest is one link away, the loader
// does not run a query per card, and the page has no inline script. This harness runs the real worker and has
// no statement counter (the shop's unit test wraps its Db; here the loader runs inside the worker), so the
// "no query per card" check is a wall-clock bound: with 200+ jobs a per-card query (three each before #728)
// takes seconds, one query for the board takes a few tens of milliseconds.
describe("the busy board", () => {
  const sql = async (statements: (db: import("bun:sqlite").Database) => void) => {
    const db = new (await import("bun:sqlite")).Database(t.dbFile);
    db.exec("pragma busy_timeout = 5000");
    try {
      statements(db);
    } finally {
      db.close();
    }
  };
  const addJobs = (count: number, status: string, prefix: string) =>
    sql((db) => {
      const serviceId = Number((db.query("select id from app__services order by id limit 1").get() as { id: number }).id);
      const today = Math.floor(Date.now() / 1000);
      const insert = db.prepare(
        "insert into app__jobs (id, branch_id, customer_id, site_id, quote_id, number, status, priority, service_id, description, scheduled_start, scheduled_end, technician_user_id, booking_id, created_by, created_at, updated_at) values (?1, 'br_dubai', 'cu_dxb_01', 'st_dxb_01a', null, ?2, ?3, 'normal', ?4, 'Busy', ?5, ?6, ?7, null, 'u_dxb_dispatcher', 1793400000, 1793400000)",
      );
      for (let i = 1; i <= count; i++) {
        const id = `jb_${prefix}_${String(i).padStart(3, "0")}`;
        const start = status === "new" ? null : today;
        insert.run(id, `J-${prefix.toUpperCase()}${String(i).padStart(3, "0")}`, status, serviceId, start, start === null ? null : start + 3600, status === "new" ? null : "u_dxb_ali");
      }
    });
  const removeJobs = (prefix: string) => sql((db) => void db.run(`delete from app__jobs where id like 'jb\\_${prefix}\\_%' escape '\\'`));
  const column = (html: string, status: string): string => {
    const from = html.indexOf(`id="col-${status}"`);
    return html.slice(from, html.indexOf("</section>", from));
  };
  const cards = (html: string, status: string): number => (column(html, status).match(/<article /gu) ?? []).length;
  const newJobs = (): number => Number(rows("select count(*) as n from app__jobs where branch_id = 'br_dubai' and status = 'new'")[0]?.n);

  test("a column with more than 30 jobs renders 30 cards and a Show all link with the right count; ?column=new&all=1 renders them all", async () => {
    await addJobs(35, "new", "cap");
    try {
      const total = newJobs();
      expect(total).toBeGreaterThan(35);
      const res = await dina.page("/dispatch");
      expect(res.status).toBe(200);
      expect(cards(res.html, "new")).toBe(30);
      expect(column(res.html, "new")).toContain(`<a href="/dispatch?column=new&amp;all=1">Show all ${total}</a>`);
      // A column that holds fewer has no link.
      expect(column(res.html, "done")).not.toContain("Show all");
      const all = await dina.page("/dispatch?column=new&all=1");
      expect(cards(all.html, "new")).toBe(total);
      expect(column(all.html, "new")).not.toContain("Show all");
      expect(all.html).toContain('id="job-jb_cap_035"');
      expect(res.html).not.toContain('id="job-jb_cap_035"');
      // Another column's `all` does not open this one.
      expect(cards((await dina.page("/dispatch?column=scheduled&all=1")).html, "new")).toBe(30);
      // The Arabic text counts too.
      const ar = await dina.page("/dispatch?lang=ar");
      expect(column(ar.html, "new")).toContain(`عرض الكل (${total})`);
    } finally {
      await removeJobs("cap");
    }
  });

  test("a card carries no form: assigning and moving a job are on the job's own page", async () => {
    const res = await dina.page("/dispatch");
    const board = res.html.slice(res.html.indexOf('id="board"'), res.html.indexOf('<p><a href="/jobs">'));
    expect(board).toContain("<article ");
    expect(board).not.toContain("<form");
    expect(board).not.toContain("<select");
  });

  test("the page has no inline script: the board's script is a file, loaded with defer", async () => {
    const res = await dina.page("/dispatch");
    expect(res.html).not.toMatch(/<script(?![^>]*\bsrc=)/u);
    expect(res.html).toMatch(/<script src="\/board\.[0-9a-f]{16}\.js" defer nonce="[^"]+"><\/script>/u);
    // The file serves, with the behaviour the accessibility pass added (#727).
    const src = /<script src="(\/board\.[0-9a-f]{16}\.js)"/u.exec(res.html)?.[1] ?? "";
    const js = await t.request("GET", src);
    expect(js.status).toBe(200);
    expect(js.html).toContain("board-announcer");
    expect(js.html).toContain("hx-swap-oob");
  });

  test("with 200 jobs today the board loads in one pass: under 150 ms (no statement counter in this harness)", async () => {
    await addJobs(70, "new", "t1");
    await addJobs(70, "scheduled", "t2");
    await addJobs(60, "done", "t3");
    try {
      expect(Number(rows("select count(*) as n from app__jobs where branch_id = 'br_dubai'")[0]?.n)).toBeGreaterThanOrEqual(200);
      await dina.page("/dispatch");
      const times: number[] = [];
      for (let i = 0; i < 3; i++) {
        const started = performance.now();
        const res = await dina.page("/dispatch");
        times.push(performance.now() - started);
        expect(res.status).toBe(200);
        expect(cards(res.html, "scheduled")).toBe(30);
        expect(cards(res.html, "done")).toBe(30);
      }
      expect(Math.min(...times)).toBeLessThan(150);
    } finally {
      await removeJobs("t1");
      await removeJobs("t2");
      await removeJobs("t3");
    }
  });
});
