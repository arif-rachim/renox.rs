// Payment methods without a card PSP (#330): cash on delivery through its
// states, a bank transfer matched by its reference and exact amount on the
// statement (nothing guessed), the CSV reader, and the methods the app
// enabled. docs/23 "Payment failure paths".
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import * as core from "../../lib/core.ts";
import { parseStatement, transferReference } from "../../src/adapters/offline.ts";

function ctx(methods = "card,cod,bank") {
  const db = new Database(":memory:");
  for (const f of ["001_init.sql", "002_checkout_refunds.sql", "003_offline_methods.sql"]) db.exec(readFileSync(join(import.meta.dir, "../../migrations", f), "utf8"));
  const emitted: [string, unknown][] = [];
  const c: core.BillingCtx = {
    db: {
      async query<T>(sql: string, p: unknown[] = []) { return db.query(sql).all(...(p as never[])) as T[]; },
      async queryOne<T>(sql: string, p: unknown[] = []) { return (db.query(sql).get(...(p as never[])) ?? null) as T | null; },
      async execute(sql: string, p: unknown[] = []) { return { changes: db.query(sql).run(...(p as never[])).changes }; },
    },
    fetch: async () => {
      throw new Error("no PSP call for offline methods");
    },
    secrets: {},
    config: { currency: "AED", methods },
    events: { emit: async (n, p) => void emitted.push([n, p]) },
  };
  return { c, emitted };
}

const order = (id: string, method: string, amount = 25000) => ({ order_id: id, customer_id: "cust_1", amount, description: `Order ${id}`, method });

test("cash on delivery: placed, out for delivery, delivered is paid; refused ends unpaid; no other move", async () => {
  const { c, emitted } = ctx();
  const s = await core.createCheckout(c, order("o-1", "cod"));
  expect(s).toMatchObject({ session_id: "cod_o-1", url: "/billing/checkout/pending?order=o-1", reused: false });
  await expect(core.codUpdate(c, "o-1", "delivered")).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await core.codUpdate(c, "o-1", "out_for_delivery")).toEqual({ state: "out_for_delivery" });
  expect(await core.codUpdate(c, "o-1", "delivered")).toEqual({ state: "delivered" });
  expect(await core.invoices(c, "cust_1")).toMatchObject([{ id: "order:o-1", status: "paid", amount: 25000 }]);
  await expect(core.codUpdate(c, "o-1", "refused")).rejects.toMatchObject({ code: "CONFLICT" });
  await core.createCheckout(c, order("o-2", "cod"));
  expect(await core.codUpdate(c, "o-2", "refused")).toEqual({ state: "refused" });
  expect(emitted.map(([n]) => n)).toEqual(["billing.payment_received", "billing.checkout_completed", "billing.payment_failed"]);
  // A refused COD order is over; the same order id does not open again.
  await expect(core.codUpdate(c, "nope", "delivered")).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("bank transfer: a reference per order; a statement row pays it only with the reference and the exact amount", async () => {
  const { c, emitted } = ctx();
  const s = await core.createCheckout(c, order("o-3", "bank", 125050));
  expect(s.session_id).toMatch(/^RNX-[0-9A-HJKMNP-TV-Z]{8}$/u);
  const ref = s.session_id;
  expect(await core.matchTransfer(c, { booked_on: "2026-10-30", amount: 125050, description: "transfer from Ahmed" })).toEqual({ order_id: null, reason: "no_reference" });
  expect(await core.matchTransfer(c, { booked_on: "2026-10-30", amount: 125000, description: `TRF ${ref.toLowerCase()} Ahmed` })).toEqual({ order_id: "o-3", reason: "amount_differs" });
  expect(emitted).toEqual([]);
  expect(await core.matchTransfer(c, { booked_on: "2026-10-30", amount: 125050, description: `TRF ${ref} Ahmed` })).toEqual({ order_id: "o-3", reason: "matched" });
  expect(await core.matchTransfer(c, { booked_on: "2026-10-31", amount: 125050, description: `TRF ${ref} again` })).toEqual({ order_id: "o-3", reason: "already_paid" });
  expect(emitted.map(([n]) => n)).toEqual(["billing.payment_received", "billing.checkout_completed"]);
  const rows = await c.db.query<{ order_id: string | null }>("select order_id from billing__transfers order by imported_at, id");
  expect(rows.filter((r) => r.order_id === "o-3")).toHaveLength(1);
  expect(rows).toHaveLength(4);
});

test("only enabled methods; offline methods are one-off; references do not repeat", async () => {
  const { c } = ctx("card");
  await expect(core.createCheckout(c, order("o-4", "cod"))).rejects.toMatchObject({ code: "INVALID" });
  const both = ctx("card,cod");
  await core.createPlan(both.c, { id: "pro", name: "Pro", amount: 100, interval: "month" });
  await expect(core.createCheckout(both.c, { order_id: "o-5", customer_id: "c", plan_id: "pro", method: "cod" })).rejects.toMatchObject({ code: "INVALID" });
  expect(core.enabledMethods(both.c)).toEqual(["card", "cod"]);
  const refs = new Set(Array.from({ length: 2000 }, () => transferReference()));
  expect(refs.size).toBe(2000);
});

test("the statement reader: named columns in any order, quoted commas, decimal amounts; a bad row is a problem, not a guess", () => {
  const csv = 'Description,Date,Amount,Balance\n"TRF RNX-ABCDEFGH, Ahmed",2026-10-30,"1,250.50",9000\nCash,2026-10-30,-5.00,1\nfee,2026-10-31,12,2\n';
  const r = parseStatement(csv);
  expect(r.rows).toEqual([
    { booked_on: "2026-10-30", amount: 125050, description: "TRF RNX-ABCDEFGH, Ahmed" },
    { booked_on: "2026-10-31", amount: 1200, description: "fee" },
  ]);
  expect(r.problems).toEqual(['row 3: amount "-5.00" is not a positive decimal']);
  expect(parseStatement("a,b\n1,2").problems[0]).toContain("date, amount and description");
  expect(r).toMatchSnapshot();
});
