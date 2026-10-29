// ctx.db (docs/contracts/ops.md section 1). Types only; the runtime glue in
// crates/renox-runtime implements them over op_db_*.

/** Values accepted as `?` parameters. `boolean` binds as 1/0. */
export type Param = null | number | bigint | string | Uint8Array | boolean;

/** Values returned in rows. INTEGER beyond ±(2^53 − 1) comes back as `bigint`. */
export type Value = null | number | bigint | string | Uint8Array;

/** One result row, keyed by column name, in column order. */
export type Row = Record<string, Value>;

export interface ExecuteResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

/** Statements available both on `ctx.db` and inside `db.transaction`. */
export interface DbStatements {
  query<T extends Row = Row>(sql: string, params?: readonly Param[]): Promise<T[]>;
  queryOne<T extends Row = Row>(sql: string, params?: readonly Param[]): Promise<T | null>;
  execute(sql: string, params?: readonly Param[]): Promise<ExecuteResult>;
}

/** The scope of `db.scoped()` (ops.md section 17): the values the owner predicates of owned tables are bound to. */
export interface Scope {
  readonly user_id?: string;
  readonly org_id?: string;
  readonly session_id?: string;
}

export interface Db extends DbStatements {
  /**
   * Runs `fn` in an IMMEDIATE transaction: commit when it resolves, rollback
   * when it throws. Rust also rolls back if the request ends first.
   */
  transaction<T>(fn: (tx: DbStatements) => Promise<T>): Promise<T>;
  /**
   * A `Db` whose statements carry `scope` (ops.md section 17, "db.scoped()"):
   * owned tables get their owner predicate, an INSERT must set the owner
   * column to the scope's value, and a statement the rewriter cannot prove is
   * refused with `RENOX_DB_SCOPE`.
   */
  scoped(scope: Scope): Db;
}
