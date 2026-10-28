// #127: renox-client.js capture paths and the batcher, against fake browser
// globals built on Bun's EventTarget (the real browser is
// cli/tests/browser/). Every event the script sends is checked against the
// contract schema (docs/contracts/schemas/client-event.schema.json).
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { validate } from "../../../cli/src/lib/schema.ts";
import { type ClientEvent, codeOf, cut, type Env, frames, install, resource, uaFamily } from "../src/index.ts";

const ORIGIN = "https://shop.renox.app";
const ID = "01JBQ3Z7MA0000000000000101";
const HASH = "3597f77a2b9c91728657e3c2b8d45d8e3c05b3eed075edf02d328bbc90e62f64";
const schema = JSON.parse(readFileSync(join(import.meta.dir, "../../../docs/contracts/schemas/client-event.schema.json"), "utf8"));

type Sent = { url: string; body: { v: number; events: ClientEvent[] } };

function fake(metas: Record<string, string> = {}, opts: { beacon?: boolean } = {}) {
  const sent: Sent[] = [];
  const dispatched: ClientEvent[] = [];
  const timers: (() => void)[] = [];
  const errors: unknown[][] = [];
  let now = 1_793_318_400_000;
  const document = Object.assign(new EventTarget(), {
    querySelector: (sel: string) => {
      const name = /meta\[name="(.+)"\]/u.exec(sel)?.[1] ?? "";
      return name in metas ? { getAttribute: () => metas[name] ?? null } : null;
    },
  });
  document.addEventListener("renox:error", (e) => dispatched.push((e as CustomEvent).detail));
  const env: Env = {
    window: new EventTarget(),
    document,
    location: { origin: ORIGIN, pathname: "/products/42", search: "?tab=reviews", href: `${ORIGIN}/products/42?tab=reviews#x` },
    navigator: {
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
      ...(opts.beacon === false
        ? {}
        : {
            sendBeacon: (url: string, body: string) => {
              sent.push({ url, body: JSON.parse(body) });
              return true;
            },
          }),
    },
    console: { error: (...a: unknown[]) => errors.push(a) },
    fetch: async (url: string, init: RequestInit) => {
      sent.push({ url, body: JSON.parse(String(init.body)) });
    },
    now: () => now,
    random: (b) => b.fill(7),
    setTimeout: (f) => timers.push(f),
    CustomEvent,
  };
  const client = install(env);
  return {
    env,
    client,
    sent,
    dispatched,
    errors,
    tick: (ms: number) => {
      now += ms;
    },
    runTimers: () => timers.splice(0).forEach((f) => f()),
    events: () => sent.flatMap((s) => s.body.events),
  };
}

const metas = { "renox-request-id": ID, "renox-deployment": HASH };

/** A window `error` event as a browser builds it. */
function errorEvent(props: Record<string, unknown>): Event {
  return Object.assign(new Event("error"), props);
}

function htmxEvent(name: string, detail: Record<string, unknown>): CustomEvent {
  return new CustomEvent(`htmx:${name}`, { detail });
}

const xhr = (status: number, body: string, id: string | null) => ({
  status,
  responseText: body,
  responseURL: `${ORIGIN}/products/42?x=1`,
  getResponseHeader: (h: string) => (h === "x-renox-request-id" ? id : null),
});

function expectValid(events: ClientEvent[]): void {
  const errs = validate(schema, { v: 0, events } as never);
  expect(errs).toEqual([]);
}

describe("capture", () => {
  let f: ReturnType<typeof fake>;
  beforeEach(() => {
    f = fake(metas);
  });

  test("window error → js.error with source, line, column, stack", () => {
    const err = new Error("cart is undefined");
    err.stack = `TypeError: cart is undefined\n    at openCart (${ORIGIN}/assets/app.js?v=3:12:31)\n    at https://cdn.example.net/alpine.min.js:1:20988`;
    f.env.window.dispatchEvent(errorEvent({ message: "TypeError: cart is undefined", filename: `${ORIGIN}/products/42?tab=reviews`, lineno: 7, colno: 5, error: err }));
    f.client.flush();
    const [e] = f.events();
    expect(e).toMatchObject({
      kind: "js.error",
      url: "/products/42?tab=reviews",
      request_id: ID,
      deployment: HASH,
      ua: "chrome",
      detail: {
        message: "TypeError: cart is undefined",
        source: "/products/42",
        line: 7,
        column: 5,
        stack: [
          { file: "/assets/app.js", line: 12, column: 31, function: "openCart" },
          { file: "https://cdn.example.net/alpine.min.js", line: 1, column: 20988 },
        ],
      },
    });
    expect(e?.session_fingerprint).toMatch(/^[A-Za-z0-9_-]{16,32}$/u);
    expect(f.sent[0]?.url).toBe("/__renox/events");
    expect(f.dispatched).toHaveLength(1);
    expectValid(f.events());
  });

  test("unhandled rejection, with an Error and with a plain value", () => {
    f.env.window.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: new Error("boom") }));
    f.env.window.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: "just a string" }));
    f.client.flush();
    const ev = f.events();
    expect(ev.map((e) => [e.kind, e.detail.message])).toEqual([
      ["js.unhandledrejection", "boom"],
      ["js.unhandledrejection", "just a string"],
    ]);
    expect(ev[1]?.detail.stack).toEqual([]);
    expectValid(ev);
  });

  test("htmx errors carry the fragment's own request id and the RENOX code", () => {
    const d = f.env.document;
    d.dispatchEvent(htmxEvent("responseError", { xhr: xhr(500, '{"error":{"code":"RENOX_DB_AUTH","message":"x"}}', "01JBQ3Z7MA0000000000000202"), target: { id: "product-list", tagName: "UL" }, requestConfig: { path: "/products?q=x" } }));
    d.dispatchEvent(htmxEvent("responseError", { xhr: xhr(503, '<meta name="renox-error-code" content="RENOX_CPU_LIMIT">', null), target: { id: "", tagName: "DIV" } }));
    d.dispatchEvent(htmxEvent("sendError", { target: { id: "cart", tagName: "SPAN" }, requestConfig: { path: "https://api.example.com/x?y" } }));
    d.dispatchEvent(htmxEvent("timeout", { elt: { id: "slow", tagName: "BUTTON" }, requestConfig: { path: "/slow" } }));
    d.dispatchEvent(htmxEvent("targetError", { target: "#missing" }));
    d.dispatchEvent(htmxEvent("swapError", { target: { id: "x", tagName: "DIV" }, error: new Error("bad swap") }));
    f.client.flush();
    const ev = f.events();
    expect(ev.map((e) => e.kind)).toEqual(["htmx.responseError", "htmx.responseError", "htmx.sendError", "htmx.timeout", "htmx.targetError", "htmx.swapError"]);
    expect(ev[0]).toMatchObject({ request_id: "01JBQ3Z7MA0000000000000202", code: "RENOX_DB_AUTH", detail: { status: 500, code: "RENOX_DB_AUTH", target: "#product-list", request_url: "/products" } });
    expect(ev[1]).toMatchObject({ request_id: ID, code: "RENOX_CPU_LIMIT", detail: { status: 503, target: "div", request_url: "/products/42" } });
    expect(ev[2]?.detail.request_url).toBe("https://api.example.com/x");
    expect(ev[4]?.detail).toEqual({ target: "#missing" });
    expect(ev[5]?.detail.message).toBe("bad swap");
    expectValid(ev);
  });

  test("CSP violation from the DOM event", () => {
    f.env.window.dispatchEvent(
      Object.assign(new Event("securitypolicyviolation"), {
        blockedURI: "inline",
        violatedDirective: "script-src-elem",
        effectiveDirective: "script-src-elem",
        sourceFile: `${ORIGIN}/products/42`,
        lineNumber: 9,
        columnNumber: 1,
        disposition: "enforce",
      }),
    );
    f.env.window.dispatchEvent(Object.assign(new Event("securitypolicyviolation"), { blockedURI: "https://evil.example/x.js?a=1", violatedDirective: "script-src-elem", effectiveDirective: "script-src-elem", sourceFile: "", lineNumber: 0, columnNumber: 0, disposition: "report" }));
    f.client.flush();
    const ev = f.events();
    expect(ev[0]?.detail).toEqual({ blocked_uri: "inline", violated_directive: "script-src-elem", effective_directive: "script-src-elem", source_file: "/products/42", line: 9, column: 1, disposition: "enforce" });
    expect(ev[1]?.detail.blocked_uri).toBe("https://evil.example/x.js");
    expect(ev[1]?.detail.disposition).toBe("report");
    expectValid(ev);
  });

  test("console.error is captured in dev only", () => {
    f.env.console.error("not captured");
    f.client.flush();
    expect(f.events()).toEqual([]);
    expect(f.errors).toEqual([["not captured"]]);
    const dev = fake({ ...metas, "renox-dev": "1" });
    dev.env.console.error("Alpine:", new Error("x is not defined"));
    dev.client.flush();
    expect(dev.events()[0]).toMatchObject({ kind: "js.console.error", detail: { message: "Alpine: x is not defined" } });
    expect(dev.errors).toEqual([["Alpine:", new Error("x is not defined")]]);
    expectValid(dev.events());
  });
});

describe("batching, dedupe, caps", () => {
  test("events wait for the timer, 20 per beacon, flushed on pagehide", () => {
    const f = fake(metas);
    for (let i = 0; i < 3; i++) f.env.window.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: `r${i}` }));
    expect(f.sent).toHaveLength(0);
    f.runTimers();
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]?.body.events).toHaveLength(3);
    for (let i = 0; i < 25; i++) f.env.window.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: `s${i}` }));
    expect(f.sent.map((s) => s.body.events.length)).toEqual([3, 20]);
    f.env.window.dispatchEvent(new Event("pagehide"));
    expect(f.sent.map((s) => s.body.events.length)).toEqual([3, 20, 5]);
    expect(f.sent.every((s) => s.body.v === 0)).toBe(true);
  });

  test("identical events within 10 s are sent once; at most 50 per page load", () => {
    const f = fake(metas);
    const same = () => f.env.window.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: "same" }));
    same();
    f.tick(9_000);
    same();
    f.tick(2_000);
    same();
    f.client.flush();
    expect(f.events()).toHaveLength(2);
    for (let i = 0; i < 100; i++) f.env.window.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: `n${i}` }));
    f.client.flush();
    expect(f.events()).toHaveLength(50);
  });

  test("fetch keepalive when sendBeacon is missing", () => {
    const f = fake(metas, { beacon: false });
    f.env.window.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: "x" }));
    f.client.flush();
    expect(f.sent).toHaveLength(1);
  });

  test("sampling: a page load outside the sample sends nothing but still dispatches renox:error", () => {
    const f = fake({ ...metas, "renox-events-sample": "0" });
    f.env.window.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: "x" }));
    f.client.flush();
    expect(f.sent).toHaveLength(0);
    expect(f.dispatched).toHaveLength(1);
  });

  test("extra: valid keys and values only, at most 1 KB", () => {
    const f = fake(metas);
    f.client.setExtra({ plan: "pro", seats: 3, beta: true, bad: { nested: 1 }, "no-dash": 1 });
    f.env.window.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: "x" }));
    f.client.setExtra({ big: "x".repeat(300), big2: "y".repeat(300), big3: "z".repeat(300), big4: "w".repeat(300) });
    f.env.window.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: "y" }));
    f.client.flush();
    const [a, b] = f.events();
    expect(a?.extra).toEqual({ plan: "pro", seats: 3, beta: true });
    expect(b?.extra).toBeUndefined();
    expectValid(f.events());
  });

  test("no meta tags: request id and deployment are null", () => {
    const f = fake({});
    f.env.window.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: "x" }));
    f.client.flush();
    expect(f.events()[0]).toMatchObject({ request_id: null, deployment: null });
    expectValid(f.events());
  });
});

describe("helpers", () => {
  test("strings are cut to 2,048 code points", () => {
    expect(Array.from(cut("é".repeat(3000)))).toHaveLength(2048);
    expect(cut("é".repeat(3000)).endsWith("…")).toBe(true);
    expect(cut("short")).toBe("short");
  });

  test("resource URLs lose query and fragment; other schemes are dropped", () => {
    expect(resource(`${ORIGIN}/a.js?v=1#x`, ORIGIN)).toBe("/a.js");
    expect(resource("https://cdn.example/a.js?v=1", ORIGIN)).toBe("https://cdn.example/a.js");
    expect(resource("/rel?x", ORIGIN)).toBe("/rel");
    expect(resource("chrome-extension://abc/x.js", ORIGIN)).toBeNull();
  });

  test("browser family and RENOX codes", () => {
    expect(uaFamily("Mozilla/5.0 Firefox/131.0")).toBe("firefox");
    expect(uaFamily("Mozilla/5.0 Chrome/130 Safari/537.36 Edg/130.0")).toBe("edge");
    expect(uaFamily("Mozilla/5.0 Version/18.0 Safari/604.1")).toBe("safari");
    expect(uaFamily("curl")).toBe("other");
    expect(codeOf('{"error":{"code":"RENOX_DB_AUTH"}}')).toBe("RENOX_DB_AUTH");
    expect(codeOf("<p>no code</p>")).toBeNull();
  });

  test("Firefox and Safari stacks", () => {
    expect(frames(`openCart@${ORIGIN}/app.js:3:9\n@${ORIGIN}/app.js:1:1`, ORIGIN)).toEqual([
      { file: "/app.js", line: 3, column: 9, function: "openCart" },
      { file: "/app.js", line: 1, column: 1 },
    ]);
  });
});
