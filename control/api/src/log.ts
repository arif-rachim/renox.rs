// Structured operator logs: one JSON object per line on stdout. Request
// bodies, Authorization headers and secret values are never passed in; as a
// second line of defence every token-shaped string is masked before writing.

export type Level = "debug" | "info" | "warn" | "error";
export type Fields = Record<string, unknown>;

export interface Logger {
  log(level: Level, msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
}

const TOKEN = /renox_(pat|node|op|ses)_[a-z2-7]{32}/gu;

export const maskTokens = (text: string): string => text.replace(TOKEN, "renox_$1_[redacted]");

export function createLogger(write: (line: string) => void = (line) => process.stdout.write(`${line}\n`)): Logger {
  const log = (level: Level, msg: string, fields: Fields = {}): void => {
    write(maskTokens(JSON.stringify({ ts: Date.now(), level, msg, ...fields })));
  };
  return {
    log,
    info: (msg, fields) => log("info", msg, fields),
    warn: (msg, fields) => log("warn", msg, fields),
    error: (msg, fields) => log("error", msg, fields),
  };
}

/** A logger that keeps lines in memory, for tests. */
export function memoryLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  return Object.assign(createLogger((line) => lines.push(line)), { lines });
}

// Unhandled errors (#402). The journal gets the error's name, code, message,
// the first stack lines, the stage it failed in (`db`, `object_store.<op>`)
// and its cause chain, so an upstream failure is told apart from a bug. The
// fields pass through the same token mask as every line; string values that
// look like credentials (an AWS secret in a signed URL, a bearer header) are
// masked too.

const STAGE = Symbol.for("renox.stage");
/** How deep the cause chain is followed; AggregateError members count as causes. */
const MAX_CAUSE_DEPTH = 5;
const MAX_TEXT = 2000;

/**
 * Marks `err` with the stage it was thrown in (the first mark wins) and
 * returns it unchanged, so callers that test `err.code` keep working.
 */
export function tagStage<T>(err: T, stage: string): T {
  if (typeof err === "object" && err !== null && !Object.prototype.hasOwnProperty.call(err, STAGE)) {
    try {
      Object.defineProperty(err, STAGE, { value: stage, enumerable: false });
    } catch {
      // A frozen error keeps no stage; the log then says "handler".
    }
  }
  return err;
}

/** The stage of `err` or of the first error in its cause chain that has one. */
export function stageOf(err: unknown, depth = 0): string | null {
  if (typeof err !== "object" || err === null || depth > MAX_CAUSE_DEPTH) return null;
  const own = (err as Record<symbol, unknown>)[STAGE];
  if (typeof own === "string") return own;
  return stageOf((err as { cause?: unknown }).cause, depth + 1);
}

/** Masks credentials that are not renox tokens: signed-URL parameters, bearer and basic values, URL userinfo. */
export function maskSecrets(text: string): string {
  return maskTokens(text)
    .replace(/((?:X-Amz-(?:Signature|Credential|Security-Token)|Signature|AWSAccessKeyId|access_token|token|secret|password)=)[^&\s"']+/giu, "$1[redacted]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gu, "$1 [redacted]")
    .replace(/(Credential=)[^,\s"']+/gu, "$1[redacted]")
    .replace(/(\/\/)[^/\s:@]+:[^/\s@]+@/gu, "$1[redacted]@");
}

const clip = (s: string): string => maskSecrets(s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}…` : s);

export interface ErrorDescription {
  name: string;
  message: string;
  code?: string | number;
  errno?: string | number;
  status?: number;
  stack?: string;
  cause?: ErrorDescription;
  errors?: ErrorDescription[];
}

/** A JSON-safe description of `err` and its causes, with secrets masked. */
export function describeError(err: unknown, depth = 0): ErrorDescription {
  if (!(err instanceof Error)) {
    const name = typeof err === "object" && err !== null ? "NonError" : typeof err;
    let text: string;
    try {
      text = typeof err === "string" ? err : JSON.stringify(err) ?? String(err);
    } catch {
      text = String(err);
    }
    return { name, message: clip(text) };
  }
  const e = err as Error & { code?: unknown; errno?: unknown; status?: unknown; cause?: unknown; errors?: unknown };
  const out: ErrorDescription = { name: clip(e.name || e.constructor?.name || "Error"), message: clip(e.message ?? "") };
  if (typeof e.code === "string" || typeof e.code === "number") out.code = typeof e.code === "string" ? clip(e.code) : e.code;
  if (typeof e.errno === "string" || typeof e.errno === "number") out.errno = e.errno;
  if (typeof e.status === "number") out.status = e.status;
  if (typeof e.stack === "string") out.stack = clip(e.stack.split("\n").slice(0, 8).join("\n"));
  if (depth < MAX_CAUSE_DEPTH) {
    if (e.cause !== undefined && e.cause !== err) out.cause = describeError(e.cause, depth + 1);
    if (Array.isArray(e.errors) && e.errors.length > 0) out.errors = e.errors.slice(0, 5).map((x) => describeError(x, depth + 1));
  }
  return out;
}
