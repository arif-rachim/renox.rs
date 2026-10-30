// Error codes and classes of docs/contracts/ops.md section 13 (contract
// version 1.6.0). tests/errors.test.ts checks the lists below against the
// table in ops.md; tests/contract.test-d.ts checks the types against ctx.d.ts.

import type { JobState } from "./ctx.ts";

/** Codes an op rejects with inside tenant code ("thrown" and "both" in ops.md section 13). */
export const RENOX_ERROR_CODES = [
  "RENOX_DB_AUTH",
  "RENOX_DB_BUSY",
  "RENOX_DB_TIMEOUT",
  "RENOX_DB_QUOTA",
  "RENOX_DB_CONSTRAINT",
  "RENOX_DB_SQL",
  "RENOX_DB_PARAM",
  "RENOX_DB_COLUMN_NAME",
  "RENOX_DB_MULTI_STATEMENT",
  "RENOX_DB_RESULT_LIMIT",
  "RENOX_DB_TX_STATE",
  // ops 1.5.0: an owned table without a scope (section 17).
  "RENOX_DB_SCOPE",
  "RENOX_FETCH_BLOCKED",
  "RENOX_FETCH_FAILED",
  "RENOX_FETCH_EGRESS_LIMIT",
  "RENOX_DEADLINE",
  "RENOX_NO_REQUEST",
  "RENOX_SECRETS_CONSUMED",
  "RENOX_MODULE_UNDECLARED",
  "RENOX_MODULE_SERVICE",
  "RENOX_EVENT_PAYLOAD",
  // ops 1.5.0: a policy denied (section 17); the realtime limits (section 18).
  "RENOX_FORBIDDEN",
  "RENOX_REALTIME_LIMIT",
  "RENOX_REALTIME_BACKPRESSURE",
  // ops 1.6.0: the jobs module's ops (section 20).
  "RENOX_JOB_NOT_FOUND",
  "RENOX_JOB_STATE",
  // ops 1.7.0: storage (section 21), AI (section 23), PDF (section 24).
  "RENOX_STORAGE_QUOTA",
  "RENOX_STORAGE_TYPE",
  "RENOX_STORAGE_TOO_LARGE",
  "RENOX_STORAGE_KEY",
  "RENOX_STORAGE_NOT_FOUND",
  "RENOX_AI_QUOTA",
  "RENOX_AI_UNAVAILABLE",
  "RENOX_PDF_LIMIT",
] as const;

/** Codes the platform answers with when a request ends ("response" and "both"). */
export const RESPONSE_ERROR_CODES = [
  "RENOX_DEADLINE",
  "RENOX_CPU_LIMIT",
  "RENOX_OOM",
  "RENOX_BUSY",
  "RENOX_INTERNAL",
  "RENOX_BODY_TOO_LARGE",
  "RENOX_CSRF",
  "RENOX_RENDER_LIMIT",
  // ops 1.4.0: a lazy route module failed its first evaluation.
  "RENOX_MODULE_EVAL",
  // ops 1.5.0: a guard or the tool check denied; the realtime caps; /mcp refusals (sections 17-19).
  "RENOX_FORBIDDEN",
  "RENOX_REALTIME_LIMIT",
  "RENOX_REALTIME_BACKPRESSURE",
  "RENOX_TOOL_INPUT",
  "RENOX_TOOL_SCOPE",
  "RENOX_TOOL_CONFIRM",
  // ops 1.7.0: the image transform rate (section 21), a refused webhook delivery (section 22).
  "RENOX_IMAGE_RATE",
  "RENOX_WEBHOOK_SIGNATURE",
] as const;

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
  | "RENOX_DB_SCOPE";

export type FetchErrorCode = "RENOX_FETCH_BLOCKED" | "RENOX_FETCH_FAILED" | "RENOX_FETCH_EGRESS_LIMIT";

/** Codes of the module broker (ops.md section 15). */
export type ModuleErrorCode = "RENOX_MODULE_UNDECLARED" | "RENOX_MODULE_SERVICE" | "RENOX_EVENT_PAYLOAD";

/** A policy denied (ops.md section 17): thrown by `authz.require` and `realtime.subscribe`, answered by a `guard`. */
export type AuthzErrorCode = "RENOX_FORBIDDEN";

/** The realtime limits (ops.md section 18): thrown by the realtime ops, and the reason of a platform close. */
export type RealtimeErrorCode = "RENOX_REALTIME_LIMIT" | "RENOX_REALTIME_BACKPRESSURE";

/** `/mcp` refusals before a tool runs (ops.md section 19), as JSON-RPC errors. */
export type ToolErrorCode = "RENOX_TOOL_INPUT" | "RENOX_TOOL_SCOPE" | "RENOX_TOOL_CONFIRM";

export type RenoxErrorCode = (typeof RENOX_ERROR_CODES)[number];

/** Never reaches tenant code as an exception; clients see it in the error body. */
export type ResponseErrorCode = (typeof RESPONSE_ERROR_CODES)[number];

/** Body of a platform error response on an API route (errors.md, "Response body"). */
export interface ErrorResponseBody {
  error: {
    code: ResponseErrorCode;
    request_id: string;
    message: string;
  };
}

export class RenoxError extends Error {
  readonly code: RenoxErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(code: RenoxErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    if (details !== undefined) this.details = Object.freeze({ ...details });
  }
}

/**
 * True for any error carrying a known `RenoxErrorCode`. Prefer it over
 * `instanceof`: an error raised by the platform's runtime glue and the class a
 * tenant bundled are not guaranteed to be the same object.
 */
export function isRenoxError(error: unknown): error is RenoxError {
  if (!(error instanceof Error)) return false;
  const code: unknown = (error as { code?: unknown }).code;
  return typeof code === "string" && (RENOX_ERROR_CODES as readonly string[]).includes(code);
}

// Database (ops.md section 1)
export class DbPermissionError extends RenoxError {
  declare readonly code: "RENOX_DB_AUTH";
  declare readonly details: { readonly table: string; readonly action: string };
  constructor(message: string, details: { table: string; action: string }) {
    super("RENOX_DB_AUTH", message, details);
  }
}
export class DbBusyError extends RenoxError {
  declare readonly code: "RENOX_DB_BUSY";
  constructor(message: string) {
    super("RENOX_DB_BUSY", message);
  }
}
export class DbTimeoutError extends RenoxError {
  declare readonly code: "RENOX_DB_TIMEOUT";
  constructor(message: string) {
    super("RENOX_DB_TIMEOUT", message);
  }
}
export class DbQuotaError extends RenoxError {
  declare readonly code: "RENOX_DB_QUOTA";
  constructor(message: string) {
    super("RENOX_DB_QUOTA", message);
  }
}
export class DbConstraintError extends RenoxError {
  declare readonly code: "RENOX_DB_CONSTRAINT";
  declare readonly details: { readonly kind: "unique" | "foreign_key" | "not_null" | "check" | "primary_key" };
  constructor(message: string, details: { kind: "unique" | "foreign_key" | "not_null" | "check" | "primary_key" }) {
    super("RENOX_DB_CONSTRAINT", message, details);
  }
}
export class DbSqlError extends RenoxError {
  declare readonly code: "RENOX_DB_SQL";
  constructor(message: string) {
    super("RENOX_DB_SQL", message);
  }
}
export type DbUsageErrorCode =
  | "RENOX_DB_PARAM"
  | "RENOX_DB_COLUMN_NAME"
  | "RENOX_DB_MULTI_STATEMENT"
  | "RENOX_DB_RESULT_LIMIT"
  | "RENOX_DB_TX_STATE";
export class DbUsageError extends RenoxError {
  declare readonly code: DbUsageErrorCode;
  constructor(code: DbUsageErrorCode, message: string) {
    super(code, message);
  }
}
export type DbScopeReason = "unscoped" | "scope_missing" | "owner_mismatch" | "unprovable";
/** Module code reached an owned table without a scope, or the rewriter refused the statement (ops.md section 17). */
export class DbScopeError extends RenoxError {
  declare readonly code: "RENOX_DB_SCOPE";
  declare readonly details: { readonly table: string; readonly module: string; readonly reason: DbScopeReason };
  constructor(message: string, details: { table: string; module: string; reason: DbScopeReason }) {
    super("RENOX_DB_SCOPE", message, details);
  }
}

// Fetch (ops.md section 2)
export type FetchBlockedReason =
  | "not_allowlisted"
  | "scheme"
  | "port"
  | "blocked_address"
  | "redirect_limit"
  | "method";
export type FetchFailedReason = "dns" | "connect" | "tls" | "reset" | "redirect" | "concurrency" | "headers";

export class FetchBlockedError extends RenoxError {
  declare readonly code: "RENOX_FETCH_BLOCKED";
  declare readonly details: { readonly host: string; readonly reason: FetchBlockedReason };
  constructor(message: string, details: { host: string; reason: FetchBlockedReason }) {
    super("RENOX_FETCH_BLOCKED", message, details);
  }
}
export class FetchError extends RenoxError {
  declare readonly code: "RENOX_FETCH_FAILED";
  declare readonly details: { readonly host: string; readonly reason: FetchFailedReason };
  constructor(message: string, details: { host: string; reason: FetchFailedReason }) {
    super("RENOX_FETCH_FAILED", message, details);
  }
}
export class FetchEgressLimitError extends RenoxError {
  declare readonly code: "RENOX_FETCH_EGRESS_LIMIT";
  declare readonly details: { readonly host: string; readonly limitBytes: number };
  constructor(message: string, details: { host: string; limitBytes: number }) {
    super("RENOX_FETCH_EGRESS_LIMIT", message, details);
  }
}

// Deadline (ops.md section 5)
export class DeadlineError extends RenoxError {
  declare readonly code: "RENOX_DEADLINE";
  constructor(message: string) {
    super("RENOX_DEADLINE", message);
  }
}

// Modules (ops.md section 15)
/** A service call, hook run, or event emit the caller's manifest does not allow. */
export class ModuleUndeclaredError extends RenoxError {
  declare readonly code: "RENOX_MODULE_UNDECLARED";
  declare readonly details: { readonly module: string; readonly target: string };
  constructor(message: string, details: { module: string; target: string }) {
    super("RENOX_MODULE_UNDECLARED", message, details);
  }
}

export type ModuleServiceErrorDetails = {
  readonly module: string;
  readonly service?: string;
  readonly hook?: string;
  readonly event?: string;
  readonly cause_code: string | null;
};

/**
 * A service, hook filler, or in-memory event handler of another module threw.
 * `module` names the callee, `service` the service (null for a hook filler or
 * an event handler). The enclosing transaction has been rolled back.
 */
export class ModuleServiceError extends RenoxError {
  declare readonly code: "RENOX_MODULE_SERVICE";
  declare readonly details: ModuleServiceErrorDetails;
  readonly module: string;
  readonly service: string | null;
  constructor(message: string, details: ModuleServiceErrorDetails) {
    super("RENOX_MODULE_SERVICE", message, { ...details });
    this.module = details.module;
    this.service = details.service ?? null;
  }
}

export type EventPayloadReason = "schema" | "not_json" | "too_large";

/** The payload does not match the event's exported schema; never carries the payload. */
export class EventPayloadError extends RenoxError {
  declare readonly code: "RENOX_EVENT_PAYLOAD";
  declare readonly details: { readonly event: string; readonly reason: EventPayloadReason };
  constructor(message: string, details: { event: string; reason: EventPayloadReason }) {
    super("RENOX_EVENT_PAYLOAD", message, details);
  }
}

// Jobs (ops.md section 20, 1.6.0)
export type JobErrorCode = "RENOX_JOB_NOT_FOUND" | "RENOX_JOB_STATE";
export type JobOp = "retry" | "cancel";

/** `op_jobs_retry` / `op_jobs_cancel` for an id that is not a job row of this tenant. */
export class JobNotFoundError extends RenoxError {
  declare readonly code: "RENOX_JOB_NOT_FOUND";
  declare readonly details: { readonly id: string };
  constructor(message: string, details: { id: string }) {
    super("RENOX_JOB_NOT_FOUND", message, details);
  }
}

/** Retry on a row that is not dead, or cancel on a running row. */
export class JobStateError extends RenoxError {
  declare readonly code: "RENOX_JOB_STATE";
  declare readonly details: { readonly id: string; readonly state: JobState; readonly op: JobOp };
  constructor(message: string, details: { id: string; state: JobState; op: JobOp }) {
    super("RENOX_JOB_STATE", message, details);
  }
}

// Storage, AI and PDF (ops.md sections 21, 23 and 24, 1.7.0)
export type StorageErrorCode = "RENOX_STORAGE_QUOTA" | "RENOX_STORAGE_TYPE" | "RENOX_STORAGE_TOO_LARGE" | "RENOX_STORAGE_KEY" | "RENOX_STORAGE_NOT_FOUND";
export type AiErrorCode = "RENOX_AI_QUOTA" | "RENOX_AI_UNAVAILABLE";

/** One of the storage refusals (section 21). */
export class StorageError extends RenoxError {
  declare readonly code: StorageErrorCode;
  constructor(code: StorageErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);
  }
}

/** The tenant's monthly AI tokens are spent (section 23). */
export class AiQuotaError extends RenoxError {
  declare readonly code: "RENOX_AI_QUOTA";
  constructor(message: string, details?: Record<string, unknown>) {
    super("RENOX_AI_QUOTA", message, details);
  }
}

/** The model provider or the platform gateway failed (section 23). */
export class AiUnavailableError extends RenoxError {
  declare readonly code: "RENOX_AI_UNAVAILABLE";
  constructor(message: string, details?: Record<string, unknown>) {
    super("RENOX_AI_UNAVAILABLE", message, details);
  }
}

/** A PDF over 200 pages or 20 MB (section 24). */
export class PdfLimitError extends RenoxError {
  declare readonly code: "RENOX_PDF_LIMIT";
  constructor(message: string, details?: Record<string, unknown>) {
    super("RENOX_PDF_LIMIT", message, details);
  }
}

// Authorization (ops.md section 17)
export type ForbiddenReason = "deny" | "unknown_action" | "missing_attribute" | "evaluation_error" | "eval_limit" | "dev_only";
export type ForbiddenErrorDetails = {
  readonly action: string;
  readonly resource: { readonly type: string; readonly id: string } | null;
  readonly reason: ForbiddenReason;
  /** The deciding policy id in dev mode only. */
  readonly policy: string | null;
};
/** A policy denied the action. Uncaught, it ends the request with 403 `RENOX_FORBIDDEN`, not 500. */
export class ForbiddenError extends RenoxError {
  declare readonly code: "RENOX_FORBIDDEN";
  declare readonly details: ForbiddenErrorDetails;
  constructor(message: string, details: ForbiddenErrorDetails) {
    super("RENOX_FORBIDDEN", message, { ...details });
  }
}

// Realtime (ops.md section 18)
export type RealtimeLimitReason = "tenant" | "user" | "topics" | "message_size" | "flood";
export class RealtimeLimitError extends RenoxError {
  declare readonly code: "RENOX_REALTIME_LIMIT";
  declare readonly details: { readonly reason: RealtimeLimitReason };
  constructor(message: string, details: { reason: RealtimeLimitReason }) {
    super("RENOX_REALTIME_LIMIT", message, details);
  }
}
/** The connection's outbound queue was full: it has been closed with 1008. */
export class RealtimeBackpressureError extends RenoxError {
  declare readonly code: "RENOX_REALTIME_BACKPRESSURE";
  declare readonly details: { readonly conn: string };
  constructor(message: string, details: { conn: string }) {
    super("RENOX_REALTIME_BACKPRESSURE", message, details);
  }
}
