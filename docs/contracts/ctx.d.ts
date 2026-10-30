// TypeScript view of docs/contracts/ops.md, contract version 1.7.0.
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
  | "RENOX_DB_TX_STATE"
  /** 1.5.0: an owned table without a scope, or a statement the rewriter cannot prove (section 17). */
  | "RENOX_DB_SCOPE";

export type FetchErrorCode = "RENOX_FETCH_BLOCKED" | "RENOX_FETCH_FAILED" | "RENOX_FETCH_EGRESS_LIMIT";

/** Codes an op rejects with inside tenant code ("thrown" in ops.md section 13). */
export type RenoxErrorCode =
  | DbErrorCode
  | FetchErrorCode
  | "RENOX_DEADLINE"
  | "RENOX_NO_REQUEST"
  | "RENOX_SECRETS_CONSUMED"
  | ModuleErrorCode
  | AuthzErrorCode
  | RealtimeErrorCode
  | JobErrorCode
  | StorageErrorCode
  | AiErrorCode
  | "RENOX_PDF_LIMIT";

/** Codes of the module broker (section 15, 1.3.0). */
export type ModuleErrorCode = "RENOX_MODULE_UNDECLARED" | "RENOX_MODULE_SERVICE" | "RENOX_EVENT_PAYLOAD";

/** 1.5.0: a policy denied (section 17); thrown by `authz.require` and `realtime.subscribe`, answered by a `guard`. */
export type AuthzErrorCode = "RENOX_FORBIDDEN";

/** 1.5.0: the realtime limits (section 18); thrown by the realtime ops, and the reason of a platform close. */
export type RealtimeErrorCode = "RENOX_REALTIME_LIMIT" | "RENOX_REALTIME_BACKPRESSURE";

/** 1.6.0: `op_jobs_retry` and `op_jobs_cancel` (section 20). */
export type JobErrorCode = "RENOX_JOB_NOT_FOUND" | "RENOX_JOB_STATE";

/** 1.5.0: `/mcp` refusals before a tool runs (section 19), as JSON-RPC errors. */
export type ToolErrorCode = "RENOX_TOOL_INPUT" | "RENOX_TOOL_SCOPE" | "RENOX_TOOL_CONFIRM";

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
  | "RENOX_MODULE_EVAL"
  | AuthzErrorCode
  | RealtimeErrorCode
  | ToolErrorCode
  /** 1.7.0: the tenant's image transform rate (section 21). */
  | "RENOX_IMAGE_RATE"
  /** 1.7.0: a webhook's signature does not hold (section 22). */
  | "RENOX_WEBHOOK_SIGNATURE";

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
export type DbScopeReason = "unscoped" | "scope_missing" | "owner_mismatch" | "unprovable";
/** 1.5.0 (section 17, "db.scoped()"): module code reached an owned table without a scope, or the rewriter refused the statement. */
export declare class DbScopeError extends RenoxError {
  readonly code: "RENOX_DB_SCOPE";
  readonly details: { readonly table: string; readonly module: string; readonly reason: DbScopeReason };
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

// Jobs (section 20, 1.6.0)
export type JobOp = "retry" | "cancel";
/** `op_jobs_retry` / `op_jobs_cancel` for an id that is not a job row of this tenant. */
export declare class JobNotFoundError extends RenoxError {
  readonly code: "RENOX_JOB_NOT_FOUND";
  readonly details: { readonly id: string };
}
/** Retry on a row that is not dead, or cancel on a running row. */
export declare class JobStateError extends RenoxError {
  readonly code: "RENOX_JOB_STATE";
  readonly details: { readonly id: string; readonly state: JobState; readonly op: JobOp };
}

// Authorization (section 17, 1.5.0)
export type ForbiddenReason = "deny" | "unknown_action" | "missing_attribute" | "evaluation_error" | "eval_limit" | "dev_only";
/**
 * A policy denied the action (section 17). Uncaught, it ends the request
 * with 403 `RENOX_FORBIDDEN`, not 500. `policy` names the deciding policy in
 * dev mode only.
 */
export declare class ForbiddenError extends RenoxError {
  readonly code: "RENOX_FORBIDDEN";
  readonly details: {
    readonly action: string;
    readonly resource: { readonly type: string; readonly id: string } | null;
    readonly reason: ForbiddenReason;
    readonly policy: string | null;
  };
}

// Realtime (section 18, 1.5.0)
export type RealtimeLimitReason = "tenant" | "user" | "topics" | "message_size" | "flood";
export declare class RealtimeLimitError extends RenoxError {
  readonly code: "RENOX_REALTIME_LIMIT";
  readonly details: { readonly reason: RealtimeLimitReason };
}
/** The connection's outbound queue was full: it has been closed with 1008 (section 18, "Limits"). */
export declare class RealtimeBackpressureError extends RenoxError {
  readonly code: "RENOX_REALTIME_BACKPRESSURE";
  readonly details: { readonly conn: string };
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

/** The scope of `db.scoped()` (section 17): the values the owner predicates of owned tables are bound to. */
export interface Scope {
  readonly user_id?: string;
  readonly org_id?: string;
  readonly session_id?: string;
}

export interface Db extends DbStatements {
  /**
   * Runs `fn` in an IMMEDIATE transaction: commit when it resolves, rollback
   * when it throws. Rust also rolls back if the request ends first. Called
   * while a transaction is current (a service called from an action), it is a
   * savepoint instead (section 1, "Savepoints", 1.3.0).
   */
  transaction<T>(fn: (tx: DbStatements) => Promise<T>): Promise<T>;
  /**
   * A `Db` whose statements carry `scope` (section 1, "Scoped statements";
   * section 17, "db.scoped()", 1.5.0): owned tables get their owner
   * predicate, an INSERT must set the owner column to the scope's value, and
   * a statement the rewriter cannot prove is refused with `RENOX_DB_SCOPE`.
   */
  scoped(scope: Scope): Db;
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
  /** The request's principal (section 17, 1.5.0); null is the anonymous principal. */
  readonly principal: Principal | null;
  /** Cedar decisions and role assignments (section 17, 1.5.0). */
  readonly authz: Authz;
  /** Topics, connections and payloads (section 18, 1.5.0); `publish` works from any handler. */
  readonly realtime: Realtime;
  /** Queued jobs (section 20, 1.5.0). */
  readonly jobs: Jobs;
  /** Files of the caller under the tenant's prefix (section 21, 1.7.0). */
  readonly storage: Storage;
  /** Model calls, direct or through the platform gateway (section 23, 1.7.0). */
  readonly ai: Ai;
  /** Templates to PDF in Rust (section 24, 1.7.0). */
  readonly pdf: Pdf;
  /**
   * Renders `template` (a page or partial of the caller; for a module, relative to its own tree)
   * with `data` to an HTML string, as a fragment: no layout (section 25, 1.8.0).
   */
  render(template: string, data: Readonly<Record<string, unknown>>): Promise<string>;
  // Reserved (section 8): kv (F2); datasource (F6–F7); domains (F7);
  // offload. `webhook` is on WebhookContext (section 22). `auth` is a service of the `auth` module, not a
  // ctx field. Pages get more fields (section 14, below).
}

// ---------------------------------------------------------------------------
// Authorization (section 17, 1.5.0)
// ---------------------------------------------------------------------------

/** One row of `renox__role_assignments` as the principal carries it. */
export interface PrincipalRole {
  readonly role: string;
  /** "global", or the `attrs` key the assignment is scoped on ("org"). */
  readonly scope_type: string;
  readonly scope_id: string | null;
}

/**
 * The end user as the cell resolved it through the `auth` module's
 * `auth.principal` service, or the System principal of a job or event
 * handler (section 17, "Principal"). Frozen; the same object in every
 * module's ctx of the request.
 */
export interface Principal {
  readonly id: string;
  readonly kind: "user" | "system";
  readonly roles: readonly PrincipalRole[];
  /** What `auth.principal` and its hook fillers added (`mfa_verified`, `org`, ...). */
  readonly attrs: Readonly<Record<string, JsonValue>>;
}

/**
 * A resource as tenant code passes it: `type` is a key of `[authz.entities]`
 * (`"<module>:<Type>"` from the app for a module's type), `id` the entity id;
 * only the declared attributes are kept, so a database row can be passed as it is.
 */
export type ResourceRef = { readonly type: string; readonly id: string } & Readonly<Record<string, unknown>>;

export type AuthzContext = Readonly<Record<string, JsonValue>>;

export interface Decision {
  readonly allow: boolean;
  /** The deciding policy id in dev mode, null otherwise. */
  readonly policy: string | null;
}

export interface Explanation {
  readonly decision: "allow" | "deny";
  readonly reasons: readonly string[];
  readonly errors: readonly string[];
}

export interface RoleScope {
  readonly type: string;
  readonly id: string | null;
}

export interface RoleAssignment {
  readonly user_id: string;
  readonly role: string;
  readonly scope_type: string;
  readonly scope_id: string | null;
  readonly granted_by: string;
  readonly at: number;
}

export interface AuthzRoles {
  /** Writes `renox__role_assignments` in the current transaction and emits `authz.roles_changed`; a module may assign only its approved roles. */
  assign(userId: string, role: string, scope?: RoleScope): Promise<void>;
  /** Resolves true when a row was removed. */
  revoke(userId: string, role: string, scope?: RoleScope): Promise<boolean>;
  list(userId: string): Promise<RoleAssignment[]>;
}

export interface Authz {
  /** Resolves when the policy allows; rejects with `ForbiddenError` otherwise. */
  require(action: string, resource?: ResourceRef, context?: AuthzContext): Promise<void>;
  can(action: string, resource?: ResourceRef, context?: AuthzContext): Promise<boolean>;
  /** One boolean per resource, in order; at most 1,000 resources. */
  canBatch(action: string, resources: readonly ResourceRef[], context?: AuthzContext): Promise<boolean[]>;
  /** Dev mode only; `RENOX_FORBIDDEN` (`reason: "dev_only"`) in production. */
  explain(action: string, resource?: ResourceRef, context?: AuthzContext): Promise<Explanation>;
  readonly roles: AuthzRoles;
}

/**
 * `export const guard = { action, resource? }` of a page, function, ws or
 * sse module (section 17, "guard"): evaluated by the cell before the module
 * is evaluated and before any handler runs, and on every fragment request.
 * `resource.id` is a literal or `":<param>"`, a route parameter.
 */
export interface Guard {
  readonly action: string;
  readonly resource?: { readonly type: string; readonly id: string };
}

// ---------------------------------------------------------------------------
// Realtime (section 18, 1.5.0)
// ---------------------------------------------------------------------------

/** A connection handle; only ws and sse handlers hold one. */
export interface Conn {
  readonly id: string;
  readonly transport: "ws" | "sse";
}

/**
 * A text frame, JSON text, or a partial rendered by the cell off the isolate
 * thread (`fragment` is a partial template id of the caller's module).
 * `event` names the SSE event; it is ignored on a WebSocket.
 */
export type RealtimePayload =
  | string
  | { readonly text: string; readonly event?: string }
  | { readonly json: JsonValue; readonly event?: string }
  | { readonly fragment: string; readonly data: Readonly<Record<string, unknown>>; readonly event?: string };

export interface Realtime {
  /** The Cedar action `realtime.subscribe` on `Renox::Topic`, fail closed: rejects with `ForbiddenError` on a deny. */
  subscribe(conn: Conn, topic: string): Promise<void>;
  unsubscribe(conn: Conn, topic: string): Promise<void>;
  /** Resolves with the number of connections the message was queued for. */
  publish(topic: string, payload: RealtimePayload): Promise<number>;
  /** Rejects with `RealtimeBackpressureError` when the connection's queue is full. */
  send(conn: Conn, payload: RealtimePayload): Promise<void>;
  close(conn: Conn, code?: number, reason?: string): Promise<void>;
}

/** The ctx of `open` and `close`: the upgrade request plus the connection. */
export interface RealtimeContext extends Ctx {
  readonly session: Session;
  readonly conn: Conn;
}
/** The ctx of `message`: one text or binary frame. */
export interface MessageContext extends RealtimeContext {
  readonly data: string | Uint8Array;
}
export interface CloseContext extends RealtimeContext {
  readonly close: { readonly code: number; readonly reason: string | null };
}

/** Shape of a `functions/ws/**\/*.ts` module's `ws` export. */
export interface WsModule {
  open?(ctx: RealtimeContext): void | Promise<void>;
  message?(ctx: MessageContext): void | Promise<void>;
  close?(ctx: CloseContext): void | Promise<void>;
}
/** Shape of a `functions/sse/**\/*.ts` module's `sse` export. */
export interface SseModule {
  open?(ctx: RealtimeContext): void | Promise<void>;
  close?(ctx: CloseContext): void | Promise<void>;
}

// ---------------------------------------------------------------------------
// App MCP tools (section 19, 1.5.0)
// ---------------------------------------------------------------------------

/** The ctx of a tool's `run`: the owning module's ctx without a request, as the token's user. */
export interface ToolContext<I = unknown> extends Omit<Ctx, "req" | "url" | "params" | "headers"> {
  readonly tool: {
    readonly name: string;
    readonly input: I;
    readonly client: { readonly name: string; readonly model?: string };
    /** true on the first call of a `confirm` tool: the run's transaction is rolled back. */
    readonly preview: boolean;
  };
}

/** A schema that validates `arguments` into `I` (the Standard Schema adapter of the SDK). */
export interface ToolInputSchema<I> {
  readonly "~standard": { readonly version: 1; readonly vendor: string; validate(value: unknown): unknown };
  readonly __input?: I;
}

export interface ToolDefinition<I> {
  readonly name: string;
  readonly description: string;
  readonly input: ToolInputSchema<I>;
  /** The Cedar action checked with the token's user before `run`. */
  readonly action: string;
  readonly confirm?: boolean;
  run(ctx: ToolContext<I>): unknown;
}

/** What `tool()` returns and a `functions/tools/*.ts` module default-exports. */
export interface Tool<I = unknown> extends ToolDefinition<I> {
  readonly confirm: boolean;
}

export declare function tool<I>(definition: ToolDefinition<I>): Tool<I>;

// ---------------------------------------------------------------------------
// Jobs (section 20, 1.5.0; implemented in F6)
// ---------------------------------------------------------------------------

export interface EnqueueOptions {
  /** Unix time in milliseconds; absent = as soon as possible. */
  readonly runAt?: number;
}

export interface Jobs {
  /** Writes a queued run of a job of this module in the current transaction; resolves with its id. */
  enqueue(name: string, payload: Readonly<Record<string, unknown>>, options?: EnqueueOptions): Promise<string>;
  /** 1.6.0, module `jobs` only (`RENOX_FORBIDDEN` for any other caller): one page of jobs in a state, never the payload. */
  list(state: JobState, options?: { readonly limit?: number; readonly cursor?: string | null }): Promise<JobPage>;
  /** 1.6.0, module `jobs` only: a dead letter goes back to the queue with its attempts reset. */
  retry(id: string): Promise<void>;
  /** 1.6.0, module `jobs` only: deletes a queued or dead row. */
  cancel(id: string): Promise<void>;
}

export type JobState = "scheduled" | "queued" | "running" | "dead";

/** One job row as the `jobs` module sees it (section 20, 1.6.0). */
export interface JobRow {
  readonly id: string;
  readonly name: string;
  readonly module: string;
  readonly tick: number | null;
  readonly next_at: number | null;
  readonly run_at: number | null;
  readonly attempts: number;
  readonly started_at: number | null;
  readonly finished_at: number | null;
  /** Redacted, at most 512 characters. */
  readonly last_error: string | null;
}

export interface JobPage {
  readonly items: readonly JobRow[];
  readonly next_cursor: string | null;
}

export interface JobInfo<P = unknown> {
  readonly id: string;
  readonly name: string;
  /** The tick the run is for, or the `runAt` of a queued run. */
  readonly tick: number;
  readonly attempt: number;
  /** null for a scheduled run. */
  readonly payload: P | null;
}

/** The ctx of `run`: the module's ctx without the request, with the attempt's transaction and the System principal. */
export interface JobContext<P = unknown> extends Omit<Ctx, "req" | "url" | "params" | "headers" | "db"> {
  readonly db: DbStatements;
  readonly job: JobInfo<P>;
}

/** Shape of a `jobs/*.ts` module. */
export interface JobModule {
  readonly schedule: string;
  readonly tz?: string;
  run(ctx: JobContext<never>): void | Promise<void>;
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
  // `principal` is the System principal of the handling module (section 17, 1.5.0).
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
  /** 1.5.0: the request's principal, already past the page's guard; absent = anonymous. */
  principal?: Principal | null;
}

/** Cell → bootstrap, one handler run of a ws or sse connection (ops.schema.json `$defs/realtimeEnvelope`). */
export interface RealtimeEnvelope {
  kind: "realtime";
  phase: "open" | "message" | "close";
  transport: "ws" | "sse";
  conn: string;
  route: string;
  params: Params;
  session: { id: string };
  principal?: Principal | null;
  module?: string;
  data?: string | Uint8Array;
  close?: { code: number; reason: string | null };
}
export type RealtimeResult = { type: "ok" } | { type: "failed"; reason: "threw" | "no_handler" };

/** Cell → bootstrap, one tool call that passed every check before `run` (ops.schema.json `$defs/toolEnvelope`). */
export interface ToolEnvelope {
  kind: "tool";
  name: string;
  module?: string;
  input: JsonValue;
  principal: Principal;
  client: { name: string; model?: string };
  preview: boolean;
  request_id: string;
}
export type ToolResult = { type: "ok"; output_json: string } | { type: "failed"; reason: "threw" | "output_too_large" };

/** Outbox worker → bootstrap, one job attempt (ops.schema.json `$defs/jobEnvelope`). */
export interface JobEnvelope {
  kind: "job";
  id: string;
  name: string;
  module: string;
  tick: number;
  attempt: number;
  payload: JsonValue;
}
export type JobResult = { type: "ok" } | { type: "failed"; reason: "threw" | "no_handler" };

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

/** A payload as it crosses after the bootstrap serialised it (ops.schema.json `$defs/realtimePayload`). */
export type RealtimeWirePayload =
  | { type: "text"; text: string; event?: string }
  | { type: "json"; json_text: string; event?: string }
  | { type: "render"; template: string; data_json: string; event?: string };

export interface Ops {
  op_db_query(sql: string, params: Param[], tx: TxHandle | null, module?: string | null, scope?: Scope | null): Promise<Row[]>;
  op_db_query_one(sql: string, params: Param[], tx: TxHandle | null, module?: string | null, scope?: Scope | null): Promise<Row | null>;
  op_db_execute(sql: string, params: Param[], tx: TxHandle | null, module?: string | null, scope?: Scope | null): Promise<ExecuteResult>;
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

  // Section 17 (1.5.0). The principal is the request's own, never an argument.
  op_authz_check(action: string, resource: ResourceRef | null, context: AuthzContext | null, module: string | null): Promise<Decision>;
  op_authz_check_batch(action: string, resources: ResourceRef[], context: AuthzContext | null, module: string | null): Promise<boolean[]>;
  op_authz_explain(action: string, resource: ResourceRef | null, context: AuthzContext | null, module: string | null): Promise<Explanation>;
  op_authz_roles_assign(userId: string, role: string, scopeType: string, scopeId: string | null, module: string | null, tx: TxHandle | null): Promise<void>;
  op_authz_roles_revoke(userId: string, role: string, scopeType: string, scopeId: string | null, module: string | null, tx: TxHandle | null): Promise<boolean>;
  op_authz_roles_list(userId: string, module: string | null): Promise<RoleAssignment[]>;

  // Section 18 (1.5.0).
  op_realtime_subscribe(conn: string, topic: string, module: string | null): Promise<void>;
  op_realtime_unsubscribe(conn: string, topic: string): Promise<void>;
  op_realtime_publish(topic: string, payload: RealtimeWirePayload, module: string | null): Promise<number>;
  op_realtime_send(conn: string, payload: RealtimeWirePayload): Promise<void>;
  op_realtime_close(conn: string, code: number, reason: string | null): Promise<void>;

  // Section 20 (1.5.0).
  op_jobs_enqueue(name: string, payloadJson: string, runAt: number | null, module: string | null, tx: TxHandle | null): Promise<string>;
  // Section 20 (1.6.0): callable only by module `jobs`.
  op_jobs_list(state: JobState, limit: number, cursor: string | null, module: string | null): Promise<JobPage>;
  op_jobs_retry(id: string, module: string | null, tx: TxHandle | null): Promise<void>;
  op_jobs_cancel(id: string, module: string | null, tx: TxHandle | null): Promise<void>;

  op_deadline_remaining_ms(): number;
}

// ---------------------------------------------------------------------------
// Storage and images (section 21, 1.7.0)
// ---------------------------------------------------------------------------

/** A file in the platform store under the caller's prefix. */
export interface StoredFile {
  readonly key: string;
  readonly bytes: number;
  readonly content_type: string;
  readonly sha256: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly public: boolean;
  readonly created_at: number;
}
export interface StoragePage {
  readonly items: readonly StoredFile[];
  readonly next_cursor: string | null;
}
export interface StoragePutOptions {
  readonly contentType: string;
  readonly public?: boolean;
  /** Set only by the `storage` module's SVG sanitiser. */
  readonly sanitised?: boolean;
}
export interface Storage {
  put(key: string, bytes: Uint8Array, options: StoragePutOptions): Promise<StoredFile>;
  get(key: string): Promise<StoredFile>;
  read(key: string): Promise<Uint8Array>;
  delete(key: string): Promise<boolean>;
  /** A signed URL on the app's host, `/_files/<key>?exp=&sig=`, valid for 60 s to 7 days. */
  sign(key: string, ttlSeconds: number): Promise<{ readonly url: string; readonly expires_at: number }>;
  list(prefix: string, options?: { readonly limit?: number; readonly cursor?: string | null }): Promise<StoragePage>;
}
export type StorageErrorCode = "RENOX_STORAGE_QUOTA" | "RENOX_STORAGE_TYPE" | "RENOX_STORAGE_TOO_LARGE" | "RENOX_STORAGE_KEY" | "RENOX_STORAGE_NOT_FOUND";
/** One of the storage refusals (section 21). */
export declare class StorageError extends RenoxError {
  readonly code: StorageErrorCode;
}

// ---------------------------------------------------------------------------
// Webhooks (section 22, 1.7.0)
// ---------------------------------------------------------------------------

export type WebhookProvider = "stripe" | "checkout" | "telr" | "paytabs" | "ngenius" | "tabby" | "tamara" | "svix" | "sns" | "apple" | "google" | "generic";
export interface WebhookEvent {
  readonly provider: WebhookProvider;
  readonly event_id: string;
  readonly received_at: number;
  /** The verified payload; for a duplicate the handler does not go on. */
  readonly payload: JsonValue;
  readonly duplicate: boolean;
}
export interface Webhook {
  /** Rejects with 401 `RENOX_WEBHOOK_SIGNATURE` (the handler does not go on) unless the signature holds. */
  verify(req: Request, options: { readonly provider: WebhookProvider } | { readonly secret: string; readonly header: string }): Promise<WebhookEvent>;
}
/** The ctx of a `functions/webhooks/*.ts` `POST`. */
export interface WebhookContext extends Ctx {
  readonly webhook: Webhook;
}

// ---------------------------------------------------------------------------
// AI (section 23, 1.7.0)
// ---------------------------------------------------------------------------

export type AiContent = { readonly type: "text"; readonly text: string } | { readonly type: "tool_use"; readonly id: string; readonly name: string; readonly input: JsonValue } | { readonly type: "tool_result"; readonly tool_use_id: string; readonly content: string };
export interface AiMessage {
  readonly role: "user" | "assistant";
  readonly content: string | readonly AiContent[];
}
export interface AiTool {
  readonly name: string;
  readonly description: string;
  readonly input_schema: JsonValue;
  /** A local tool: run in the isolate with the caller's authorization. */
  readonly run?: (input: JsonValue) => Promise<JsonValue> | JsonValue;
}
export interface AiRequest {
  readonly model?: string;
  readonly system?: string;
  readonly messages: readonly AiMessage[];
  readonly tools?: readonly AiTool[];
  readonly maxTokens?: number;
}
export interface AiResult {
  readonly id: string;
  readonly model: string;
  readonly content: readonly AiContent[];
  readonly stop_reason: string;
  readonly usage: { readonly input_tokens: number; readonly output_tokens: number };
}
export interface Ai {
  chat(request: AiRequest): Promise<AiResult>;
}
export type AiErrorCode = "RENOX_AI_QUOTA" | "RENOX_AI_UNAVAILABLE";
export declare class AiQuotaError extends RenoxError {
  readonly code: "RENOX_AI_QUOTA";
}
export declare class AiUnavailableError extends RenoxError {
  readonly code: "RENOX_AI_UNAVAILABLE";
}

// ---------------------------------------------------------------------------
// PDF (section 24, 1.7.0)
// ---------------------------------------------------------------------------

export interface PdfOptions {
  readonly page?: "A4" | "Letter" | "A5";
  readonly orientation?: "portrait" | "landscape";
  readonly marginMm?: number;
}
export interface Pdf {
  /** Renders `template` (a page or partial of the caller; for a module, relative to its own tree, 1.8.0) with `data` and converts it to PDF in Rust. */
  render(template: string, data: Readonly<Record<string, unknown>>, options?: PdfOptions): Promise<Uint8Array>;
}
export declare class PdfLimitError extends RenoxError {
  readonly code: "RENOX_PDF_LIMIT";
}
