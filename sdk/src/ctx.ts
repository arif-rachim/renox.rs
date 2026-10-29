// The request context and handler shape (docs/contracts/ops.md sections 2-6,
// 8, 15 and 16). Types identical to docs/contracts/ctx.d.ts; tests/contract.test-d.ts
// enforces it.

import type { Db, DbStatements } from "./db.ts";

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
  // Reserved (ops.md section 8): see README.md.
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
