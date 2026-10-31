// `.renox/types/` (#43): db.d.ts reflects the shop's app__products columns,
// params are typed per route, fragment names per page; the generated files
// type-check against the SDK and reject a wrong param.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discoverFunctions, discoverPages, routesOf } from "../src/lib/routes.ts";
import type { CompiledTemplate } from "../src/lib/templates-compile.ts";
import { columnType, dbDts, routesDts, writeTypes } from "../src/lib/types/generate.ts";

const repo = join(import.meta.dir, "../..");

test("db.d.ts reflects the shop's app__products columns", () => {
  const dts = dbDts(join(repo, "examples/shop"));
  expect(dts).toContain(`"app__products": {
    id: number;
    name: string;
    description: string;
    price_fils: number;
    stock: number;
    category: string;
    image: string;
    image_width: number | null;
    image_height: number | null;
  };`);
  expect(dts).toContain(`"app__cart_items": {`);
  expect(columnType("VARCHAR(20)")).toBe("string");
  expect(columnType("blob")).toBe("Uint8Array");
  expect(columnType("DOUBLE PRECISION")).toBe("number");
});

const templates: Record<string, CompiledTemplate> = {
  "pages/products/[id]": { kind: "page", source: "", fragments: { product: { target: "product" }, cart_badge: { target: "cart-badge" } } },
  "pages/about": { kind: "page", source: "", fragments: {} },
};

test("routes.d.ts: params per route and fragment names per page", () => {
  const fixture = join(import.meta.dir, "fixtures/pages");
  const routes = routesOf(discoverFunctions(fixture), discoverPages(fixture));
  const dts = routesDts(routes, templates);
  expect(dts).toContain(`"pages/products/[id]": { id: string };`);
  expect(dts).toContain(`"pages/docs/[...slug]": { slug: string[] };`);
  expect(dts).toContain(`"pages/about": Record<string, never>;`);
  expect(dts).toContain(`"functions/api/health": Record<string, never>;`);
  expect(dts).toContain(`"pages/products/[id]": "product" | "cart_badge";`);
});

test("the generated types check a page module with tsc, and reject a wrong param", async () => {
  const fixture = join(import.meta.dir, "fixtures/pages");
  const dir = mkdtempSync(join(tmpdir(), "renox-types-"));
  mkdirSync(join(dir, "migrations"));
  writeFileSync(join(dir, "migrations/001_init.sql"), "create table app__products (id integer primary key, name text not null, note text);\n");
  writeTypes(dir, routesOf(discoverFunctions(fixture), discoverPages(fixture)), templates);
  const sdk = join(repo, "sdk/src/index.ts");
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, allowImportingTsExtensions: true, module: "esnext", moduleResolution: "bundler", target: "es2022", lib: ["es2022", "dom"], paths: { renox: [sdk] }, skipLibCheck: true },
      include: ["page.ts", ".renox/types/*.d.ts"],
    }),
  );
  const good = `import type { LoaderContextOf, RowOf } from "./.renox/types";
export async function load({ params, fragment }: LoaderContextOf<"pages/products/[id]">) {
  const id: string = params.id;
  const f: "product" | "cart_badge" | null = fragment;
  const row: RowOf<"app__products"> = { id: 1, name: "x", note: null };
  return { id, f, row };
}
`;
  const tsc = join(repo, "node_modules/.bin/tsc");
  writeFileSync(join(dir, "page.ts"), good);
  const ok = Bun.spawnSync([tsc, "-p", dir]);
  expect(ok.stdout.toString() + ok.stderr.toString()).toBe("");
  expect(ok.exitCode).toBe(0);
  writeFileSync(join(dir, "page.ts"), good.replace("params.id", "params.slug"));
  const bad = Bun.spawnSync([tsc, "-p", dir]);
  expect(bad.exitCode).not.toBe(0);
  expect(bad.stdout.toString()).toContain("slug");
}, 60_000);
