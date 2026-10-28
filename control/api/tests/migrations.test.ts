import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPglite } from "../src/db/pglite.ts";
import { migrate, MigrationError, readMigrations } from "../src/db/migrate.ts";
import { testDb } from "./helpers.ts";

describe("migrations", () => {
  test("the schema has every table of #51", async () => {
    const db = await testDb();
    const tables = (await db.query<{ tablename: string }>("select tablename from pg_tables where schemaname = 'public'")).map(
      (r) => r.tablename,
    );
    for (const t of [
      "tenants",
      "apps",
      "deployments",
      "permissions",
      "secrets",
      "secret_sets",
      "tenant_keys",
      "meters_raw",
      "meters_hourly",
      "audit",
      "workers",
      "tokens",
      "node_tokens",
      "schema_migrations",
    ]) {
      expect(tables).toContain(t);
    }
    const states = await db.query<{ def: string }>(
      "select pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'deployments'::regclass and contype = 'c'",
    );
    expect(states.map((s) => s.def).join(" ")).toContain("superseded");
  });

  test("a second run applies nothing", async () => {
    const db = await testDb();
    expect(await migrate(db)).toEqual([]);
  });

  test("a changed migration file stops the start", async () => {
    const dir = `${mkdtempSync(join(tmpdir(), "renox-mig-"))}/`;
    writeFileSync(`${dir}0001_one.sql`, "create table one (id int);");
    const db = await openPglite();
    expect(await migrate(db, readMigrations(dir))).toEqual([1]);
    writeFileSync(`${dir}0001_one.sql`, "create table one (id bigint);");
    await expect(migrate(db, readMigrations(dir))).rejects.toBeInstanceOf(MigrationError);
    await db.close();
  });

  test("numbering gaps are refused", () => {
    const dir = `${mkdtempSync(join(tmpdir(), "renox-mig-"))}/`;
    writeFileSync(`${dir}0002_two.sql`, "select 1;");
    expect(() => readMigrations(dir)).toThrow("without gaps");
  });

  test("the audit table is append-only", async () => {
    const db = await testDb();
    await db.query("insert into audit (at, actor, action, target, status, request_id) values (1, 'operator', 'x', '{}'::jsonb, 200, 'r')");
    await expect(db.query("update audit set status = 500")).rejects.toThrow("append-only");
    await expect(db.query("delete from audit")).rejects.toThrow("append-only");
  });
});
