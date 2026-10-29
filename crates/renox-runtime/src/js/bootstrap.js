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
  op_db_savepoint_begin,
  op_db_savepoint_release,
  op_db_savepoint_rollback,
  op_db_tx_begin,
  op_db_tx_commit,
  op_db_tx_rollback,
  op_deadline_remaining_ms,
  op_events_ack,
  op_events_emit,
  op_password_hash,
  op_password_verify,
  op_renox_fetch,
  op_fetch_body_close,
  op_fetch_body_read,
  op_log,
  op_response_end,
  op_response_write,
  op_secrets_get_all,
} from "ext:core/ops";

const {
  ArrayIsArray,
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
// (section 1, "Module argument"), and the service call depth.
const moduleVar = new core.AsyncVariable();
const stateVar = new core.AsyncVariable();
const txVar = new core.AsyncVariable();
const depthVar = new core.AsyncVariable();

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

async function dbCall(op, sql, params, tx, module) {
  const token = currentToken();
  if (typeof sql !== "string") throw new RenoxError("RENOX_DB_PARAM", "sql must be a string");
  const [wire, bytes] = encodeParams(params);
  try {
    return await op(token, sql, wire, bytes, tx, moduleArg(module));
  } catch (e) {
    throw toRenoxError(e);
  }
}

/**
 * Statements under `module`'s authorizer. `tx` is a transaction handle, 0
 * for none, or "current": the request's current transaction at call time
 * (ops.md 1.3.0 section 1), which is how a service called from an action
 * writes in the action's transaction.
 */
function statements(tx, module = "app") {
  const handle = () => (tx === "current" ? (txVar.get() ?? 0) : tx);
  return ObjectFreeze({
    async query(sql, params) {
      return toRows(await dbCall(op_db_query, sql, params, handle(), module));
    },
    async queryOne(sql, params) {
      const rows = toRows(await dbCall(op_db_query_one, sql, params, handle(), module));
      return rows.length === 0 ? null : rows[0];
    },
    async execute(sql, params) {
      const r = await dbCall(op_db_execute, sql, params, handle(), module);
      return { changes: r.changes, lastInsertRowid: decodeCell(r.lastInsertRowid) };
    },
  });
}

/**
 * `ctx.db` of `module`. The app's statements keep the 1.2 rule (no
 * transaction unless through `tx`); a module's run in the current one.
 * `transaction(fn)` is IMMEDIATE, or a savepoint when a transaction is
 * current (ops.md 1.3.0 section 1, "Savepoints").
 */
function makeDb(module) {
  return ObjectFreeze({
    ...statements(module === "app" ? 0 : "current", module),
    async transaction(fn) {
      const token = currentToken();
      const outer = txVar.get();
      if (outer !== undefined && outer !== 0) {
        let sp;
        try {
          sp = await op_db_savepoint_begin(token, outer);
        } catch (e) {
          throw toRenoxError(e);
        }
        let result;
        try {
          result = await within([[txVar, outer]], () => fn(statements(outer, module)));
        } catch (e) {
          try {
            await op_db_savepoint_rollback(token, outer, sp);
          } catch {
            // The transaction itself may be gone (rolled back by the broker).
          }
          throw e;
        }
        try {
          await op_db_savepoint_release(token, outer, sp);
        } catch (e) {
          throw toRenoxError(e);
        }
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
        result = await within([[txVar, tx]], () => fn(statements(tx, module)));
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
/** Module name -> the `on` map of its `hooks.ts` (events, #231). */
const eventHandlers = new SafeMap();
/** Installed module name -> frozen proxies of its services (renox:modules, ctx.services). */
let serviceProxies = ObjectFreeze({});
const MAX_CALL_DEPTH = 16;

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
 * A callee threw: roll the current transaction back at once (ops.md 1.3.0
 * section 15.2, "Errors"), log the callee's error with its module, and
 * hand the caller a ModuleServiceError.
 */
async function calleeFailed(e, details, label) {
  const st = stateVar.get();
  const tx = txVar.get();
  if (tx !== undefined && tx !== 0 && st !== undefined && !st.rolledBack.has(tx)) {
    st.rolledBack.add(tx);
    try {
      await op_db_tx_rollback(currentToken(), tx);
    } catch {
      // Already gone.
    }
  }
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
  const fn = serviceModules.get(target)?.[service];
  const calleeCtx = st.ctxOf(target);
  try {
    return await within(
      [
        [moduleVar, target],
        [depthVar, depth],
      ],
      () => fn(calleeCtx, ...args),
    );
  } catch (e) {
    throw await calleeFailed(e, { module: target, service }, `${target}.${service}`);
  }
}

/** `ctx.hooks` of `module` (ops.md 1.3.0 section 15.3). */
function makeHooks(module) {
  return ObjectFreeze({
    async run(name, args) {
      const st = requestState();
      if (!ArrayPrototypeIncludes(infoOf(module)?.exports?.hooks ?? [], name)) {
        throw new ModuleUndeclaredError(`module ${module} does not export hook ${name}`, { module, target: name });
      }
      for (const f of new SafeArrayIterator(hookFillers.get(name) ?? [])) {
        const fillerCtx = st.ctxOf(f.module);
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

/** Called by Rust after the tenant modules loaded (ops.md 1.3.0 section 11, step 5). */
function register(namespaces) {
  for (const [name, info] of new SafeArrayIterator([...modules])) {
    const ns = namespaces[name] ?? {};
    const services = ns.services;
    for (const svc of new SafeArrayIterator(info.exports?.services ?? [])) {
      if (typeof services?.[svc] !== "function") {
        throw new TypeError(`module ${name}: service ${svc} is not a function export of services.ts`);
      }
    }
    if (services !== undefined) serviceModules.set(name, services);
    const hooksNs = ns.hooks;
    const fills = hooksNs?.hooks;
    if (fills !== undefined && fills !== null) {
      for (const hook of new SafeArrayIterator(ObjectKeys(fills))) {
        if (!ArrayPrototypeIncludes(info.permissions?.hooks ?? [], hook)) {
          throw new TypeError(`module ${name}: hooks.ts fills ${hook}, which its manifest does not declare`);
        }
        const filler = fills[hook];
        if (typeof filler?.handle !== "function") throw new TypeError(`module ${name}: hooks.${hook}.handle is not a function`);
        const priority = filler.priority ?? 100;
        if (typeof priority !== "number" || priority < 0 || priority > 1000) throw new TypeError(`module ${name}: hooks.${hook}.priority must be 0-1000`);
        const list = hookFillers.get(hook) ?? [];
        ArrayPrototypePush(list, { module: name, priority, handle: filler.handle });
        hookFillers.set(hook, list);
      }
    }
    const on = hooksNs?.on;
    if (on !== undefined && on !== null) {
      for (const [ev, h] of new SafeArrayIterator(ObjectEntries(on))) {
        if (typeof h !== "function") throw new TypeError(`module ${name}: on["${ev}"] is not a function`);
      }
      eventHandlers.set(name, on);
    }
  }
  for (const list of new SafeArrayIterator([...hookFillers.values()])) {
    ArrayPrototypeSort(list, (a, b) => a.priority - b.priority || (a.module < b.module ? -1 : a.module > b.module ? 1 : 0));
  }
  // Module -> the events it handles: the cell fans durable events out to them.
  const handled = {};
  for (const [name, on] of new SafeArrayIterator([...eventHandlers])) handled[name] = ObjectKeys(on);
  return handled;
}

/**
 * Runs the in-memory handlers of `name` (ops.md 1.3.0 section 15.4): each
 * installed module's `on[name]`, in the modules order, with its own ctx and
 * the emitter's current transaction. A throw rolls the transaction back and
 * fails the emit.
 */
async function runInMemory(st, id, name, payload) {
  for (const [m, on] of new SafeArrayIterator([...eventHandlers])) {
    const h = on[name];
    if (typeof h !== "function") continue;
    const e = ObjectFreeze({ id, name, payload, attempt: 1 });
    const hctx = eventCtx(st.ctxOf(m), m, statements("current", m), e);
    try {
      await within([[moduleVar, m]], () => h(hctx, e));
    } catch (err) {
      throw await calleeFailed(err, { module: m, event: name }, `${m} handler of ${name}`);
    }
  }
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
    ctxOf(m) {
      let c = cache.get(m);
      if (c === undefined) {
        c = ObjectFreeze({ ...st.base, ...moduleFields(m) });
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

/**
 * A Response to Rust, head first (ops.md section 6, "Response body"): a
 * static body crosses with the head in one piece; a body backed by a
 * ReadableStream crosses as `stream: true`, and `pumpBody` writes it chunk
 * by chunk after the head.
 */
async function serializeResponse(res, wantBody) {
  if (!ObjectPrototypeIsPrototypeOf(responseMod().ResponsePrototype, res)) {
    return { kind: KIND_NOT_RESPONSE, name: typeof res };
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
  const out = { kind: KIND_RENDER, data_json: json };
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
    const ctx = ObjectFreeze({ ...st.ctxOf(owner), db: statements(tx, owner), form, action: page.action, fragment: page.fragment ?? null });
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
  let data = actionData;
  if (load !== null) {
    const loaded = await load(st.ctxOf(owner));
    if (isResponse(loaded)) return serializeResponse(loaded, wantBody);
    if (loaded === null || typeof loaded !== "object" || ArrayIsArray(loaded)) return pageResult(loaded);
    data = { ...loaded, ...actionData };
  }
  const out = pageResult(data);
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
function dispatch(handler, token, method, url, headers, body, params, wantBody, page, action, owner = "app") {
  if (handler !== null && typeof handler === "object" && typeof handler.lazy === "string") {
    return dispatchLazy(handler, token, method, url, headers, body, params, wantBody, page, owner);
  }
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
        deadline,
      };
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
function dispatchLazy(desc, token, method, url, headers, body, params, wantBody, page, owner) {
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
        return dispatch(handler, token, method, url, headers, body, params, wantBody, page, action, owner);
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
function deliver(token, id, name, payloadJson, attempt, module) {
  const previous = requestVar.enter(token);
  try {
    moduleVar.enter(module);
    const h = eventHandlers.get(module)?.[name];
    if (typeof h !== "function") return PromiseResolve({ kind: KIND_EVENT, result: "no_handler" });
    const st = newRequestState({
      deadline: ObjectFreeze({
        remainingMs() {
          try {
            return op_deadline_remaining_ms(currentToken());
          } catch (e) {
            throw toRenoxError(e);
          }
        },
      }),
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
      const hctx = eventCtx(st.ctxOf(module), module, statements(tx, module), e);
      try {
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
  value: ObjectFreeze({ dispatch, deliver, harden, register }),
  writable: false,
  enumerable: false,
  configurable: true,
});

