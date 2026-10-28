// #93: the dev error overlay. What it shows for each error kind (snapshots
// of the rows built from the worker's log lines and meter record), how the
// proxy injects it, and that a production build never ships it.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collectErrorDetails, errorDetails } from "../src/dev/overlay/details.ts";
import { ERROR_DETAILS_PATH, ERROR_OVERLAY_JS, ERROR_OVERLAY_PATH, injectErrorOverlay, overlayRows } from "../src/dev/overlay/overlay.ts";
import { buildArtifact } from "../src/lib/build.ts";

const repo = join(import.meta.dir, "../..");
const ID = "01JBQ3Z7MA0000000000000101";
const line = (message: string, fields: Record<string, unknown>, level = "error") => ({ level, request_id: ID, message, fields });

/** Log lines as the worker writes them (crates/renox-runtime/src/isolate.rs, crates/renox-cell/src/render.rs). */
const CASES: Record<string, { status: number; lines: ReturnType<typeof line>[]; record: Record<string, unknown> | null }> = {
  cpu_limit: {
    status: 503,
    lines: [line("request CPU limit reached; isolate recycled", { code: "RENOX_CPU_LIMIT", route: "GET /loop", phase: "request", cpu_ms: 51.2, limit_ms: 50 })],
    record: { request_id: ID, route: "GET /loop", cpu_ms: 51.2, peak_heap_bytes: 3_145_728, wall_ms: 53.9 },
  },
  oom: {
    status: 503,
    lines: [line("isolate heap limit reached; isolate recycled", { code: "RENOX_OOM", route: "GET /alloc", phase: "request", peak_heap_bytes: 133_169_152, limit_bytes: 134_217_728 })],
    record: { request_id: ID, route: "GET /alloc", cpu_ms: 40.1, peak_heap_bytes: 133_169_152, wall_ms: 48 },
  },
  timeout: {
    status: 504,
    lines: [line("request deadline passed", { code: "RENOX_DEADLINE", route: "GET /hang", wall_ms: 30_001, limit_ms: 30_000 }, "warn")],
    record: null,
  },
  render_limit: {
    status: 500,
    lines: [line("render limit reached", { code: "RENOX_RENDER_LIMIT", template: "pages/nested", limit: "fuel", render_fuel: 250_000 })],
    record: { request_id: ID, route: "GET /nested", cpu_ms: 2.5, peak_heap_bytes: 9_000_000, wall_ms: 120, render_fuel: 250_000 },
  },
  render_failed: {
    status: 500,
    lines: [
      line("page could not be rendered", {
        code: "RENOX_INTERNAL",
        phase: "render",
        reason: "render_failed",
        cause_message: "template error: invalid operation: cannot convert to number (in pages/products/index:42)",
      }),
    ],
    record: null,
  },
  internal: {
    status: 500,
    lines: [line("load threw", { code: "RENOX_INTERNAL", route: "GET /throws", cause_message: "Error: database is down", stack: "Error: database is down\n    at load (pages/throws.js:1:30)" })],
    record: { request_id: ID, route: "GET /throws", cpu_ms: 0.4, peak_heap_bytes: 2_000_000, wall_ms: 1.2 },
  },
  not_found: { status: 404, lines: [], record: null },
};

describe("error overlay rows", () => {
  for (const [name, c] of Object.entries(CASES)) {
    test(name, () => {
      const d = errorDetails(ID, c.lines, c.record as never);
      expect(overlayRows(c.status, d)).toMatchSnapshot();
    });
  }

  test("a render error names the template and its line", () => {
    const c = CASES.render_failed as (typeof CASES)[string];
    const d = errorDetails(ID, c.lines, null);
    expect([d.template, d.line]).toEqual(["pages/products/index", 42]);
  });

  test("the line with the platform code wins over the error page's own line", () => {
    const d = errorDetails(ID, [line("render limit reached", { code: "RENOX_RENDER_LIMIT", template: "pages/nested", limit: "fuel" }), line("error page could not be rendered", { template: "pages/_error" })], null);
    expect(d.template).toBe("pages/nested");
  });
});

test("details come from .renox/logs and .renox/meters", async () => {
  const state = mkdtempSync(join(tmpdir(), "renox-overlay-"));
  mkdirSync(join(state, "logs"));
  mkdirSync(join(state, "meters"));
  const other = { ...(CASES.oom as (typeof CASES)[string]).lines[0], request_id: "01JBQ3Z7MA0000000000000999" };
  writeFileSync(join(state, "logs", "tenant.ndjson"), [other, ...(CASES.cpu_limit as (typeof CASES)[string]).lines].map((l) => JSON.stringify(l)).join("\n") + "\n");
  writeFileSync(join(state, "meters", "2026-10-28.ndjson"), `${JSON.stringify({ records: [{ request_id: ID, route: "GET /loop", cpu_ms: 51.2, peak_heap_bytes: 3_145_728, wall_ms: 53.9 }] })}\n`);
  const d = await collectErrorDetails(state, ID, 0);
  expect(d.code).toBe("RENOX_CPU_LIMIT");
  expect(d.limit).toBe("cpu");
  expect(d.wall_ms).toBe(53.9);
  expect(d.peak_heap_bytes).toBe(3_145_728);
});

test("the proxy injects the overlay script with the nonce, id, and status", () => {
  const html = "<!doctype html><html><head></head><body><h1>503</h1></body></html>";
  const csp = "default-src 'self'; script-src 'self' 'nonce-QUJDRA=='";
  expect(injectErrorOverlay(html, ID, 503, csp)).toMatchSnapshot();
  expect(injectErrorOverlay("<p>x</p>", `${ID}"><x`, 500, null)).toBe(`<p>x</p><script src="${ERROR_OVERLAY_PATH}" data-request-id="${ID}x" data-status="500"></script>`);
});

test("the browser script is valid ES and runs the tested row builder", () => {
  expect(() => new Function(ERROR_OVERLAY_JS)).not.toThrow();
  expect(ERROR_OVERLAY_JS).toContain("function overlayRows(status, d)");
  expect(ERROR_OVERLAY_JS).toContain(JSON.stringify(ERROR_DETAILS_PATH));
});

describe("production never ships the overlay", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? files(p) : [p];
    });

  test("a production build of examples/hello has no overlay code", async () => {
    const out = mkdtempSync(join(tmpdir(), "renox-prod-"));
    const r = await buildArtifact(join(repo, "examples/hello"), out);
    for (const f of files(r.dir)) {
      const text = readFileSync(f, "utf8");
      for (const needle of ["__renox/dev", "renox-dev-error", "renox-dev-overlay", "overlayRows"]) expect(text).not.toContain(needle);
    }
  });

  test("only the renox dev proxy imports the overlay", () => {
    const src = join(repo, "cli/src");
    const importers = files(src)
      .filter((f) => f.endsWith(".ts") && !f.includes("/dev/overlay/"))
      .filter((f) => readFileSync(f, "utf8").includes("dev/overlay/"))
      .map((f) => f.slice(src.length + 1));
    expect(importers).toEqual(["commands/dev.ts"]);
  });
});
