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
  op_db_execute,
  op_db_query,
  op_db_query_one,
  op_db_tx_begin,
  op_db_tx_commit,
  op_db_tx_rollback,
  op_deadline_remaining_ms,
  op_renox_fetch,
  op_fetch_body_close,
  op_fetch_body_read,
  op_log,
  op_secrets_get_all,
} from "ext:core/ops";

const {
  ArrayIsArray,
  ArrayPrototypeJoin,
  ArrayPrototypeMap,
  ArrayPrototypePush,
  BigInt,
  Error,
  ErrorPrototype,
  JSONStringify,
  ObjectDefineProperty,
  ObjectFreeze,
  ObjectKeys,
  ObjectGetOwnPropertyDescriptor,
  ObjectGetOwnPropertyNames,
  ObjectGetPrototypeOf,
  ObjectPrototypeIsPrototypeOf,
  PromisePrototypeThen,
  PromiseReject,
  PromiseResolve,
  ReflectConstruct,
  ReflectDeleteProperty,
  SafeArrayIterator,
  String,
  StringPrototypeIsWellFormed,
  StringPrototypeStartsWith,
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
  return new RenoxError(code, msg.slice(second + 1), details ?? undefined);
}

// ---------------------------------------------------------------------------
// fetch (ops.md section 2). Replaces the global `fetch`; also `ctx.fetch`.

async function renoxFetch(input, init = undefined) {
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

async function dbCall(op, sql, params, tx) {
  const token = currentToken();
  if (typeof sql !== "string") throw new RenoxError("RENOX_DB_PARAM", "sql must be a string");
  const [wire, bytes] = encodeParams(params);
  try {
    return await op(token, sql, wire, bytes, tx);
  } catch (e) {
    throw toRenoxError(e);
  }
}

function statements(tx) {
  return ObjectFreeze({
    async query(sql, params) {
      return toRows(await dbCall(op_db_query, sql, params, tx));
    },
    async queryOne(sql, params) {
      const rows = toRows(await dbCall(op_db_query_one, sql, params, tx));
      return rows.length === 0 ? null : rows[0];
    },
    async execute(sql, params) {
      const r = await dbCall(op_db_execute, sql, params, tx);
      return { changes: r.changes, lastInsertRowid: decodeCell(r.lastInsertRowid) };
    },
  });
}

const db = ObjectFreeze({
  ...statements(0),
  /** IMMEDIATE transaction: commit when fn resolves, rollback when it throws. */
  async transaction(fn) {
    const token = currentToken();
    let tx;
    try {
      tx = await op_db_tx_begin(token, "immediate");
    } catch (e) {
      throw toRenoxError(e);
    }
    let result;
    try {
      result = await fn(statements(tx));
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
    op_log(currentToken(), level, safeString(message), f);
  } catch {
    // Logging never throws into tenant code.
  }
}

const log = ObjectFreeze({
  debug: (message, fields) => writeLog("debug", message, fields),
  info: (message, fields) => writeLog("info", message, fields),
  warn: (message, fields) => writeLog("warn", message, fields),
  error: (message, fields) => writeLog("error", message, fields),
});

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
// Secrets (ops.md section 3): taken once by harden(), before tenant code.

let secrets = ObjectFreeze({});

// ---------------------------------------------------------------------------
// Request dispatch (ops.md section 11, step 6).

const KIND_OK = 0;
const KIND_THROW = 1;
const KIND_NOT_RESPONSE = 2;
// Page loaders (ops.md section 14): an object becomes template data.
const KIND_RENDER = 3;
const KIND_PAGE_INTERNAL = 4;

function safeString(v) {
  try {
    return String(v);
  } catch {
    return "<unprintable>";
  }
}

function describeThrow(err) {
  let name = "Error";
  let message = "";
  let stack = "";
  let code = null;
  try {
    if (ObjectPrototypeIsPrototypeOf(ErrorPrototype, err)) {
      name = safeString(err.name);
      message = safeString(err.message);
      stack = safeString(err.stack);
      if (typeof err.code === "string" && StringPrototypeStartsWith(err.code, "RENOX_")) code = err.code;
    } else {
      name = typeof err;
      message = safeString(err);
    }
  } catch {
    // A hostile getter: keep what we have.
  }
  return { kind: KIND_THROW, name, message, stack, code };
}

async function serializeResponse(res, wantBody) {
  if (!ObjectPrototypeIsPrototypeOf(responseMod().ResponsePrototype, res)) {
    return { kind: KIND_NOT_RESPONSE, name: typeof res };
  }
  const headers = [];
  for (const pair of new SafeArrayIterator([...res.headers])) {
    ArrayPrototypePush(headers, [pair[0], pair[1]]);
  }
  let body = null;
  if (res.body !== null) {
    const buf = await res.arrayBuffer();
    if (wantBody) body = new Uint8Array(buf);
  }
  return { kind: KIND_OK, status: res.status, headers, body };
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
function pageResult(res) {
  if (res === null || typeof res !== "object" || ArrayIsArray(res)) {
    return { kind: KIND_PAGE_INTERNAL, reason: "load_result", name: res === null ? "null" : ArrayIsArray(res) ? "array" : typeof res };
  }
  let json;
  try {
    json = JSONStringify(res, dataReplacer);
  } catch (e) {
    return { kind: KIND_PAGE_INTERNAL, reason: "data_not_serialisable", name: safeString(e?.message) };
  }
  return { kind: KIND_RENDER, data_json: json };
}

/**
 * Called by Rust for every request. Runs the handler inside a fresh async
 * context carrying `token`; resolves to a plain object Rust deserialises.
 * Never rejects: every failure is described in the result.
 */
function dispatch(handler, token, method, url, headers, body, params, wantBody, page) {
  const previous = requestVar.enter(token);
  try {
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
      const fields = {
        req,
        url: new (urlMod().URL)(url),
        params: ObjectFreeze(params),
        headers: req.headers,
        db,
        fetch: renoxFetch,
        secrets,
        log,
        deadline,
      };
      // LoaderContext (ops.md section 14): the fragment the cell renders.
      if (page !== null) fields.fragment = page.fragment ?? null;
      const ctx = ObjectFreeze(fields);
      p = PromiseResolve(handler(ctx));
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

function harden() {
  // Step 3: the secrets, once (a second call is RENOX_SECRETS_CONSUMED).
  const s = op_secrets_get_all();
  const own = {};
  for (const k of new SafeArrayIterator(ObjectKeys(s))) own[k] = s[k];
  secrets = ObjectFreeze(own);
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
  value: ObjectFreeze({ dispatch, harden }),
  writable: false,
  enumerable: false,
  configurable: true,
});

