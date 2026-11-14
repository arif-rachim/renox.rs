// Low stock and the stock report (#816, wave D): the demo seed's inventory is consistent (every move's balance_after
// follows from the one before, the stock row is the last balance and the average cost follows the rule), the admin
// tile counts the parts under their minimum in the branches the viewer holds, /reports/stock shows and exports
// (CSV and .xlsx, one sheet each, the .xlsx read back from its sheet) the stock and the moves of a period
// with totals that match the seed, roles (a dispatcher and an accountant read it, a technician gets 403), and the
// daily job `low-stock` tells the managers and the owner once for each list. Tests that change stock come last.
// Runs on the local worker with the seed's users (password below).
import { Database } from "bun:sqlite";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { app } from "@renoxium/sdk/test";

import { addDays } from "../lib/contract-dates";

setDefaultTimeout(120_000);
const t = await app();
const PASSWORD = "correct horse battery";

async function signIn(jar: string, email: string, next = "/") {
  const u = t.as(jar);
  expect((await u.action("/auth/login", "default", { email, password: PASSWORD, next })).status).toBe(303);
  return u;
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
const today = (): string => new Date(Date.now() + 4 * 3_600_000).toISOString().slice(0, 10);
const lines = (csv: string): string[] => csv.replace(/^﻿/u, "").split("\r\n").filter((l) => l !== "");

const owner = await signIn("owner", "owner@fixit.example", "/admin");
const manager = await signIn("manager", "manager.dubai@fixit.example");
const dispatcher = await signIn("dispatcher", "dispatcher.dubai@fixit.example");
const accountant = await signIn("accountant", "accountant.dubai@fixit.example");
const ali = await signIn("ali", "ali.dubai@fixit.example", "/me");

const DXB = "br_dubai";
const SHJ = "br_sharjah";
/** Every period the seed's moves fall in (the opening balances are 40 days ago). */
const EVER = { from: "2000-01-01", to: "2100-12-31" };

type Move = { id: string; branch_id: string; part_id: string; kind: string; qty: number; unit_cost_fils: number | null; ref_kind: string | null; ref_id: string | null; balance_after: number };
type Level = { branch_id: string; part_id: string; qty: number; avg_cost_fils: number };

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/** The rows of a CSV (RFC 4180: quoted fields may hold commas) as objects keyed by the header. */
function csvRows(csv: string): Record<string, string>[] {
  const out: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const text = csv.replace(/^\uFEFF/u, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\r" && text[i + 1] === "\n") {
      row.push(field);
      out.push(row);
      row = [];
      field = "";
      i++;
    } else field += c;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    out.push(row);
  }
  const [head = [], ...rest] = out;
  return rest.map((r) => Object.fromEntries(r.map((v, i) => [head[i], v])));
}

/**
 * The cells of the first sheet of an .xlsx the app downloaded, as rows (text as strings, numbers as numbers). The
 * test client cannot hand `reports.readXlsx` its bytes (a service call carries JSON, the service wants a
 * Uint8Array: the import's check job is what calls it, tests/import.test.ts), so the module's writer, which stores
 * the sheet uncompressed with inline strings, is read here.
 */
function sheetOf(binary: string): (string | number | null)[][] {
  const unescape = (v: string): string => v.replace(/&lt;/gu, "<").replace(/&gt;/gu, ">").replace(/&quot;/gu, '"').replace(/&apos;/gu, "'").replace(/&amp;/gu, "&");
  const sheet = /<sheetData>([\s\S]*?)<\/sheetData>/u.exec(binary)?.[1] ?? "";
  return [...sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/gu)].map((r) =>
    [...(r[1] ?? "").matchAll(/<c\b[^>]*?(?:\/>|>([\s\S]*?)<\/c>)/gu)].map((c): string | number | null => {
      const inner = c[1] ?? "";
      const text = /<t\b[^>]*>([\s\S]*?)<\/t>/u.exec(inner)?.[1];
      if (text !== undefined) return unescape(text);
      const n = /<v>([^<]*)<\/v>/u.exec(inner)?.[1];
      return n === undefined ? null : Number(n);
    }),
  );
}

/** The "stock" download of the viewer as rows keyed by the header. */
async function stockCsv(who: typeof owner, fields: Record<string, string> = {}) {
  const res = await who.action("/reports/stock", "export", { report: "stock", format: "csv", ...fields });
  expect(res.status).toBe(200);
  return csvRows(res.html);
}
async function movesCsv(who: typeof owner, fields: Record<string, string> = {}) {
  const res = await who.action("/reports/stock", "export", { report: "moves", format: "csv", ...EVER, ...fields });
  expect(res.status).toBe(200);
  return csvRows(res.html);
}

describe("the demo seed's inventory", () => {
  test("twelve parts with Arabic names, two suppliers, two orders (one received, one sent), stock in both branches", () => {
    expect(rows("select count(*) as n from app__parts")[0]?.n).toBe(12);
    expect(rows("select count(*) as n from app__parts where name_ar = '' or name_ar = name_en")[0]?.n).toBe(0);
    expect(rows("select count(*) as n from app__suppliers")[0]?.n).toBe(2);
    expect(rows("select number, status from app__purchase_orders order by number").map((r) => [r.number, r.status])).toEqual([["PO-DEMO01", "received"], ["PO-DEMO02", "sent"]]);
    expect(rows("select branch_id, count(*) as n from app__stock group by branch_id order by branch_id").map((r) => [r.branch_id, r.n])).toEqual([[DXB, 12], [SHJ, 12]]);
    // Two visit part lines are linked to a stocked part and to the move that took it out.
    const linked = rows("select p.id, p.part_id, p.stock_move_id, m.ref_id, m.kind, m.qty from app__visit_parts p join app__stock_moves m on m.id = p.stock_move_id order by p.id");
    expect(linked.map((r) => [r.id, r.ref_kind ?? r.ref_id, r.kind, r.qty])).toEqual([[3, "vs_seed_13", "out", 1], [4, "vs_seed_19", "out", 1]]);
  });

  test("every move's balance_after is the running balance, the stock row is the last one and the average cost follows the rule", () => {
    const moves = rows("select id, branch_id, part_id, kind, qty, unit_cost_fils, ref_kind, ref_id, balance_after from app__stock_moves order by created_at, rowid") as unknown as Move[];
    const levels = rows("select branch_id, part_id, qty, avg_cost_fils from app__stock") as unknown as Level[];
    expect(moves.length).toBeGreaterThanOrEqual(28);
    const state = new Map<string, { qty: number; avg: number }>();
    for (const m of moves) {
      const key = `${m.branch_id}|${m.part_id}`;
      const s = state.get(key) ?? { qty: 0, avg: 0 };
      const delta = m.kind === "in" || m.kind === "transfer_in" ? m.qty : -m.qty;
      const balance = round3(s.qty + delta);
      expect(m.balance_after, `${m.id} balance`).toBe(balance);
      if ((m.kind === "in" || m.kind === "transfer_in") && m.unit_cost_fils !== null) s.avg = s.qty <= 0 ? m.unit_cost_fils : Math.round((s.qty * s.avg + m.qty * m.unit_cost_fils) / (s.qty + m.qty));
      else if (m.kind === "out") expect(m.unit_cost_fils, `${m.id} cost`).toBe(s.avg);
      s.qty = balance;
      state.set(key, s);
    }
    expect(levels).toHaveLength(state.size);
    for (const l of levels) expect(state.get(`${l.branch_id}|${l.part_id}`), `${l.branch_id} ${l.part_id}`).toEqual({ qty: l.qty, avg: l.avg_cost_fils });
    // The received order's lines are fully received, and the PVC tees' average in Sharjah is the one the rule gives: (35 x 2.00 + 15 x 2.20) / 50.
    expect(rows("select count(*) as n from app__purchase_order_lines l join app__purchase_orders o on o.id = l.po_id where o.status = 'received' and l.received_qty != l.qty")[0]?.n).toBe(0);
    expect(rows("select avg_cost_fils, qty from app__stock where branch_id = 'br_sharjah' and part_id = 'pt_00000000000d0008'")[0]).toEqual({ avg_cost_fils: 206, qty: 50 });
  });
});

describe("the admin tile", () => {
  const low = async (who: typeof owner): Promise<number> => {
    const res = await who.request("GET", "/admin/tile", { headers: { "hx-request": "true", "hx-target": "home-services-tile" } });
    expect(res.status).toBe(200);
    return Number(/id="tile-low"[^>]*><span>[^<]*<\/span><strong dir="ltr">(\d+)<\/strong><a href="\/admin\/stock\?low=1"/u.exec(res.html)?.[1]);
  };

  test("the owner holds both branches: Dubai is under its minimum on three parts, Sharjah on two, so the tile says 5, linking to /admin/stock?low=1", async () => {
    expect(await low(owner)).toBe(5);
    const page = await owner.page("/admin/tile");
    expect(page.html).toContain("Parts low on stock");
    expect(page.html).toContain('href="/admin/stock?low=1"');
    // The list behind the number: the low parts of Dubai on the stock page (its rows; the forms' selects hold every part).
    const rowsOf = (html: string): string[] => [...html.matchAll(/<tr id="stock-(pt_[0-9a-f]+)"/gu)].map((m) => m[1] as string);
    expect(rowsOf((await owner.page("/admin/stock?low=1")).html)).toEqual(["pt_00000000000d0002", "pt_00000000000d0008", "pt_00000000000d0006"]);
    expect(rowsOf((await owner.page(`/admin/stock?branch=${SHJ}&low=1`)).html)).toEqual(["pt_00000000000d000c", "pt_00000000000d0001"]);
  });

  test("a dispatcher, a manager and an accountant have no tile (403: it is the owner's page); the stock page is where they see low stock", async () => {
    for (const who of [dispatcher, manager, accountant, ali]) expect((await who.page("/admin/tile")).status).toBe(403);
    expect((await dispatcher.page("/admin/stock?low=1")).html).toContain("FIL-AC-C");
  });
});

describe("/reports/stock", () => {
  test("normal case: per branch the parts with quantity, minimum, average cost and value, with the totals of the seed", async () => {
    const res = await owner.page("/reports/stock");
    expect(res.status).toBe(200);
    expect(res.html).toContain('id="report-stock-br_dubai"');
    expect(res.html).toContain('id="report-stock-br_sharjah"');
    // Dubai holds 1,901.00 AED of stock at average cost, Sharjah 1,612.00.
    expect(res.html).toMatch(/id="total-br_dubai"[^>]*><strong[^>]*>AED\s1,901\.00<\/strong>/u);
    expect(res.html).toMatch(/id="total-br_sharjah"[^>]*><strong[^>]*>AED\s1,612\.00<\/strong>/u);
    expect(res.html).toMatch(/id="grand-total"[^>]*>AED\s3,513\.00</u);
    // A part under its minimum is marked, one at its minimum is not (R22 in Sharjah: 4 on hand, minimum 3).
    const row = (id: string): string => new RegExp(`<tr id="${id}">[\\s\\S]*?</tr>`, "u").exec(res.html)?.[0] ?? "";
    expect(row("stock-br_dubai-pt_00000000000d0002")).toContain('<strong class="badge">Low</strong>');
    expect(row("stock-br_sharjah-pt_00000000000d0006")).not.toContain("badge");
    expect(res.html).toContain('id="to-stock"');
    expect((await owner.page("/admin/stock")).html).toContain('id="stock-report-link"');
  });

  test("the CSV of the stock: one row per branch and part, the totals add up to the seed's values", async () => {
    const all = await stockCsv(owner);
    expect(all).toHaveLength(24);
    const value = (branch: string): number => all.filter((r) => r.branch === branch).reduce((n, r) => n + Number(r.value_fils), 0);
    expect(value("Dubai")).toBe(190_100);
    expect(value("Sharjah")).toBe(161_200);
    expect(all.find((r) => r.branch === "Dubai" && r.sku === "REF-R410A")).toMatchObject({ name: "Refrigerant R410A", unit: "kg", qty: "6", min_stock: "4", avg_cost_fils: "3800", value_fils: "22800" });
    expect(all.find((r) => r.branch === "Sharjah" && r.sku === "PVC-TEE-25")).toMatchObject({ qty: "50", min_stock: "30", avg_cost_fils: "206", value_fils: "10300" });
    expect(all.find((r) => r.branch === "Sharjah" && r.sku === "DESCALE-KIT")).toMatchObject({ qty: "2", min_stock: "4", avg_cost_fils: "2000", value_fils: "4000" });
    const res = await owner.action("/reports/stock", "export", { report: "stock", format: "csv" });
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain(`stock-${today()}.csv`);
    expect(lines(res.html)[0]).toBe("branch,sku,name,unit,qty,min_stock,avg_cost_fils,value_fils");
  });

  test("the .xlsx of the stock has one sheet, read back: numbers are numbers, text is text", async () => {
    const res = await owner.action("/reports/stock", "export", { report: "stock", format: "xlsx" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("spreadsheetml");
    expect(res.headers.get("content-disposition")).toContain(`stock-${today()}.xlsx`);
    expect(res.html.startsWith("PK")).toBe(true);
    const cells = sheetOf(res.html);
    expect(cells[0]).toEqual(["branch", "sku", "name", "unit", "qty", "min_stock", "avg_cost_fils", "value_fils"]);
    expect(cells).toHaveLength(25);
    expect(cells.find((r) => r[0] === "Dubai" && r[1] === "REF-R410A")).toEqual(["Dubai", "REF-R410A", "Refrigerant R410A", "kg", 6, 4, 3800, 22800]);
    expect(cells.slice(1).filter((r) => r[0] === "Dubai").reduce((n, r) => n + Number(r[7]), 0)).toBe(190_100);
  });

  test("the moves of a period: received, used on visits, adjusted and transferred per part; the period filters them", async () => {
    // Every period: the openings and the order are received; the visits used 1 mixer tap (Dubai) and 1 descaling kit (Sharjah).
    const all = await movesCsv(owner);
    expect(all.find((r) => r.branch === "Dubai" && r.sku === "REF-R410A")).toMatchObject({ received: "6", used: "0", adjusted: "0", transferred: "0" });
    expect(all.find((r) => r.branch === "Sharjah" && r.sku === "PVC-TEE-25")).toMatchObject({ received: "50" });
    expect(all.find((r) => r.branch === "Dubai" && r.sku === "MIXER-TAP")).toMatchObject({ received: "5", used: "1" });
    expect(all.find((r) => r.branch === "Sharjah" && r.sku === "DESCALE-KIT")).toMatchObject({ received: "3", used: "1" });
    expect(all).toHaveLength(24);
    // The last five days hold the visits and nothing else: the openings were 40 days ago, the order 10.
    const recent = await movesCsv(owner, { from: addDays(today(), -5), to: today() });
    expect(recent.map((r) => [r.branch, r.sku, r.received, r.used])).toEqual([["Dubai", "MIXER-TAP", "0", "1"], ["Sharjah", "DESCALE-KIT", "0", "1"]]);
    // A window around the order has it and only it.
    const order = await movesCsv(owner, { from: addDays(today(), -12), to: addDays(today(), -8) });
    expect(order.map((r) => [r.branch, r.sku, r.received])).toEqual([["Sharjah", "PVC-TEE-25", "15"], ["Sharjah", "SEAL-SIL-CL", "6"]]);
    // A period with no move is only the header.
    const none = await owner.action("/reports/stock", "export", { report: "moves", format: "csv", from: "2020-01-01", to: "2020-01-31" });
    expect(lines(none.html)).toEqual(["branch,sku,name,unit,received,used,adjusted,transferred"]);
    // The page shows the same table for the period asked for (and the current month when none is).
    const page = await owner.page(`/reports/stock?from=${addDays(today(), -5)}&to=${today()}`);
    expect(page.html).toMatch(/id="moves-br_dubai-pt_00000000000d000b"/u);
    expect(page.html).not.toMatch(/id="moves-br_dubai-pt_00000000000d0005"/u);
    expect((await owner.page("/reports/stock?from=nope&to=2020-13-45")).status).toBe(200);
  });

  test("the .xlsx of the moves is the sheet 'moves': the period is in the file name", async () => {
    const res = await owner.action("/reports/stock", "export", { report: "moves", format: "xlsx", from: "2026-01-01", to: "2026-12-31" });
    expect(res.headers.get("content-disposition")).toContain("moves-2026-01-01_2026-12-31.xlsx");
    const cells = sheetOf(res.html);
    expect(cells[0]).toEqual(["branch", "sku", "name", "unit", "received", "used", "adjusted", "transferred"]);
  });

  test("roles: a dispatcher, a manager and an accountant read and download it (their own branch only); a technician gets 403 on the page and the download", async () => {
    for (const who of [dispatcher, manager, accountant]) {
      const page = await who.page("/reports/stock");
      expect(page.status).toBe(200);
      expect(page.html).toContain('id="report-stock-br_dubai"');
      expect(page.html).not.toContain('id="report-stock-br_sharjah"');
      expect(page.html).not.toContain('id="grand-total"');
      const mine = await stockCsv(who);
      expect(mine).toHaveLength(12);
      expect([...new Set(mine.map((r) => r.branch))]).toEqual(["Dubai"]);
    }
    expect((await ali.page("/reports/stock")).status).toBe(403);
    expect((await ali.action("/reports/stock", "export", { report: "stock", format: "csv" })).status).toBe(403);
  });
});

describe("the daily job low-stock", () => {
  const notes = () => rows("select user_id, title, body, link from notifications__items where category = 'stock' order by rowid");
  const hashOf = (branch: string) => rows("select value from app__settings where key = ?", [`low_stock_hash_${branch}`])[0]?.value;

  test("normal case: one notification to each manager and the owner of each branch with low parts, listing SKU, name, on hand and minimum, with the link", async () => {
    expect(notes()).toEqual([]);
    await t.job("low-stock");
    const sent = notes();
    // Dubai: the owner and the manager; Sharjah: the owner (its dispatcher is no manager).
    expect(sent.map((n) => [n.user_id, n.link]).sort()).toEqual(
      [
        ["u_owner", "/admin/stock?branch=br_dubai&low=1"],
        ["u_dxb_manager", "/admin/stock?branch=br_dubai&low=1"],
        ["u_owner", "/admin/stock?branch=br_sharjah&low=1"],
      ].sort(),
    );
    const dubai = sent.find((n) => n.user_id === "u_dxb_manager");
    expect(dubai?.title).toBe("Low stock in Dubai: 3 parts under their minimum");
    expect(String(dubai?.body).split("\n")).toEqual(["FIL-AC-C AC filter, cassette unit: 4 on hand, minimum 6", "PVC-TEE-25 PVC tee 25 mm: 25 on hand, minimum 30", "REF-R22 Refrigerant R22: 2 on hand, minimum 3"]);
    expect(hashOf(DXB)).toBeTruthy();
    expect(hashOf(SHJ)).toBeTruthy();
  });

  test("the same list again tells nobody", async () => {
    const before = notes().length;
    await t.job("low-stock");
    expect(notes()).toHaveLength(before);
  });

  test("a list that changed tells again; a branch with nothing low forgets its hash, so the old list is told again when it returns", async () => {
    const before = notes().length;
    // The manager receives 10 cassette filters: Dubai's list loses a part.
    const res = await manager.action("/admin/stock", "receive", { part: "pt_00000000000d0002", qty: "10", unit_cost: "18.00", reason: "delivery" });
    expect(res.status).toBe(303);
    await t.job("low-stock");
    const sent = notes().slice(before);
    expect(sent.map((n) => n.link).sort()).toEqual(["/admin/stock?branch=br_dubai&low=1", "/admin/stock?branch=br_dubai&low=1"]);
    expect(sent[0]?.title).toBe("Low stock in Dubai: 2 parts under their minimum");
    // Nothing is low in Sharjah once its two parts are brought up to their minimum: the hash is forgotten.
    rw((db) => db.run("update app__parts set min_stock = 0 where id in ('pt_00000000000d0001', 'pt_00000000000d000c')"));
    await t.job("low-stock");
    expect(hashOf(SHJ)).toBeUndefined();
    // The minimums come back: the same list as before is told again, because the hash was forgotten.
    const mid = notes().length;
    rw((db) => db.run("update app__parts set min_stock = 10 where id = 'pt_00000000000d0001'"));
    rw((db) => db.run("update app__parts set min_stock = 4 where id = 'pt_00000000000d000c'"));
    await t.job("low-stock");
    expect(notes().length).toBeGreaterThan(mid);
  });

  test("more than ten low parts: the notification lists ten and says how many more", async () => {
    // Twelve parts with a minimum nobody has: Sharjah's list becomes long.
    rw((db) => db.run("update app__parts set min_stock = 1000"));
    const before = notes().length;
    await t.job("low-stock");
    const sent = notes().slice(before).filter((n) => String(n.link).includes("br_sharjah"));
    expect(sent).toHaveLength(1);
    expect(String(sent[0]?.title)).toBe("Low stock in Sharjah: 12 parts under their minimum");
    const body = String(sent[0]?.body).split("\n");
    expect(body).toHaveLength(11);
    expect(body[10]).toBe("and 2 more");
  });
});

describe("a part name is text in the downloads, never a formula", () => {
  test("a part named =1+1 is a string cell in the .xlsx and no formula element is written", async () => {
    expect(
      (
        await owner.action("/admin/parts", "save", { sku: "FORMULA-1", name_en: "=1+1", name_ar: "=2+2", unit: "piece", cost: "1", sell: "2", vat_rate: "5", min_stock: "1" })
      ).status,
    ).toBe(303);
    const res = await owner.action("/reports/stock", "export", { report: "stock", format: "xlsx" });
    expect(res.html).not.toContain("<f>");
    const cells = sheetOf(res.html);
    expect(cells.find((r) => r[1] === "FORMULA-1")?.[2]).toBe("=1+1");
  });
});

// The language a page is asked for in stays the user's: Arabic runs last.
describe("in Arabic", () => {
  test("the tile in Arabic says the same in the owner's language", async () => {
    const res = await owner.request("GET", "/admin/tile?lang=ar", { headers: { "hx-request": "true", "hx-target": "home-services-tile" } });
    expect(res.html).toContain("قطع قاربت على النفاد");
  });


  test("the page and the download render in Arabic: names in Arabic, right to left", async () => {
    const page = await owner.page("/reports/stock?lang=ar");
    expect(page.html).toContain('dir="rtl"');
    expect(page.html).toContain("تقرير المخزون");
    expect(page.html).toContain("فلتر مكيف سبليت");
    const csv = await owner.action("/reports/stock", "export", { report: "stock", format: "csv" });
    expect(csv.html).toContain("فلتر مكيف سبليت");
  });
});
