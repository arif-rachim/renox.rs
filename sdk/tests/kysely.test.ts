// #237: renox/kysely. Unit tests over a bun:sqlite Db (statements and
// parameter order as the op receives them), then the same builder on the
// real worker, including the refusal of a table outside the app's prefix
// (docs/23-failure-modes.md F4 row "Query builder still blocked by the
// authorizer on another module's table").

import { afterAll, expect, test } from "bun:test";

import { check } from "../../cli/src/commands/check.ts";
import { kysely } from "../src/kysely.ts";
import { buildersApp, worker } from "./builders-worker.ts";
import { fakeDb } from "./fake-db.ts";

interface Tables {
  app__items: { id: number; name: string; qty: number };
}

test("? placeholders and parameter order reach the db op unchanged; writes go to execute", async () => {
  const db = fakeDb();
  const k = kysely<Tables>({ db });
  const ins = await k.insertInto("app__items").values({ id: 7, name: "dates", qty: 3 }).executeTakeFirst();
  expect(ins.numInsertedOrUpdatedRows).toBe(1n);
  expect(ins.insertId).toBe(7n);
  const rows = await k.selectFrom("app__items").select(["id", "name"]).where("qty", ">", 2).where("name", "=", "dates").execute();
  expect(rows).toEqual([{ id: 7, name: "dates" }]);
  expect(db.log).toEqual([
    ['insert into "app__items" ("id", "name", "qty") values (?, ?, ?)', [7, "dates", 3]],
    ['select "id", "name" from "app__items" where "qty" > ? and "name" = ?', [2, "dates"]],
  ]);
});

test("a builder transaction commits, and rolls back when its callback throws", async () => {
  const db = fakeDb();
  const k = kysely<Tables>({ db });
  await expect(
    k.transaction().execute(async (tx) => {
      await tx.insertInto("app__items").values({ id: 1, name: "a", qty: 1 }).execute();
      throw new Error("boom");
    }),
  ).rejects.toThrow("boom");
  await k.transaction().execute(async (tx) => {
    await tx.insertInto("app__items").values({ id: 2, name: "b", qty: 1 }).execute();
  });
  expect(await k.selectFrom("app__items").select("id").execute()).toEqual([{ id: 2 }]);
});

test("returning and update counts", async () => {
  const db = fakeDb();
  const k = kysely<Tables>({ db });
  const back = await k.insertInto("app__items").values({ id: 3, name: "c", qty: 1 }).returning(["id", "name"]).executeTakeFirst();
  expect(back).toEqual({ id: 3, name: "c" });
  const up = await k.updateTable("app__items").set({ qty: 9 }).where("id", "=", 3).executeTakeFirst();
  expect(up.numUpdatedRows).toBe(1n);
});

afterAll(async () => {
  if (worker) await (await buildersApp()).stop();
});

test.skipIf(!worker)("on the worker: own table works; another prefix is refused exactly like raw SQL; rollback on throw", async () => {
  const { base, dir } = await buildersApp();
  // The fixture app with Kysely (and Drizzle) builds, and renox check is clean.
  expect(await check(dir)).toEqual({ errors: [], findings: [] });
  const own = (await (await fetch(`${base}/api/builders?case=own`)).json()) as { viaKysely: unknown };
  expect(own.viaKysely).toEqual([
    { id: 1, name: "dates" },
    { id: 2, name: "saffron" },
  ]);
  const foreign = (await (await fetch(`${base}/api/builders?case=foreign`)).json()) as { raw: { error: { code: string } }; kysely: unknown };
  expect(foreign.raw.error.code).toBe("RENOX_DB_AUTH");
  expect(foreign.kysely).toEqual(foreign.raw);
  const rb = (await (await fetch(`${base}/api/builders?case=rollback`)).json()) as { r: { error: unknown }; left: unknown };
  expect(rb.r.error).toBeDefined();
  expect(rb.left).toEqual([{ id: 12 }]);
}, 60_000);
