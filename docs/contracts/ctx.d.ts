// TypeScript view of docs/contracts/ops.md, contract version 0.
// Plain declarations, no implementation: the SDK package (#31) implements and
// re-exports these types. Section numbers refer to ops.md.

// ---------------------------------------------------------------------------
// Errors (ops.md section 0 and the "Errors" table of each section)
// ---------------------------------------------------------------------------

export type DbErrorCode =
  | "RENOX_DB_AUTH"
  | "RENOX_DB_BUSY"
  | "RENOX_DB_TIMEOUT"
  | "RENOX_DB_QUOTA"
  | "RENOX_DB_CONSTRAINT"
  | "RENOX_DB_SQL"
  | "RENOX_DB_PARAM"
  | "RENOX_DB_COLUMN_NAME"
  | "RENOX_DB_MULTI_STATEMENT"
  | "RENOX_DB_RESULT_LIMIT"
  | "RENOX_DB_TX_STATE";

export type FetchErrorCode = "RENOX_FETCH_BLOCKED" | "RENOX_FETCH_FAILED" | "RENOX_FETCH_EGRESS_LIMIT";

export type RenoxErrorCode =
  | DbErrorCode
  | FetchErrorCode
  | "RENOX_DEADLINE"
  | "RENOX_NO_REQUEST"
  | "RENOX_SECRETS_CONSUMED";

export declare class RenoxError extends Error {
  readonly code: RenoxErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;
}

// Database (section 1)
export declare class DbPermissionError extends RenoxError {
  readonly code: "RENOX_DB_AUTH";
  readonly details: { readonly table: string; readonly action: string };
}
export declare class DbBusyError extends RenoxError {
  readonly code: "RENOX_DB_BUSY";
}
export declare class DbTimeoutError extends RenoxError {
  readonly code: "RENOX_DB_TIMEOUT";
}
export declare class DbQuotaError extends RenoxError {
  readonly code: "RENOX_DB_QUOTA";
}
export declare class DbConstraintError extends RenoxError {
  readonly code: "RENOX_DB_CONSTRAINT";
  readonly details: { readonly kind: "unique" | "foreign_key" | "not_null" | "check" | "primary_key" };
}
export declare class DbSqlError extends RenoxError {
  readonly code: "RENOX_DB_SQL";
}
export declare class DbUsageError extends RenoxError {
  readonly code:
    | "RENOX_DB_PARAM"
    | "RENOX_DB_COLUMN_NAME"
    | "RENOX_DB_MULTI_STATEMENT"
    | "RENOX_DB_RESULT_LIMIT"
    | "RENOX_DB_TX_STATE";
}

// Fetch (section 2)
export type FetchBlockedReason =
  | "not_allowlisted"
  | "scheme"
  | "port"
  | "blocked_address"
  | "redirect_limit"
  | "method";
export type FetchFailedReason = "dns" | "connect" | "tls" | "reset" | "redirect" | "concurrency" | "headers";

export declare class FetchBlockedError extends RenoxError {
  readonly code: "RENOX_FETCH_BLOCKED";
  readonly details: { readonly host: string; readonly reason: FetchBlockedReason };
}
export declare class FetchError extends RenoxError {
  readonly code: "RENOX_FETCH_FAILED";
  readonly details: { readonly host: string; readonly reason: FetchFailedReason };
}
export declare class FetchEgressLimitError extends RenoxError {
  readonly code: "RENOX_FETCH_EGRESS_LIMIT";
  readonly details: { readonly host: string; readonly limitBytes: number };
}

// Deadline (section 5)
export declare class DeadlineError extends RenoxError {
  readonly code: "RENOX_DEADLINE";
}

// ---------------------------------------------------------------------------
// Database (section 1)
// ---------------------------------------------------------------------------

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

export interface Db extends DbStatements {
  /**
   * Runs `fn` in an IMMEDIATE transaction: commit when it resolves, rollback
   * when it throws. Rust also rolls back if the request ends first.
   */
  transaction<T>(fn: (tx: DbStatements) => Promise<T>): Promise<T>;
}

// ---------------------------------------------------------------------------
// Fetch (section 2): the standard signature; the allowlist and blocked ranges
// are enforced in Rust and surface as the Fetch* errors above.
// ---------------------------------------------------------------------------

export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

// ---------------------------------------------------------------------------
// Secrets (section 3)
// ---------------------------------------------------------------------------

/** Frozen; contains only declared and set secrets. */
export type Secrets = Readonly<Record<string, string>>;

// ---------------------------------------------------------------------------
// Logging (section 4)
// ---------------------------------------------------------------------------

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, JsonValue>;

/** Never throws; lines over the tenant's rate limit are dropped and counted. */
export interface Log {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

// ---------------------------------------------------------------------------
// Deadline (section 5)
// ---------------------------------------------------------------------------

export interface Deadline {
  /** Whole milliseconds of wall-clock time left for this request, >= 0. */
  remainingMs(): number;
}

// ---------------------------------------------------------------------------
// Request envelope and handlers (section 6)
// ---------------------------------------------------------------------------

export type Params = Record<string, string | string[]>;

export interface Ctx {
  readonly req: Request;
  readonly url: URL;
  readonly params: Params;
  readonly headers: Headers;
  readonly db: Db;
  readonly fetch: Fetch;
  readonly secrets: Secrets;
  readonly log: Log;
  readonly deadline: Deadline;
  // Reserved (section 8), not available in F1:
  // form, render, webhook, kv (F2); auth, session, config, events, hooks (F4);
  // authz, realtime (F5); datasource (F6–F7); ai, domains (F7); offload.
}

export type Handler = (ctx: Ctx) => Response | Promise<Response>;

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";

/** Shape of a `functions/**\/*.ts` module: one optional export per method. */
export type FunctionModule = Partial<Record<HttpMethod, Handler>>;

// ---------------------------------------------------------------------------
// Ops as the SDK sees them (sections 1–5). Not visible to tenant code.
// ---------------------------------------------------------------------------

export type TxHandle = number;

export interface FetchRequest {
  method: string;
  url: string;
  headers: [string, string][];
  body: Uint8Array | null;
  redirect: "follow" | "manual" | "error";
}

export interface FetchResponseHead {
  status: number;
  statusText: string;
  headers: [string, string][];
  url: string;
  redirected: boolean;
  body: number | null;
}

export interface Ops {
  op_db_query(sql: string, params: Param[], tx: TxHandle | null): Promise<Row[]>;
  op_db_query_one(sql: string, params: Param[], tx: TxHandle | null): Promise<Row | null>;
  op_db_execute(sql: string, params: Param[], tx: TxHandle | null): Promise<ExecuteResult>;
  op_db_tx_begin(mode: "deferred" | "immediate"): Promise<TxHandle>;
  op_db_tx_commit(tx: TxHandle): Promise<void>;
  op_db_tx_rollback(tx: TxHandle): Promise<void>;

  op_fetch(request: FetchRequest): Promise<FetchResponseHead>;
  op_fetch_body_read(body: number): Promise<Uint8Array | null>;
  op_fetch_body_close(body: number): Promise<void>;

  op_secrets_get_all(): Secrets;

  op_log(level: LogLevel, message: string, fields: LogFields | null): void;

  op_deadline_remaining_ms(): number;
}
