// #237: renox/drizzle, on drizzle's SQLite proxy driver. Unit tests over a
// bun:sqlite Db, then on the real worker (the refusal of a table outside the
// app's prefix equals the raw path's; docs/23-failure-modes.md F4 row "Query
// builder still blocked by the authorizer on another module's table").

import { afterAll, expect, test } from "bun:test";
import { eq, gt } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { drizzle } from "../src/drizzle.ts";
import { buildersApp, worker } from "./builders-worker.ts";
import { fakeDb } from "./fake-db.ts";

const items = sqliteTable("app__items", { id: integer("id").primaryKey(), name: text("name").notNull(), qty: integer("qty").notNull() });

test("statements, ? placeholders and parameter order reach the db op unchanged", async () => {
  const db = fakeDb();
  const d = drizzle({ db });
  await d.insert(items).values({ id: 1, name: "dates", qty: 3 });
  const rows = await d.select({ id: items.id, name: items.name }).from(items).where(gt(items.qty, 2));
  expect(rows).toEqual([{ id: 1, name: "dates" }]);
  const one = await d.select().from(items).where(eq(items.id, 1)).get();
  expect(one).toEqual({ id: 1, name: "dates", qty: 3 });
  expect(db.log.map(([sql, p]) => [sql.replace(/\s+/gu, " "), p])).toEqual([
    ['insert into "app__items" ("id", "name", "qty") values (?, ?, ?)', [1, "dates", 3]],
    ['select "id", "name" from "app__items" where "app__items"."qty" > ?', [2]],
    ['select "id", "name", "qty" from "app__items" where "app__items"."id" = ?', [1]],
  ]);
});

test("drizzle's own transaction() is refused; ctx.db.transaction with drizzle(tx) rolls back on throw", async () => {
  const db = fakeDb();
  const d = drizzle({ db });
  await expect(d.transaction(async (tx) => tx.insert(items).values({ id: 1, name: "x", qty: 1 }))).rejects.toThrow("Failed query: begin");
  await expect(
    db.transaction(async (tx) => {
      await drizzle({ db: tx }).insert(items).values({ id: 2, name: "y", qty: 1 });
      throw new Error("boom");
    }),
  ).rejects.toThrow("boom");
  expect(await d.select().from(items)).toEqual([]);
});

afterAll(async () => {
  if (worker) await (await buildersApp()).stop();
});

test.skipIf(!worker)("on the worker: own table works; another prefix is refused exactly like raw SQL; rollback on throw", async () => {
  const { base } = await buildersApp();
  const own = (await (await fetch(`${base}/api/builders?case=own`)).json()) as { viaDrizzle: unknown };
  expect(own.viaDrizzle).toEqual([{ id: 2, name: "saffron", qty: 5 }]);
  const foreign = (await (await fetch(`${base}/api/builders?case=foreign`)).json()) as { raw: { error: { code: string } }; drizzle: unknown };
  expect(foreign.raw.error.code).toBe("RENOX_DB_AUTH");
  expect(foreign.drizzle).toEqual(foreign.raw);
  const rb = (await (await fetch(`${base}/api/builders?case=rollback`)).json()) as { d2: { error: unknown } };
  expect(rb.d2.error).toBeDefined();
}, 60_000);
