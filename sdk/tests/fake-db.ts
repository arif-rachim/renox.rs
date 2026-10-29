// A `Db` over bun:sqlite for unit tests of the query builders (#237): the
// same surface as the `db` op, statements and parameters recorded. The
// worker tests (builders-worker.ts) prove the real op path.

import { Database } from "bun:sqlite";

import type { Db, DbStatements, ExecuteResult, Param, Row } from "../src/db.ts";

export interface FakeDb extends Db {
  log: [string, Param[]][];
  sqlite: Database;
}

export function fakeDb(setup = "create table app__items (id integer primary key, name text not null, qty integer not null default 0)"): FakeDb {
  const sqlite = new Database(":memory:");
  sqlite.exec(setup);
  const log: [string, Param[]][] = [];
  const statements: DbStatements = {
    async query<T extends Row = Row>(sql: string, params: readonly Param[] = []) {
      log.push([sql, [...params]]);
      return sqlite.query(sql).all(...(params as never[])) as T[];
    },
    async queryOne<T extends Row = Row>(sql: string, params: readonly Param[] = []) {
      log.push([sql, [...params]]);
      return (sqlite.query(sql).get(...(params as never[])) as T | null) ?? null;
    },
    async execute(sql: string, params: readonly Param[] = []): Promise<ExecuteResult> {
      log.push([sql, [...params]]);
      const r = sqlite.query(sql).run(...(params as never[]));
      return { changes: r.changes, lastInsertRowid: r.lastInsertRowid };
    },
  };
  const db: FakeDb = {
    ...statements,
    log,
    sqlite,
    // No rewriter in unit tests: a scoped Db is the same Db (ops.md section 17 is enforced in Rust).
    scoped: () => db,
    async transaction<T>(fn: (tx: DbStatements) => Promise<T>): Promise<T> {
      sqlite.exec("begin immediate");
      try {
        const out = await fn(statements);
        sqlite.exec("commit");
        return out;
      } catch (e) {
        sqlite.exec("rollback");
        throw e;
      }
    },
  };
  return db;
}
