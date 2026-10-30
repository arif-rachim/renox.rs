// The request context and handler shape (docs/contracts/ops.md sections 2-6,
// 8, 15 to 20). Types identical to docs/contracts/ctx.d.ts; tests/contract.test-d.ts
// enforces it.

import type { Db, DbStatements } from "./db.ts";
import type { Session } from "./pages.ts";

/** Standard `fetch`; the allowlist and blocked ranges are enforced in Rust. */
export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Frozen; contains only declared and set secrets. Not available at module top level. */
export type Secrets = Readonly<Record<string, string>>;

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

export interface Deadline {
  /** Whole milliseconds of wall-clock time left for this request, >= 0. */
  remainingMs(): number;
}

/** Route parameters: `[id]` → string, `[...slug]` → string[]. */
export type Params = Record<string, string | string[]>;

/** Frozen and new for every request. */
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
  /** The module this ctx is bound to (ops.md section 15.1); "app" for the app. */
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
  // Reserved (ops.md section 8): see README.md.
}

// Authorization (ops.md section 17). The runtime glue is #279; `guard`,
// `renox check` and the typed `authz` surface are #283.

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
 * handler. Frozen; the same object in every module's ctx of the request.
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
 * sse module: evaluated by the cell before the module is evaluated and
 * before any handler runs, and on every fragment request. `resource.id` is
 * a literal or `":<param>"`, a route parameter.
 */
export interface Guard {
  readonly action: string;
  readonly resource?: { readonly type: string; readonly id: string };
}

// Realtime (ops.md section 18). The typed `ws` / `sse` helpers are #284.

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

// App MCP tools (ops.md section 19). The `tool()` builder is #284.

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

// Jobs (ops.md section 20; implemented in F6, #297).

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

// Modules (ops.md section 15). Untyped here: the generated `renox:modules`
// types narrow these.

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


export type Handler = (ctx: Ctx) => Response | Promise<Response>;

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";

/** Shape of a `functions/**\/*.ts` module: one optional export per method. */
export type FunctionModule = Partial<Record<HttpMethod, Handler>>;

/**
 * Optional sugar: types a set of handlers in one place and returns it unchanged.
 *
 * ```ts
 * export const { GET, POST } = defineHandlers({ GET: () => Response.json([]), POST: async ({ req }) => ... });
 * ```
 */
export function defineHandlers<const M extends FunctionModule>(handlers: M): M {
  return handlers;
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

// ---------------------------------------------------------------------------
// Webhooks (section 22, 1.7.0)
// ---------------------------------------------------------------------------

export type WebhookProvider = "stripe" | "checkout" | "telr" | "paytabs" | "ngenius" | "tabby" | "tamara" | "apple" | "google" | "generic";
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

// ---------------------------------------------------------------------------
// PDF (section 24, 1.7.0)
// ---------------------------------------------------------------------------

export interface PdfOptions {
  readonly page?: "A4" | "Letter" | "A5";
  readonly orientation?: "portrait" | "landscape";
  readonly marginMm?: number;
}
export interface Pdf {
  /** Renders `template` (a page or partial of the caller) with `data` and converts it to PDF in Rust. */
  render(template: string, data: Readonly<Record<string, unknown>>, options?: PdfOptions): Promise<Uint8Array>;
}
