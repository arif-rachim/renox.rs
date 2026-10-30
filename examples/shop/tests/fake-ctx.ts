// A fake `ctx` for unit tests: `db` on an in-memory bun:sqlite database with
// the shop's migration and seed applied. Positional parameters only, as in
// the runtime; transactions are serialised like the runtime's writer.
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Ctx, Db, DbStatements, ExecuteResult, Param, Row } from "renox";

const root = join(import.meta.dir, "..");

export function shopDb(seed = true): Database {
  const sqlite = new Database(":memory:", { strict: false });
  sqlite.exec("pragma foreign_keys = on");
  for (const m of ["001_init.sql", "002_orders.sql", "003_orders_org.sql"]) sqlite.exec(readFileSync(join(root, "migrations", m), "utf8"));
  if (seed) sqlite.exec(readFileSync(join(root, "seeds/products.sql"), "utf8"));
  return sqlite;
}

type Bind = string | number | bigint | boolean | null | Uint8Array;

function statements(sqlite: Database): DbStatements {
  const bind = (params: readonly Param[] = []): Bind[] => params.map((p) => p as Bind);
  return {
    query: async <T extends Row = Row>(sql: string, params?: readonly Param[]) =>
      sqlite.query(sql).all(...bind(params)) as T[],
    queryOne: async <T extends Row = Row>(sql: string, params?: readonly Param[]) =>
      (sqlite.query(sql).get(...bind(params)) as T | null) ?? null,
    execute: async (sql: string, params?: readonly Param[]): Promise<ExecuteResult> => {
      const r = sqlite.query(sql).run(...bind(params));
      return { changes: r.changes, lastInsertRowid: r.lastInsertRowid };
    },
  };
}

export function fakeDb(sqlite: Database): Db {
  const s = statements(sqlite);
  let chain = Promise.resolve();
  const db: Db = {
    ...s,
    // Unit tests have no rewriter: a scoped Db is the same Db (ops.md section 17 is enforced in Rust).
    scoped: () => db,
    transaction: <T>(fn: (tx: DbStatements) => Promise<T>): Promise<T> => {
      const run = chain.then(async () => {
        sqlite.exec("begin immediate");
        try {
          const out = await fn(s);
          sqlite.exec("commit");
          return out;
        } catch (e) {
          sqlite.exec("rollback");
          throw e;
        }
      });
      chain = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };
  return db;
}

export function ctx(sqlite: Database, method: string, url: string, init: { body?: unknown; params?: Ctx["params"] } = {}): Ctx {
  const req = new Request(url, {
    method,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body), headers: { "content-type": "application/json" } }),
  });
  const noop = (): void => {};
  return {
    req,
    url: new URL(req.url),
    params: init.params ?? {},
    headers: req.headers,
    db: fakeDb(sqlite),
    fetch: () => Promise.reject(new Error("no network in unit tests")),
    secrets: Object.freeze({}),
    log: { debug: noop, info: noop, warn: noop, error: noop },
    deadline: { remainingMs: () => 30_000 },
    module: "app",
    config: Object.freeze({}),
    services: Object.freeze({}),
    events: { emit: () => Promise.reject(new Error("no events in unit tests")) },
    hooks: { run: () => Promise.resolve({ halt: false }) },
    password: { hash: () => Promise.reject(new Error("no password op in unit tests")), verify: () => Promise.resolve(false) },
    principal: null,
    authz: {
      require: () => Promise.reject(new Error("no authz in unit tests")),
      can: () => Promise.resolve(false),
      canBatch: (_a, rs) => Promise.resolve(rs.map(() => false)),
      explain: () => Promise.resolve({ decision: "deny", reasons: [], errors: [] }),
      roles: { assign: () => Promise.resolve(), revoke: () => Promise.resolve(false), list: () => Promise.resolve([]) },
    },
    realtime: {
      subscribe: () => Promise.resolve(),
      unsubscribe: () => Promise.resolve(),
      publish: () => Promise.resolve(0),
      send: () => Promise.resolve(),
      close: () => Promise.resolve(),
    },
    jobs: {
      enqueue: () => Promise.reject(new Error("no jobs in unit tests")),
      list: () => Promise.reject(new Error("no jobs in unit tests")),
      retry: () => Promise.reject(new Error("no jobs in unit tests")),
      cancel: () => Promise.reject(new Error("no jobs in unit tests")),
    },
  };
}
