// Route discovery from functions/ and conflict detection (docs/07-app-model.md
// "Routing rules"; artifact.md V8).
import { expect, test } from "bun:test";
import { join } from "node:path";

import { discoverFunctions, patternFor, RouteError, routeConflicts, routesOf, sortRoutes } from "../src/lib/routes.ts";

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
  const routes = routesOf(fns).map((r) => `${r.method} ${r.path} ${r.module}`);
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
