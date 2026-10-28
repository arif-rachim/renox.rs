// #127: browser events under `renox dev`: the terminal line, the batch
// handler (.renox/logs/browser.ndjson), the dev marker, and the overlay's
// Browser tab rows (snapshots).
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { allHints, browserLine, clientLine, handleBatch, hintFor, injectDevMeta, parseBatch, templateFor } from "../src/dev/client-events.ts";
import { browserRows, browserTabJs } from "../src/dev/overlay/browser-tab.ts";

const ID = "01JBQ3Z7MA0000000000000101";
const routes = [
  { kind: "page", path: "/products", template: "pages/products/index" },
  { kind: "page", path: "/products/:id", template: "pages/products/[id]" },
  { kind: "function", path: "/api/cart" },
];

const jsError = {
  kind: "js.error",
  url: "/products/42?tab=reviews",
  request_id: ID,
  detail: { message: "TypeError: cart is undefined", source: "/products/42", line: 42, column: 7, stack: [{ file: "/products/42", line: 42, column: 7, function: "openCart" }] },
};
const htmxError = {
  kind: "htmx.responseError",
  url: "/products",
  request_id: "01JBQ3Z7MA0000000000000202",
  code: "RENOX_CPU_LIMIT",
  detail: { status: 503, code: "RENOX_CPU_LIMIT", target: "#product-list", request_url: "/products" },
};

describe("terminal", () => {
  test("an inline script error names the page's template", () => {
    expect(templateFor("/products/42", routes)).toBe("pages/products/[id].html");
    expect(templateFor("/products", routes)).toBe("pages/products/index.html");
    expect(templateFor("/api/cart", routes)).toBeNull();
    expect(browserLine(jsError, routes)).toBe(`[browser] js.error pages/products/[id].html:42:7 TypeError: cart is undefined (${ID})`);
  });

  test("an htmx error shows status, code, and the catalogue hint", () => {
    const line = browserLine(htmxError, routes);
    expect(line.split("\n")[0]).toBe("[browser] htmx.responseError /products → #product-list 503 RENOX_CPU_LIMIT (01JBQ3Z7MA0000000000000202)");
    expect(line).toContain("hint: Move heavy work out of the request path");
  });

  test("CSP violations the worker logged print in the same form", () => {
    const line = clientLine({
      request_id: null,
      fields: { source: "client", kind: "csp.violation", url: "/products", detail: { blocked_uri: "inline", effective_directive: "script-src-elem", source_file: "/products", line: 9, disposition: "enforce" } },
    });
    expect(line).toBe("[browser] csp.violation script-src-elem blocked inline in /products:9");
    expect(clientLine({ fields: { code: "RENOX_INTERNAL" } })).toBeNull();
  });

  test("the error catalogue's hints", () => {
    expect(hintFor("RENOX_OOM")).toContain("Stream large bodies");
    expect(hintFor("RENOX_NOPE")).toBeNull();
    expect(Object.keys(allHints()).length).toBeGreaterThan(20);
  });
});

describe("batches", () => {
  test("a batch is printed and written to browser.ndjson; anything else is ignored; always 204", async () => {
    const dir = mkdtempSync(join(tmpdir(), "renox-browser-"));
    const browserLog = join(dir, "logs", "browser.ndjson");
    const lines: string[] = [];
    const post = (body: string) => handleBatch(new Request("http://localhost/__renox/events", { method: "POST", body }), { browserLog, routes: () => routes, log: (l) => lines.push(l) });
    const ok = await post(JSON.stringify({ v: 0, events: [jsError, { kind: "js.console.error", url: "/products", request_id: ID, detail: { message: "Alpine: x" } }] }));
    expect(ok.status).toBe(204);
    expect(lines).toEqual([`[browser] js.error pages/products/[id].html:42:7 TypeError: cart is undefined (${ID})`, `[browser] js.console.error pages/products/index.html Alpine: x (${ID})`]);
    const written = readFileSync(browserLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(written[0]).toMatchObject({ level: "error", request_id: ID, fields: { source: "client", kind: "js.error", url: "/products/42?tab=reviews" } });
    for (const bad of ["{", JSON.stringify({ v: 1, events: [jsError] }), JSON.stringify({ v: 0, events: [{}] }), "x".repeat(40_000)]) expect((await post(bad)).status).toBe(204);
    expect(lines).toHaveLength(2);
    expect(parseBatch(JSON.stringify({ v: 0, events: Array(21).fill(jsError) }))).toBeNull();
  });

  test("the dev marker goes first in <head>", () => {
    expect(injectDevMeta('<!doctype html><html><head lang="en"><meta name="renox-request-id" content="x"></head></html>', "<script src=/t.js></script>")).toBe(
      '<!doctype html><html><head lang="en"><meta name="renox-dev" content="1"><script src=/t.js></script><meta name="renox-request-id" content="x"></head></html>',
    );
    expect(injectDevMeta("<li>fragment</li>")).toBe("<li>fragment</li>");
  });
});

describe("Browser tab", () => {
  const hints = { RENOX_CPU_LIMIT: "Move heavy work out of the request path" };
  test("rows of a js.error", () => {
    expect(browserRows(jsError, hints)).toMatchSnapshot();
  });
  test("rows of an htmx error with a code and its hint", () => {
    expect(browserRows(htmxError, hints)).toMatchSnapshot();
  });
  test("rows of a CSP violation", () => {
    expect(browserRows({ kind: "csp.violation", url: "/products", request_id: null, detail: { blocked_uri: "inline", effective_directive: "script-src-elem", source_file: "/products", line: 9, column: 1 } }, hints)).toMatchSnapshot();
  });
  test("the script is valid ES with the hints inlined", () => {
    const js = browserTabJs(hints);
    expect(() => new Function(js)).not.toThrow();
    expect(js).toContain("function browserRows(e, hints)");
    expect(js).toContain("Move heavy work out of the request path");
  });
});
