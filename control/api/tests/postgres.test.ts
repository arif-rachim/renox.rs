// The production adapter (Bun's Postgres client) against a real server.
// Runs only when CONTROL_TEST_DATABASE_URL points at an empty database, e.g.
// the compose stack: postgres://renox:renox@localhost:5432/renox_test

import { describe, expect, test } from "bun:test";
import { openPostgres } from "../src/db/postgres.ts";
import { migrate } from "../src/db/migrate.ts";

const url = process.env.CONTROL_TEST_DATABASE_URL;

describe.skipIf(url === undefined)("postgres adapter", () => {
  test("migrates, queries with parameters, rolls back, and delivers NOTIFY", async () => {
    const db = openPostgres(url as string);
    await db.exec("drop schema public cascade; create schema public;");
    expect(await migrate(db)).toEqual([1]);
    expect(await migrate(db)).toEqual([]);
    await db.query("insert into tenants (id, name, tier, created_at) values ($1, $2, $3, $4)", ["t_a", "A", "free", 1793318400000]);
    const rows = await db.query<{ created_at: unknown; scopes: unknown }>(
      "select created_at, '[\"*\"]'::jsonb as scopes from tenants where id = $1",
      ["t_a"],
    );
    expect(Number(rows[0]?.created_at)).toBe(1793318400000);
    expect(rows[0]?.scopes).toEqual(["*"]);
    await expect(
      db.transaction(async (tx) => {
        await tx.query("insert into tenants (id, name, tier, created_at) values ('t_b', 'B', 'free', 1)");
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect((await db.query("select id from tenants where id = 't_b'")).length).toBe(0);
    await expect(db.query("delete from audit")).resolves.toBeDefined();
    await db.query("insert into audit (at, actor, action, target, status, request_id) values (1, 'operator', 'x', '{}'::jsonb, 200, 'r')");
    await expect(db.query("delete from audit")).rejects.toThrow("append-only");
    const got: string[] = [];
    const unlisten = await db.listen("renox_test", (p) => got.push(p));
    await db.query("select pg_notify('renox_test', 'v42')");
    for (let i = 0; i < 50 && got.length === 0; i++) await Bun.sleep(20);
    expect(got).toEqual(["v42"]);
    await unlisten();
    await db.close();
  });
});
