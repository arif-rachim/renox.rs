// Route discovery from functions/ and conflict detection (docs/07-app-model.md
// "Routing rules"; artifact.md V8).
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { actionNames, discoverFunctions, discoverPages, patternFor, RouteError, routeConflicts, routeLabel, routesOf, sortRoutes } from "../src/lib/routes.ts";

const fixture = (name: string): string => join(import.meta.dir, "fixtures", name);

test("file names map to patterns", () => {
  expect(patternFor("api/hello")).toBe("/api/hello");
  expect(patternFor("api/notes/index")).toBe("/api/notes");
  expect(patternFor("index")).toBe("/");
  expect(patternFor("api/notes/[id]")).toBe("/api/notes/:id");
  expect(patternFor("api/docs/[...slug]")).toBe("/api/docs/*slug");
  expect(() => patternFor("api/[...rest]/x")).toThrow(RouteError);
  expect(() => patternFor("api/[id]/[id]")).toThrow(RouteError);
  expect(() => patternFor("api/[Bad]")).toThrow(RouteError);
  expect(() => patternFor("api/a b")).toThrow(RouteError);
});

test("discovery finds method exports and skips _ files and modules without handlers", () => {
  const fns = discoverFunctions(fixture("routes"));
  const routes = routesOf(fns).map((r) => `${routeLabel(r)} ${r.module}`);
  expect(routes.sort()).toEqual(
    [
      "GET /api/notes functions/api/notes/index",
      "POST /api/notes functions/api/notes/index",
      "GET /api/notes/:id functions/api/notes/[id]",
      "DELETE /api/notes/:id functions/api/notes/[id]",
      "GET /api/products/new functions/api/products/new",
      "GET /api/products/:id functions/api/products/[id]",
      "GET /api/docs/*slug functions/api/docs/[...slug]",
    ].sort(),
  );
  expect(routeConflicts(routesOf(fns))).toEqual([]);
});

test("precedence: static before parameter before catch-all", () => {
  const sorted = sortRoutes(routesOf(discoverFunctions(fixture("routes"))))
    .filter((r) => r.path.startsWith("/api/products"))
    .map((r) => r.path);
  expect(sorted).toEqual(["/api/products/new", "/api/products/:id"]);
});

test("two parameter routes with the same shape conflict", () => {
  const conflicts = routeConflicts(routesOf(discoverFunctions(fixture("conflict"))));
  expect(conflicts.length).toBe(1);
  expect(conflicts[0]).toContain("V8");
  expect(conflicts[0]).toContain("/a/:id");
  expect(conflicts[0]).toContain("/a/:slug");
});

// Pages (#41): docs/07-app-model.md "Routing rules" (one row each) and
// "Pages" (the three .ts/.html shapes); artifact.md section 3, "Page routes".

test("page discovery: routing rule rows and the three file shapes", () => {
  const routes = routesOf([], discoverPages(fixture("pages")));
  expect(routes).toEqual([
    { kind: "page", path: "/about", template: "pages/about" },
    { kind: "page", path: "/docs/*slug", template: "pages/docs/[...slug]" },
    { kind: "page", path: "/", template: "pages/index" },
    { kind: "page", path: "/logout", module: "pages/logout", load: true },
    {
      kind: "page",
      path: "/products/:id",
      module: "pages/products/[id]",
      load: true,
      actions: ["addToCart", "remove", "rename"],
      template: "pages/products/[id]",
    },
    { kind: "page", path: "/products", module: "pages/products/index", load: true, template: "pages/products/index" },
  ]);
  // _layouts/, _404, _error are not routes.
  expect(routes.some((r) => r.path.includes("_"))).toBe(false);
  expect(sortRoutes(routes).map((r) => r.path)).toEqual(["/", "/about", "/docs/*slug", "/logout", "/products", "/products/:id"]);
});

test("action names come from the actions object literal", () => {
  expect(actionNames(`export const actions = { a() {}, async b(x: number) { return { y: { z: 1 } }; }, c: () => 1, "d": function () {} };`)).toEqual(["a", "b", "c", "d"]);
  expect(actionNames(`const actions = { default: async () => new Response("") };\nexport { actions };`)).toEqual(["default"]);
  expect(() => actionNames(`export const actions = makeActions();`)).toThrow(RouteError);
  expect(() => actionNames(`export const actions = { ...shared, a() {} };`)).toThrow(RouteError);
  expect(() => actionNames(`export const actions = { "a-b": () => 1 };`)).toThrow(RouteError);
});

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "renox-pages-"));
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), text);
  }
  return dir;
}

test("page problems: .ts without load or template, _error.ts, two files for one URL", () => {
  expect(() => discoverPages(project({ "pages/a.ts": "export const x = 1;" }))).toThrow(/must export load/u);
  expect(() => discoverPages(project({ "pages/_error.ts": "export function load() {}", "pages/_error.html": "<p></p>" }))).toThrow(/no loader/u);
  expect(() => discoverPages(project({ "pages/a.html": "<p></p>", "pages/a/index.html": "<p></p>" }))).toThrow(/maps to \/a/u);
});

test("V8 with pages: a page conflicts with a page or function of the same shape", () => {
  const pages = discoverPages(project({ "pages/api/x.html": "<p></p>", "pages/p/[id].html": "<p></p>", "pages/p/[slug]/index.html": "<p></p>" }));
  const fn = { id: "functions/api/x", source: "functions/api/x.ts", pattern: "/api/x", methods: ["GET" as const, "POST" as const] };
  const conflicts = routeConflicts(routesOf([fn], pages));
  expect(conflicts).toHaveLength(2);
  expect(conflicts[0]).toContain("GET /api/x");
  expect(conflicts[1]).toContain("/p/:id");
  // POST /api/x and a page without actions do not conflict.
  const ok = routeConflicts(routesOf([{ ...fn, methods: ["POST"] }], discoverPages(project({ "pages/api/x.html": "<p></p>" }))));
  expect(ok).toEqual([]);
});
