// renox-client.js (#127; docs/contracts/client-events.md): the platform
// script every page loads first in <head> (crates/renox-template/src/shell.rs).
// It captures browser errors, htmx failures, and CSP violations, adds the
// page's request id and deployment, and sends them in batches to
// /__renox/events with navigator.sendBeacon (fetch keepalive as fallback).
// Each event is also dispatched as a `renox:error` DOM event, so an app can
// show a toast; under `renox dev` the overlay's Browser tab listens to it.
//
// Privacy (contract section 8): no cookies, form values, storage, or full
// user agent are read; URLs lose their query and fragment (the page URL keeps
// its query); strings are cut to 2,048 code points.
//
// Built by sdk/client/build.ts from main.ts (which installs it on the page)
// into crates/renox-gateway/assets/renox-client.js (no dependencies, at most
// 4 KB gzipped).

export const EVENTS_URL = "/__renox/events";
const MAX_STR = 2048;
const MAX_EVENTS = 50;
const BATCH = 20;
const DEDUPE_MS = 10_000;
const FLUSH_MS = 1000;

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type ClientEvent = {
  kind: string;
  ts: number;
  url: string;
  request_id: string | null;
  deployment: string | null;
  ua: string;
  session_fingerprint: string;
  code?: string | null;
  extra?: Record<string, Json>;
  detail: Record<string, Json>;
};

/** What the script needs from the browser; tests pass fakes. */
export interface Env {
  window: EventTarget;
  document: EventTarget & { querySelector(s: string): { getAttribute(n: string): string | null } | null };
  location: { origin: string; pathname: string; search: string; href: string };
  navigator: { userAgent: string; sendBeacon?: (url: string, body: string) => boolean };
  console: { error: (...a: unknown[]) => void };
  fetch?: (url: string, init: RequestInit) => Promise<unknown>;
  now: () => number;
  random: (bytes: Uint8Array) => Uint8Array;
  setTimeout: (f: () => void, ms: number) => unknown;
  CustomEvent: typeof CustomEvent;
}

/** At most 2,048 code points; a longer string ends in "…". */
export const cut = (s: unknown, max = MAX_STR): string => {
  const a = Array.from(String(s ?? ""));
  return a.length > max ? `${a.slice(0, max - 1).join("")}…` : a.join("");
};

/** A resource URL: same origin → path; cross origin → origin and path; never a query or fragment. Null for other schemes. */
export const resource = (u: unknown, origin: string): string | null => {
  try {
    const p = new URL(String(u), origin);
    if (!/^https?:$/u.test(p.protocol)) return null;
    const path = cut(p.pathname.replace(/\s/gu, "%20"), 1500);
    return p.origin === origin ? path : `${p.origin}${path}`;
  } catch {
    return null;
  }
};

/** The browser family, never more. */
export const uaFamily = (ua: string): string =>
  /SamsungBrowser\//u.test(ua) ? "samsung" : /Edg(A|iOS)?\//u.test(ua) ? "edge" : /Firefox\/|FxiOS\//u.test(ua) ? "firefox" : /Chrome\/|CriOS\//u.test(ua) ? "chrome" : /Safari\//u.test(ua) ? "safari" : "other";

/** Stack frames `{ file, line, column, function }` from a V8 or Firefox/Safari stack; at most 50. */
export const frames = (stack: unknown, origin: string): Json[] => {
  const out: Json[] = [];
  for (const l of String(stack ?? "").split("\n")) {
    const m = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/u.exec(l) ?? /^(.*?)@(.+?):(\d+):(\d+)$/u.exec(l);
    const file = m && resource(m[2], origin);
    if (!m || !file) continue;
    const f: Record<string, Json> = { file, line: Number(m[3]), column: Number(m[4]) };
    if (m[1]) f.function = cut(m[1], 256);
    out.push(f);
    if (out.length === 50) break;
  }
  return out;
};

/** `RENOX_*` from a JSON error body or the `renox-error-code` meta tag of an HTML error page. */
export const codeOf = (body: unknown): string | null => {
  const s = String(body ?? "");
  const m = /"code"\s*:\s*"(RENOX_[A-Z0-9_]+)"/u.exec(s) ?? /name="renox-error-code" content="(RENOX_[A-Z0-9_]+)"/u.exec(s);
  return m ? (m[1] as string).slice(0, 64) : null;
};

const CODE = /^RENOX_[A-Z0-9]+(_[A-Z0-9]+)*$/u;
const KEY = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/u;

export function install(env: Env): { flush: () => void; setExtra: (x: Record<string, unknown>) => void; queue: ClientEvent[] } {
  const { window: w, document: d, location: loc } = env;
  const meta = (n: string): string | null => d.querySelector(`meta[name="${n}"]`)?.getAttribute("content") ?? null;
  const pageId = meta("renox-request-id");
  const dep = meta("renox-deployment");
  const deployment = dep && /^[0-9a-f]{64}$/u.test(dep) ? dep : null;
  const pageCode = meta("renox-error-code");
  const dev = meta("renox-dev") !== null;
  const rate = Number(meta("renox-events-sample") ?? 1);
  const sampled = env.random(new Uint8Array(1))[0]! / 256 < rate;
  const fp = Array.from(env.random(new Uint8Array(16)), (b) => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"[b & 63]).join("");
  const ua = uaFamily(env.navigator.userAgent);
  const origin = loc.origin;
  const page = (): string => cut(loc.pathname + loc.search);
  const queue: ClientEvent[] = [];
  const seen = new Map<string, number>();
  let count = 0;
  let extra: Record<string, Json> | undefined;
  let timer: unknown = null;

  const send = (events: ClientEvent[]): void => {
    const body = JSON.stringify({ v: 0, events });
    if (env.navigator.sendBeacon?.(EVENTS_URL, body)) return;
    env.fetch?.(EVENTS_URL, { method: "POST", body, keepalive: true, headers: { "content-type": "text/plain;charset=UTF-8" } })?.catch?.(() => {});
  };
  const flush = (): void => {
    timer = null;
    while (queue.length) send(queue.splice(0, BATCH));
  };

  const emit = (kind: string, detail: Record<string, Json>, requestId: string | null = pageId, code: string | null = null): void => {
    const now = env.now();
    const key = `${kind}|${JSON.stringify(detail)}`;
    if ((seen.get(key) ?? -Infinity) > now - DEDUPE_MS) return;
    seen.set(key, now);
    if (count >= MAX_EVENTS) return;
    count++;
    const e: ClientEvent = {
      kind,
      ts: Math.floor(now),
      url: page(),
      request_id: requestId && /^[0-9A-Za-z_-]{8,64}$/u.test(requestId) ? requestId : null,
      deployment,
      ua,
      session_fingerprint: fp,
      detail,
    };
    const c = code ?? pageCode;
    if (c && CODE.test(c)) e.code = c;
    if (extra) e.extra = extra;
    try {
      d.dispatchEvent(new env.CustomEvent("renox:error", { detail: e }));
    } catch {
      // A throwing listener must not stop the report.
    }
    if (!sampled) return;
    queue.push(e);
    if (queue.length >= BATCH) flush();
    else if (timer === null) timer = env.setTimeout(flush, FLUSH_MS);
  };

  w.addEventListener("error", (ev: Event) => {
    const e = ev as ErrorEvent;
    if (!("message" in e)) return; // a resource load error, not a script error
    emit("js.error", {
      message: cut(e.message),
      source: resource(e.filename, origin) ?? resource(loc.href, origin) ?? "/",
      line: typeof e.lineno === "number" ? e.lineno : null,
      column: typeof e.colno === "number" ? e.colno : null,
      stack: frames((e.error as Error | undefined)?.stack, origin),
    });
  });
  w.addEventListener("unhandledrejection", (ev: Event) => {
    const r = (ev as PromiseRejectionEvent).reason as { message?: unknown; stack?: unknown } | undefined;
    const isError = r instanceof Error;
    emit("js.unhandledrejection", { message: cut(isError ? r.message : r), stack: isError ? frames(r.stack, origin) : [] });
  });
  w.addEventListener("securitypolicyviolation", (ev: Event) => {
    const e = ev as SecurityPolicyViolationEvent;
    const b = String(e.blockedURI ?? "");
    const keyword = /^(inline|eval|wasm-eval|trusted-types-policy|trusted-types-sink)$/u.test(b) ? b : /^(data|blob)(:|$)/u.exec(b)?.[1];
    emit("csp.violation", {
      blocked_uri: keyword ?? resource(b, origin) ?? "",
      violated_directive: cut(e.violatedDirective || e.effectiveDirective, 256),
      effective_directive: cut(e.effectiveDirective, 64),
      source_file: e.sourceFile ? resource(e.sourceFile, origin) : null,
      line: e.lineNumber || null,
      column: e.columnNumber || null,
      disposition: e.disposition === "report" ? "report" : "enforce",
    });
  });

  // htmx: the failed request's own id comes from its response header.
  type HtmxDetail = { xhr?: XMLHttpRequest; target?: Element | string; elt?: Element; requestConfig?: { path?: string }; pathInfo?: { requestPath?: string }; error?: unknown };
  const target = (t: HtmxDetail["target"] | undefined): string => cut(typeof t === "string" ? t : t ? (t.id ? `#${t.id}` : t.tagName.toLowerCase()) : "", 256);
  const reqUrl = (x: HtmxDetail): string => resource(x.requestConfig?.path ?? x.pathInfo?.requestPath ?? x.xhr?.responseURL ?? "", origin) ?? "/";
  const xhrId = (x: HtmxDetail): string | null => x.xhr?.getResponseHeader?.("x-renox-request-id") ?? null;
  const htmx = (name: string, kind: string, detail: (x: HtmxDetail) => Record<string, Json>, code?: (x: HtmxDetail) => string | null): void => {
    d.addEventListener(`htmx:${name}`, (ev: Event) => {
      const x = ((ev as CustomEvent).detail ?? {}) as HtmxDetail;
      emit(kind, detail(x), xhrId(x) ?? pageId, code?.(x) ?? null);
    });
  };
  htmx(
    "responseError",
    "htmx.responseError",
    (x) => ({ status: x.xhr?.status ?? 0, code: codeOf(x.xhr?.responseText), target: target(x.target ?? x.elt), request_url: reqUrl(x) }),
    (x) => codeOf(x.xhr?.responseText),
  );
  htmx("sendError", "htmx.sendError", (x) => ({ target: target(x.target ?? x.elt), request_url: reqUrl(x) }));
  htmx("timeout", "htmx.timeout", (x) => ({ target: target(x.target ?? x.elt), request_url: reqUrl(x) }));
  htmx("targetError", "htmx.targetError", (x) => ({ target: target(x.target) }));
  htmx("swapError", "htmx.swapError", (x) => ({ target: target(x.target ?? x.elt), message: cut((x.error as Error | undefined)?.message ?? x.error ?? "swap failed") }));

  if (dev) {
    const original = env.console.error;
    env.console.error = (...a: unknown[]) => {
      original.apply(env.console, a);
      emit("js.console.error", { message: cut(a.map((v) => (v instanceof Error ? v.message : typeof v === "string" ? v : JSON.stringify(v))).join(" ")) });
    };
  }
  // Page unload: send what is queued now; the beacon survives the unload.
  w.addEventListener("pagehide", flush);

  const setExtra = (x: Record<string, unknown>): void => {
    const out: Record<string, Json> = {};
    for (const [k, v] of Object.entries(x ?? {}).slice(0, 16))
      if (KEY.test(k) && (v === null || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v)) || typeof v === "string")) out[k] = typeof v === "string" ? cut(v, 256) : (v as Json);
    extra = JSON.stringify(out).length <= 1024 && Object.keys(out).length ? out : undefined;
  };
  return { flush, setExtra, queue };
}
