// Renox platform bootstrap: the ESM of the `renox` extension, part of the
// platform snapshot (docs/contracts/ops.md section 11).
//
// Evaluated once when the snapshot is built. It exposes exactly one object,
// `globalThis.__renoxInternal`, which Rust takes into a v8::Global and then
// deletes before any tenant module is evaluated (step 2, "Capture and
// harden"). Tenant code can therefore never reach `dispatch`, `harden`, the
// op functions imported below, or `Deno.core`.

import { core, primordials } from "ext:core/mod.js";
import {
  op_authz_check,
  op_authz_check_batch,
  op_authz_explain,
  op_authz_guard,
  op_authz_principal_cached,
  op_authz_principal_set,
  op_authz_roles_assign,
  op_authz_roles_list,
  op_authz_roles_revoke,
  op_db_execute,
  op_db_query,
  op_db_query_one,
  op_db_savepoint_begin,
  op_db_savepoint_release,
  op_db_savepoint_rollback,
  op_db_tx_begin,
  op_db_tx_commit,
  op_db_tx_rollback,
  op_deadline_remaining_ms,
  op_events_ack,
  op_events_emit,
  op_jobs_ack,
  op_jobs_cancel,
  op_jobs_enqueue,
  op_jobs_list,
  op_jobs_retry,
  op_password_hash,
  op_password_verify,
  op_realtime_close,
  op_realtime_publish,
  op_realtime_send,
  op_realtime_subscribe,
  op_realtime_unsubscribe,
  op_renox_fetch,
  op_fetch_body_close,
  op_fetch_body_read,
  op_log,
  op_response_end,
  op_response_write,
  op_secrets_get_all,
  op_span_service_begin,
  op_span_service_end,
  op_modules_call,
  op_storage_put,
  op_storage_get,
  op_storage_read,
  op_storage_delete,
  op_storage_sign,
  op_storage_sign_upload,
  op_storage_list,
  op_webhook_verify,
  op_ai_env,
  op_ai_gateway,
  op_ai_meter,
  op_render_pdf,
  op_render_template,
} from "ext:core/ops";

const {
  ArrayIsArray,
  ArrayPrototypeFind,
  ArrayPrototypeFindIndex,
  ArrayPrototypeIndexOf,
  ArrayPrototypeFilter,
  ArrayPrototypeEvery,
  ArrayPrototypeIncludes,
  ArrayPrototypeJoin,
  ArrayPrototypeSort,
  JSONParse,
  ObjectEntries,
  RangeError,
  RegExpPrototypeTest,
  SafeMap,
  SafeSet,
  ArrayPrototypeMap,
  ArrayPrototypeSome,
  ArrayPrototypePush,
  ArrayPrototypePop,
  ArrayPrototypeSplice,
  BigInt,
  Error,
  ErrorPrototype,
  JSONStringify,
  ObjectDefineProperty,
  ObjectDefineProperties,
  ObjectGetOwnPropertyDescriptors,
  ObjectFreeze,
  ObjectKeys,
  ObjectGetOwnPropertyDescriptor,
  ObjectGetOwnPropertyNames,
  ObjectGetPrototypeOf,
  ObjectPrototypeHasOwnProperty,
  ObjectPrototypeIsPrototypeOf,
  SymbolFor,
  Uint8ArrayPrototype,
  NumberIsInteger,
  PromisePrototypeThen,
  PromiseReject,
  PromiseResolve,
  ReflectConstruct,
  ReflectDeleteProperty,
  SafeArrayIterator,
  String,
  StringPrototypeIsWellFormed,
  StringPrototypeStartsWith,
  StringPrototypeToLowerCase,
  StringPrototypeToUpperCase,
  SafeWeakSet,
  TypeError,
  TypedArrayPrototypeGetSymbolToStringTag,
  Uint8Array,
} = primordials;

// Deno loads these extension modules lazily. Renox loads them here, at the
// top level of the bootstrap, which runs while the platform snapshot is
// built: they are evaluated into the snapshot, so neither isolate creation
// nor a fresh isolate's first request pays for them, and a first request's
// CPU budget covers tenant code only (#145, #146). Deno's own global getters
// (`Request`, `Response`, ...) get the same, already evaluated modules.
function lazy(specifier) {
  const mod = core.loadExtScript(specifier);
  return () => mod;
}
const requestMod = lazy("ext:deno_fetch/23_request.js");
const responseMod = lazy("ext:deno_fetch/23_response.js");
const formDataMod = lazy("ext:deno_fetch/21_formdata.js");
const streamsMod = lazy("ext:deno_web/06_streams.js");
const urlMod = lazy("ext:deno_web/00_url.js");

// The request token rides on V8's continuation-preserved embedder data
// (ops.md section 0, "Request scope"). AsyncVariable entries survive
// `await`, promise continuations, timers, and node:async_hooks'
// AsyncLocalStorage (which copies the mapping it extends).
const requestVar = new core.AsyncVariable();

/** The token of the current request, or 0 outside any request. */
function currentToken() {
  return requestVar.get() ?? 0;
}

// ops.md 1.3.0 section 15.1: the async context also carries the module
// whose code runs (attribution of console, fetch, and renox:modules calls),
// the request's module state (its ctx objects), the current transaction
// (section 1, "Module argument"), and the service call depth. ops.md
// 1.17.0 (#734): also the innermost savepoint the running code is inside.
const moduleVar = new core.AsyncVariable();
const stateVar = new core.AsyncVariable();
const txVar = new core.AsyncVariable();
const depthVar = new core.AsyncVariable();
const spVar = new core.AsyncVariable();

/** The module whose code runs now: "app" unless the broker entered one. */
function currentModule() {
  return moduleVar.get() ?? "app";
}

/** The op's module argument: null for the app (ops.md section 0, "Module"). */
function moduleArg(module) {
  return module === "app" ? null : module;
}

/** Runs `fn` with `vars` entered ([variable, value] pairs), restoring the context after. */
function within(vars, fn) {
  const previous = vars[0][0].enter(vars[0][1]);
  try {
    for (let i = 1; i < vars.length; i++) vars[i][0].enter(vars[i][1]);
    return fn();
  } finally {
    core.setAsyncContext(previous);
  }
}

// ---------------------------------------------------------------------------
// Errors thrown into tenant code (ops.md section 0, "Errors").

class RenoxError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "RenoxError";
    this.code = code;
    if (details !== undefined) this.details = ObjectFreeze(details);
  }
}

class ModuleUndeclaredError extends RenoxError {
  constructor(message, details) {
    super("RENOX_MODULE_UNDECLARED", message, details);
    this.name = "ModuleUndeclaredError";
  }
}

class ModuleServiceError extends RenoxError {
  constructor(message, details) {
    super("RENOX_MODULE_SERVICE", message, details);
    this.name = "ModuleServiceError";
    this.module = details.module;
    this.service = details.service ?? null;
  }
}

// ops.md 1.5.0 section 17: the typed errors of authorization and db.scoped().
class ForbiddenError extends RenoxError {
  constructor(message, details) {
    super("RENOX_FORBIDDEN", message, details);
    this.name = "ForbiddenError";
  }
}

class DbScopeError extends RenoxError {
  constructor(message, details) {
    super("RENOX_DB_SCOPE", message, details);
    this.name = "DbScopeError";
  }
}

// ops.md 1.5.0 section 18: the typed errors of realtime.
class RealtimeLimitError extends RenoxError {
  constructor(message, details) {
    super("RENOX_REALTIME_LIMIT", message, details);
    this.name = "RealtimeLimitError";
  }
}

class RealtimeBackpressureError extends RenoxError {
  constructor(message, details) {
    super("RENOX_REALTIME_BACKPRESSURE", message, details);
    this.name = "RealtimeBackpressureError";
  }
}

// ops.md 1.6.0 section 20: the typed errors of the jobs ops.
class JobNotFoundError extends RenoxError {
  constructor(message, details) {
    super("RENOX_JOB_NOT_FOUND", message, details);
    this.name = "JobNotFoundError";
  }
}

class JobStateError extends RenoxError {
  constructor(message, details) {
    super("RENOX_JOB_STATE", message, details);
    this.name = "JobStateError";
  }
}

// ops.md 1.7.0 section 23.
class AiQuotaError extends RenoxError {
  constructor(message, details) {
    super("RENOX_AI_QUOTA", message, details);
    this.name = "AiQuotaError";
  }
}
class AiUnavailableError extends RenoxError {
  constructor(message, details) {
    super("RENOX_AI_UNAVAILABLE", message, details);
    this.name = "AiUnavailableError";
  }
}

// ops.md 1.7.0 section 24.
class PdfLimitError extends RenoxError {
  constructor(message, details) {
    super("RENOX_PDF_LIMIT", message, details);
    this.name = "PdfLimitError";
  }
}

// ops.md 1.7.0 section 21: every RENOX_STORAGE_* code.
class StorageError extends RenoxError {
  constructor(code, message, details) {
    super(code, message, details);
    this.name = "StorageError";
  }
}

/** Ops reject with "CODE|json-details|message"; turn that into a RenoxError. */
function toRenoxError(e) {
  const msg = typeof e?.message === "string" ? e.message : "";
  if (!StringPrototypeStartsWith(msg, "RENOX_")) return e;
  const first = msg.indexOf("|");
  const second = msg.indexOf("|", first + 1);
  if (first < 0 || second < 0) return e;
  const code = msg.slice(0, first);
  let details;
  try {
    details = JSON.parse(msg.slice(first + 1, second));
  } catch {
    details = undefined;
  }
  const message = msg.slice(second + 1);
  switch (code) {
    case "RENOX_FORBIDDEN":
      return new ForbiddenError(message, details ?? undefined);
    case "RENOX_DB_SCOPE":
      return new DbScopeError(message, details ?? undefined);
    case "RENOX_REALTIME_LIMIT":
      return new RealtimeLimitError(message, details ?? undefined);
    case "RENOX_REALTIME_BACKPRESSURE":
      return new RealtimeBackpressureError(message, details ?? undefined);
    case "RENOX_MODULE_UNDECLARED":
      return new ModuleUndeclaredError(message, details ?? undefined);
    case "RENOX_JOB_NOT_FOUND":
      return new JobNotFoundError(message, details ?? undefined);
    case "RENOX_JOB_STATE":
      return new JobStateError(message, details ?? undefined);
    case "RENOX_PDF_LIMIT":
      return new PdfLimitError(message, details ?? undefined);
    case "RENOX_AI_QUOTA":
      return new AiQuotaError(message, details ?? undefined);
    case "RENOX_AI_UNAVAILABLE":
      return new AiUnavailableError(message, details ?? undefined);
    case "RENOX_STORAGE_QUOTA":
    case "RENOX_STORAGE_TYPE":
    case "RENOX_STORAGE_TOO_LARGE":
    case "RENOX_STORAGE_KEY":
    case "RENOX_STORAGE_NOT_FOUND":
      return new StorageError(code, message, details ?? undefined);
    default:
      return new RenoxError(code, message, details ?? undefined);
  }
}

// ---------------------------------------------------------------------------
// fetch (ops.md section 2). Replaces the global `fetch`; also `ctx.fetch`.

/** The global `fetch`: checked against the list of the module whose code runs. */
function renoxFetch(input, init = undefined) {
  return moduleFetch(currentModule(), input, init);
}

/** `fetch` for `module`'s own allowlist (ops.md 1.3.0 section 2, `FetchRequest.module`). */
async function moduleFetch(module, input, init = undefined) {
  const token = currentToken();
  // Normalise everything through the standard Request so headers, methods,
  // and bodies follow the Fetch spec; then hand plain values to Rust.
  const req = new (requestMod().Request)(input, init);
  const method = StringPrototypeToUpperCase(req.method);
  const headers = [];
  for (const pair of new SafeArrayIterator([...req.headers])) {
    ArrayPrototypePush(headers, [pair[0], pair[1]]);
  }
  let body = null;
  if (req.body !== null) {
    body = new Uint8Array(await req.arrayBuffer());
  }
  let head;
  try {
    head = await op_renox_fetch(token, {
      method,
      url: req.url,
      headers,
      body,
      redirect: req.redirect,
      module: moduleArg(module),
    });
  } catch (e) {
    throw toRenoxError(e);
  }
  const rid = head.body;
  let stream = null;
  if (rid !== null) {
    stream = new (streamsMod().ReadableStream)({
      type: "bytes",
      async pull(controller) {
        let chunk;
        try {
          chunk = await op_fetch_body_read(currentToken(), rid);
        } catch (e) {
          controller.error(toRenoxError(e));
          return;
        }
        if (chunk === null) {
          controller.close();
          // A closed bytes stream may still have a pending BYOB request.
          controller.byobRequest?.respond(0);
        } else {
          controller.enqueue(chunk);
        }
      },
      cancel() {
        op_fetch_body_close(currentToken(), rid);
      },
    });
  }
  const res = new (responseMod().Response)(stream, {
    status: head.status,
    statusText: head.statusText,
    headers: head.headers,
  });
  // `url` and `redirected` are read-only getters on Response.
  ObjectDefineProperty(res, "url", { value: head.url, enumerable: true });
  ObjectDefineProperty(res, "redirected", { value: head.redirected, enumerable: true });
  return res;
}

// ---------------------------------------------------------------------------
// Database (ops.md section 1): ctx.db and the statements of a transaction.
// Contract version 1.0.0-f1; the published types are sdk/ (ctx.d.ts).
//
// Parameters cross as [tag, number, string] with the bytes of Uint8Array
// parameters in a second list; Rust (ops/db.rs, convert_params) decides
// what binds and what is refused, so the rules live in one place.

const PARAM_NULL = 0;
const PARAM_BOOL = 1;
const PARAM_NUMBER = 2;
const PARAM_BIGINT = 3;
const PARAM_STRING = 4;
const PARAM_BYTES = 5;
const PARAM_UNSUPPORTED = 6;
const PARAM_ILL_FORMED = 7;

function isUint8Array(v) {
  return TypedArrayPrototypeGetSymbolToStringTag(v) === "Uint8Array";
}

function encodeParams(params) {
  if (params === undefined || params === null) params = [];
  if (!ArrayIsArray(params)) {
    throw new RenoxError("RENOX_DB_PARAM", "params must be an array");
  }
  const wire = [];
  const bytes = [];
  for (let i = 0; i < params.length; i++) {
    const v = params[i];
    switch (typeof v) {
      case "boolean":
        ArrayPrototypePush(wire, [PARAM_BOOL, v ? 1 : 0, null]);
        break;
      case "number":
        ArrayPrototypePush(wire, [PARAM_NUMBER, v, null]);
        break;
      case "bigint":
        ArrayPrototypePush(wire, [PARAM_BIGINT, null, String(v)]);
        break;
      case "string":
        ArrayPrototypePush(
          wire,
          StringPrototypeIsWellFormed(v) ? [PARAM_STRING, null, v] : [PARAM_ILL_FORMED, null, null],
        );
        break;
      default:
        if (v === null) {
          ArrayPrototypePush(wire, [PARAM_NULL, null, null]);
        } else if (isUint8Array(v)) {
          ArrayPrototypePush(wire, [PARAM_BYTES, null, null]);
          ArrayPrototypePush(bytes, v);
        } else {
          const name = v === undefined ? "undefined" : (TypedArrayPrototypeGetSymbolToStringTag(v) ?? typeof v);
          ArrayPrototypePush(wire, [PARAM_UNSUPPORTED, null, name]);
        }
    }
  }
  return [wire, bytes];
}

/** A result cell: [decimal] is a bigint (an INTEGER beyond 2^53 - 1). */
function decodeCell(v) {
  return ArrayIsArray(v) ? BigInt(v[0]) : v;
}

function toRows(out) {
  const { columns, rows } = out;
  return ArrayPrototypeMap(rows, (cells) => {
    const row = {};
    for (let i = 0; i < columns.length; i++) {
      ObjectDefineProperty(row, columns[i], {
        value: decodeCell(cells[i]),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return row;
  });
}

async function dbCall(op, sql, params, tx, module, scope = null) {
  const token = currentToken();
  if (typeof sql !== "string") throw new RenoxError("RENOX_DB_PARAM", "sql must be a string");
  const [wire, bytes] = encodeParams(params);
  try {
    return await op(token, sql, wire, bytes, tx, moduleArg(module), scope);
  } catch (e) {
    throw toRenoxError(e);
  }
}

/**
 * Statements under `module`'s authorizer. `tx` is a transaction handle, 0
 * for none, or "current": the request's current transaction at call time
 * (ops.md 1.3.0 section 1), which is how a service called from an action
 * writes in the action's transaction; or "outside": none, and refused at
 * once while a transaction is current (the app's `ctx.db.scoped(s)`, #749:
 * it would otherwise wait for the writer the request itself holds).
 */
function statements(tx, module = "app", scope = null) {
  const handle = () => {
    if (tx === "current") return txVar.get() ?? 0;
    if (tx === "outside") {
      const current = txVar.get();
      if (current !== undefined && current !== 0) {
        throw new RenoxError("RENOX_DB_TX_STATE", "use tx.scoped(...) inside a transaction");
      }
      return 0;
    }
    return tx;
  };
  return ObjectFreeze({
    async query(sql, params) {
      return toRows(await dbCall(op_db_query, sql, params, handle(), module, scope));
    },
    async queryOne(sql, params) {
      const rows = toRows(await dbCall(op_db_query_one, sql, params, handle(), module, scope));
      return rows.length === 0 ? null : rows[0];
    },
    async execute(sql, params) {
      const r = await dbCall(op_db_execute, sql, params, handle(), module, scope);
      return { changes: r.changes, lastInsertRowid: decodeCell(r.lastInsertRowid) };
    },
  });
}

/** `db.scoped(scope)` (ops.md 1.5.0 section 17): `{ user_id?, org_id?, session_id? }`, strings. */
function checkScope(scope) {
  if (scope === null || typeof scope !== "object" || ArrayIsArray(scope)) {
    throw new TypeError("db.scoped: a scope object { user_id?, org_id?, session_id? }");
  }
  const out = {};
  for (const k of new SafeArrayIterator(ObjectKeys(scope))) {
    if (k !== "user_id" && k !== "org_id" && k !== "session_id") throw new TypeError(`db.scoped: unknown key ${k}`);
    const v = scope[k];
    if (v === undefined || v === null) continue;
    if (typeof v !== "string" && typeof v !== "number") throw new TypeError(`db.scoped: ${k} must be a string`);
    out[k] = String(v);
  }
  return ObjectFreeze(out);
}

/**
 * The `tx` that `transaction(fn)` hands to `fn`: the transaction's
 * statements plus `scoped(scope)`, the same statements with the scope in the
 * same transaction, as `actionDb`'s (ops.md 1.15.0 section 17, #749).
 */
function txStatements(tx, module, scope) {
  return ObjectFreeze({
    ...statements(tx, module, scope),
    scoped(s) {
      return statements(tx, module, checkScope(s));
    },
  });
}

// ---------------------------------------------------------------------------
// Savepoints of a transaction (ops.md section 1, "Savepoints"): a nested
// `db.transaction` and, since 1.17.0 (#734), each module service call made
// inside a transaction. Rust names them `renox_sp_<n>` and allows only the
// innermost to end; this mirror of the open ones, per request and
// transaction, keeps calls that run concurrently (`Promise.all`) from
// breaking that order.
//
// A record is `{ tx, sp, shared, done }`. A savepoint is opened only when
// the innermost open one is the caller's own (`spVar`); a service call that
// starts while a sibling's savepoint is innermost runs without one, and
// the sibling's is marked `shared`: rolling back to it would also undo the
// concurrent call's writes, so a failure there rolls the whole transaction
// back, as before 1.17.0. A savepoint whose code has finished while
// another is open above it is released once it is innermost again.

/** The open savepoint records of `tx` in this request, innermost last, or null outside a request. */
function savepointStack(tx, create) {
  const st = stateVar.get();
  if (st === undefined) return null;
  let stack = st.savepoints.get(tx);
  if (stack === undefined && create) {
    stack = [];
    st.savepoints.set(tx, stack);
  }
  return stack ?? null;
}

/**
 * Records a savepoint about to be opened on `tx`, before the open is
 * awaited (so a call started next sees it). `optional`: a service call's
 * savepoint, skipped (null) when the innermost open savepoint is not the
 * caller's own; a nested `db.transaction` always gets its record.
 */
function pushSavepoint(tx, optional) {
  const rec = { tx, sp: 0, shared: false, done: false };
  const stack = savepointStack(tx, true);
  if (stack === null) return optional ? null : rec;
  const parent = spVar.get();
  const own = parent !== undefined && parent.tx === tx ? parent : undefined;
  if (stack.length > 0 && stack[stack.length - 1] !== own) {
    // Concurrent code holds the innermost savepoint: its range now holds
    // this code's writes too.
    for (let i = stack.length - 1; i >= 0 && stack[i] !== own; i--) stack[i].shared = true;
    if (optional) return null;
  }
  ArrayPrototypePush(stack, rec);
  return rec;
}

/** Forgets `rec` (its savepoint did not open, or its transaction is gone). */
function dropSavepoint(rec) {
  const stack = savepointStack(rec.tx, false);
  if (stack === null) return;
  const i = ArrayPrototypeIndexOf(stack, rec);
  if (i >= 0) ArrayPrototypeSplice(stack, i, 1);
}

/** Releases the finished savepoints that are innermost, innermost first. */
async function flushSavepoints(token, tx) {
  const stack = savepointStack(tx, false);
  while (stack !== null && stack.length > 0 && stack[stack.length - 1].done) {
    const top = ArrayPrototypePop(stack);
    try {
      await op_db_savepoint_release(token, tx, top.sp);
    } catch (e) {
      throw toRenoxError(e);
    }
  }
}

/**
 * `rec`'s code returned: its statements join the transaction (released
 * now, or once it is innermost). When the transaction was rolled back
 * meanwhile, a `quiet` (service call) savepoint is only forgotten; a
 * nested `db.transaction` reports it, as before 1.17.0.
 */
async function releaseSavepoint(token, rec, quiet) {
  const st = stateVar.get();
  const gone = st !== undefined && st.rolledBack.has(rec.tx);
  if (gone) dropSavepoint(rec);
  if (gone && quiet) return;
  if (gone || savepointStack(rec.tx, false) === null) {
    try {
      await op_db_savepoint_release(token, rec.tx, rec.sp);
    } catch (e) {
      throw toRenoxError(e);
    }
    return;
  }
  rec.done = true;
  await flushSavepoints(token, rec.tx);
}

/**
 * `rec`'s code threw: undo its statements and release it. Resolves false
 * when that cannot be done on its own (the savepoint is shared, not the
 * innermost, or the rollback failed); the caller then decides.
 */
async function rollbackSavepoint(token, rec) {
  const stack = savepointStack(rec.tx, false);
  if (stack !== null && (rec.shared || stack[stack.length - 1] !== rec)) return false;
  try {
    await op_db_savepoint_rollback(token, rec.tx, rec.sp);
  } catch {
    return false;
  } finally {
    dropSavepoint(rec);
  }
  try {
    await flushSavepoints(token, rec.tx);
  } catch {
    // The released savepoints above are the transaction's; its end reports it.
  }
  return true;
}

/**
 * `ctx.db` of `module`. The app's statements keep the 1.2 rule (no
 * transaction unless through `tx`); a module's run in the current one. The
 * app's scoped statements are refused while a transaction is current
 * ("outside", #749). `transaction(fn)` is IMMEDIATE, or a savepoint when a
 * transaction is current (ops.md 1.3.0 section 1, "Savepoints").
 */
function makeDb(module, scope = null, fixedTx = null) {
  const own = module !== "app" ? "current" : scope === null ? 0 : "outside";
  return ObjectFreeze({
    ...statements(fixedTx ?? own, module, scope),
    scoped(s) {
      return makeDb(module, checkScope(s), fixedTx);
    },
    async transaction(fn) {
      const token = currentToken();
      // A tool preview's Db (#285): everything nests inside its transaction.
      const outer = fixedTx ?? txVar.get();
      if (outer !== undefined && outer !== 0) {
        const rec = pushSavepoint(outer, false);
        try {
          rec.sp = await op_db_savepoint_begin(token, outer);
        } catch (e) {
          dropSavepoint(rec);
          throw toRenoxError(e);
        }
        let result;
        try {
          result = await within(
            [
              [txVar, outer],
              [spVar, rec],
            ],
            () => fn(txStatements(outer, module, scope)),
          );
        } catch (e) {
          // Shared or not innermost: Rust refuses as before 1.17.0. The
          // transaction itself may be gone (rolled back by the broker).
          if (!(await rollbackSavepoint(token, rec))) {
            dropSavepoint(rec);
            try {
              await op_db_savepoint_rollback(token, outer, rec.sp);
            } catch {
              // As above.
            }
          }
          throw e;
        }
        await releaseSavepoint(token, rec, false);
        return result;
      }
      let tx;
      try {
        tx = await op_db_tx_begin(token, "immediate");
      } catch (e) {
        throw toRenoxError(e);
      }
      let result;
      try {
        result = await within([[txVar, tx]], () => fn(txStatements(tx, module, scope)));
      } catch (e) {
        try {
          await op_db_tx_rollback(token, tx);
        } catch {
          // The request may have ended; Rust rolls back in that case.
        }
        throw e;
      }
      try {
        await op_db_tx_commit(token, tx);
      } catch (e) {
        throw toRenoxError(e);
      }
      return result;
    },
  });
}

const db = makeDb("app");

/**
 * An action's `ctx.db` (ops.md section 14): the action's transaction, no
 * `transaction()`; `scoped(scope)` (1.5.0 section 17) gives the same
 * statements with the scope, in the same transaction.
 */
function actionDb(tx, module) {
  return ObjectFreeze({
    ...statements(tx, module),
    scoped(s) {
      return ObjectFreeze(statements(tx, module, checkScope(s)));
    },
  });
}

// ---------------------------------------------------------------------------
// Logging (ops.md section 4): ctx.log and console. Rust adds tenant,
// deployment, request, level, and time, redacts secret values, applies the
// size and rate limits.

/** Field values to JSON (ops.md section 12). */
function toJson(v, seen) {
  switch (typeof v) {
    case "string":
    case "boolean":
      return v;
    case "number":
      return v === v && v !== Infinity && v !== -Infinity ? v : String(v);
    case "bigint":
      return String(v);
    case "undefined":
    case "function":
    case "symbol":
      return undefined;
  }
  if (v === null) return null;
  if (seen.has(v)) return "[circular]";
  if (isUint8Array(v)) return `[${v.length} bytes]`;
  if (ObjectPrototypeIsPrototypeOf(ErrorPrototype, v)) {
    return { name: safeString(v.name), message: safeString(v.message), stack: safeString(v.stack) };
  }
  seen.add(v);
  try {
    if (ArrayIsArray(v)) {
      return ArrayPrototypeMap(v, (x) => toJson(x, seen) ?? null);
    }
    const out = {};
    for (const k of new SafeArrayIterator(ObjectKeys(v))) {
      const x = toJson(v[k], seen);
      if (x !== undefined) out[k] = x;
    }
    return out;
  } catch {
    return "[unprintable]";
  } finally {
    seen.delete(v);
  }
}

function writeLog(level, message, fields) {
  try {
    let f = null;
    if (fields !== undefined && fields !== null && typeof fields === "object") {
      f = toJson(fields, new SafeWeakSet());
      if (typeof f !== "object" || f === null || ArrayIsArray(f)) f = { value: f };
    }
    op_log(currentToken(), level, safeString(message), f, moduleArg(currentModule()));
  } catch {
    // Logging never throws into tenant code.
  }
}

/** `ctx.log` of `module`: its lines carry `module` (ops.md 1.3.0 section 4). */
function makeLog(module) {
  const w = (level) => (message, fields) => within([[moduleVar, module]], () => writeLog(level, message, fields));
  return ObjectFreeze({ debug: w("debug"), info: w("info"), warn: w("warn"), error: w("error") });
}

const log = makeLog("app");

/** console arguments to one message: strings as is, the rest as JSON. */
function formatArgs(args) {
  return ArrayPrototypeJoin(
    ArrayPrototypeMap(args, (a) => {
      if (typeof a === "string") return a;
      if (ObjectPrototypeIsPrototypeOf(ErrorPrototype, a)) return safeString(a.stack ?? a);
      try {
        const j = JSON.stringify(toJson(a, new SafeWeakSet()));
        return j === undefined ? safeString(a) : j;
      } catch {
        return safeString(a);
      }
    }),
    " ",
  );
}

const CONSOLE_LEVELS = { debug: "debug", trace: "debug", warn: "warn", error: "error", assert: "error" };

/** A console whose every method goes through op_log (no stdout, no stderr). */
function makeConsole(original) {
  const c = {};
  const names = original ? ObjectKeys(original) : [];
  for (const name of new SafeArrayIterator(["log", "info", "debug", "warn", "error", "trace", "assert", ...names])) {
    const level = CONSOLE_LEVELS[name] ?? "info";
    if (name === "assert") {
      c.assert = (cond, ...args) => {
        if (!cond) writeLog(level, formatArgs(["Assertion failed", ...args]));
      };
    } else {
      c[name] = (...args) => writeLog(level, formatArgs(args));
    }
  }
  return c;
}

// ---------------------------------------------------------------------------
// Secrets (ops.md section 3): taken once per module by harden(), before
// tenant code.

let secrets = ObjectFreeze({});
/** Module name -> its frozen secrets (ops.md 1.3.0 section 15.1). */
const moduleSecrets = new SafeMap();

// ---------------------------------------------------------------------------
// The module broker (ops.md 1.3.0 section 15, shared mode).

/** Module name -> its info from the artifact (`$defs/moduleInfo`), in lock order. */
const modules = new SafeMap();
/** Module name -> `services.ts` namespace. */
const serviceModules = new SafeMap();
/** Hook name -> [{ module, priority, handle }], in run order. */
const hookFillers = new SafeMap();
/** Module name -> the `on` map of its `hooks.ts` (events, #231), or a LazyOn of its recorded names. */
const eventHandlers = new SafeMap();
/**
 * ops.md 1.14.0 (ADR D32): module name -> its lazy entries,
 * `{ services?: specifier, hooks?: { specifier, hooks, on } }`. An entry
 * leaves this map's role once evaluated: its namespace goes to
 * serviceModules, hookFillers and eventHandlers as for an eager one.
 */
const lazyEntries = new SafeMap();
/** `${module}/${part}` -> the promise of its checked namespace: one evaluation per isolate, a rejection cached. */
const entryLoads = new SafeMap();
/** Hook names some of whose fillers were lazy at registration and are not ordered yet. */
const pendingHooks = new SafeSet();
/** The recorded `on` names of a lazy `hooks` entry, until it is evaluated. */
class LazyOn {
  constructor(names) {
    this.names = names;
  }
}
/** Installed module name -> frozen proxies of its services (renox:modules, ctx.services). */
let serviceProxies = ObjectFreeze({});
const MAX_CALL_DEPTH = 16;
/** ops.md 1.7.0 section 15.6: the most JSON that crosses between isolates per call, each way. */
const MAX_CROSS = 1024 * 1024;

/** Whether `module`'s code runs in this isolate (ops.md 1.7.0 section 15.6). */
function isLocal(module) {
  return infoOf(module)?.local !== false;
}

/**
 * A call into the isolate of another module (`isolate` mode): the
 * structured clone (JSON) of the arguments and the result, at most
 * MAX_CROSS each way, with this request's transaction and principal.
 */
async function crossCall(kind, target, name, args) {
  const caller = currentModule();
  const json = JSONStringify(args ?? null, dataReplacer) ?? "null";
  if (json.length > MAX_CROSS) {
    throw new ModuleServiceError(`${target}.${name} failed: the arguments are over 1 MiB`, { module: target, service: name, reason: "too_large", cause_code: null });
  }
  // ops.md 1.17.0 (#734): a service call gets its savepoint here, in the
  // caller's isolate, around the callee's run on the lent transaction.
  const call = kind === "service" ? await openCall() : null;
  let out;
  try {
    out = await op_modules_call(currentToken(), kind, caller, target, name, json, txVar.get() ?? 0);
  } catch (e) {
    const err = toRenoxError(e);
    const details = err?.details ?? {};
    if (details.reason === "too_large") {
      // The callee returned, but the call failed: its writes are undone.
      if (call !== null) await undoCall(call, false);
      throw new ModuleServiceError(`${target}.${name} failed: the result is over 1 MiB`, { module: target, service: name, reason: "too_large", cause_code: null });
    }
    if (call !== null && details.reason !== "isolate") {
      // The callee threw: only its call is undone (the callee logged its throw).
      await undoCall(call, false);
    } else {
      // A hook filler threw, or the callee's isolate failed (killed for
      // CPU, memory or time): as in shared mode, the current transaction
      // is rolled back.
      dropCall(call);
      await rollbackTx(false);
    }
    throw new ModuleServiceError(`${target}.${name} failed`, { module: target, service: name, cause_code: details.cause_code ?? null });
  }
  await closeCall(call);
  return JSONParse(out);
}

function requestState() {
  const st = stateVar.get();
  if (st === undefined || currentToken() === 0) {
    throw new RenoxError("RENOX_NO_REQUEST", "module services, hooks and events need a request");
  }
  return st;
}

function infoOf(module) {
  return modules.get(module);
}

/**
 * Rolls the current transaction back once (a hook filler or an event
 * handler failed; ops.md 1.3.0 section 15.2, "Errors"). `lent`: leave a
 * transaction lent by another isolate's caller to that caller.
 */
async function rollbackTx(lent) {
  const st = stateVar.get();
  const tx = txVar.get();
  if (tx !== undefined && tx !== 0 && st !== undefined && !st.rolledBack.has(tx) && !(lent && st.borrowedTx === tx)) {
    st.rolledBack.add(tx);
    st.savepoints.delete(tx);
    try {
      await op_db_tx_rollback(currentToken(), tx);
    } catch {
      // Already gone.
    }
  }
}

/** rollbackTx for code of this isolate: a lent transaction is the caller's to roll back. */
function rollbackCurrent() {
  return rollbackTx(true);
}

/**
 * ops.md 1.17.0 section 15.2 (#734): the savepoint of a service call made
 * while the caller holds an open transaction, opened before the callee
 * runs. Resolves `{ tx, rec }`, `rec` null when the call runs without one
 * (a concurrent sibling's savepoint is innermost, or more than 32 are
 * open); null outside a transaction or once it was rolled back.
 */
async function openCall() {
  const st = stateVar.get();
  const tx = txVar.get();
  if (tx === undefined || tx === 0 || st === undefined || st.rolledBack.has(tx)) return null;
  const rec = pushSavepoint(tx, true);
  if (rec === null) return { tx, rec: null };
  try {
    rec.sp = await op_db_savepoint_begin(currentToken(), tx);
  } catch {
    dropSavepoint(rec);
    return { tx, rec: null };
  }
  return { tx, rec };
}

/** `vars` plus the savepoint of `call`, the async-context entries its callee runs with. */
function callVars(call, vars) {
  if (call?.rec) ArrayPrototypePush(vars, [spVar, call.rec]);
  return vars;
}

/**
 * The callee of `call` threw: roll back to its savepoint, so its writes are
 * undone and the caller's stay; the caller's transaction goes on. Without
 * a savepoint of its own (or when it cannot be rolled back alone) the
 * whole transaction is rolled back, as before 1.17.0; `lent` as rollbackTx.
 */
async function undoCall(call, lent) {
  const st = stateVar.get();
  if (call.rec !== null && st !== undefined && !st.rolledBack.has(call.tx)) {
    if (await rollbackSavepoint(currentToken(), call.rec)) return;
  }
  dropCall(call);
  await within([[txVar, call.tx]], () => rollbackTx(lent));
}

/** The callee of `call` returned: its savepoint is released. */
async function closeCall(call) {
  if (call?.rec) await releaseSavepoint(currentToken(), call.rec, true);
}

/** Forgets the savepoint of `call` (the whole transaction is rolled back). */
function dropCall(call) {
  if (call?.rec) dropSavepoint(call.rec);
}

/** Fails if the sorted keys of `obj` differ from the recorded `names`. */
function sameKeys(obj, names, what) {
  const keys = ArrayPrototypeSort(ObjectKeys(obj ?? {}));
  const recorded = ArrayPrototypeSort([...new SafeArrayIterator(names)]);
  if (keys.length !== recorded.length || ArrayPrototypeSome(keys, (k, i) => k !== recorded[i])) {
    throw new TypeError(`${what} has keys ${JSONStringify(keys)}, the artifact records ${JSONStringify(recorded)}`);
  }
}

/**
 * Evaluates `module`'s lazy `part` entry ("services" or "hooks") once per
 * isolate (ops.md 1.14.0 section 11, step 4), inside the current
 * invocation: its top-level code runs with this request's ops, deadline
 * and CPU. The evaluated namespace is checked as an eager one is at
 * creation (step 5), and the `hooks` and `on` keys against the recorded
 * names. Resolves with the namespace; a failure is logged once as
 * RENOX_MODULE_EVAL and stays cached for the isolate.
 */
function loadEntry(module, part) {
  const key = `${module}/${part}`;
  let p = entryLoads.get(key);
  if (p !== undefined) return p;
  const lazyOf = lazyEntries.get(module)?.[part];
  const specifier = part === "hooks" ? lazyOf?.specifier : lazyOf;
  if (typeof specifier !== "string") return PromiseResolve(undefined);
  p = within([[moduleVar, module]], () => {
    let imported = lazyModules.get(specifier);
    if (imported === undefined) {
      imported = import(specifier);
      lazyModules.set(specifier, imported);
    }
    return imported;
  });
  p = PromisePrototypeThen(p, (ns) => {
    if (part === "services") {
      checkServices(module, ns);
      serviceModules.set(module, ns);
    } else {
      sameKeys(ns.hooks, lazyOf.hooks, `${module === "app" ? "app" : `module ${module}`}: hooks.ts hooks`);
      sameKeys(ns.on, lazyOf.on, `${module === "app" ? "app" : `module ${module}`}: hooks.ts on`);
      const fillers = checkFillers(module, ns);
      const on = checkOn(module, ns);
      for (const f of new SafeArrayIterator(fillers)) {
        const list = hookFillers.get(f.hook);
        const i = ArrayPrototypeFindIndex(list ?? [], (x) => x.module === module && x.lazy === true);
        if (i >= 0) list[i] = f.filler;
      }
      if (eventHandlers.get(module) instanceof LazyOn) eventHandlers.set(module, on ?? {});
    }
    return ns;
  });
  p = PromisePrototypeThen(p, undefined, (e) => {
    within([[moduleVar, module]], () =>
      writeLog("error", `module ${module}: ${part}.ts failed to evaluate`, { error: describeThrow(e), code: "RENOX_MODULE_EVAL", entry: part }),
    );
    throw e;
  });
  entryLoads.set(key, p);
  return p;
}

/**
 * The namespace of `module`'s `part` entry, evaluating a lazy one first.
 * A failed evaluation fails the invocation as if the module had thrown
 * there: `undo` runs (the current transaction rolls back; for a service
 * call, only the call, ops.md 1.17.0) and the caller gets a
 * ModuleServiceError with `cause_code: "RENOX_MODULE_EVAL"` (ops.md 1.14.0).
 */
async function entryOf(module, part, details, undo = rollbackCurrent) {
  if (!lazyEntries.get(module)?.[part]) return undefined;
  try {
    return await loadEntry(module, part);
  } catch (e) {
    await undo();
    throw new ModuleServiceError(`${module} failed to evaluate`, { ...details, cause_code: "RENOX_MODULE_EVAL" });
  }
}

/** Whether `module` has `service`, evaluated or recorded (ops.md 1.14.0). */
function hasService(module, service) {
  if (serviceModules.has(module)) return typeof serviceModules.get(module)?.[service] === "function";
  return typeof lazyEntries.get(module)?.services === "string" && ArrayPrototypeIncludes(infoOf(module)?.exports?.services ?? [], service);
}

/** The `on[name]` handler of `module`, evaluating its lazy `hooks` entry when it records `name`. */
async function handlerOf(module, name, details) {
  const on = eventHandlers.get(module);
  if (on instanceof LazyOn) {
    if (!ArrayPrototypeIncludes(on.names, name)) return undefined;
    await entryOf(module, "hooks", details);
    return eventHandlers.get(module)?.[name];
  }
  return on?.[name];
}

/**
 * The fillers of hook `name` in run order. Before a hook's first run on
 * the isolate its lazy fillers are evaluated, in the modules order (the
 * app last), and then ordered by their evaluated priority (ops.md 1.14.0
 * section 15.3, "Lazy fillers").
 */
async function fillersOf(name) {
  if (pendingHooks.has(name)) {
    const lazy = ArrayPrototypeFilter(hookFillers.get(name) ?? [], (f) => f.lazy === true);
    const order = [...new SafeArrayIterator([...modules.keys()]), "app"];
    ArrayPrototypeSort(lazy, (a, b) => ArrayPrototypeIndexOf(order, a.module) - ArrayPrototypeIndexOf(order, b.module));
    // Each run awaits the shared evaluations, so a failure fails (and rolls back) every run that needs it.
    for (const f of new SafeArrayIterator(lazy)) {
      await entryOf(f.module, "hooks", { module: f.module, hook: name });
    }
    if (pendingHooks.has(name)) {
      pendingHooks.delete(name);
      sortFillers(hookFillers.get(name) ?? []);
    }
  }
  return [...new SafeArrayIterator(hookFillers.get(name) ?? [])];
}

/** Priority, then module name, the app last on ties (artifact 1.8). */
function sortFillers(list) {
  const byModule = (a, b) => (a === b ? 0 : a === "app" ? 1 : b === "app" ? -1 : a < b ? -1 : 1);
  ArrayPrototypeSort(list, (a, b) => a.priority - b.priority || byModule(a.module, b.module));
}

/**
 * A callee threw: run `undo` (ops.md 1.3.0 section 15.2, "Errors": for a
 * hook filler or an event handler the current transaction rolls back at
 * once; for a service call, since 1.17.0, only the call), log the callee's
 * error with its module, and hand the caller a ModuleServiceError.
 */
async function calleeFailed(e, details, label, undo = rollbackCurrent) {
  await undo();
  const cause = typeof e?.code === "string" && StringPrototypeStartsWith(e.code, "RENOX_") ? e.code : null;
  within([[moduleVar, details.module]], () =>
    writeLog("error", `${label} threw`, { error: describeThrow(e), code: "RENOX_MODULE_SERVICE" }),
  );
  return new ModuleServiceError(`${label} failed: ${safeString(e?.message ?? e)}`, { ...details, cause_code: cause });
}

/** `<target>.<service>(...args)` from the module whose code runs. */
async function callService(target, service, args) {
  const st = requestState();
  const caller = currentModule();
  const callerInfo = infoOf(caller);
  if (caller !== "app" && !ArrayPrototypeIncludes(callerInfo?.dependencies ?? [], target)) {
    throw new ModuleUndeclaredError(`module ${caller} does not declare a dependency on ${target}`, { module: caller, target });
  }
  const depth = (depthVar.get() ?? 0) + 1;
  if (depth > MAX_CALL_DEPTH) {
    throw new ModuleServiceError(`${target}.${service} failed: call depth`, { module: target, service, cause_code: null });
  }
  if (!isLocal(target)) return await crossCall("service", target, service, args);
  // ops.md 1.17.0 (#734): inside a transaction the call runs in a savepoint
  // of its own; a throw undoes only the call, nested calls the same way.
  const call = await openCall();
  const undo = () => (call === null ? rollbackCurrent() : undoCall(call, true));
  let fn = serviceModules.get(target)?.[service];
  // ops.md 1.14.0: a lazy services entry is evaluated on its first call, as the callee.
  if (fn === undefined && !serviceModules.has(target)) {
    fn = (await within(callVars(call, [[depthVar, depth]]), () => entryOf(target, "services", { module: target, service }, undo)))?.[service];
  }
  const calleeCtx = st.ctxOf(target);
  // #295: one module.service span per call (caller, callee, name; never the arguments).
  let span = 0;
  try {
    span = op_span_service_begin(currentToken(), caller, target, service);
  } catch {
    // Outside a request (module evaluation): no span.
  }
  let result;
  try {
    result = await within(
      callVars(call, [
        [moduleVar, target],
        [depthVar, depth],
      ]),
      () => fn(calleeCtx, ...args),
    );
  } catch (e) {
    throw await calleeFailed(e, { module: target, service }, `${target}.${service}`, undo);
  } finally {
    if (span !== 0) op_span_service_end(span);
  }
  await closeCall(call);
  return result;
}

/** `ctx.hooks` of `module` (ops.md 1.3.0 section 15.3). */
function makeHooks(module) {
  return ObjectFreeze({
    async run(name, args) {
      const st = requestState();
      if (!ArrayPrototypeIncludes(infoOf(module)?.exports?.hooks ?? [], name)) {
        throw new ModuleUndeclaredError(`module ${module} does not export hook ${name}`, { module, target: name });
      }
      for (const f of new SafeArrayIterator(await fillersOf(name))) {
        const fillerCtx = f.remote === true ? null : st.ctxOf(f.module);
        let r;
        try {
          r = await within([[moduleVar, f.module]], () => f.handle(fillerCtx, args));
          if (r !== undefined && !(r !== null && typeof r === "object" && r.halt === true && isResponse(r.response))) {
            throw new TypeError("a hook filler returns undefined or { halt: true, response }");
          }
        } catch (e) {
          throw await calleeFailed(e, { module: f.module, hook: name }, `${f.module} filler of ${name}`);
        }
        if (r !== undefined) return ObjectFreeze({ halt: true, response: r.response, module: f.module });
      }
      return ObjectFreeze({ halt: false });
    },
  });
}

/** A hook filler of another isolate's module: its `{ halt, response }` crosses as status, headers and body. */
async function remoteFiller(module, hook, args) {
  const r = await crossCall("hook", module, hook, args);
  if (r === null || r === undefined || r.halt !== true) return undefined;
  const res = r.response ?? {};
  return { halt: true, response: new Response(res.body ?? null, { status: res.status ?? 200, headers: res.headers ?? [] }) };
}

/** Step 5 for a `services` namespace: every `exports.services` name is a function export. */
function checkServices(name, services) {
  for (const svc of new SafeArrayIterator(infoOf(name)?.exports?.services ?? [])) {
    if (typeof services?.[svc] !== "function") {
      throw new TypeError(`module ${name}: service ${svc} is not a function export of services.ts`);
    }
  }
}

/**
 * Step 5 for a `hooks` namespace's fillers: each filled hook is declared
 * (the app needs no permissions.hooks, it is the tenant's own code), with a
 * `handle` function and a priority of 0-1000. Returns `[{ hook, filler }]`.
 */
function checkFillers(name, hooksNs) {
  const label = name === "app" ? "app" : `module ${name}`;
  const out = [];
  const fills = hooksNs?.hooks;
  if (fills === undefined || fills === null) return out;
  for (const hook of new SafeArrayIterator(ObjectKeys(fills))) {
    if (name !== "app" && !ArrayPrototypeIncludes(infoOf(name)?.permissions?.hooks ?? [], hook)) {
      throw new TypeError(`${label}: hooks.ts fills ${hook}, which its manifest does not declare`);
    }
    const filler = fills[hook];
    if (typeof filler?.handle !== "function") throw new TypeError(`${label}: hooks.${hook}.handle is not a function`);
    const priority = filler.priority ?? 100;
    if (typeof priority !== "number" || priority < 0 || priority > 1000) throw new TypeError(`${label}: hooks.${hook}.priority must be 0-1000`);
    ArrayPrototypePush(out, { hook, filler: { module: name, priority, handle: filler.handle } });
  }
  return out;
}

/** Step 5 for a `hooks` namespace's `on`: every value is a function. Returns the map, or undefined. */
function checkOn(name, hooksNs) {
  const on = hooksNs?.on;
  if (on === undefined || on === null) return undefined;
  for (const [ev, h] of new SafeArrayIterator(ObjectEntries(on))) {
    if (typeof h !== "function") throw new TypeError(`${name === "app" ? "app" : `module ${name}`}: on["${ev}"] is not a function`);
  }
  return on;
}

/**
 * Called by Rust after the eager tenant modules loaded (ops.md 1.3.0
 * section 11, step 5). Each entry is `{ services?, hooks?, lazy? }`: an
 * eager entry's namespace, checked now (fail closed), or (1.14.0, ADR D32)
 * a lazy entry's specifier and recorded names, from which the fillers and
 * handlers are known without evaluating it.
 */
function register(namespaces) {
  const registerOne = (name, ns) => {
    const lazy = ns.lazy ?? {};
    if (typeof lazy.services === "string" || lazy.hooks !== undefined) lazyEntries.set(name, lazy);
    if (ns.services !== undefined) {
      checkServices(name, ns.services);
      serviceModules.set(name, ns.services);
    } else if (typeof lazy.services !== "string" && name !== "app") {
      checkServices(name, undefined);
    }
    if (lazy.hooks !== undefined) {
      for (const hook of new SafeArrayIterator(lazy.hooks.hooks)) {
        // The recorded fillers are approved at prepare (V23); checked again here.
        if (name !== "app" && !ArrayPrototypeIncludes(infoOf(name)?.permissions?.hooks ?? [], hook)) {
          throw new TypeError(`module ${name}: hooks.ts fills ${hook}, which its manifest does not declare`);
        }
        const list = hookFillers.get(hook) ?? [];
        ArrayPrototypePush(list, { module: name, priority: 100, lazy: true });
        hookFillers.set(hook, list);
        pendingHooks.add(hook);
      }
      if (name === "app") eventHandlers.delete("app");
      eventHandlers.set(name, new LazyOn(lazy.hooks.on));
      return;
    }
    for (const f of new SafeArrayIterator(checkFillers(name, ns.hooks))) {
      const list = hookFillers.get(f.hook) ?? [];
      ArrayPrototypePush(list, f.filler);
      hookFillers.set(f.hook, list);
    }
    const on = checkOn(name, ns.hooks);
    if (on !== undefined) {
      if (name === "app") eventHandlers.delete("app");
      eventHandlers.set(name, on);
    }
  };
  for (const [name, info] of new SafeArrayIterator([...modules])) {
    if (info.local === false) {
      // ops.md 1.7.0 section 15.6: the fillers of a module that runs in
      // another isolate, from its manifest, run there (priority 100).
      for (const hook of new SafeArrayIterator(info.permissions?.hooks ?? [])) {
        const list = hookFillers.get(hook) ?? [];
        ArrayPrototypePush(list, { module: name, priority: 100, remote: true, handle: (_ctx, args) => remoteFiller(name, hook, args) });
        hookFillers.set(hook, list);
      }
      continue;
    }
    registerOne(name, namespaces[name] ?? {});
  }
  // ops.md 1.12.0 section 15.4: the app's own hooks.ts, as module "app".
  // It is the tenant's own code, so it needs no permissions.hooks; its
  // `on` is stored last, so the in-memory order runs it after the modules.
  if (namespaces.app !== undefined) registerOne("app", namespaces.app);
  for (const list of new SafeArrayIterator([...hookFillers.values()])) sortFillers(list);
  // Module -> the events it handles: the cell fans durable events out to them.
  const handled = {};
  for (const [name, on] of new SafeArrayIterator([...eventHandlers])) handled[name] = on instanceof LazyOn ? [...new SafeArrayIterator(on.names)] : ObjectKeys(on);
  return handled;
}

/**
 * Runs the in-memory handlers of `name` (ops.md 1.3.0 section 15.4): each
 * installed module's `on[name]`, in the modules order, with its own ctx and
 * the emitter's current transaction. A throw rolls the transaction back and
 * fails the emit.
 */
async function runInMemory(st, id, name, payload) {
  for (const [m] of new SafeArrayIterator([...eventHandlers])) {
    // ops.md 1.14.0: a lazy handler module is evaluated just before its handler runs.
    const h = await handlerOf(m, name, { module: m, event: name });
    if (typeof h !== "function") continue;
    const e = ObjectFreeze({ id, name, payload, attempt: 1 });
    const hctx = eventCtx(st.ctxOf(m), m, actionDb("current", m), e);
    try {
      await within([[moduleVar, m]], () => h(hctx, e));
    } catch (err) {
      throw await calleeFailed(err, { module: m, event: name }, `${m} handler of ${name}`);
    }
  }
}

/** A JobContext (ops.md section 20): the module's ctx without the request, `db` the attempt's transaction, `job` the run. */
function jobCtx(base, statementsOf, info) {
  const c = { ...base, db: statementsOf, job: info };
  delete c.req;
  delete c.url;
  delete c.params;
  delete c.headers;
  delete c.setLocale;
  delete c.session;
  delete c.fragment;
  return ObjectFreeze(c);
}

/** An EventContext: the module's ctx without the request, `db` given. */
function eventCtx(base, module, statementsOf, e) {
  const c = { ...base, db: statementsOf, event: ObjectFreeze({ id: e.id, name: e.name, attempt: e.attempt }) };
  delete c.req;
  delete c.url;
  delete c.params;
  delete c.headers;
  delete c.setLocale;
  delete c.session;
  delete c.fragment;
  return ObjectFreeze(c);
}

/** `ctx.events` of `module`. */
function makeEvents(module) {
  return ObjectFreeze({
    async emit(name, payload, options = undefined) {
      const st = requestState();
      if (typeof name !== "string") throw new TypeError("events.emit: name must be a string");
      const durable = options?.durable ?? true;
      if (typeof durable !== "boolean") throw new TypeError("events.emit: durable must be a boolean");
      let json;
      try {
        json = JSONStringify(payload);
      } catch {
        json = undefined;
      }
      // Not JSON-serialisable: Rust answers RENOX_EVENT_PAYLOAD, reason "not_json".
      if (typeof json !== "string") json = "";
      const tx = txVar.get() ?? 0;
      let id;
      try {
        id = await op_events_emit(currentToken(), name, json, durable, moduleArg(module), tx);
      } catch (e) {
        throw toRenoxError(e);
      }
      if (!durable) await runInMemory(st, id, name, JSONParse(json));
      return id;
    },
  });
}

/** `ctx.jobs` of `module` (ops.md 1.6.0 section 20). */
/**
 * `ctx.ai` of `module` (ops.md 1.7.0 section 23): one Messages call, or a
 * loop while the model asks for local tools (`run`), which execute here
 * with the caller's ctx under the request's limits. Direct mode fetches
 * the provider through the module's allowlist with the app's own key;
 * gateway mode goes through the cell. Nothing of the conversation is logged.
 */
function makeAi(module) {
  return ObjectFreeze({
    async chat(request) {
      if (request === null || typeof request !== "object" || !ArrayIsArray(request.messages) || request.messages.length === 0) {
        throw new TypeError("ai.chat: messages is a non-empty array");
      }
      const env = op_ai_env();
      const maxTokens = request.maxTokens ?? 1024;
      if (typeof maxTokens !== "number" || !NumberIsInteger(maxTokens) || maxTokens < 1 || maxTokens > env.max_tokens) {
        throw new RangeError(`ai.chat: maxTokens is 1 to ${env.max_tokens}`);
      }
      const tools = ArrayIsArray(request.tools) ? request.tools : [];
      const byName = new SafeMap();
      for (const t of new SafeArrayIterator(tools)) byName.set(t.name, t);
      const wire = ArrayPrototypeMap(tools, (t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
      const messages = [...request.messages];
      let tokensIn = 0;
      let tokensOut = 0;
      for (let round = 0; round <= env.max_rounds; round++) {
        const body = { model: request.model ?? "default", messages, max_tokens: maxTokens };
        if (typeof request.system === "string") body.system = request.system;
        if (wire.length > 0) body.tools = wire;
        const res = env.mode === "direct" ? await aiDirect(module, env, body) : await aiGateway(body);
        const used = res.usage ?? {};
        tokensIn += used.input_tokens ?? 0;
        tokensOut += used.output_tokens ?? 0;
        op_ai_meter(currentToken(), used.input_tokens ?? 0, used.output_tokens ?? 0);
        const content = ArrayIsArray(res.content) ? res.content : [];
        const uses = ArrayPrototypeFilter(content, (c) => c?.type === "tool_use");
        const local = uses.length > 0 && ArrayPrototypeEvery(uses, (u) => typeof byName.get(u.name)?.run === "function");
        if (res.stop_reason !== "tool_use" || !local) {
          return ObjectFreeze({ id: res.id ?? "", model: res.model ?? body.model, content: ObjectFreeze(content), stop_reason: res.stop_reason ?? "end_turn", usage: ObjectFreeze({ input_tokens: tokensIn, output_tokens: tokensOut }) });
        }
        ArrayPrototypePush(messages, { role: "assistant", content });
        const results = [];
        for (const u of new SafeArrayIterator(uses)) {
          const out = await byName.get(u.name).run(u.input);
          ArrayPrototypePush(results, { type: "tool_result", tool_use_id: u.id, content: typeof out === "string" ? out : (JSONStringify(out ?? null, dataReplacer) ?? "null") });
        }
        ArrayPrototypePush(messages, { role: "user", content: results });
      }
      throw new AiUnavailableError(`ai.chat: more than ${env.max_rounds} tool rounds`);
    },
  });
}

/**
 * `ctx.pdf` (ops.md 1.7.0 section 24): a template of the caller, rendered and
 * converted in Rust. The module argument is the caller's own (null for the
 * app), so the op adds the prefix `modules/<name>/` (1.9.0).
 */
function makePdf(m) {
  const module = m === "app" ? null : m;
  return ObjectFreeze({
    async render(template, data, options = undefined) {
      if (typeof template !== "string" || template.length === 0) throw new TypeError("pdf.render: template is a template id");
      const json = JSONStringify(data ?? {}, dataReplacer);
      try {
        return await op_render_pdf(currentToken(), template, json ?? "{}", JSONStringify(options ?? {}), module);
      } catch (e) {
        throw e instanceof RangeError || e instanceof TypeError ? e : toRenoxError(e);
      }
    },
  });
}

/**
 * `ctx.render` (ops.md 1.8.0 section 25): a template of the caller as an HTML
 * fragment, in the request's locale and direction (`setLocale`; `en` and
 * `ltr` outside a page).
 */
function makeRender(m) {
  const module = m === "app" ? null : m;
  return async (template, data = undefined) => {
    if (typeof template !== "string" || template.length === 0) throw new TypeError("render: template is a template id");
    const json = JSONStringify(data ?? {}, dataReplacer);
    const st = stateVar.get();
    try {
      return await op_render_template(currentToken(), template, json ?? "{}", module, st?.locale ?? null, st?.dir ?? null);
    } catch (e) {
      throw e instanceof RangeError || e instanceof TypeError ? e : toRenoxError(e);
    }
  };
}

/** Direct mode: the Anthropic Messages API with the app's own key, through `fetch`. */
async function aiDirect(module, env, body) {
  const key = (module === "app" ? secrets : moduleSecrets.get(module) ?? {})[env.key_name ?? ""];
  if (typeof key !== "string") throw new AiUnavailableError("ai.chat: direct mode needs the key secret", { reason: "no_key" });
  const wire = { ...body, model: body.model === "default" ? "claude-opus-5-5" : body.model };
  let res;
  try {
    res = await moduleFetch(module, `${env.base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSONStringify(wire),
    });
  } catch (e) {
    if (e?.code === "RENOX_FETCH_BLOCKED") throw e;
    throw new AiUnavailableError("ai.chat: the provider did not answer", { reason: "fetch" });
  }
  if (!res.ok) {
    try {
      await res.body?.cancel();
    } catch {
      // Gone.
    }
    throw new AiUnavailableError(`ai.chat: the provider answered ${res.status}`, { status: res.status });
  }
  return await res.json();
}

/** Gateway mode: the platform's gateway through the cell; the key stays there. */
async function aiGateway(body) {
  try {
    return JSONParse(await op_ai_gateway(currentToken(), JSONStringify(body)));
  } catch (e) {
    throw e instanceof TypeError ? e : toRenoxError(e);
  }
}

// ops.md 1.7.0 section 22: a duplicate delivery ends the handler with 200.
const WEBHOOK_DUPLICATE = SymbolFor("renox.webhook.duplicate");

/** `ctx.webhook` of a webhook route: `verify(req, { provider } | { secret, header })`. */
function makeWebhook(module, req) {
  const own = moduleSecrets.get(module) ?? (module === "app" ? secrets : undefined) ?? {};
  return ObjectFreeze({
    async verify(r, options) {
      const provider = typeof options?.provider === "string" ? options.provider : options?.secret !== undefined ? "generic" : null;
      if (provider === null) throw new TypeError("webhook.verify: options.provider, or options.secret and options.header");
      const source = r ?? req;
      const bytes = new Uint8Array(await source.clone().arrayBuffer());
      const hs = [];
      for (const [k, v] of source.headers) ArrayPrototypePush(hs, [k, v]);
      // A module's secrets carry its prefix (MF4): `<MODULE>_WEBHOOK_<PROVIDER>_SECRET`.
      const p = StringPrototypeToUpperCase(provider);
      const secret = provider === "generic" ? options.secret : (own[`WEBHOOK_${p}_SECRET`] ?? own[`${StringPrototypeToUpperCase(module)}_WEBHOOK_${p}_SECRET`]);
      let out;
      try {
        out = await op_webhook_verify(currentToken(), provider, typeof secret === "string" ? secret : null, options?.header ?? null, bytes, hs);
      } catch (e) {
        throw toRenoxError(e);
      }
      let payload = null;
      try {
        payload = JSONParse(out.payload_json);
      } catch {
        payload = out.payload_json;
      }
      const event = ObjectFreeze({ provider: out.provider, event_id: out.event_id, received_at: out.received_at, payload, duplicate: out.duplicate });
      // The provider stops retrying; the handler does not run on.
      if (out.duplicate) throw { [WEBHOOK_DUPLICATE]: true, event };
      return event;
    },
  });
}

/** A webhook handler's throw: a duplicate is 200, a bad signature 401, the unverified bucket 429. */
function webhookOutcome(e) {
  if (e !== null && typeof e === "object" && e[WEBHOOK_DUPLICATE] === true) return ResponseJson({ duplicate: true });
  const code = e?.code;
  if (code === "RENOX_WEBHOOK_SIGNATURE") {
    return ResponseJson({ error: { code, message: "The webhook signature is not valid." } }, 401);
  }
  if (code === "RENOX_RATE_LIMITED") {
    return ResponseJson({ error: { code, message: "Too many requests." } }, 429, { "retry-after": "1" });
  }
  throw e;
}

function ResponseJson(body, status = 200, headers = {}) {
  return new (responseMod().Response)(JSONStringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/** `ctx.storage` of `module` (ops.md 1.7.0 section 21): keys under `<module>/`. */
function makeStorage(module) {
  const call = async (op, ...args) => {
    try {
      return await op(currentToken(), ...args);
    } catch (e) {
      throw e instanceof RangeError || e instanceof TypeError ? e : toRenoxError(e);
    }
  };
  const checkKey = (key, what) => {
    if (typeof key !== "string" || key.length === 0) throw new TypeError(`storage.${what}: key must be a string`);
  };
  return ObjectFreeze({
    async put(key, bytes, options) {
      checkKey(key, "put");
      if (!ObjectPrototypeIsPrototypeOf(Uint8ArrayPrototype, bytes)) throw new TypeError("storage.put: bytes must be a Uint8Array");
      const contentType = options?.contentType;
      if (typeof contentType !== "string" || contentType.length === 0) throw new TypeError("storage.put: options.contentType is required");
      return ObjectFreeze(await call(op_storage_put, key, bytes, contentType, options?.public === true, options?.sanitised === true, moduleArg(module)));
    },
    async get(key) {
      checkKey(key, "get");
      return ObjectFreeze(await call(op_storage_get, key, moduleArg(module)));
    },
    async read(key) {
      checkKey(key, "read");
      return await call(op_storage_read, key, moduleArg(module));
    },
    async delete(key) {
      checkKey(key, "delete");
      return await call(op_storage_delete, key, moduleArg(module));
    },
    async sign(key, ttlSeconds) {
      checkKey(key, "sign");
      if (typeof ttlSeconds !== "number" || !NumberIsInteger(ttlSeconds)) throw new TypeError("storage.sign: ttlSeconds must be an integer");
      return ObjectFreeze(await call(op_storage_sign, key, ttlSeconds, moduleArg(module)));
    },
    async signUpload(key, options) {
      checkKey(key, "signUpload");
      const contentType = options?.contentType;
      if (typeof contentType !== "string" || contentType.length === 0) throw new TypeError("storage.signUpload: options.contentType is required");
      const maxBytes = options?.maxBytes;
      if (typeof maxBytes !== "number") throw new TypeError("storage.signUpload: options.maxBytes must be a number");
      const ttlSeconds = options?.ttlSeconds ?? 900;
      if (typeof ttlSeconds !== "number") throw new TypeError("storage.signUpload: options.ttlSeconds must be a number");
      return ObjectFreeze(await call(op_storage_sign_upload, key, contentType, maxBytes, ttlSeconds, options?.public === true, moduleArg(module)));
    },
    async list(prefix, options = undefined) {
      if (typeof prefix !== "string") throw new TypeError("storage.list: prefix must be a string");
      const limit = options?.limit ?? 100;
      const page = await call(op_storage_list, prefix, limit, options?.cursor ?? null, moduleArg(module));
      return ObjectFreeze({ items: ObjectFreeze(ArrayPrototypeMap(page.items, (f) => ObjectFreeze(f))), next_cursor: page.next_cursor ?? null });
    },
  });
}

function makeJobs(module) {
  const call = async (op, ...args) => {
    try {
      return await op(currentToken(), ...args);
    } catch (e) {
      throw e instanceof RangeError || e instanceof TypeError ? e : toRenoxError(e);
    }
  };
  const checkId = (id, what) => {
    if (typeof id !== "string" || id.length === 0) throw new TypeError(`jobs.${what}: id must be a string`);
  };
  return ObjectFreeze({
    async enqueue(name, payload, options = undefined) {
      if (typeof name !== "string") throw new TypeError("jobs.enqueue: name must be a string");
      let json;
      try {
        json = JSONStringify(payload);
      } catch {
        json = undefined;
      }
      if (typeof json !== "string" || payload === null || typeof payload !== "object" || ArrayIsArray(payload) || json.length > 64 * 1024) {
        throw new RangeError("jobs.enqueue: the payload is a JSON object of at most 64 KiB");
      }
      const runAt = options?.runAt ?? null;
      let at = null;
      if (runAt !== null) {
        at = typeof runAt === "number" ? runAt : typeof runAt?.getTime === "function" ? runAt.getTime() : NaN;
        if (typeof at !== "number" || at !== at || at === Infinity || at === -Infinity) throw new TypeError("jobs.enqueue: runAt is a Date or Unix ms");
      }
      return await call(op_jobs_enqueue, name, json, at, moduleArg(module), txVar.get() ?? 0);
    },
    async list(state, options = undefined) {
      if (typeof state !== "string") throw new TypeError("jobs.list: state must be a string");
      const limit = options?.limit ?? 50;
      if (typeof limit !== "number" || limit < 1 || limit > 100 || limit !== (limit | 0)) throw new RangeError("jobs.list: limit is 1 to 100");
      const cursor = options?.cursor ?? null;
      if (cursor !== null && typeof cursor !== "string") throw new TypeError("jobs.list: cursor must be a string or null");
      const page = await call(op_jobs_list, state, limit, cursor, moduleArg(module));
      return ObjectFreeze({ items: ObjectFreeze(ArrayPrototypeMap(page.items, (r) => ObjectFreeze(r))), next_cursor: page.next_cursor ?? null });
    },
    async retry(id) {
      checkId(id, "retry");
      await call(op_jobs_retry, id, moduleArg(module), txVar.get() ?? 0);
    },
    async cancel(id) {
      checkId(id, "cancel");
      await call(op_jobs_cancel, id, moduleArg(module), txVar.get() ?? 0);
    },
  });
}

/** `ctx.password` (ops.md 1.3.0 section 16): argon2id in Rust, off this thread. */
const password = ObjectFreeze({
  async hash(pw) {
    if (typeof pw !== "string") throw new TypeError("password.hash: a string");
    try {
      return await op_password_hash(currentToken(), pw);
    } catch (e) {
      throw e instanceof RangeError ? e : toRenoxError(e);
    }
  },
  async verify(pw, hash) {
    if (typeof pw !== "string" || typeof hash !== "string") throw new TypeError("password.verify: two strings");
    try {
      return await op_password_verify(currentToken(), pw, hash);
    } catch (e) {
      throw e instanceof RangeError ? e : toRenoxError(e);
    }
  },
});

// ---------------------------------------------------------------------------
// Authorization (ops.md 1.5.0 section 17): ctx.authz. Rust evaluates with
// the request's own principal; tenant code never passes one.

/** A resource or context as plain JSON (dates as strings, bigints as text). */
function authzJson(v, what) {
  if (v === undefined || v === null) return null;
  if (typeof v !== "object" || ArrayIsArray(v)) throw new TypeError(`authz: ${what} must be an object`);
  return JSONParse(JSONStringify(v, dataReplacer));
}

function checkAction(action) {
  if (typeof action !== "string" || action.length === 0) throw new TypeError("authz: action must be a string");
}

/** `ctx.authz` of `module`. */
function makeAuthz(module) {
  const call = async (op, ...args) => {
    try {
      return await op(currentToken(), ...args);
    } catch (e) {
      throw e instanceof RangeError ? e : toRenoxError(e);
    }
  };
  const roleArgs = (userId, role, scope) => {
    if (typeof userId !== "string" || typeof role !== "string") throw new TypeError("authz.roles: userId and role are strings");
    if (scope !== undefined && (scope === null || typeof scope !== "object")) throw new TypeError("authz.roles: scope is { type, id }");
    return { user_id: userId, role, scope_type: scope?.type ?? "global", scope_id: scope?.id ?? null };
  };
  return ObjectFreeze({
    async require(action, resource = undefined, context = undefined) {
      checkAction(action);
      await call(op_authz_check, action, authzJson(resource, "resource"), authzJson(context, "context"), moduleArg(module), true);
    },
    async can(action, resource = undefined, context = undefined) {
      checkAction(action);
      const d = await call(op_authz_check, action, authzJson(resource, "resource"), authzJson(context, "context"), moduleArg(module), false);
      return d.allow === true;
    },
    async canBatch(action, resources, context = undefined) {
      checkAction(action);
      if (!ArrayIsArray(resources)) throw new TypeError("authz.canBatch: resources must be an array");
      if (resources.length > 1000) throw new RangeError("authz.canBatch: at most 1000 resources");
      return await call(op_authz_check_batch, action, ArrayPrototypeMap(resources, (r) => authzJson(r, "resource")), authzJson(context, "context"), moduleArg(module));
    },
    async explain(action, resource = undefined, context = undefined) {
      checkAction(action);
      const x = await call(op_authz_explain, action, authzJson(resource, "resource"), authzJson(context, "context"), moduleArg(module));
      return ObjectFreeze({ decision: x.decision, reasons: ObjectFreeze(x.reasons), errors: ObjectFreeze(x.errors) });
    },
    roles: ObjectFreeze({
      async assign(userId, role, scope = undefined) {
        await call(op_authz_roles_assign, roleArgs(userId, role, scope), moduleArg(module), txVar.get() ?? 0);
      },
      async revoke(userId, role, scope = undefined) {
        return await call(op_authz_roles_revoke, roleArgs(userId, role, scope), moduleArg(module), txVar.get() ?? 0);
      },
      async list(userId) {
        if (typeof userId !== "string") throw new TypeError("authz.roles.list: userId is a string");
        return ObjectFreeze(ArrayPrototypeMap(await call(op_authz_roles_list, userId, moduleArg(module)), (r) => ObjectFreeze(r)));
      },
    }),
  });
}

// ---------------------------------------------------------------------------
// Realtime (ops.md 1.5.0 section 18): ctx.realtime. Connections live in the
// cell; the ops reach them by id. Fan-out never enters the isolate.

const TOPIC = /^[A-Za-z0-9_.-]+(:[A-Za-z0-9_.-]+)*$/;

function checkTopic(topic) {
  if (typeof topic !== "string" || topic.length === 0 || topic.length > 256 || !RegExpPrototypeTest(TOPIC, topic)) {
    throw new RangeError("realtime: a topic is 1 to 256 characters of segments [A-Za-z0-9_.-] split on ':'");
  }
}

/** A `Conn` or its id. */
function connId(conn) {
  const id = typeof conn === "string" ? conn : conn?.id;
  if (typeof id !== "string") throw new TypeError("realtime: conn is a Conn or its id");
  return id;
}

/** `RealtimePayload` -> the wire shape of `ops.schema.json` `$defs/realtimePayload`. */
function realtimePayload(module, p) {
  if (typeof p === "string") return { kind: "text", text: p, event: null };
  if (p === null || typeof p !== "object") throw new TypeError("realtime: payload is a string, { text }, { json }, or { fragment, data }");
  const event = p.event ?? null;
  if (event !== null && typeof event !== "string") throw new TypeError("realtime: event is a string");
  if (typeof p.text === "string") return { kind: "text", text: p.text, event };
  if (ObjectPrototypeHasOwnProperty(p, "json")) {
    const text = JSONStringify(p.json, dataReplacer);
    if (typeof text !== "string") throw new TypeError("realtime: json is not JSON-serialisable");
    return { kind: "text", text, event };
  }
  if (typeof p.fragment === "string") {
    const data = JSONStringify(p.data ?? {}, dataReplacer);
    if (typeof data !== "string") throw new TypeError("realtime: fragment data is not JSON-serialisable");
    return { kind: "fragment", fragment: p.fragment, data, module, event };
  }
  throw new TypeError("realtime: payload is a string, { text }, { json }, or { fragment, data }");
}

/** `ctx.realtime` of `module`. */
function makeRealtime(module) {
  const call = async (op, ...args) => {
    try {
      return await op(currentToken(), ...args);
    } catch (e) {
      throw e instanceof RangeError || e instanceof TypeError ? e : toRenoxError(e);
    }
  };
  return ObjectFreeze({
    async subscribe(conn, topic) {
      const id = connId(conn);
      checkTopic(topic);
      await call(op_realtime_subscribe, id, topic);
    },
    async unsubscribe(conn, topic) {
      const id = connId(conn);
      checkTopic(topic);
      await call(op_realtime_unsubscribe, id, topic);
    },
    async publish(topic, payload) {
      checkTopic(topic);
      return await call(op_realtime_publish, topic, realtimePayload(module, payload));
    },
    async send(conn, payload) {
      await call(op_realtime_send, connId(conn), realtimePayload(module, payload));
    },
    async close(conn, code = 1000, reason = null) {
      if (typeof code !== "number") throw new TypeError("realtime.close: code is a number");
      await call(op_realtime_close, connId(conn), code, reason ?? "");
    },
  });
}

/** A principal from Rust, frozen all the way down. */
function freezePrincipal(p) {
  if (p === null || p === undefined) return null;
  return ObjectFreeze({
    id: p.id,
    kind: p.kind,
    roles: ObjectFreeze(ArrayPrototypeMap(p.roles ?? [], (r) => ObjectFreeze({ ...r }))),
    attrs: ObjectFreeze({ ...(p.attrs ?? {}) }),
  });
}

/**
 * The request's principal (ops.md 1.5.0 section 17, "Principal"): the
 * cell's cache, else the `auth` module's `principal` service (which runs
 * the `auth.principal` hook), else anonymous. A failing service gives the
 * anonymous principal (fail closed) and a log line.
 */
async function resolvePrincipal(token, url, headers) {
  const cached = op_authz_principal_cached(token);
  if (cached.state !== "miss") return cached.principal ?? null;
  let answer = null;
  if (hasService("auth", "principal")) {
    const req = new (requestMod().Request)(url, { method: "GET", headers });
    const st0 = newRequestState({
      req,
      url: new (urlMod().URL)(url),
      params: ObjectFreeze({}),
      headers: req.headers,
      principal: null,
      deadline: requestDeadline,
    });
    try {
      answer = await within(
        [
          [moduleVar, "auth"],
          [stateVar, st0],
        ],
        async () => {
          // ops.md 1.14.0: a lazy `auth` services entry is evaluated on the first principal lookup.
          const svc = serviceModules.get("auth")?.principal ?? (await entryOf("auth", "services", { module: "auth", service: "principal" }))?.principal;
          return await svc(st0.ctxOf("auth"), cached.session ?? null);
        },
      );
    } catch (e) {
      within([[moduleVar, "auth"]], () => writeLog("error", "auth.principal threw; the request is anonymous", { error: describeThrow(e), code: "RENOX_INTERNAL" }));
      answer = null;
    }
    if (answer !== null && (typeof answer !== "object" || typeof answer.id !== "string")) answer = null;
  }
  return await op_authz_principal_set(token, answer === null ? null : JSONParse(JSONStringify({ id: answer.id, attrs: answer.attrs ?? {} }, dataReplacer)));
}

/** Principal, then the route's guard; `{ forbidden }` stops the request. */
async function prelude(token, url, headers) {
  const principal = await resolvePrincipal(token, url, headers);
  const g = await op_authz_guard(token);
  if (!g.allow) {
    const who = principal === null || principal === undefined ? { kind: "anonymous" } : { id: String(principal.id ?? ""), kind: String(principal.kind ?? "user"), roles: ArrayIsArray(principal.roles) ? ArrayPrototypeMap(principal.roles, (r) => (typeof r === "string" ? r : String(r?.role ?? ""))) : [] };
    return { forbidden: { kind: KIND_FORBIDDEN, reason: g.reason ?? "deny", name: g.policy ?? undefined, details_json: JSONStringify({ principal: who }) } };
  }
  return { principal: freezePrincipal(principal) };
}

/** One frozen object of service proxies per installed module. */
function buildProxies() {
  const out = {};
  for (const [name, info] of new SafeArrayIterator([...modules])) {
    const p = {};
    for (const svc of new SafeArrayIterator(info.exports?.services ?? [])) {
      p[svc] = (...args) => callService(name, svc, args);
    }
    out[name] = ObjectFreeze(p);
  }
  return ObjectFreeze(out);
}

// Locale of the page (ops.md 1.3.0 section 14, "Locale").
// ops.md 1.4.0 section 14 ("Locale"; `ops.schema.json` `$defs/locale`): the
// language part, then optionally one `-u-` extension with `ca` and `nu`.
const LOCALE_TAG =
  /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*(-u(-ca-(gregory|islamic|islamic-civil|islamic-tbla|islamic-umalqura|persian)(-nu-(arab|arabext|latn))?|-nu-(arab|arabext|latn)))?$/;
const RTL_LANGS = ["ar", "fa", "he", "ur", "ps", "sd", "ug", "yi", "dv", "ckb"];

function makeSetLocale(st) {
  return (locale, dir = undefined) => {
    if (typeof locale !== "string" || locale.length > 64 || !RegExpPrototypeTest(LOCALE_TAG, locale)) {
      throw new RangeError("setLocale: a BCP 47 tag such as \"ar-AE\"");
    }
    if (dir !== undefined && dir !== "ltr" && dir !== "rtl") throw new RangeError('setLocale: dir is "ltr" or "rtl"');
    st.locale = locale;
    st.dir = dir ?? (ArrayPrototypeIncludes(RTL_LANGS, StringPrototypeToLowerCase(locale.split("-")[0])) ? "rtl" : "ltr");
  };
}

/**
 * The per-request module state: `base` holds the request fields every
 * module's ctx shares (req, url, params, headers, deadline, session,
 * fragment, setLocale); `ctxOf(m)` builds module `m`'s frozen ctx once.
 */
function newRequestState(base) {
  const cache = new SafeMap();
  const st = {
    base,
    locale: undefined,
    dir: undefined,
    rolledBack: new SafeSet(),
    /** tx -> its open savepoint records, innermost last (#734). */
    savepoints: new SafeMap(),
    ctxOf(m) {
      let c = cache.get(m);
      if (c === undefined) {
        // The descriptors, not the values: a lazy field of `base` (the
        // realtime run's `req`, `url`, `headers`, #680) stays a getter.
        c = ObjectDefineProperties({}, ObjectGetOwnPropertyDescriptors(st.base));
        const fields = moduleFields(m);
        for (const k of new SafeArrayIterator(ObjectKeys(fields))) c[k] = fields[k];
        c = ObjectFreeze(c);
        cache.set(m, c);
      }
      return c;
    },
  };
  return st;
}

/** What is bound to one module in its ctx (ops.md 1.3.0 section 15.1). */
function moduleFields(m) {
  const info = infoOf(m);
  return {
    db: m === "app" ? db : makeDb(m),
    fetch: m === "app" ? renoxFetch : (input, init) => moduleFetch(m, input, init),
    secrets: m === "app" ? secrets : (moduleSecrets.get(m) ?? ObjectFreeze({})),
    log: m === "app" ? log : makeLog(m),
    config: info === undefined ? ObjectFreeze({}) : ObjectFreeze({ ...info.config }),
    module: m,
    services: serviceProxies,
    hooks: makeHooks(m),
    events: makeEvents(m),
    jobs: makeJobs(m),
    storage: makeStorage(m),
    ai: makeAi(m),
    pdf: makePdf(m),
    render: makeRender(m),
    authz: makeAuthz(m),
    realtime: makeRealtime(m),
    password,
  };
}

// ---------------------------------------------------------------------------
// Request dispatch (ops.md section 11, step 6).

const KIND_OK = 0;
const KIND_THROW = 1;
const KIND_NOT_RESPONSE = 2;
// Page loaders (ops.md section 14): an object becomes template data.
const KIND_RENDER = 3;
const KIND_PAGE_INTERNAL = 4;
// An event delivery ended (ops.md 1.3.0 section 15.4).
const KIND_EVENT = 5;
// A lazy route module failed its first evaluation or lacks the route's
// export (ops.md 1.4.0 section 11, steps 4-5).
const KIND_MODULE_EVAL = 6;
// The route's guard denied before the handler (ops.md 1.5.0 section 17).
const KIND_FORBIDDEN = 7;
// A realtime run ended (ops.md 1.5.0 section 18): `result` is `ok` or `no_handler`.
const KIND_REALTIME = 8;
// A service or tool invocation ended (#285): `result` is `ok` (with
// `data_json`), `no_handler`, or `output_too_large`.
const KIND_INVOKE = 9;
/** ops.md 1.5.0 section 19: a tool's output is at most 256 KB of JSON. */
const MAX_TOOL_OUTPUT = 256 * 1024;

/** `ctx.deadline`: the request's own (ops.md section 5). */
const requestDeadline = ObjectFreeze({
  remainingMs() {
    try {
      return op_deadline_remaining_ms(currentToken());
    } catch (e) {
      throw toRenoxError(e);
    }
  },
});

function safeString(v) {
  try {
    return String(v);
  } catch {
    return "<unprintable>";
  }
}

/** Who the request runs as, for a log line: id, kind and role names, never attributes. */
function principalSummary() {
  try {
    const p = stateVar.get()?.base?.principal ?? null;
    if (p === null || p === undefined) return { kind: "anonymous" };
    const roles = ArrayIsArray(p.roles) ? ArrayPrototypeMap(p.roles, (r) => (typeof r === "string" ? r : String(r?.role ?? ""))) : [];
    return { id: String(p.id ?? ""), kind: String(p.kind ?? "user"), roles };
  } catch {
    return null;
  }
}

function describeThrow(err) {
  let name = "Error";
  let message = "";
  let stack = "";
  let code = null;
  let detailsJson = undefined;
  try {
    if (ObjectPrototypeIsPrototypeOf(ErrorPrototype, err)) {
      name = safeString(err.name);
      message = safeString(err.message);
      stack = safeString(err.stack);
      if (typeof err.code === "string" && StringPrototypeStartsWith(err.code, "RENOX_")) code = err.code;
      // #294: a denial's or a scope refusal's details and who asked, for the tenant log (dev overlay).
      if ((code === "RENOX_FORBIDDEN" || code === "RENOX_DB_SCOPE") && err.details !== null && typeof err.details === "object") {
        detailsJson = JSONStringify({ ...err.details, principal: principalSummary() });
      }
    } else {
      name = typeof err;
      message = safeString(err);
    }
  } catch {
    // A hostile getter: keep what we have.
  }
  return { kind: KIND_THROW, name, message, stack, code, details_json: detailsJson };
}

/**
 * #444: the type name of a handler's value that is not a Response, for the
 * tenant's log and `renox dev`: `undefined`, `null`, `number`, `string`,
 * `boolean`, `bigint`, `symbol`, `function`, `array`, `object` (a plain
 * object), or the class name of an instance (a short identifier). Never the
 * value, and no tenant code runs: getters and Proxy traps are read through
 * descriptors inside a `try`, and anything odd falls back to `object`.
 */
const TYPE_NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;
function resultTypeName(res) {
  if (res === null) return "null";
  const t = typeof res;
  if (t !== "object") return t;
  try {
    if (ArrayIsArray(res)) return "array";
    const proto = ObjectGetPrototypeOf(res);
    if (proto === null) return "object";
    const ctor = ObjectGetOwnPropertyDescriptor(proto, "constructor")?.value;
    if (typeof ctor !== "function") return "object";
    const name = ObjectGetOwnPropertyDescriptor(ctor, "name")?.value;
    if (typeof name === "string" && name !== "Object" && RegExpPrototypeTest(TYPE_NAME, name)) return name;
  } catch {
    // A hostile Proxy: the generic name.
  }
  return "object";
}

/**
 * A Response to Rust, head first (ops.md section 6, "Response body"): a
 * static body crosses with the head in one piece; a body backed by a
 * ReadableStream crosses as `stream: true`, and `pumpBody` writes it chunk
 * by chunk after the head.
 */
async function serializeResponse(res, wantBody) {
  if (!ObjectPrototypeIsPrototypeOf(responseMod().ResponsePrototype, res)) {
    // #444: the type of what came back, never the value (it may hold tenant data or secrets).
    return { kind: KIND_NOT_RESPONSE, reason: "handler_result", name: resultTypeName(res) };
  }
  const headers = [];
  for (const pair of new SafeArrayIterator([...res.headers])) {
    ArrayPrototypePush(headers, [pair[0], pair[1]]);
  }
  // The inner body, read without the `body` getter, which would turn a
  // static body into a stream.
  const inner = responseMod().toInnerResponse(res)?.body ?? null;
  if (
    inner !== null &&
    ObjectPrototypeIsPrototypeOf(streamsMod().ReadableStreamPrototype, inner.streamOrStatic)
  ) {
    const stream = res.body;
    if (!wantBody) {
      // HEAD: the head only; the stream is never read.
      PromisePrototypeThen(stream.cancel(), undefined, () => {});
      return { kind: KIND_OK, status: res.status, headers, body: null };
    }
    pumpBody(currentToken(), stream);
    return { kind: KIND_OK, status: res.status, headers, body: null, stream: true };
  }
  let body = null;
  if (inner !== null) {
    const buf = await res.arrayBuffer();
    if (wantBody) body = new Uint8Array(buf);
  }
  return { kind: KIND_OK, status: res.status, headers, body };
}

/**
 * Writes a streamed body to Rust (ops.md section 6): each chunk through
 * op_response_write, which waits while Rust's buffer is full, then
 * op_response_end. Runs in the request's async context, so its CPU is the
 * request's and the stream's own ops keep working until it ends. When Rust
 * stops the stream (egress limit, deadline, client gone), the write rejects
 * and the handler's stream is cancelled.
 */
async function pumpBody(token, stream) {
  let reader;
  try {
    reader = stream.getReader();
  } catch (e) {
    op_response_end(token, safeString(e?.message ?? e));
    return;
  }
  for (;;) {
    let next;
    try {
      next = await reader.read();
    } catch (e) {
      op_response_end(token, describeThrow(e).message);
      return;
    }
    if (next.done) break;
    const chunk = next.value;
    if (!isUint8Array(chunk)) {
      const message = "TypeError: a response body chunk must be a Uint8Array";
      PromisePrototypeThen(reader.cancel(new TypeError(message)), undefined, () => {});
      op_response_end(token, message);
      return;
    }
    if (chunk.length === 0) continue;
    try {
      await op_response_write(token, chunk);
    } catch (e) {
      PromisePrototypeThen(reader.cancel(toRenoxError(e)), undefined, () => {});
      return;
    }
  }
  op_response_end(token, null);
}

function isResponse(v) {
  return ObjectPrototypeIsPrototypeOf(responseMod().ResponsePrototype, v);
}

/** JSON.stringify replacer: bigint as a decimal string; bytes refused. */
function dataReplacer(_key, value) {
  if (typeof value === "bigint") return String(value);
  if (value !== null && typeof value === "object" && isUint8Array(value)) {
    throw new TypeError("a Uint8Array cannot be template data");
  }
  return value;
}

/**
 * A loader's result that is not a Response (ops.md section 14, "Loader"):
 * a plain object becomes the template data, serialised here inside V8 and
 * parsed by the cell (the B9 path). Dates become ISO strings (toJSON),
 * undefined and functions are dropped, a cycle or bytes are refused.
 */
function pageResult(res, status = undefined) {
  if (res === null || typeof res !== "object" || ArrayIsArray(res)) {
    return { kind: KIND_PAGE_INTERNAL, reason: "load_result", name: res === null ? "null" : ArrayIsArray(res) ? "array" : typeof res };
  }
  let json;
  try {
    json = JSONStringify(res, dataReplacer);
  } catch (e) {
    return { kind: KIND_PAGE_INTERNAL, reason: "data_not_serialisable", name: safeString(e?.message) };
  }
  const out = { kind: KIND_RENDER, data_json: json };
  if (status !== undefined) out.status = status;
  // ops.md 1.3.0 section 14, "Locale": platform values beside the data.
  const st = stateVar.get();
  if (st?.locale !== undefined) {
    out.locale = st.locale;
    out.dir = st.dir;
  }
  return out;
}

/** The content types an action's `ctx.form` is parsed from (ops.md section 14). */
function isFormBody(req) {
  const type = StringPrototypeToLowerCase(req.headers.get("content-type") ?? "");
  return (
    StringPrototypeStartsWith(type, "application/x-www-form-urlencoded") ||
    StringPrototypeStartsWith(type, "multipart/form-data")
  );
}

/**
 * Runs one page action (ops.md section 14, "Actions"): the form is parsed,
 * the IMMEDIATE transaction opened, the action called with `ctx.db` bound to
 * it; commit when it resolves to a Response, an object, or nothing,
 * rollback when it throws or returns anything else. After an object, `load`
 * runs again (outside the transaction) and the data is
 * `{ ...loadResult, ...actionObject }` without `fragments`.
 */
async function runAction(action, load, st, owner, page, req, wantBody) {
  const token = currentToken();
  // The CSRF field was checked by the cell; tenant code never sees it.
  let form;
  if (isFormBody(req)) {
    form = await req.formData();
    form.delete("_csrf");
  } else {
    form = new (formDataMod().FormData)();
  }
  let tx;
  try {
    tx = await op_db_tx_begin(token, "immediate");
  } catch (e) {
    throw toRenoxError(e);
  }
  const rollback = async () => {
    try {
      await op_db_tx_rollback(token, tx);
    } catch {
      // The request may have ended; Rust rolls back in that case.
    }
  };
  let res;
  try {
    const ctx = ObjectFreeze({ ...st.ctxOf(owner), db: actionDb(tx, owner), form, action: page.action, fragment: page.fragment ?? null });
    // The action's transaction is current for the services it calls (ops.md 1.3.0 section 1).
    res = await within([[txVar, tx]], () => action(ctx));
  } catch (e) {
    await rollback();
    throw e;
  }
  if (res === undefined) res = {};
  const response = isResponse(res);
  if (!response) {
    const plain = res !== null && typeof res === "object" && !ArrayIsArray(res);
    if (!plain || !page.template) {
      // Anything but a Response or a plain object, or an object from a page
      // without a template: refused, and nothing is committed.
      await rollback();
      if (plain) return { kind: KIND_PAGE_INTERNAL, reason: "no_template", name: "object" };
      return { kind: KIND_PAGE_INTERNAL, reason: "action_result", name: res === null ? "null" : ArrayIsArray(res) ? "array" : typeof res };
    }
  }
  // ops.md 1.9.0 section 14, "Status": 200, 400, 409 or 422, an integer.
  let status;
  if (!response && res.status !== undefined) {
    status = res.status;
    if (status !== 200 && status !== 400 && status !== 409 && status !== 422) {
      await rollback();
      return { kind: KIND_PAGE_INTERNAL, reason: "action_result", name: "status" };
    }
  }
  let fragments = [];
  if (!response && res.fragments !== undefined) {
    const list = res.fragments;
    if (!ArrayIsArray(list) || ArrayPrototypeSome(list, (f) => typeof f !== "string")) {
      await rollback();
      return { kind: KIND_PAGE_INTERNAL, reason: "action_result", name: "fragments" };
    }
    fragments = ArrayPrototypeMap(list, (f) => f);
  }
  // A callee that threw rolled the transaction back (ops.md 1.3.0 section
  // 15.2): the action may still answer, but nothing of it is kept.
  if (!st.rolledBack.has(tx)) {
    try {
      await op_db_tx_commit(token, tx);
    } catch (e) {
      throw toRenoxError(e);
    }
  }
  if (response) return serializeResponse(res, wantBody);
  const actionData = { ...res };
  delete actionData.fragments;
  delete actionData.status;
  let data = actionData;
  if (load !== null) {
    const loaded = await load(st.ctxOf(owner));
    if (isResponse(loaded)) return serializeResponse(loaded, wantBody);
    if (loaded === null || typeof loaded !== "object" || ArrayIsArray(loaded)) return pageResult(loaded);
    data = { ...loaded, ...actionData };
  }
  const out = pageResult(data, status);
  if (out.kind === KIND_RENDER) out.fragments = fragments;
  return out;
}

/**
 * Called by Rust for every request. Runs the handler inside a fresh async
 * context carrying `token`; resolves to a plain object Rust deserialises.
 * Never rejects: every failure is described in the result.
 *
 * `page` is null for a function route, else `{ fragment, session, action,
 * template }`; for an action, `action` is the action function and
 * `handler` the page's `load` (or null).
 */
function dispatch(handler, token, method, url, headers, body, params, wantBody, page, action, owner = "app", realtime = null, webhook = null) {
  if (realtime !== null) return dispatchRealtime(handler, token, url, headers, body, params, owner, realtime);
  const previous = requestVar.enter(token);
  try {
    moduleVar.enter(owner);
    return PromisePrototypeThen(
      prelude(token, url, headers),
      (pre) => {
        if (pre.forbidden !== undefined) return pre.forbidden;
        if (handler !== null && typeof handler === "object" && typeof handler.lazy === "string") {
          return dispatchLazy(handler, token, method, url, headers, body, params, wantBody, page, owner, pre.principal, webhook);
        }
        return run(handler, token, method, url, headers, body, params, wantBody, page, action, owner, pre.principal, webhook);
      },
      describeThrow,
    );
  } finally {
    core.setAsyncContext(previous);
  }
}

/** The handler, once the principal is known and the guard passed. */
function run(handler, token, method, url, headers, body, params, wantBody, page, action, owner, principal, webhook = null) {
  const previous = requestVar.enter(token);
  try {
    moduleVar.enter(owner);
    let p;
    try {
      const init = { method, headers };
      if (body !== null && method !== "GET" && method !== "HEAD") init.body = body;
      const req = new (requestMod().Request)(url, init);
      const deadline = ObjectFreeze({
        remainingMs() {
          try {
            return op_deadline_remaining_ms(currentToken());
          } catch (e) {
            throw toRenoxError(e);
          }
        },
      });
      const base = {
        req,
        url: new (urlMod().URL)(url),
        params: ObjectFreeze(params),
        headers: req.headers,
        principal,
        deadline,
      };
      // ops.md 1.7.0 section 22: `ctx.webhook` on a webhook route.
      if (webhook !== null) base.webhook = makeWebhook(owner, req);
      const st = newRequestState(base);
      stateVar.enter(st);
      if (page !== null) {
        // LoaderContext / ActionContext (ops.md section 14).
        base.session = ObjectFreeze({ id: page.session });
        base.fragment = page.fragment ?? null;
        base.setLocale = makeSetLocale(st);
        if (action !== null) {
          return PromisePrototypeThen(runAction(action, handler, st, owner, page, req, wantBody), undefined, describeThrow);
        }
      }
      const ctx = st.ctxOf(owner);
      // A guarded page without `load`: the template gets `{}`.
      p = PromiseResolve(handler === null ? {} : handler(ctx));
      if (webhook !== null) p = PromisePrototypeThen(p, undefined, webhookOutcome);
    } catch (e) {
      p = PromiseReject(e);
    }
    return PromisePrototypeThen(
      p,
      (res) => {
        if (page !== null && !isResponse(res)) return pageResult(res);
        return PromisePrototypeThen(serializeResponse(res, wantBody), undefined, describeThrow);
      },
      describeThrow,
    );
  } finally {
    core.setAsyncContext(previous);
  }
}

/**
 * A `ws` / `sse` handler run (ops.md 1.5.0 section 18, "Dispatch"). Phase
 * `connect` is the prelude alone (principal and guard, before the
 * handshake); `open`, `message`, and `close` run the module's handler with
 * the principal resolved at connect, `ctx.conn`, and the phase's fields.
 */
function dispatchRealtime(handler, token, url, headers, body, params, owner, rt) {
  const previous = requestVar.enter(token);
  try {
    moduleVar.enter(owner);
    const go = async () => {
      if (rt.phase === "connect") {
        const pre = await prelude(token, url, headers);
        if (pre.forbidden !== undefined) return pre.forbidden;
        return { kind: KIND_REALTIME, result: "ok" };
      }
      const principal = freezePrincipal(op_authz_principal_cached(token).principal ?? null);
      let handlers = handler;
      if (handlers !== null && typeof handlers === "object" && typeof handlers.lazy === "string") {
        let p = lazyModules.get(handlers.lazy);
        if (p === undefined) {
          p = import(handlers.lazy);
          lazyModules.set(handlers.lazy, p);
        }
        let ns;
        try {
          ns = await p;
        } catch (e) {
          return lazyFailed(handlers, e);
        }
        const desc = handlers;
        handlers = ns[desc.export];
        if (handlers === null || typeof handlers !== "object") return lazyFailed(desc, new TypeError(`export ${desc.export} of ${desc.module} is missing or not an object`));
      }
      const h = handlers?.[rt.phase];
      if (typeof h !== "function") return { kind: KIND_REALTIME, result: "no_handler" };
      // #680: the Request and the URL are built when the handler reads
      // them, once per run; most `open` and `message` handlers never do.
      let req;
      let parsed;
      const reqOf = () => (req ??= new (requestMod().Request)(url, { method: "GET", headers }));
      const base = {
        get req() {
          return reqOf();
        },
        get url() {
          return (parsed ??= new (urlMod().URL)(url));
        },
        params: ObjectFreeze(params),
        get headers() {
          return reqOf().headers;
        },
        principal,
        deadline: requestDeadline,
        session: ObjectFreeze({ id: rt.session }),
        conn: ObjectFreeze({ id: rt.conn, transport: rt.transport }),
      };
      if (rt.phase === "message") base.data = rt.binary ? new Uint8Array(body ?? []) : rt.text;
      if (rt.phase === "close") base.close = ObjectFreeze({ code: rt.close_code, reason: rt.close_reason ?? "" });
      const st = newRequestState(base);
      const ctx = st.ctxOf(owner);
      await within([[stateVar, st]], () => h(ctx));
      return { kind: KIND_REALTIME, result: "ok" };
    };
    return PromisePrototypeThen(go(), undefined, describeThrow);
  } finally {
    core.setAsyncContext(previous);
  }
}

/**
 * Called by Rust for a call into module code that is not a request (#285):
 * `{ kind: "service", module, name, args }` (a service the platform needs,
 * through the broker, as the app) or `{ kind: "tool", name, input, client,
 * preview }` (ops.md 1.5.0 section 19: the tool's `run` with the owning
 * module's ctx without a request, the token's user as principal, and
 * `ctx.tool`; a preview runs inside a transaction that is always rolled
 * back). Resolves with `{ kind: KIND_INVOKE, result, data_json }`, or the
 * description of a throw.
 */
function invoke(token, env, handler, owner) {
  const previous = requestVar.enter(token);
  try {
    moduleVar.enter(env.kind === "tool" || env.kind === "cross" ? owner : "app");
    const principal = freezePrincipal(op_authz_principal_cached(token).principal ?? null);
    const st = newRequestState({ deadline: requestDeadline, principal });
    stateVar.enter(st);
    const go = async () => {
      if (env.kind === "cross") return await crossServe(st, env);
      if (env.kind === "service") {
        if (!hasService(env.module, env.name)) return { kind: KIND_INVOKE, result: "no_handler" };
        const value = await within([[stateVar, st]], () => callService(env.module, env.name, JSONParse(env.args)));
        return { kind: KIND_INVOKE, result: "ok", data_json: JSONStringify(value ?? null, dataReplacer) };
      }
      let def = handler;
      if (def !== null && typeof def === "object" && typeof def.lazy === "string") {
        let p = lazyModules.get(def.lazy);
        if (p === undefined) {
          p = import(def.lazy);
          lazyModules.set(def.lazy, p);
        }
        def = (await p)[def.export];
      }
      if (def === null || typeof def !== "object" || typeof def.run !== "function") return { kind: KIND_INVOKE, result: "no_handler" };
      // The tool's Cedar action as the token's user, before run (audited when sensitive).
      try {
        await op_authz_check(token, env.action, null, null, moduleArg(owner), true);
      } catch {
        return { kind: KIND_INVOKE, result: "forbidden" };
      }
      const tool = ObjectFreeze({ name: env.name, input: JSONParse(env.input), client: ObjectFreeze(JSONParse(env.client)), preview: env.preview === true });
      let output;
      if (env.preview === true) {
        let tx;
        try {
          tx = await op_db_tx_begin(token, "immediate");
        } catch (e) {
          throw toRenoxError(e);
        }
        const ctx = ObjectFreeze({ ...st.ctxOf(owner), db: makeDb(owner, null, tx), tool });
        try {
          output = await within([[txVar, tx], [stateVar, st]], () => def.run(ctx));
        } finally {
          try {
            await op_db_tx_rollback(token, tx);
          } catch {
            // Gone already (a callee rolled it back); Rust rolls back at the end anyway.
          }
        }
      } else {
        const ctx = ObjectFreeze({ ...st.ctxOf(owner), tool });
        output = await within([[stateVar, st]], () => def.run(ctx));
      }
      const json = JSONStringify(output === undefined ? null : output, dataReplacer);
      if (typeof json !== "string") return { kind: KIND_INVOKE, result: "ok", data_json: "null" };
      if (json.length > MAX_TOOL_OUTPUT) return { kind: KIND_INVOKE, result: "output_too_large" };
      return { kind: KIND_INVOKE, result: "ok", data_json: json };
    };
    return PromisePrototypeThen(go(), undefined, describeThrow);
  } finally {
    core.setAsyncContext(previous);
  }
}

/**
 * The callee side of a cross-isolate call (ops.md 1.7.0 section 15.6):
 * `{ what: "service" | "hook", caller, module, name, args, tx }`. The
 * statements join the caller's transaction `tx`; the result goes back as
 * JSON (a filler's Response as status, headers and body text).
 */
async function crossServe(st, env) {
  const tx = env.tx ?? 0;
  if (tx !== 0) st.borrowedTx = tx;
  const vars = [
    [stateVar, st],
    [moduleVar, env.module],
  ];
  if (tx !== 0) ArrayPrototypePush(vars, [txVar, tx]);
  const args = JSONParse(env.args);
  let value;
  if (env.what === "hook") {
    const f = ArrayPrototypeFind(await within(vars, () => fillersOf(env.name)), (x) => x.module === env.module && x.remote !== true);
    if (f === undefined) return { kind: KIND_INVOKE, result: "no_handler" };
    const r = await within(vars, () => f.handle(st.ctxOf(env.module), args));
    if (r === undefined) value = { halt: false };
    else if (r !== null && typeof r === "object" && r.halt === true && isResponse(r.response)) {
      const headers = [];
      for (const [k, v] of r.response.headers) ArrayPrototypePush(headers, [k, v]);
      value = { halt: true, response: { status: r.response.status, headers, body: await r.response.text() } };
    } else throw new TypeError("a hook filler returns undefined or { halt: true, response }");
  } else {
    if (!hasService(env.module, env.name)) return { kind: KIND_INVOKE, result: "no_handler" };
    const fn = serviceModules.get(env.module)?.[env.name] ?? (await within(vars, () => entryOf(env.module, "services", { module: env.module, service: env.name })))?.[env.name];
    value = await within(vars, () => fn(st.ctxOf(env.module), ...(ArrayIsArray(args) ? args : [])));
  }
  const json = JSONStringify(value ?? null, dataReplacer);
  if (typeof json !== "string") return { kind: KIND_INVOKE, result: "ok", data_json: "null" };
  if (json.length > MAX_CROSS) return { kind: KIND_INVOKE, result: "output_too_large" };
  return { kind: KIND_INVOKE, result: "ok", data_json: json };
}

/** Code entry specifier -> the promise of its namespace: one evaluation per isolate; a rejection stays cached until the isolate is replaced. */
const lazyModules = new SafeMap();
/** Module ids whose failure was reported already (logged once per isolate). */
const lazyReported = new SafeSet();

function lazyFailed(desc, err) {
  const d = describeThrow(err);
  const first = !lazyReported.has(desc.module);
  if (first) lazyReported.add(desc.module);
  return { kind: KIND_MODULE_EVAL, name: d.name, message: d.message, stack: d.stack, reason: desc.module, first };
}

/**
 * A route whose module is evaluated on first use (ops.md 1.4.0 section 11,
 * step 4): `desc` is `{ lazy, module, export, action }`. The module is
 * imported inside this request, so its top-level code runs with the
 * request's ops, deadline, and CPU; concurrent first requests share the one
 * evaluation. Then the handler and the action are looked up (step 5) and
 * the request goes on as for an eager route.
 */
function dispatchLazy(desc, token, method, url, headers, body, params, wantBody, page, owner, principal, webhook = null) {
  const previous = requestVar.enter(token);
  try {
    moduleVar.enter(owner);
    let p = lazyModules.get(desc.lazy);
    if (p === undefined) {
      p = import(desc.lazy);
      lazyModules.set(desc.lazy, p);
    }
    return PromisePrototypeThen(
      p,
      (ns) => {
        let handler = null;
        let action = null;
        if (desc.export !== null) {
          handler = ns[desc.export];
          if (typeof handler !== "function") return lazyFailed(desc, new TypeError(`export ${desc.export} of ${desc.module} is missing or not a function`));
        }
        if (desc.action !== null) {
          const actions = ns.actions;
          action = actions !== null && typeof actions === "object" ? actions[desc.action] : undefined;
          if (typeof action !== "function") return lazyFailed(desc, new TypeError(`action ${desc.action} of ${desc.module} is missing or not a function`));
        }
        return run(handler, token, method, url, headers, body, params, wantBody, page, action, owner, principal, webhook);
      },
      (e) => lazyFailed(desc, e),
    );
  } finally {
    core.setAsyncContext(previous);
  }
}

/**
 * Called by Rust for one delivery attempt of a durable event (ops.md 1.3.0
 * section 15.4, "Delivery"): `module`'s `on[name]` runs with a fresh ctx of
 * that module, `db` its own IMMEDIATE transaction; when it resolves, the
 * delivery is acknowledged in that transaction and it commits. Never rejects.
 */
function deliver(token, id, name, payloadJson, attempt, module, job) {
  if (job !== null && job !== undefined) return deliverJob(token, id, payloadJson, attempt, module, job);
  const previous = requestVar.enter(token);
  try {
    moduleVar.enter(module);
    const on = eventHandlers.get(module);
    const recorded = on instanceof LazyOn ? ArrayPrototypeIncludes(on.names, name) : typeof on?.[name] === "function";
    if (!recorded) return PromiseResolve({ kind: KIND_EVENT, result: "no_handler" });
    const st = newRequestState({
      deadline: requestDeadline,
      // ops.md 1.5.0 section 17: event handlers run as Renox::System::"<module>".
      principal: freezePrincipal({ id: module, kind: "system", roles: [], attrs: {} }),
    });
    stateVar.enter(st);
    const run = async () => {
      let tx;
      try {
        tx = await op_db_tx_begin(token, "immediate");
      } catch (e) {
        throw toRenoxError(e);
      }
      const e = ObjectFreeze({ id, name, payload: JSONParse(payloadJson), attempt });
      const hctx = eventCtx(st.ctxOf(module), module, actionDb(tx, module), e);
      try {
        // ops.md 1.14.0: a lazy handler module is evaluated inside the attempt; a failure is a failed attempt.
        const h = await within([[txVar, tx]], () => handlerOf(module, name, { module, event: name }));
        if (typeof h !== "function") throw new TypeError(`${module}: on["${name}"] is not a function`);
        await within([[txVar, tx]], () => h(hctx, e));
        if (st.rolledBack.has(tx)) throw new ModuleServiceError(`${module} handler of ${name}: a callee failed`, { module, event: name, cause_code: null });
        await op_events_ack(token, tx, id, module);
        await op_db_tx_commit(token, tx);
      } catch (err) {
        if (!st.rolledBack.has(tx)) {
          try {
            await op_db_tx_rollback(token, tx);
          } catch {
            // The request may have ended; Rust rolls back in that case.
          }
        }
        throw err;
      }
      return { kind: KIND_EVENT, result: "ok" };
    };
    return PromisePrototypeThen(run(), undefined, (err) => ({ ...describeThrow(err), kind: KIND_EVENT, result: "threw" }));
  } finally {
    core.setAsyncContext(previous);
  }
}

/**
 * Called by Rust for one attempt of a job run (ops.md 1.6.0 section 20,
 * "Delivery path"): `job` is `{ name, tick, handler }`, `handler` the
 * module's exported `run` (or its lazy descriptor), null when the active
 * deployment has no such job. `run(ctx)` gets a JobContext with its own
 * IMMEDIATE transaction and the System principal of its module; when it
 * resolves, the run is acknowledged in that transaction and it commits.
 * Never rejects.
 */
function deliverJob(token, id, payloadJson, attempt, module, job) {
  const previous = requestVar.enter(token);
  try {
    moduleVar.enter(module);
    const st = newRequestState({
      deadline: requestDeadline,
      // docs/11: jobs run as Renox::System::"<module>", never as a superuser.
      principal: freezePrincipal({ id: module, kind: "system", roles: [], attrs: {} }),
    });
    stateVar.enter(st);
    const go = async () => {
      let fn = job.handler;
      if (fn !== null && typeof fn === "object" && typeof fn.lazy === "string") {
        let p = lazyModules.get(fn.lazy);
        if (p === undefined) {
          p = import(fn.lazy);
          lazyModules.set(fn.lazy, p);
        }
        fn = (await p)[fn.export];
      }
      if (typeof fn !== "function") return { kind: KIND_EVENT, result: "no_handler" };
      let tx;
      try {
        tx = await op_db_tx_begin(token, "immediate");
      } catch (e) {
        throw toRenoxError(e);
      }
      const tick = typeof job.tick === "number" ? job.tick : null;
      const info = ObjectFreeze({ id, name: job.name, tick, attempt, payload: payloadJson === "null" ? null : ObjectFreeze(JSONParse(payloadJson)) });
      const jctx = jobCtx(st.ctxOf(module), actionDb(tx, module), info);
      try {
        await within([[txVar, tx]], () => fn(jctx));
        if (st.rolledBack.has(tx)) throw new ModuleServiceError(`${module} job ${job.name}: a callee failed`, { module, job: job.name, cause_code: null });
        await op_jobs_ack(token, tx, id, module, job.name, tick);
        await op_db_tx_commit(token, tx);
      } catch (err) {
        if (!st.rolledBack.has(tx)) {
          try {
            await op_db_tx_rollback(token, tx);
          } catch {
            // The request may have ended; Rust rolls back in that case.
          }
        }
        throw err;
      }
      return { kind: KIND_EVENT, result: "ok" };
    };
    return PromisePrototypeThen(go(), undefined, (err) => ({ ...describeThrow(err), kind: KIND_EVENT, result: "threw" }));
  } finally {
    core.setAsyncContext(previous);
  }
}

// ---------------------------------------------------------------------------
// Global hardening (ops.md section 11, step 2, and the README's table).

const REMOVED_GLOBALS = [
  // File system, environment, sockets, subprocesses, Deno.core.
  "Deno",
  // Outbound connections that would bypass op_renox_fetch.
  "WebSocket",
  "WebSocketStream",
  "EventSource",
  // No persistence except ctx.db.
  "caches",
  "localStorage",
  "sessionStorage",
  "indexedDB",
  // Spectre-class timers; also absent by the V8 flag.
  "SharedArrayBuffer",
  // Web workers are not supported by the platform (one isolate per
  // deployment), and BroadcastChannel has no use without them.
  "Worker",
  "BroadcastChannel",
  // close() ends the whole process in deno_runtime; alert/confirm/prompt
  // read the worker's stdin.
  "close",
  "closed",
  "alert",
  "confirm",
  "prompt",
  // Deno-specific window events and the unstable/Node-only names.
  "onbeforeunload",
  "onunload",
  "onload",
  "Temporal",
  // Node's process global: exit, env, stdin, cwd, memoryUsage. npm code
  // guards it with `typeof process`.
  "process",
  // Constructors of APIs that have no instance here.
  "Cache",
  "CacheStorage",
  "Storage",
];

function takeSecrets(module) {
  const s = op_secrets_get_all(moduleArg(module));
  const own = {};
  for (const k of new SafeArrayIterator(ObjectKeys(s))) own[k] = s[k];
  return ObjectFreeze(own);
}

function harden(modulesJson) {
  // Step 3: the module list, then the secrets, once per module (a second
  // call is RENOX_SECRETS_CONSUMED).
  for (const info of new SafeArrayIterator(JSONParse(modulesJson ?? "[]"))) modules.set(info.name, ObjectFreeze(info));
  secrets = takeSecrets("app");
  for (const name of new SafeArrayIterator([...modules.keys()])) moduleSecrets.set(name, takeSecrets(name));
  serviceProxies = buildProxies();
  // `import { auth } from "renox:modules"` (loader.rs): the same proxies as
  // ctx.services; the caller is the module whose code runs.
  ObjectDefineProperty(globalThis, "__renoxModules", { value: serviceProxies, writable: false, enumerable: false, configurable: false });
  for (const name of new SafeArrayIterator(REMOVED_GLOBALS)) {
    ReflectDeleteProperty(globalThis, name);
    if (ObjectGetOwnPropertyDescriptor(globalThis, name) !== undefined) {
      throw new TypeError(`renox: global ${name} could not be removed`);
    }
  }
  // navigator: no GPU access, and no host platform details.
  const nav = globalThis.navigator;
  if (nav) {
    const navProto = ObjectGetPrototypeOf(nav);
    for (const name of new SafeArrayIterator(["gpu", "userAgentData", "platform"])) {
      ReflectDeleteProperty(navProto, name);
    }
  }
  // WebGPU: needs a GPU and native code paths we do not want.
  for (const name of new SafeArrayIterator(ObjectGetOwnPropertyNames(globalThis))) {
    if (StringPrototypeStartsWith(name, "GPU")) ReflectDeleteProperty(globalThis, name);
  }
  // console: through op_log, with redaction and the rate limit (section 4).
  ObjectDefineProperty(globalThis, "console", {
    value: makeConsole(globalThis.console),
    writable: true,
    enumerable: false,
    configurable: true,
  });
  // fetch: the op_renox_fetch-backed implementation (ops.md section 2).
  ObjectDefineProperty(globalThis, "fetch", {
    value: renoxFetch,
    writable: true,
    enumerable: true,
    configurable: true,
  });
  // Shared WebAssembly.Memory would hand out a SharedArrayBuffer; the V8
  // flag hides only the constructor. The descriptor is copied first so a
  // getter cannot answer differently on the second read. A wasm module that
  // declares its own shared memory is the remaining gap (README, "Hidden
  // globals"); without Worker there is no second thread to build a timer.
  const WasmMemory = globalThis.WebAssembly.Memory;
  function Memory(descriptor) {
    if (new.target === undefined) throw new TypeError("WebAssembly.Memory must be called with new");
    const d = { ...descriptor };
    if (d.shared) throw new TypeError("shared WebAssembly.Memory is not available");
    return ReflectConstruct(WasmMemory, [d], new.target === Memory ? WasmMemory : new.target);
  }
  Memory.prototype = WasmMemory.prototype;
  ObjectDefineProperty(WasmMemory.prototype, "constructor", { value: Memory, writable: true, configurable: true });
  ObjectDefineProperty(globalThis.WebAssembly, "Memory", { value: Memory, writable: true, configurable: true });
  // Swallow unhandled rejections so a stray promise in tenant code does not
  // end the isolate's event loop; the rejection is the tenant's to log.
  globalThis.addEventListener("unhandledrejection", (e) => e.preventDefault());
}

ObjectDefineProperty(globalThis, "__renoxInternal", {
  value: ObjectFreeze({ dispatch, deliver, invoke, harden, register }),
  writable: false,
  enumerable: false,
  configurable: true,
});

