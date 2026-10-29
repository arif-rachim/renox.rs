// TypeScript view of docs/contracts/ops.md, contract version 1.2.0.
// Plain declarations, no implementation: the SDK package (#31) implements and
// re-exports these types. Section numbers refer to ops.md.

// ---------------------------------------------------------------------------
// Errors (ops.md section 13, "Error codes"; HTTP status and tenant guidance in
// docs/contracts/errors.md). validate.ts checks that the codes below are
// exactly the codes of ops.md section 13 and that each is in errors.md.
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

/** Codes an op rejects with inside tenant code ("thrown" in ops.md section 13). */
export type RenoxErrorCode =
  | DbErrorCode
  | FetchErrorCode
  | "RENOX_DEADLINE"
  | "RENOX_NO_REQUEST"
  | "RENOX_SECRETS_CONSUMED";

/**
 * Codes the platform answers with when a request ends ("response" in ops.md
 * section 13). They never reach tenant code as exceptions; clients see them in
 * the error body of errors.md: `{ error: { code, request_id, message } }`.
 */
export type ResponseErrorCode =
  | "RENOX_DEADLINE"
  | "RENOX_CPU_LIMIT"
  | "RENOX_OOM"
  | "RENOX_BUSY"
  | "RENOX_INTERNAL"
  | "RENOX_BODY_TOO_LARGE"
  | "RENOX_CSRF"
  | "RENOX_RENDER_LIMIT";

/** Body of a platform error response on an API route (errors.md, "Response body"). */
export interface ErrorResponseBody {
  error: {
    code: ResponseErrorCode;
    request_id: string;
    message: string;
  };
}

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

/** Frozen; contains only declared and set secrets. Not available at module top level. */
export type Secrets = Readonly<Record<string, string>>;

// ---------------------------------------------------------------------------
// Logging (section 4)
// ---------------------------------------------------------------------------

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, JsonValue>;

/**
 * Never throws; lines over the tenant's rate limit are dropped and counted.
 * Field values outside JsonValue (bigint, Uint8Array, Error, cycles) are
 * converted by the bootstrap as in ops.md section 12.
 */
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
// Request envelope and handlers (section 6). The ctx object is frozen and new
// for every request (section 11).
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
  // Reserved (section 8): render, webhook, kv (F2); auth, session data,
  // config, events, hooks (F4); authz, realtime (F5); datasource (F6–F7);
  // ai, domains (F7); offload. Pages get more fields (section 14, below).
}

export type Handler = (ctx: Ctx) => Response | Promise<Response>;

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";

/** Shape of a `functions/**\/*.ts` module: one optional export per method. */
export type FunctionModule = Partial<Record<HttpMethod, Handler>>;

// ---------------------------------------------------------------------------
// Pages (section 14): pages/**/*.ts modules export `load` and `actions`.
// ---------------------------------------------------------------------------

/** The session of the request; F2 carries only the id (section 14, "Session"). */
export interface Session {
  /** Opaque random id, 22 base64url characters, from the signed `__Host-renox_sid` cookie. */
  readonly id: string;
}

export interface LoaderContext extends Ctx {
  /** The fragment the cell will render for this request, or null for the full page. */
  readonly fragment: string | null;
  readonly session: Session;
}

/** The template data a loader returns: a plain object (section 14, "Loader"). */
export type PageData = Record<string, unknown>;

export type Loader = (ctx: LoaderContext) => PageData | Response | Promise<PageData | Response>;

export interface ActionContext extends Omit<Ctx, "db"> {
  /** The action's own IMMEDIATE transaction: committed when the action resolves, rolled back when it throws. */
  readonly db: DbStatements;
  /** The action name from `?/<name>`, or "default". */
  readonly action: string;
  /** The parsed form body (urlencoded or multipart); empty for other content types. CSRF is checked before. */
  readonly form: FormData;
  readonly fragment: string | null;
  readonly session: Session;
}

/**
 * A `Response` is sent as is. An object (or nothing) re-runs `load` and is
 * merged over its result as template data; `fragments` names the extra
 * fragments rendered out of band.
 */
export type ActionResult = Response | (PageData & { fragments?: readonly string[] }) | void;

export type Action = (ctx: ActionContext) => ActionResult | Promise<ActionResult>;

/** Shape of a `pages/**\/*.ts` module. */
export interface PageModule {
  load?: Loader;
  actions?: Readonly<Record<string, Action>>;
}

/** Rust → bootstrap, one page invocation (ops.schema.json `$defs/pageInvocation`). */
export interface PageInvocation {
  route: string;
  phase: "load" | "action";
  action: string | null;
  fragment: string | null;
  params: Params;
  session: { id: string };
}

/** Bootstrap → Rust (ops.schema.json `$defs/pageResult`). */
export type PageResult =
  | { type: "response" }
  | { type: "render"; data_json: string; fragments: string[] }
  | { type: "internal"; reason: PageInternalReason };

export type PageInternalReason =
  | "threw"
  | "load_result"
  | "action_result"
  | "data_not_serialisable"
  | "data_too_large"
  | "no_template";

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
