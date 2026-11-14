// Purchase orders (#815, wave D): /admin/purchasing, /admin/purchasing/<id> and its PDF. A draft with two lines totals
// with 5 % VAT; sending needs a line; lines change only in a draft; receiving half of a line makes the order
// `partly_received`, raises the branch's stock at the cost paid and moves the average cost and the part's cost; the
// rest makes it `received`; more than is outstanding is a 422; cancel is refused after a receipt; the stock history
// links to the order; a manager of another branch gets 404 and a dispatcher 403; the PDF is the order's language.
// Runs on the local worker with the seed's users (password below). Stock is written only by lib/stock.ts: the tests
// plant parts, suppliers and the other branch's order by SQL, and read the stock tables, never write them.
// Not tested: the supplier's mail with the PDF attached. The platform's email module has no attachment (platform gap,
// reported with #815), so Send only marks the order and the page offers the PDF.
import { Database } from "bun:sqlite";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { app, snapshot } from "@renoxium/sdk/test";

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
const located = (res: { headers: Headers }) => res.headers.get("location") ?? "";

const DXB = "br_dubai";
const SHJ = "br_sharjah";
const FILTER = "pt_0000000000815a01";
const PIPE = "pt_0000000000815a02";
const OFF = "pt_0000000000815a03";
const NOOR = "su_0000000000815a01";
const NOMAIL = "su_0000000000815a02";
const GONE = "su_0000000000815a03";
const SHJ_PO = "po_0000000000815a99";
const NOW = 1_700_000_000;
rw((db) => {
  db.run("insert into app__parts (id, sku, name_en, name_ar, unit, cost_fils, sell_fils, vat_rate, min_stock, active, created_at) values (?, 'AC-FILTER', 'AC filter', 'فلتر مكيف', 'piece', 500, 900, 5, 0, 1, ?)", [FILTER, NOW]);
  db.run("insert into app__parts (id, sku, name_en, name_ar, unit, cost_fils, sell_fils, vat_rate, min_stock, active, created_at) values (?, 'PIPE-15', 'Copper pipe 15 mm', 'أنبوب نحاسي 15 مم', 'metre', 850, 1400, 5, 0, 1, ?)", [PIPE, NOW]);
  db.run("insert into app__parts (id, sku, name_en, name_ar, unit, cost_fils, sell_fils, vat_rate, min_stock, active, created_at) values (?, 'OLD-GAS', 'Old gas', 'غاز قديم', 'kg', 0, 0, 0, 0, 0, ?)", [OFF, NOW]);
  db.run("insert into app__suppliers (id, name, trn, phone, email, address, notes, active, created_at) values (?, 'Al Noor Trading', '100123456700003', '+97144110088', 'orders@alnoor.example', 'Deira, Dubai', '', 1, ?)", [NOOR, NOW]);
  db.run("insert into app__suppliers (id, name, trn, phone, email, address, notes, active, created_at) values (?, 'Walk-in Pipes', null, '', '', '', '', 1, ?)", [NOMAIL, NOW]);
  db.run("insert into app__suppliers (id, name, trn, phone, email, address, notes, active, created_at) values (?, 'Closed Supplier', null, '', '', '', '', 0, ?)", [GONE, NOW]);
  // Another branch's order: a Dubai manager must not reach it.
  db.run("insert into app__po_numbers (po_id) values (?)", [SHJ_PO]);
  db.run("insert into app__purchase_orders (id, branch_id, supplier_id, number, status, language, notes, created_by, created_at, sent_at) values (?, ?, ?, 'PO-SHJ-0001', 'sent', 'en', '', 'seed', ?, ?)", [SHJ_PO, SHJ, NOOR, NOW, NOW]);
  db.run("insert into app__purchase_order_lines (po_id, branch_id, part_id, qty, unit_cost_fils, received_qty) values (?, ?, ?, 3, 500, 0)", [SHJ_PO, SHJ, FILTER]);
});

const manager = await signIn("manager", "manager.dubai@fixit.example");
const dispatcher = await signIn("dispatcher", "dispatcher.dubai@fixit.example");
const accountant = await signIn("accountant", "accountant.dubai@fixit.example");
const ali = await signIn("ali", "ali.dubai@fixit.example", "/me");

type Who = typeof manager;
const create = (who: Who, form: Record<string, string>) => who.action("/admin/purchasing", "create", { supplier: NOOR, language: "en", expected_on: "", notes: "", ...form });
const act = (who: Who, id: string, name: string, form: Record<string, string> = {}) => who.action(`/admin/purchasing/${id}`, name, form);
const poOf = (number: string) => rows("select * from app__purchase_orders where number = ?", [number])[0] as Record<string, unknown>;
const linesOf = (id: string) => rows("select id, part_id, qty, unit_cost_fils, received_qty from app__purchase_order_lines where po_id = ? order by id", [id]);
const level = (branch: string, part: string) => rows("select qty, avg_cost_fils from app__stock where branch_id = ? and part_id = ?", [branch, part])[0];
const moves = (part: string) => rows("select kind, qty, unit_cost_fils, balance_after, reason, ref_kind, ref_id from app__stock_moves where branch_id = ? and part_id = ? order by rowid", [DXB, part]);
const count = (table: string): number => Number(rows(`select count(*) as n from ${table}`)[0]?.n);
const audited = (action: string): number => Number(rows("select count(*) as n from audit__events where action = ?", [action])[0]?.n);

/** A draft of the given supplier and language with `lines` ([part, qty, unit cost text]) added through the page. */
async function draft(lines: [string, string, string][], form: Record<string, string> = {}): Promise<string> {
  const res = await create(manager, form);
  expect(res.status).toBe(303);
  const id = /\/admin\/purchasing\/(po_[0-9a-f]{16})/u.exec(located(res))?.[1] ?? "";
  expect(id).not.toBe("");
  for (const [part, qty, unit_cost] of lines) expect((await act(manager, id, "add_line", { part, qty, unit_cost })).status).toBe(303);
  return id;
}

let main = "";

describe("a draft", () => {
  test("is created with the next number, in the active branch, and lists on /admin/purchasing", async () => {
    const res = await create(manager, { expected_on: "2026-12-31", notes: "Deliver to the back door" });
    expect(res.status).toBe(303);
    expect(located(res)).toMatch(/^\/admin\/purchasing\/po_[0-9a-f]{16}\?saved=created$/u);
    main = /po_[0-9a-f]{16}/u.exec(located(res))?.[0] ?? "";
    const po = poOf("PO-000002");
    expect([po.id, po.branch_id, po.supplier_id, po.status, po.language, po.expected_on, po.notes, po.created_by, po.sent_at, po.closed_at]).toEqual([main, DXB, NOOR, "draft", "en", "2026-12-31", "Deliver to the back door", "u_dxb_manager", null, null]);
    const list = await manager.page("/admin/purchasing");
    expect(list.status).toBe(200);
    expect(list.html).toContain(`id="po-${main}"`);
    expect(list.html).not.toContain(SHJ_PO);
    expect(list.html).toContain(">PO-000002<");
  });

  test("error case: a bad form is a 422 naming the field and stores nothing", async () => {
    const before = count("app__purchase_orders");
    const cases: [Record<string, string>, string][] = [
      [{ supplier: "" }, "supplier"],
      [{ supplier: "nope" }, "supplier"],
      [{ supplier: "su_ffffffffffffffff" }, "supplier"],
      [{ supplier: GONE }, "supplier"],
      [{ expected_on: "2026-02-30" }, "expected_on"],
      [{ expected_on: "tomorrow" }, "expected_on"],
      [{ language: "fr" }, "language"],
    ];
    for (const [form, field] of cases) {
      const res = await create(manager, form);
      expect([JSON.stringify(form), res.status]).toEqual([JSON.stringify(form), 422]);
      expect(res.html).toContain(`id="err-${field}"`);
    }
    expect(count("app__purchase_orders")).toBe(before);
  });

  test("two lines total net, VAT at the part's 5 % and gross; a blank cost is the part's", async () => {
    expect((await act(manager, main, "add_line", { part: FILTER, qty: "10", unit_cost: "" })).status).toBe(303);
    const added = await act(manager, main, "add_line", { part: PIPE, qty: "4", unit_cost: "10.00" });
    expect(located(added)).toBe(`/admin/purchasing/${main}?saved=line_added`);
    expect(linesOf(main).map((l) => [l.part_id, l.qty, l.unit_cost_fils, l.received_qty])).toEqual([[FILTER, 10, 500, 0], [PIPE, 4, 1000, 0]]);
    // 10 x 5.00 = 50.00 and 4 x 10.00 = 40.00: net 90.00, VAT 4.50, total 94.50.
    const page = await manager.page(`/admin/purchasing/${main}`);
    expect(page.status).toBe(200);
    expect(page.html).toMatch(/id="net">AED\s90\.00</u);
    expect(page.html).toMatch(/id="vat">AED\s4\.50</u);
    expect(page.html).toMatch(/id="total"><strong[^>]*>AED\s94\.50</u);
    expect(page.html).toContain('id="pdf-links"');
  });

  test("error case: a bad line is a 422 and adds nothing", async () => {
    const before = linesOf(main).length;
    const cases: [Record<string, string>, string][] = [
      [{ part: "", qty: "1" }, "part"],
      [{ part: "pt_ffffffffffffffff", qty: "1" }, "part"],
      [{ part: OFF, qty: "1" }, "part"],
      [{ part: FILTER, qty: "0" }, "qty"],
      [{ part: FILTER, qty: "1.2345" }, "qty"],
      [{ part: FILTER, qty: "2", unit_cost: "five" }, "unit_cost"],
    ];
    for (const [form, field] of cases) {
      const res = await act(manager, main, "add_line", form);
      expect([JSON.stringify(form), res.status]).toEqual([JSON.stringify(form), 422]);
      expect(res.html).toContain(`id="err-${field}"`);
    }
    expect(linesOf(main).length).toBe(before);
  });

  test("a line can be removed while the order is a draft", async () => {
    const id = await draft([[FILTER, "1", ""], [PIPE, "2", ""]]);
    const [first] = linesOf(id);
    expect(located(await act(manager, id, "remove_line", { line: String(first?.id) }))).toBe(`/admin/purchasing/${id}?saved=line_removed`);
    expect(linesOf(id).map((l) => l.part_id)).toEqual([PIPE]);
    expect((await act(manager, id, "remove_line", { line: String(first?.id) })).status).toBe(404);
    // A line of another order is no line of this one.
    expect((await act(manager, id, "remove_line", { line: String(linesOf(main)[0]?.id) })).status).toBe(404);
  });
});

describe("sending", () => {
  test("error case: an order with no line cannot be sent (422) and stays a draft", async () => {
    const empty = await draft([]);
    const res = await act(manager, empty, "send");
    expect(res.status).toBe(422);
    expect(res.html).toContain('id="err-lines"');
    expect(rows("select status from app__purchase_orders where id = ?", [empty])).toEqual([{ status: "draft" }]);
    expect(audited("purchase.send")).toBe(0);
  });

  test("an order with lines becomes sent, with its time and an audit row; nothing is mailed (platform gap)", async () => {
    const mails = count("email__messages");
    const res = await act(manager, main, "send");
    expect(res.status).toBe(303);
    expect(located(res)).toBe(`/admin/purchasing/${main}?saved=sent`);
    const po = poOf("PO-000002");
    expect(po.status).toBe("sent");
    expect(Number(po.sent_at)).toBeGreaterThan(NOW);
    expect(audited("purchase.send")).toBe(1);
    expect(count("email__messages")).toBe(mails);
    const page = await manager.page(`/admin/purchasing/${main}?saved=sent`);
    expect(page.html).toContain('id="send-note"');
    expect(page.html).toContain('id="receive-form"');
  });

  test("lines cannot change after the order is sent", async () => {
    const before = linesOf(main);
    const added = await act(manager, main, "add_line", { part: FILTER, qty: "1" });
    expect(added.status).toBe(422);
    expect(added.html).toContain('id="err-form"');
    const removed = await act(manager, main, "remove_line", { line: String(before[0]?.id) });
    expect(removed.status).toBe(422);
    expect((await act(manager, main, "send")).status).toBe(422);
    expect(linesOf(main)).toEqual(before);
  });
});

describe("the PDF", () => {
  test("is application/pdf starting with %PDF, private and not stored, in English and in Arabic", async () => {
    for (const lang of ["en", "ar"]) {
      const res = await manager.page(`/admin/purchasing/${main}/pdf?lang=${lang}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/pdf");
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(res.html.startsWith("%PDF")).toBe(true);
    }
  });

  test("without ?lang it is the order's own language: Arabic for an `ar` order", async () => {
    expect((await manager.page(`/admin/purchasing/${main}/pdf`)).headers.get("content-disposition")).toContain("PO-000002-en.pdf");
    const id = await draft([[FILTER, "2", ""]], { language: "ar", supplier: NOMAIL });
    const res = await manager.page(`/admin/purchasing/${id}/pdf`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/PO-\d{6}-ar\.pdf/u);
    expect(res.html.startsWith("%PDF")).toBe(true);
  });

  test("a bad id and another branch's order are a 404; a dispatcher and a technician are refused (403)", async () => {
    expect((await manager.page("/admin/purchasing/nope/pdf")).status).toBe(404);
    expect((await manager.page(`/admin/purchasing/${SHJ_PO}/pdf`)).status).toBe(404);
    expect((await dispatcher.page(`/admin/purchasing/${main}/pdf`)).status).toBe(403);
    expect((await ali.page(`/admin/purchasing/${main}/pdf`)).status).toBe(403);
    expect((await accountant.page(`/admin/purchasing/${main}/pdf`)).status).toBe(200);
  });
});

describe("receiving", () => {
  test("half of line 1 makes the order partly received, raises the stock at the paid cost and moves the average and the part's cost", async () => {
    // The branch already holds 5 of the filter at 4.00 (a manual receipt through the stock page).
    expect((await manager.action("/admin/stock", "receive", { part: FILTER, qty: "5", unit_cost: "4.00", reason: "opening count" })).status).toBe(303);
    const [first] = linesOf(main);
    const res = await act(manager, main, "receive", { qty_0: "5", price_0: "6.00", qty_1: "", price_1: "" });
    expect(res.status).toBe(303);
    expect(located(res)).toBe(`/admin/purchasing/${main}?saved=received`);
    expect(poOf("PO-000002").status).toBe("partly_received");
    expect(poOf("PO-000002").closed_at).toBeNull();
    expect(linesOf(main).map((l) => l.received_qty)).toEqual([5, 0]);
    // 5 at 4.00 and 5 at 6.00: 10 on hand at an average of 5.00; the part's cost is the last paid, 6.00.
    expect(level(DXB, FILTER)).toEqual({ qty: 10, avg_cost_fils: 500 });
    expect(moves(FILTER).at(-1)).toEqual({ kind: "in", qty: 5, unit_cost_fils: 600, balance_after: 10, reason: "PO-000002", ref_kind: "purchase", ref_id: main });
    expect(rows("select cost_fils from app__parts where id = ?", [FILTER])).toEqual([{ cost_fils: 600 }]);
    expect(level(DXB, PIPE)).toBeUndefined();
    expect(first?.part_id).toBe(FILTER);
    expect(audited("purchase.receive")).toBe(1);
  });

  test("the stock history of the part links to the order", async () => {
    const history = await manager.page(`/admin/stock/${FILTER}?branch=${DXB}`);
    expect(history.status).toBe(200);
    expect(history.html).toContain(`href="/admin/purchasing/${main}"`);
    expect((await manager.page(`/admin/purchasing/${main}`)).status).toBe(200);
  });

  test("error case: more than outstanding, a bad number and an empty receipt are 422s that move nothing", async () => {
    const before = count("app__stock_moves");
    const cases: [Record<string, string>, string][] = [
      [{ qty_0: "5.001", price_0: "", qty_1: "", price_1: "" }, "qty_0"],
      [{ qty_0: "0", price_0: "", qty_1: "4.5", price_1: "" }, "qty_1"],
      [{ qty_0: "-1", price_0: "", qty_1: "", price_1: "" }, "qty_0"],
      [{ qty_0: "two", price_0: "", qty_1: "", price_1: "" }, "qty_0"],
      [{ qty_0: "1", price_0: "free", qty_1: "", price_1: "" }, "price_0"],
      [{ qty_0: "0", price_0: "", qty_1: "", price_1: "" }, "lines"],
      [{}, "lines"],
    ];
    for (const [form, field] of cases) {
      const res = await act(manager, main, "receive", form);
      expect([JSON.stringify(form), res.status]).toEqual([JSON.stringify(form), 422]);
      expect(res.html).toContain(`id="err-${field}"`);
    }
    // One good line and one bad one: nothing of it is booked.
    expect((await act(manager, main, "receive", { qty_0: "1", price_0: "", qty_1: "9", price_1: "" })).status).toBe(422);
    expect(count("app__stock_moves")).toBe(before);
    expect(linesOf(main).map((l) => l.received_qty)).toEqual([5, 0]);
    expect(poOf("PO-000002").status).toBe("partly_received");
  });

  test("cancel is refused after a receipt", async () => {
    const res = await act(manager, main, "cancel");
    expect(res.status).toBe(422);
    expect(res.html).toContain('id="err-form"');
    expect(poOf("PO-000002").status).toBe("partly_received");
    expect(audited("purchase.cancel")).toBe(0);
  });

  test("the rest makes it received, with its closing time; a blank cost is the line's", async () => {
    const res = await act(manager, main, "receive", { qty_0: "5", price_0: "6.00", qty_1: "4", price_1: "" });
    expect(res.status).toBe(303);
    const po = poOf("PO-000002");
    expect(po.status).toBe("received");
    expect(Number(po.closed_at)).toBeGreaterThan(NOW);
    expect(linesOf(main).map((l) => l.received_qty)).toEqual([5 + 5, 4]);
    expect(level(DXB, FILTER)).toEqual({ qty: 15, avg_cost_fils: 533 });
    expect(level(DXB, PIPE)).toEqual({ qty: 4, avg_cost_fils: 1000 });
    expect(rows("select cost_fils from app__parts where id = ?", [PIPE])).toEqual([{ cost_fils: 1000 }]);
    expect(moves(PIPE).map((m) => [m.kind, m.qty, m.unit_cost_fils, m.ref_id])).toEqual([["in", 4, 1000, main]]);
    expect(audited("purchase.receive")).toBe(2);
    // Nothing more to receive, change or cancel.
    expect((await act(manager, main, "receive", { qty_0: "1", price_0: "", qty_1: "", price_1: "" })).status).toBe(422);
    expect((await act(manager, main, "cancel")).status).toBe(422);
    expect((await act(manager, main, "send")).status).toBe(422);
    expect(poOf("PO-000002").status).toBe("received");
  });

  test("an order that was never sent cannot be received", async () => {
    const id = await draft([[FILTER, "2", ""]]);
    const before = count("app__stock_moves");
    expect((await act(manager, id, "receive", { qty_0: "2", price_0: "", })).status).toBe(422);
    expect(count("app__stock_moves")).toBe(before);
  });
});

describe("cancelling", () => {
  test("a draft and a sent order can be cancelled; each is audited", async () => {
    const a = await draft([[FILTER, "1", ""]]);
    expect(located(await act(manager, a, "cancel"))).toBe(`/admin/purchasing/${a}?saved=cancelled`);
    const b = await draft([[FILTER, "1", ""]]);
    expect((await act(manager, b, "send")).status).toBe(303);
    expect((await act(manager, b, "cancel")).status).toBe(303);
    expect(rows("select status, closed_at is not null as closed from app__purchase_orders where id in (?, ?) order by number", [a, b])).toEqual([{ status: "cancelled", closed: 1 }, { status: "cancelled", closed: 1 }]);
    expect(audited("purchase.cancel")).toBe(2);
    expect((await act(manager, a, "add_line", { part: FILTER, qty: "1" })).status).toBe(422);
    expect((await act(manager, a, "send")).status).toBe(422);
  });
});

describe("who may", () => {
  test("a manager of another branch gets 404 on its order and its actions", async () => {
    expect((await manager.page(`/admin/purchasing/${SHJ_PO}`)).status).toBe(404);
    for (const [name, form] of [["send", {}], ["cancel", {}], ["receive", { qty_0: "1" }], ["add_line", { part: FILTER, qty: "1" }], ["remove_line", { line: "1" }]] as const) {
      expect([name, (await act(manager, SHJ_PO, name, form)).status]).toEqual([name, 404]);
    }
    expect(poOf("PO-SHJ-0001").status).toBe("sent");
    expect(level(SHJ, FILTER)).toBeUndefined();
    expect((await manager.page("/admin/purchasing/not-an-order")).status).toBe(404);
  });

  test("a dispatcher and a technician are refused (403); an accountant reads but changes nothing", async () => {
    for (const who of [dispatcher, ali]) {
      expect((await who.page("/admin/purchasing")).status).toBe(403);
      expect((await who.page(`/admin/purchasing/${main}`)).status).toBe(403);
      expect((await create(who, {})).status).toBe(403);
    }
    expect((await accountant.page("/admin/purchasing")).status).toBe(200);
    const view = await accountant.page(`/admin/purchasing/${main}`);
    expect(view.status).toBe(200);
    expect(view.html).not.toContain('id="receive-form"');
    expect(view.html).not.toContain('id="cancel-po"');
    expect((await create(accountant, {})).status).toBe(403);
    const id = await draft([[FILTER, "1", ""]]);
    for (const [name, form] of [["send", {}], ["cancel", {}], ["add_line", { part: FILTER, qty: "1" }], ["receive", { qty_0: "1" }]] as const) {
      expect([name, (await act(accountant, id, name, form)).status]).toEqual([name, 403]);
    }
    expect(poOf(String(rows("select number from app__purchase_orders where id = ?", [id])[0]?.number)).status).toBe("draft");
  });
});

describe("the list", () => {
  test("filters by status and supplier and shows 25 to a page, newest first", async () => {
    rw((db) => {
      for (let i = 0; i < 27; i++) db.run("insert into app__purchase_orders (id, branch_id, supplier_id, number, status, language, notes, created_by, created_at) values (?, ?, ?, ?, 'draft', 'en', '', 'seed', ?)", [`po_00000000008150${String(i).padStart(2, "0")}`, DXB, NOMAIL, `PO-9${String(i).padStart(5, "0")}`, NOW + i]);
    });
    const ids = (html: string): string[] => [...html.matchAll(/id="po-(po_[0-9a-f]{16})"/gu)].map((m) => m[1] as string);
    const first = ids((await manager.page("/admin/purchasing")).html);
    expect(first.length).toBe(25);
    expect(ids((await manager.page("/admin/purchasing?page=2")).html).length).toBeGreaterThan(0);
    const walkIn = ids((await manager.page(`/admin/purchasing?supplier=${NOMAIL}&status=draft`)).html);
    expect(walkIn.length).toBe(25);
    expect(walkIn.every((id) => rows("select supplier_id from app__purchase_orders where id = ?", [id])[0]?.supplier_id === NOMAIL)).toBe(true);
    const received = ids((await manager.page("/admin/purchasing?status=received")).html);
    expect(received).toEqual([main]);
    expect(ids((await manager.page(`/admin/purchasing?supplier=${GONE}`)).html)).toEqual([]);
    expect((await manager.page("/admin/purchasing?status=bogus&page=-4&supplier=x")).status).toBe(200);
  });
});

describe("snapshots", () => {
  test("the list and an order, in English and in Arabic", async () => {
    const steady = (html: string) => html.replace(/po_[0-9a-f]{16}/gu, "po_<id>").replace(/\d{4}-\d{2}-\d{2}/gu, "<date>");
    const sent = await draft([[FILTER, "3", "5.50"], [PIPE, "2.5", "9.00"]], { supplier: NOOR, expected_on: "2026-12-31", notes: "Call before delivery" });
    expect((await act(manager, sent, "send")).status).toBe(303);
    for (const lang of ["en", "ar"]) {
      const list = await manager.page(`/admin/purchasing?status=sent&lang=${lang}`);
      expect(list.status).toBe(200);
      snapshot(steady(list.html), { role: `purchase orders sent, manager, ${lang}` });
      const detail = await manager.page(`/admin/purchasing/${sent}?lang=${lang}`);
      expect(detail.status).toBe(200);
      snapshot(steady(detail.html), { role: `purchase order sent, manager, ${lang}` });
      const fresh = await draft([[FILTER, "1", ""]]);
      const editing = await manager.page(`/admin/purchasing/${fresh}?lang=${lang}`);
      snapshot(steady(editing.html).replace(/PO-\d{6}/gu, "PO-<n>"), { role: `purchase order draft, manager, ${lang}` });
    }
  });
});
