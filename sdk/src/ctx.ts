// The request context and handler shape (docs/contracts/ops.md sections 2-6
// and 8). Types identical to docs/contracts/ctx.d.ts; tests/contract.test-d.ts
// enforces it.

import type { Db } from "./db.ts";

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
  // Reserved (ops.md section 8), not available in F1: see README.md.
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
