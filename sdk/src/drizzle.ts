// `renox/drizzle`: Drizzle over the `db` op (docs/06-data.md, "API layers";
// #237), on drizzle's SQLite proxy driver. Every statement goes to
// `ctx.db.query` or `execute` with its `?` parameters in order, so the
// platform's limits and the module authorizer apply exactly as to raw SQL.
//
//   import { drizzle } from "renox/drizzle";
//   const db = drizzle(ctx, { schema });
//   await db.select().from(products).where(eq(products.id, id));
//
// Transactions: run the builder on the transaction, not with drizzle's own
// `db.transaction()` (that one sends BEGIN/COMMIT as SQL, which the platform
// refuses): `await ctx.db.transaction(async (tx) => drizzle({ db: tx }).insert(...))`.
//
// Errors: Drizzle wraps a failed statement in its `DrizzleQueryError`; the
// platform's `RenoxError` (RENOX_DB_AUTH, ...) is its `cause`, unchanged.
//
// `drizzle-orm` is an optional peer dependency: an app that never imports
// this subpath does not need it.

import { type SqliteRemoteDatabase, drizzle as proxy } from "drizzle-orm/sqlite-proxy";

import type { Db, DbStatements, Param, Row, Value } from "./db.ts";

type Method = "run" | "all" | "values" | "get";

/** The proxy callback: drizzle wants rows as arrays of values, in column order. */
function callback(db: Db | DbStatements) {
  return async (sql: string, params: unknown[], method: Method): Promise<{ rows: unknown[] }> => {
    if (/^\s*(begin|commit|rollback|savepoint|release)\b/iu.test(sql)) {
      throw new Error("renox/drizzle: transactions go through ctx.db.transaction(async (tx) => drizzle({ db: tx }) ...)");
    }
    const ps = params as Param[];
    if (method === "run") {
      await db.execute(sql, ps);
      return { rows: [] };
    }
    const values = (r: Row): Value[] => Object.values(r);
    if (method === "get") {
      const row = await db.queryOne<Row>(sql, ps);
      return { rows: row === null ? [] : values(row) };
    }
    return { rows: (await db.query<Row>(sql, ps)).map(values) };
  };
}

/** A Drizzle database over `ctx.db` (or a transaction's `tx`). */
export function drizzle<TSchema extends Record<string, unknown> = Record<string, never>>(
  ctx: { readonly db: Db | DbStatements },
  config?: { schema?: TSchema },
): SqliteRemoteDatabase<TSchema> {
  return proxy<TSchema>(callback(ctx.db), config);
}
