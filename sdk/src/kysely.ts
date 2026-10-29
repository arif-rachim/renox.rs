// `renox/kysely`: Kysely over the `db` op (docs/06-data.md, "API layers";
// #237). A thin driver: every compiled query goes to `ctx.db.query` or
// `execute` with its `?` parameters in order, so the platform's limits and
// the module authorizer apply exactly as to raw SQL; there is no second
// execution path. Transactions run through `db.transaction` (a savepoint
// when one is already current, ops.md section 1). No streaming.
//
//   import { kysely } from "renox/kysely";
//   import type { Tables } from "../.renox/types/db";
//   const rows = await kysely<Tables>(ctx).selectFrom("app__products").selectAll().where("id", "=", id).execute();
//
// `kysely` is an optional peer dependency: an app that never imports this
// subpath does not need it.

import {
  type CompiledQuery,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  Kysely,
  type QueryResult,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
} from "kysely";

import type { Db, DbStatements, Param, Row } from "./db.ts";

/** A statement writes and returns no rows unless it is a SELECT, a WITH ... SELECT, or carries RETURNING. */
function returnsRows(query: CompiledQuery): boolean {
  const kind = (query.query as { kind?: string }).kind;
  if (kind === "SelectQueryNode") return true;
  return /\breturning\b/iu.test(query.sql) || /^\s*(select|with|pragma|values)\b/iu.test(query.sql);
}

function params(query: CompiledQuery): Param[] {
  return query.parameters.map((p) => (p instanceof Date ? p.toISOString() : (p as Param)));
}

class RenoxConnection implements DatabaseConnection {
  /** The open transaction while Kysely runs one on this connection. */
  tx: TransactionConnection | undefined;

  constructor(public db: DbStatements) {}

  async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
    if (returnsRows(query)) {
      const rows = await this.db.query<Row>(query.sql, params(query));
      return { rows: rows as R[] };
    }
    const r = await this.db.execute(query.sql, params(query));
    return { rows: [], numAffectedRows: BigInt(r.changes), insertId: BigInt(r.lastInsertRowid) };
  }

  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error("renox/kysely: streaming queries are not supported; use execute()");
  }
}

/**
 * Kysely's begin/commit/rollback over the callback form of `db.transaction`:
 * `begin` opens the transaction and parks its callback until `commit`
 * resolves it or `rollback` rejects it.
 */
class TransactionConnection extends RenoxConnection {
  private finish!: (commit: boolean) => void;
  private done!: Promise<void>;

  static async open(db: Db): Promise<TransactionConnection> {
    let ready!: (c: TransactionConnection) => void;
    const opened = new Promise<TransactionConnection>((r) => (ready = r));
    const done = db.transaction(
      (tx) =>
        new Promise<void>((resolve, reject) => {
          const conn = new TransactionConnection(tx);
          conn.finish = (commit) => (commit ? resolve() : reject(new RollbackSignal()));
          ready(conn);
        }),
    );
    const conn = await Promise.race([opened, done.then(() => Promise.reject(new Error("transaction ended before it began")))]);
    conn.done = done.catch((e: unknown) => {
      if (!(e instanceof RollbackSignal)) throw e;
    });
    return conn;
  }

  async end(commit: boolean): Promise<void> {
    this.finish(commit);
    await this.done;
  }
}

class RollbackSignal extends Error {}

class RenoxDriver implements Driver {
  constructor(private readonly db: Db | DbStatements) {}

  async init(): Promise<void> {}

  async acquireConnection(): Promise<DatabaseConnection> {
    return new RenoxConnection(this.db);
  }

  async beginTransaction(connection: DatabaseConnection): Promise<void> {
    if (!("transaction" in this.db)) throw new Error("renox/kysely: this db is already a transaction; run the queries on it directly");
    // Kysely runs the transaction's queries on the connection it passes to
    // `beginTransaction`: from here on that connection forwards to the
    // transaction.
    const c = connection as RenoxConnection;
    c.tx = await TransactionConnection.open(this.db);
    c.db = c.tx.db;
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await this.endTx(connection, true);
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await this.endTx(connection, false);
  }

  private async endTx(connection: DatabaseConnection, commit: boolean): Promise<void> {
    const c = connection as RenoxConnection;
    const tx = c.tx;
    if (tx === undefined) throw new Error("renox/kysely: no open transaction");
    c.tx = undefined;
    c.db = this.db;
    await tx.end(commit);
  }

  async releaseConnection(): Promise<void> {}

  async destroy(): Promise<void> {}
}

/** The SQLite dialect over the `db` op. */
export function renoxDialect(db: Db | DbStatements): Dialect {
  return {
    createAdapter: () => new SqliteAdapter(),
    createDriver: () => new RenoxDriver(db),
    createIntrospector: (k) => new SqliteIntrospector(k),
    createQueryCompiler: () => new SqliteQueryCompiler(),
  };
}

/**
 * A Kysely instance over `ctx.db` (or over the `tx` of `db.transaction`, or
 * an action's `ctx.db`). `DB` is the `Tables` type of `.renox/types/db.d.ts`.
 */
export function kysely<DB>(ctx: { readonly db: Db | DbStatements }): Kysely<DB> {
  return new Kysely<DB>({ dialect: renoxDialect(ctx.db) });
}
