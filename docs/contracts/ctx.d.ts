// TypeScript view of docs/contracts/ops.md, contract version 1.3.0.
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
  | "RENOX_SECRETS_CONSUMED"
  | ModuleErrorCode;

/** Codes of the module broker (section 15, 1.3.0). */
export type ModuleErrorCode = "RENOX_MODULE_UNDECLARED" | "RENOX_MODULE_SERVICE" | "RENOX_EVENT_PAYLOAD";

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
  | "RENOX_RENDER_LIMIT"
  /** 1.4.0: a lazy route module failed its first evaluation (ops.md section 11). */
  | "RENOX_MODULE_EVAL";

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

// Modules (section 15, 1.3.0)
/** A service call, hook run, or event emit the caller's manifest does not allow (15.2–15.4). */
export declare class ModuleUndeclaredError extends RenoxError {
  readonly code: "RENOX_MODULE_UNDECLARED";
  readonly details: { readonly module: string; readonly target: string };
}
/**
 * A service, hook filler, or in-memory event handler of another module threw
 * (15.2). `module` names the callee; `service` the service, or null for a hook
 * filler or event handler (then `details.hook` or `details.event` names it).
 * The enclosing transaction has been rolled back.
 */
export declare class ModuleServiceError extends RenoxError {
  readonly code: "RENOX_MODULE_SERVICE";
  readonly module: string;
  readonly service: string | null;
  readonly details: {
    readonly module: string;
    readonly service?: string;
    readonly hook?: string;
    readonly event?: string;
    readonly cause_code: string | null;
  };
}
export type EventPayloadReason = "schema" | "not_json" | "too_large";
/** `ctx.events.emit` got a payload its exported schema refuses (15.4). The payload is never in the error. */
export declare class EventPayloadError extends RenoxError {
  readonly code: "RENOX_EVENT_PAYLOAD";
  readonly details: { readonly event: string; readonly reason: EventPayloadReason };
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
   * when it throws. Rust also rolls back if the request ends first. Called
   * while a transaction is current (a service called from an action), it is a
   * savepoint instead (section 1, "Savepoints", 1.3.0).
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
  /** The module this ctx is bound to (section 15.1, 1.3.0); "app" for the app. */
  readonly module: string;
  /** The module's resolved `[config]` (section 15.5); `{}` for the app. */
  readonly config: ModuleConfig;
  /** Service proxies of the installed modules, as `renox:modules` (section 15.2). */
  readonly services: Services;
  readonly events: Events;
  readonly hooks: Hooks;
  /** Argon2id off the isolate thread (section 16). */
  readonly password: Password;
  // Reserved (section 8): render, webhook, kv (F2); authz, realtime (F5);
  // datasource (F6–F7); ai, domains (F7); offload. `auth` is a service of the
  // `auth` module, not a ctx field. Pages get more fields (section 14, below).
}

// ---------------------------------------------------------------------------
// Modules (section 15, 1.3.0). Untyped here: `renox:modules` types generated
// from the installed manifests narrow these (#236).
// ---------------------------------------------------------------------------

export type ConfigValue = string | number | boolean;
export type ModuleConfig = Readonly<Record<string, ConfigValue>>;

/** One service as the caller sees it: the broker supplies the callee's ctx. */
export type ServiceFunction = (...args: readonly unknown[]) => Promise<unknown>;
export type ModuleServices = Readonly<Record<string, ServiceFunction>>;
/** Installed module name → its exported services. */
export type Services = Readonly<Record<string, ModuleServices>>;

export interface EmitOptions {
  /** Default true: into `renox__outbox` in the current transaction. false: handlers run now, in this request. */
  durable?: boolean;
}

export interface Events {
  /** Resolves with the event id (a ULID). Only events the module exports (section 15.4). */
  emit(name: string, payload: Readonly<Record<string, unknown>>, options?: EmitOptions): Promise<string>;
}

export type HookRunResult = { readonly halt: false } | { readonly halt: true; readonly response: Response; readonly module: string };

export interface Hooks {
  /** Runs the fillers of a hook point this module exports, in priority order (section 15.3). */
  run(name: string, args?: unknown): Promise<HookRunResult>;
}

export interface Password {
  /** A PHC string `$argon2id$v=19$m=65536,t=3,p=1$<salt>$<hash>`. */
  hash(password: string): Promise<string>;
  /** Constant-time; false for a malformed hash or one above the platform's parameters. */
  verify(password: string, hash: string): Promise<boolean>;
}

/** What a module's `services.ts` exports: each service gets the callee's ctx first. */
export type ServiceImplementation = (ctx: Ctx, ...args: never[]) => unknown;
export type ServicesModule = Readonly<Record<string, ServiceImplementation>>;

/** A filler continues with `undefined`, or stops the run with a response. */
export type HookFillerResult = void | { readonly halt: true; readonly response: Response };

export interface HookFiller {
  /** 0–1000, default 100; lower runs first, ties by module name. */
  readonly priority?: number;
  handle(ctx: Ctx, args: never): HookFillerResult | Promise<HookFillerResult>;
}

/** The event as a handler receives it (section 15.4). */
export interface EventInfo {
  readonly id: string;
  readonly name: string;
  readonly attempt: number;
}
export interface DeliveredEvent<P = unknown> extends EventInfo {
  readonly payload: P;
}

/**
 * The ctx of an event handler: the module's ctx without the request. A
 * durable delivery's `db` is its own transaction; an in-memory handler's runs
 * in the emitter's current transaction.
 */
export interface EventContext extends Omit<Ctx, "req" | "url" | "params" | "headers" | "db"> {
  readonly db: DbStatements;
  readonly event: EventInfo;
}

export type EventHandler = (ctx: EventContext, e: DeliveredEvent<never>) => void | Promise<void>;

/** What a module's `hooks.ts` exports. */
export interface HooksModule {
  hooks?: Readonly<Record<string, HookFiller>>;
  on?: Readonly<Record<string, EventHandler>>;
}

/** Cell → bootstrap, one delivery attempt (ops.schema.json `$defs/eventEnvelope`). */
export interface EventEnvelope {
  kind: "event";
  id: string;
  name: string;
  payload: JsonValue;
  attempt: number;
  module: string;
}

/** Bootstrap → cell (ops.schema.json `$defs/eventResult`). */
export type EventResult = { type: "ok" } | { type: "failed"; reason: "threw" | "no_handler" };

/** One module as the bootstrap's init receives it (ops.schema.json `$defs/moduleInfo`). */
export interface ModuleInfo {
  name: string;
  isolation: "shared" | "isolate";
  dependencies: string[];
  config: Record<string, ConfigValue>;
  permissions: { tables?: string; network: string[]; secrets: string[]; slots: string[]; hooks: string[] };
  exports: {
    services?: string[];
    events?: Record<string, Record<string, unknown>>;
    hooks?: string[];
    views?: string[];
  };
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

export type TextDirection = "ltr" | "rtl";

/**
 * A BCP 47 tag as `setLocale` accepts it (ops.md section 14, "Locale";
 * `ops.schema.json` `$defs/locale`): `ar`, `ar-AE`, and from 1.4.0 one `-u-`
 * extension with `ca` (calendar) and `nu` (digits), e.g. `ar-AE-u-nu-arab`.
 */
export type LocaleTag = string;

export interface LoaderContext extends Ctx {
  /** The fragment the cell will render for this request, or null for the full page. */
  readonly fragment: string | null;
  readonly session: Session;
  /**
   * Sets the page's locale and direction (section 14, "Locale", 1.3.0); `dir`
   * defaults from the language subtag. From 1.4.0 the tag may carry one `-u-`
   * extension with `ca` and `nu` (`"ar-AE-u-nu-arab"`); anything else throws a
   * `RangeError`.
   */
  setLocale(locale: LocaleTag, dir?: TextDirection): void;
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
  /** As for the loader. */
  setLocale(locale: LocaleTag, dir?: TextDirection): void;
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
  /** 1.3.0: the installed module whose page it is; absent for the app's pages. */
  module?: string;
}

/** Bootstrap → Rust (ops.schema.json `$defs/pageResult`). */
export type PageResult =
  | { type: "response" }
  | { type: "render"; data_json: string; fragments: string[]; locale?: string; dir?: TextDirection }
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
export type SavepointHandle = number;

export interface FetchRequest {
  method: string;
  url: string;
  headers: [string, string][];
  body: Uint8Array | null;
  redirect: "follow" | "manual" | "error";
  /** 1.3.0: whose allowlist applies; null or absent = the app. */
  module?: string | null;
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
  op_db_query(sql: string, params: Param[], tx: TxHandle | null, module?: string | null): Promise<Row[]>;
  op_db_query_one(sql: string, params: Param[], tx: TxHandle | null, module?: string | null): Promise<Row | null>;
  op_db_execute(sql: string, params: Param[], tx: TxHandle | null, module?: string | null): Promise<ExecuteResult>;
  op_db_tx_begin(mode: "deferred" | "immediate"): Promise<TxHandle>;
  op_db_tx_commit(tx: TxHandle): Promise<void>;
  op_db_tx_rollback(tx: TxHandle): Promise<void>;
  op_db_savepoint_begin(tx: TxHandle): Promise<SavepointHandle>;
  op_db_savepoint_release(tx: TxHandle, sp: SavepointHandle): Promise<void>;
  op_db_savepoint_rollback(tx: TxHandle, sp: SavepointHandle): Promise<void>;

  op_fetch(request: FetchRequest): Promise<FetchResponseHead>;
  op_fetch_body_read(body: number): Promise<Uint8Array | null>;
  op_fetch_body_close(body: number): Promise<void>;

  op_secrets_get_all(module?: string | null): Secrets;

  op_log(level: LogLevel, message: string, fields: LogFields | null, module?: string | null): void;

  op_events_emit(name: string, payloadJson: string, durable: boolean, module: string | null, tx: TxHandle | null): Promise<string>;

  op_password_hash(password: string): Promise<string>;
  op_password_verify(password: string, hash: string): Promise<boolean>;

  op_deadline_remaining_ms(): number;
}
