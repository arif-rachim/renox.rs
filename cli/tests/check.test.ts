// #265 (ops.md 1.4.0 section 11, step 5): route modules are evaluated on
// first use, so `renox check` refuses a handler or a service that is
// missing or is not a function, naming the file and the export; the
// artifact records each entry's exports and `eager` flag (artifact 1.2).

import { expect, test } from "bun:test";
import { join } from "node:path";

import { exportKind } from "../src/check/exports.ts";
import { check } from "../src/commands/check.ts";
import { buildArtifact, entriesOf } from "../src/lib/build.ts";
import { shopWithAuth } from "./shop-auth-fixture.ts";
import { testWorker } from "./worker-env.ts";

const worker = testWorker();
const repo = join(import.meta.dir, "../..");

test("exportKind tells functions, plain values, and missing exports apart without running the code", () => {
  const src = `
    import type { Handler } from "renox";
    export async function GET() { return new Response("x"); }
    export const POST: Handler = async (ctx) => new Response("y");
    export const PUT = (ctx) => new Response("z");
    export const PATCH = 42;
    export const DELETE = { not: "a function" };
    const helper = () => new Response("h");
    export { helper as OPTIONS };
    export const HEAD = wrap(GET);
    function wrap(f) { return f; }
  `;
  expect(exportKind(src, "GET")).toBe("function");
  expect(exportKind(src, "POST")).toBe("function");
  expect(exportKind(src, "PUT")).toBe("function");
  expect(exportKind(src, "OPTIONS")).toBe("function");
  expect(exportKind(src, "PATCH")).toBe("value");
  expect(exportKind(src, "DELETE")).toBe("value");
  // Cannot be told from the declaration: passes, the runtime checks it on first use.
  expect(exportKind(src, "HEAD")).toBe("unknown");
  expect(exportKind(src, "load")).toBe("missing");
});

test("entriesOf: the exports of each bundled entry, route modules lazy, services, hooks and _error eager", () => {
  const entry = { "functions/api/pay": "functions/api/pay.js", "pages/_error": "pages/_error.js", "modules/auth/services": "modules/auth/services.js", "modules/auth/hooks": "modules/auth/hooks.js" };
  const code = new Map([
    ["functions/api/pay.js", "async function p(){}\nexport { p as POST };\n"],
    ["pages/_error.js", "export function load(){}\n"],
    ["modules/auth/services.js", "export async function login(){}\nexport async function currentUser(){}\n"],
    ["modules/auth/hooks.js", "export const hooks = {};\nexport const on = {};\n"],
  ]);
  expect(entriesOf(entry, code)).toEqual({
    "functions/api/pay": { exports: ["POST"], eager: false },
    "modules/auth/hooks": { exports: ["hooks", "on"] },
    "modules/auth/services": { exports: ["currentUser", "login"] },
    "pages/_error": { exports: ["load"] },
  });
});

test.skipIf(!worker)("a route handler or a page loader that is not a function fails renox check with file and name", async () => {
  const dir = await shopWithAuth({
    "functions/api/broken.ts": "export const GET = 42;\n",
    "pages/report.ts": "export const load = { rows: [] };\n",
    "pages/report.html": "<r-layout use=\"main\"><h1>Report</h1></r-layout>\n",
  });
  const messages = (await check(dir)).errors.map((e) => `${e.file ?? ""} | ${e.message}`);
  expect(messages).toContain("functions/api/broken.ts | functions/api/broken.ts: the route handler `GET` is exported but is not a function");
  expect(messages).toContain("pages/report.ts | pages/report.ts: the page loader `load` is exported but is not a function");
});

test.skipIf(!worker)("a service the module declares but does not export fails renox check with file and name", async () => {
  const dir = await shopWithAuth({}, { "services.ts": "export async function somethingElse(ctx) { return null; }\n" });
  const messages = (await check(dir)).errors.map((e) => e.message);
  expect(messages).toContain("auth/services.ts: the service `currentUser` is not exported");
});

test.skipIf(!worker)("examples/shop passes; its artifact records entries with lazy route modules", async () => {
  const shop = join(repo, "examples/shop");
  expect((await check(shop, { strict: true })).errors).toEqual([]);
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const r = await buildArtifact(shop, mkdtempSync(join(tmpdir(), "renox-shop-entries-")));
  const entries = r.manifest.entries ?? {};
  expect(Object.keys(entries).sort()).toEqual(Object.keys(r.manifest.code.entry).sort());
  expect(entries["functions/api/checkout"]).toEqual({ exports: ["POST"], eager: false });
  expect(entries["pages/products/index"]?.eager).toBe(false);
  expect(entries["modules/auth/services"]?.eager).toBeUndefined();
  expect(entries["modules/auth/services"]?.exports).toContain("currentUser");
}, 120_000);
