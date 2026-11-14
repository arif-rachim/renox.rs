// Stock per branch and its moves (#813, wave D): /admin/stock and /admin/stock/<part>. Receiving at a cost averages it;
// a transfer moves stock between two branches with one reference and never takes the sender under zero; a count
// (adjust) writes the difference with the count in its reason and needs the second factor, for that form only; a
// dispatcher sees the page without forms; a manager of one branch neither sees nor moves another's stock; and after a
// run of mixed moves every move's balance_after follows from the one before and the last is what is on hand.
// Runs on the local worker with the seed's users (password below). The tables are written only through the pages
// (lib/stock.ts): the tests read them, never write them. A visit's `out` arrives with #814.
import { Database } from "bun:sqlite";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { totp } from "@renoxium/sdk";
import { app, snapshot } from "@renoxium/sdk/test";

setDefaultTimeout(120_000);
const t = await app();
const PASSWORD = "correct horse battery";

async function signIn(jar: string, email: string, next = "/") {
  const u = t.as(jar);
  expect((await u.action("/auth/login", "default", { email, password: PASSWORD, next })).status).toBe(303);
  return u;
}

/** Enrols a TOTP factor for `email` on one session, then signs in on another that passed it (as admin.test.ts does). */
async function withSecondFactor(jar: string, email: string, next: string) {
  const plain = await signIn(`${jar}-plain`, email, next);
  const enrolling = await signIn(`${jar}-enrol`, email, next);
  const enrol = await enrolling.page("/2fa/enroll/totp");
  const secret = (/id="secret"[^>]*>([A-Z2-7 ]+)</u.exec(enrol.html)?.[1] ?? "").replace(/ /gu, "");
  expect((await enrolling.action("/2fa/enroll/totp", "confirm", { code: await totp(secret) })).status).toBe(200);
  const halted = await t.as(jar).action("/auth/login", "default", { email, password: PASSWORD, next });
  expect(halted.headers.get("location")).toBe(`/2fa/verify?next=${encodeURIComponent(next)}`);
  expect((await t.as(jar).action("/2fa/verify", "totp", { code: await totp(secret, Date.now() / 1000 + 30), next })).status).toBe(303);
  return { plain, verified: t.as(jar) };
}

const rows = (sql: string, params: (string | number | null)[] = []) => t.db.query<Record<string, unknown>>(sql, params);
const rw = <T>(f: (db: Database) => T): T => {
  const db = new Database(t.dbFile);
  db.exec("pragma busy_timeout = 5000");
  try {
    return f(db);
  } finally {
    db.close();
  }
};
const located = (res: { headers: Headers }) => res.headers.get("location") ?? "";

const DXB = "br_dubai";
const SHJ = "br_sharjah";
const FILTER = "pt_0000000000813a01";
const PIPE = "pt_0000000000813a02";
const OFF = "pt_0000000000813a03";
rw((db) => {
  db.run("insert into app__parts (id, sku, name_en, name_ar, unit, cost_fils, sell_fils, vat_rate, min_stock, active, created_at) values ('pt_0000000000813a01', 'AC-FILTER', 'AC filter', 'فلتر مكيف', 'piece', 500, 900, 5, 5, 1, 1700000000)");
  db.run("insert into app__parts (id, sku, name_en, name_ar, unit, cost_fils, sell_fils, vat_rate, min_stock, active, created_at) values ('pt_0000000000813a02', 'PIPE-15', 'Copper pipe 15 mm', 'أنبوب نحاسي 15 مم', 'metre', 850, 1400, 5, 0, 1, 1700000001)");
  db.run("insert into app__parts (id, sku, name_en, name_ar, unit, cost_fils, sell_fils, vat_rate, min_stock, active, created_at) values ('pt_0000000000813a03', 'OLD-GAS', 'Old gas', 'غاز قديم', 'kg', 0, 0, 0, 0, 0, 1700000002)");
});

const owner = (await withSecondFactor("owner", "owner@fixit.example", "/admin/stock")).verified;
const ownerNoFactor = await signIn("owner-nofactor", "owner@fixit.example", "/admin/stock");
const manager = await signIn("manager", "manager.dubai@fixit.example");
const dispatcher = await signIn("dispatcher", "dispatcher.dubai@fixit.example");
const accountant = await signIn("accountant", "accountant.dubai@fixit.example");
const ali = await signIn("ali", "ali.dubai@fixit.example", "/me");

const level = (branch: string, part: string) => rows("select qty, avg_cost_fils from app__stock where branch_id = ? and part_id = ?", [branch, part])[0];
const moves = (branch: string, part: string) => rows("select * from app__stock_moves where branch_id = ? and part_id = ? order by rowid", [branch, part]);
const count = (table: string): number => Number(rows(`select count(*) as n from ${table}`)[0]?.n);
const audited = (action: string): number => Number(rows("select count(*) as n from audit__events where action = ?", [action])[0]?.n);

type Who = typeof owner;
const receive = (who: Who, form: Record<string, string>) => who.action("/admin/stock", "receive", { reason: "delivery from the supplier", ...form });
const adjust = (who: Who, form: Record<string, string>) => who.action("/admin/stock", "adjust", { reason: "shelf count", ...form });
const transfer = (who: Who, form: Record<string, string>) => who.action("/admin/stock", "transfer", { reason: "balance the branches", ...form });

describe("receiving and the average cost", () => {
  test("10 at 5.00 and then 10 at 7.00 leave 20 on hand at an average of 6.00, each with its move", async () => {
    const first = await receive(manager, { part: FILTER, qty: "10", unit_cost: "5.00" });
    expect(first.status).toBe(303);
    expect(located(first)).toBe(`/admin/stock?branch=${DXB}&saved=received`);
    expect((await receive(manager, { part: FILTER, qty: "10", unit_cost: "7.00" })).status).toBe(303);
    expect(level(DXB, FILTER)).toEqual({ qty: 20, avg_cost_fils: 600 });
    const list = moves(DXB, FILTER);
    expect(list.map((m) => [m.kind, m.qty, m.unit_cost_fils, m.balance_after, m.ref_kind, m.created_by])).toEqual([
      ["in", 10, 500, 10, "manual", "u_dxb_manager"],
      ["in", 10, 700, 20, "manual", "u_dxb_manager"],
    ]);
    expect(list[0]?.reason).toBe("delivery from the supplier");
  });

  test("error case: a bad form is a 422 naming the field and writes nothing", async () => {
    const before = count("app__stock_moves");
    const cases: [Record<string, string>, string][] = [
      [{ part: FILTER, qty: "0", unit_cost: "5" }, "qty"],
      [{ part: FILTER, qty: "1.2345", unit_cost: "5" }, "qty"],
      [{ part: FILTER, qty: "-2", unit_cost: "5" }, "qty"],
      [{ part: FILTER, qty: "2", unit_cost: "five" }, "unit_cost"],
      [{ part: FILTER, qty: "2", unit_cost: "5", reason: "ab" }, "reason"],
      [{ part: FILTER, qty: "2", unit_cost: "5", reason: "x".repeat(201) }, "reason"],
      [{ part: "nope", qty: "2", unit_cost: "5" }, "part"],
      [{ part: "pt_ffffffffffffffff", qty: "2", unit_cost: "5" }, "part"],
    ];
    for (const [form, field] of cases) {
      const res = await receive(manager, form);
      expect([JSON.stringify(form), res.status]).toEqual([JSON.stringify(form), 422]);
      expect(res.html).toContain(`id="err-${field}"`);
    }
    expect(count("app__stock_moves")).toBe(before);
  });
});

describe("transfers between branches", () => {
  test("3 move between two branches with one reference, the receiver takes the sender's average, and the move is audited", async () => {
    const res = await transfer(owner, { branch: DXB, part: FILTER, qty: "3", to_branch: SHJ });
    expect(res.status).toBe(303);
    expect(located(res)).toBe(`/admin/stock?branch=${DXB}&saved=transferred`);
    expect(level(DXB, FILTER)).toEqual({ qty: 17, avg_cost_fils: 600 });
    expect(level(SHJ, FILTER)).toEqual({ qty: 3, avg_cost_fils: 600 });
    const out = moves(DXB, FILTER).at(-1);
    const into = moves(SHJ, FILTER).at(-1);
    expect([out?.kind, out?.qty, out?.balance_after, out?.ref_kind]).toEqual(["transfer_out", 3, 17, "transfer"]);
    expect([into?.kind, into?.qty, into?.balance_after, into?.ref_kind, into?.unit_cost_fils]).toEqual(["transfer_in", 3, 3, "transfer", 600]);
    expect(out?.ref_id).toBe(into?.ref_id);
    expect(String(out?.ref_id)).toMatch(/^tr_[0-9a-f]{16}$/u);
    expect(audited("stock.transfer")).toBe(1);
  });

  test("a transfer that would leave the sender under zero is a 422 and changes nothing", async () => {
    const before = count("app__stock_moves");
    const res = await transfer(owner, { branch: DXB, part: FILTER, qty: "17.001", to_branch: SHJ });
    expect(res.status).toBe(422);
    expect(res.html).toContain('id="err-qty"');
    expect((await transfer(owner, { branch: SHJ, part: FILTER, qty: "4", to_branch: DXB })).status).toBe(422);
    expect(level(DXB, FILTER)?.qty).toBe(17);
    expect(level(SHJ, FILTER)?.qty).toBe(3);
    expect(count("app__stock_moves")).toBe(before);
    expect(audited("stock.transfer")).toBe(1);
  });

  test("the whole balance can move; the destination is a branch the user holds, never another one, never the same", async () => {
    expect((await transfer(owner, { branch: SHJ, part: FILTER, qty: "3", to_branch: DXB })).status).toBe(303);
    expect(level(SHJ, FILTER)?.qty).toBe(0);
    expect(level(DXB, FILTER)?.qty).toBe(20);
    expect((await transfer(owner, { branch: DXB, part: FILTER, qty: "3", to_branch: SHJ })).status).toBe(303);
    expect(level(SHJ, FILTER)?.qty).toBe(3);
    const before = count("app__stock_moves");
    for (const to of [DXB, "br_nowhere", "", "../x"]) expect([to, (await transfer(owner, { branch: DXB, part: FILTER, qty: "1", to_branch: to })).status]).toEqual([to, 422]);
    // A manager of Dubai holds no other branch: nothing to transfer to.
    expect((await transfer(manager, { part: FILTER, qty: "1", to_branch: SHJ })).status).toBe(422);
    expect(count("app__stock_moves")).toBe(before);
  });
});

describe("a count (adjust) and the second factor", () => {
  test("a count equal to the books is no change; a count of 15 on 17 writes a move of 2 with the count text", async () => {
    expect((await adjust(owner, { branch: DXB, part: FILTER, counted: "17" })).status).toBe(422);
    const res = await adjust(owner, { branch: DXB, part: FILTER, counted: "15", reason: "two filters broken" });
    expect(res.status).toBe(303);
    expect(located(res)).toBe(`/admin/stock?branch=${DXB}&saved=adjusted`);
    const move = moves(DXB, FILTER).at(-1);
    expect([move?.kind, move?.qty, move?.balance_after, move?.ref_kind]).toEqual(["adjust", 2, 15, "manual"]);
    expect(String(move?.reason)).toContain("count: was 17, is 15");
    expect(String(move?.reason)).toContain("two filters broken");
    expect(level(DXB, FILTER)).toEqual({ qty: 15, avg_cost_fils: 600 });
    expect(audited("stock.adjust")).toBe(1);
    // Up as well: a count above the books.
    expect((await adjust(owner, { branch: DXB, part: FILTER, counted: "17" })).status).toBe(303);
    const up = moves(DXB, FILTER).at(-1);
    expect([up?.qty, up?.balance_after]).toEqual([2, 17]);
    expect(String(up?.reason)).toContain("count: was 15, is 17");
  });

  test("without a recent second factor the person is sent to the verification page and nothing changes; a receive does not ask for it", async () => {
    const before = count("app__stock_moves");
    const res = await adjust(manager, { part: FILTER, counted: "1" });
    expect(res.status).toBe(303);
    expect(located(res)).toBe(`/2fa/verify?next=${encodeURIComponent(`/admin/stock?branch=${DXB}`)}`);
    // The owner's session that has not passed the second factor yet is refused outright.
    expect([303, 403]).toContain((await adjust(ownerNoFactor, { part: FILTER, counted: "1" })).status);
    expect(count("app__stock_moves")).toBe(before);
    expect(level(DXB, FILTER)?.qty).toBe(17);
    // The manager has no second factor and still receives.
    expect((await receive(manager, { part: PIPE, qty: "2", unit_cost: "1" })).status).toBe(303);
  });

  test("error case: a count under zero or no number is a 422; a dispatcher cannot adjust at all", async () => {
    const before = count("app__stock_moves");
    for (const counted of ["-1", "abc", "", "1.2345"]) {
      const res = await adjust(owner, { branch: DXB, part: FILTER, counted });
      expect([counted, res.status]).toEqual([counted, 422]);
      expect(res.html).toContain('id="err-counted"');
    }
    expect((await adjust(owner, { branch: DXB, part: FILTER, counted: "3", reason: "no" })).status).toBe(422);
    expect((await adjust(dispatcher, { part: FILTER, counted: "1" })).status).toBe(403);
    expect(count("app__stock_moves")).toBe(before);
  });

  test("a count of zero empties the shelf", async () => {
    expect((await adjust(owner, { branch: DXB, part: PIPE, counted: "0", reason: "all used up" })).status).toBe(303);
    expect(level(DXB, PIPE)?.qty).toBe(0);
    expect(moves(DXB, PIPE).at(-1)?.balance_after).toBe(0);
  });
});

describe("who sees and moves what", () => {
  test("a dispatcher sees the page and the history without forms, and a post is refused", async () => {
    const res = await dispatcher.page("/admin/stock");
    expect(res.status).toBe(200);
    expect(res.html).toContain('id="stock-AC-FILTER"'.replace("AC-FILTER", FILTER));
    expect(res.html).not.toContain('id="stock-forms"');
    expect(res.html).not.toContain('id="receive-form"');
    expect((await dispatcher.page(`/admin/stock/${FILTER}`)).status).toBe(200);
    expect((await receive(dispatcher, { part: FILTER, qty: "1", unit_cost: "1" })).status).toBe(403);
    expect((await transfer(dispatcher, { part: FILTER, qty: "1", to_branch: SHJ })).status).toBe(403);
    const accounted = await accountant.page("/admin/stock");
    expect(accounted.status).toBe(200);
    expect(accounted.html).not.toContain('id="stock-forms"');
  });

  test("a technician has no stock pages and no link", async () => {
    expect((await ali.page("/admin/stock")).status).toBe(403);
    expect((await ali.page(`/admin/stock/${FILTER}`)).status).toBe(403);
    expect((await receive(ali, { part: FILTER, qty: "1", unit_cost: "1" })).status).toBe(403);
  });

  test("a manager of branch A cannot see or move branch B's stock", async () => {
    expect((await owner.page(`/admin/stock?branch=${SHJ}`)).status).toBe(200);
    for (const path of [`/admin/stock?branch=${SHJ}`, `/admin/stock/${FILTER}?branch=${SHJ}`, "/admin/stock?branch=br_nowhere"]) expect([path, (await manager.page(path)).status]).toEqual([path, 404]);
    const mine = await manager.page("/admin/stock");
    expect(mine.html).not.toContain('id="branch-picker"');
    expect(mine.html).not.toContain(`id="total-${SHJ}"`);
    const before = [count("app__stock_moves"), count("app__stock")];
    expect((await receive(manager, { branch: SHJ, part: FILTER, qty: "3", unit_cost: "1" })).status).toBe(404);
    expect((await transfer(manager, { branch: SHJ, part: FILTER, qty: "1", to_branch: DXB })).status).toBe(404);
    expect((await adjust(manager, { branch: SHJ, part: FILTER, counted: "9" })).status).toBe(404);
    expect([count("app__stock_moves"), count("app__stock")]).toEqual(before);
  });

  test("the owner holds both branches: the picker lists them with their values and the forms offer the other as a destination", async () => {
    const res = await owner.page("/admin/stock");
    expect(res.html).toContain('id="branch-picker"');
    expect(res.html).toContain(`id="total-${DXB}"`);
    expect(res.html).toContain(`id="total-${SHJ}"`);
    expect(res.html).toContain(`<option value="${SHJ}"`);
    expect(res.html).not.toContain(`<option value="${DXB}"`);
    const there = await owner.page(`/admin/stock?branch=${SHJ}`);
    expect(there.html).toContain(`<option value="${DXB}"`);
    expect(there.html).toMatch(/<h2 id="branch-name"[^>]*>Sharjah<\/h2>/u);
  });

  test("the roles lib/stock.ts reads for a branch other than the active one are the ones renox.toml gives", async () => {
    const toml = await Bun.file(`${import.meta.dir}/../renox.toml`).text();
    const src = await Bun.file(`${import.meta.dir}/../lib/stock.ts`).text();
    const roles = (action: string) => [...toml.matchAll(/^(\w+) = \[(.*)\]$/gmu)].filter((m) => (m[2] ?? "").includes(`"${action}"`) && !["actions", "sensitive", "secrets"].includes(m[1] ?? "")).map((m) => m[1] as string);
    const declared = (name: string) => [...(new RegExp(`${name} = \\[(.*?)\\]`, "u").exec(src)?.[1] ?? "").matchAll(/"(\w+)"/gu)].map((m) => m[1] as string);
    expect(declared("STOCK_MOVE_ROLES").sort()).toEqual(roles("stock.move").sort());
    expect(declared("STOCK_READ_ROLES").sort()).toEqual(roles("stock.read").sort());
  });
});

describe("the pages", () => {
  test("/admin/stock lists what a branch holds, marks low stock and filters", async () => {
    const dxb = await owner.page(`/admin/stock?branch=${DXB}`);
    expect(dxb.html).toContain(`id="stock-${FILTER}"`);
    expect(dxb.html).not.toContain(`id="stock-${OFF}"`);
    expect(dxb.html).not.toContain(`id="low-${FILTER}"`);
    // Sharjah holds 3 of them against a minimum of 5: low.
    const shj = await owner.page(`/admin/stock?branch=${SHJ}`);
    expect(shj.html).toContain(`id="low-${FILTER}"`);
    expect((await owner.page(`/admin/stock?branch=${SHJ}&low=1`)).html).toContain(`id="stock-${FILTER}"`);
    expect((await owner.page(`/admin/stock?branch=${DXB}&low=1`)).html).not.toContain(`id="stock-${FILTER}"`);
    expect((await owner.page(`/admin/stock?branch=${DXB}&q=filter`)).html).toContain(`id="stock-${FILTER}"`);
    expect((await owner.page(`/admin/stock?branch=${DXB}&q=zzz`)).html).not.toContain(`id="stock-${FILTER}"`);
    // The value: 17 at 6.00 is 102.00 in Dubai.
    expect(dxb.html).toMatch(/<td dir="ltr">AED\s102\.00<\/td>/u);
  });

  test("the history lists the moves newest first with sign, balance, cost, reason and who", async () => {
    const res = await owner.page(`/admin/stock/${FILTER}?branch=${DXB}`);
    expect(res.status).toBe(200);
    const kinds = [...res.html.matchAll(/<tr id="move-sm_[0-9a-f]{16}">\s*<td dir="ltr">[^<]*<\/td>\s*<td dir="auto">([^<]*)<\/td>\s*<td dir="ltr">([^<]*)<\/td>/gu)].map((m) => `${m[1]} ${m[2]}`);
    expect(kinds.slice(0, 5)).toEqual(["Count adjustment +2", "Count adjustment -2", "Transferred out -3", "Transferred in +3", "Transferred out -3"]);
    expect(kinds.at(-1)).toBe("Received +10");
    expect(res.html).toContain("Mona Manager");
    expect((await owner.page("/admin/stock/pt_ffffffffffffffff")).status).toBe(404);
    expect((await owner.page("/admin/stock/not-a-part")).status).toBe(404);
  });

  test("snapshots: the page and the history, in English and in Arabic", async () => {
    const en = await owner.page(`/admin/stock?branch=${DXB}&lang=en`);
    snapshot(en.html, { role: "stock, owner, en" });
    const ar = await owner.page(`/admin/stock?branch=${DXB}&lang=ar`);
    expect(ar.status).toBe(200);
    snapshot(ar.html, { role: "stock, owner, ar" });
    const steady = (html: string) => html.replace(/id="move-sm_[0-9a-f]{16}"/gu, 'id="move-<id>"').replace(/<td dir="ltr">\d{4}-\d{2}-\d{2} \d{2}:\d{2}<\/td>/gu, '<td dir="ltr"><when></td>').replace(/tr_[0-9a-f]{16}/gu, "tr_<id>");
    snapshot(steady((await owner.page(`/admin/stock/${FILTER}?branch=${DXB}&lang=en`)).html), { role: "stock history, owner, en" });
    snapshot(steady((await owner.page(`/admin/stock/${FILTER}?branch=${DXB}&lang=ar`)).html), { role: "stock history, owner, ar" });
    expect((await owner.page("/admin/stock?lang=en")).status).toBe(200);
  });

  test("the sidebar links the stock page to who may read it", async () => {
    const nav = (html: string) => /<nav class="renox-admin-sidebar"[\s\S]*?<\/nav>/u.exec(html)?.[0] ?? "";
    expect(nav((await owner.page("/admin")).html)).toContain('id="nav-stock"');
  });
});

describe("property: the balances of a run of mixed moves follow from each other", () => {
  test("50 mixed moves from a fixed seed: balance_after is the one before plus the move, the average follows, the last is on hand", async () => {
    // mulberry32: the same 50 moves on every run.
    let seed = 813;
    const rand = (): number => {
      seed = (seed + 0x6d2b79f5) | 0;
      let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
    const int = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1));
    const part = PIPE;
    const branches = [DXB, SHJ];
    // The model, from what the page already holds: the two branches' starting points.
    const model: Record<string, { qty: number; avg: number }> = {
      [DXB]: { qty: Number(level(DXB, part)?.qty), avg: Number(level(DXB, part)?.avg_cost_fils) },
      [SHJ]: { qty: Number(level(SHJ, part)?.qty ?? 0), avg: Number(level(SHJ, part)?.avg_cost_fils ?? 0) },
    };
    const start = { [DXB]: moves(DXB, part).length, [SHJ]: moves(SHJ, part).length };
    const average = (m: { qty: number; avg: number }, q: number, cost: number): number => (m.qty <= 0 ? cost : Math.round((m.qty * m.avg + q * cost) / (m.qty + q)));
    let refused = 0;
    for (let i = 0; i < 50; i++) {
      const from = branches[int(0, 1)] as string;
      const other = from === DXB ? SHJ : DXB;
      const m = model[from] as { qty: number; avg: number };
      const o = model[other] as { qty: number; avg: number };
      const kind = int(0, 2);
      if (kind === 0) {
        const q = int(1, 9);
        const cost = int(1, 9) * 100 + int(0, 99);
        expect((await receive(owner, { branch: from, part, qty: String(q), unit_cost: (cost / 100).toFixed(2) })).status).toBe(303);
        m.avg = average(m, q, cost);
        m.qty += q;
      } else if (kind === 1) {
        const counted = int(0, 30);
        const res = await adjust(owner, { branch: from, part, counted: String(counted) });
        if (counted === m.qty) {
          expect(res.status).toBe(422);
          refused++;
        } else {
          expect(res.status).toBe(303);
          m.qty = counted;
        }
      } else {
        const q = int(1, 9) + (int(0, 1) === 1 ? 0.5 : 0);
        const res = await transfer(owner, { branch: from, part, qty: String(q), to_branch: other });
        if (q > m.qty) {
          expect(res.status).toBe(422);
          refused++;
        } else {
          expect(res.status).toBe(303);
          const cost = m.avg;
          o.avg = average(o, q, cost);
          o.qty += q;
          m.qty -= q;
        }
      }
    }
    expect(refused).toBeGreaterThan(0);
    for (const branch of branches) {
      const list = moves(branch, part).slice(start[branch as keyof typeof start]);
      // The first of the run follows the move before it (or zero when the branch had none).
      const before = moves(branch, part)[start[branch as keyof typeof start] - 1];
      let balance = Number(before?.balance_after ?? 0);
      for (const mv of list) {
        const into = mv.kind === "in" || mv.kind === "transfer_in";
        const out = mv.kind === "out" || mv.kind === "transfer_out";
        const next = into ? balance + Number(mv.qty) : out ? balance - Number(mv.qty) : Number(mv.balance_after);
        expect(Math.abs(Number(mv.balance_after) - next)).toBeLessThan(1e-9);
        if (mv.kind === "adjust") expect(Math.abs(Number(mv.balance_after) - balance)).toBeCloseTo(Number(mv.qty), 9);
        expect(Number(mv.balance_after)).toBeGreaterThanOrEqual(0);
        balance = Number(mv.balance_after);
      }
      const m = model[branch] as { qty: number; avg: number };
      expect(Number(level(branch, part)?.qty)).toBe(m.qty);
      expect(Number(level(branch, part)?.avg_cost_fils)).toBe(m.avg);
      expect(balance).toBe(m.qty);
    }
  });
});
