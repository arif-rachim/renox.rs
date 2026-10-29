// `renox new` + `renox build` + `renox check`.
import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { check } from "../src/commands/check.ts";
import { newApp } from "../src/commands/new.ts";
import { buildArtifact } from "../src/lib/build.ts";
import { hashDir } from "../src/lib/hash.ts";
import { type Json, validate } from "../src/lib/schema.ts";
import { schemas } from "../src/lib/schemas.ts";
import { testWorker } from "./worker-env.ts";

const repo = join(import.meta.dir, "../..");
const tmp = (p: string): string => mkdtempSync(join(tmpdir(), `renox-cli-${p}-`));
const readJson = (p: string): Json => JSON.parse(readFileSync(p, "utf8")) as Json;
/** Templates are transpiled by `renox-worker transpile` (#43): those tests need the binary. */
const worker = testWorker();

describe("renox build", () => {
  test("examples/hello builds a schema-valid artifact named by its hash", async () => {
    const out = tmp("hello");
    const r = await buildArtifact(join(repo, "examples/hello"), out);
    expect(readdirSync(out)).toEqual([r.hash]);
    expect(hashDir(r.dir)).toBe(r.hash);
    expect(validate(schemas.manifest, readJson(join(r.dir, "manifest.json")))).toEqual([]);
    expect(r.manifest.routes).toEqual([
      { kind: "function", method: "GET", path: "/api/hello", module: "functions/api/hello", export: "GET" },
    ]);
    const code = readFileSync(join(r.dir, "code/functions/api/hello.js"), "utf8");
    expect(code).toContain("Response.json");
    expect(code).not.toContain(": Pick<"); // types stripped
    // Source maps stay out of the artifact (#143): next to it, project-relative.
    expect(code).not.toContain("sourceMappingURL");
    expect(r.mapsDir).toBe(join(out, "..", "sourcemaps", r.hash));
    const map = readJson(join(r.mapsDir, "functions/api/hello.js.map")) as { sources: string[] };
    expect(map.sources).toEqual(["functions/api/hello.ts"]);
    expect(code).not.toContain(repo); // no machine path
    // Reproducible: the same project builds to the same hash.
    expect((await buildArtifact(join(repo, "examples/hello"), tmp("hello2"))).hash).toBe(r.hash);
  });

  test("renox new x --template hello && renox build", async () => {
    const parent = tmp("new");
    const dir = newApp("x", "hello", parent);
    expect(readFileSync(join(dir, "functions/api/hello.ts"), "utf8")).toBe(
      readFileSync(join(repo, "examples/hello/functions/api/hello.ts"), "utf8"),
    );
    expect(readFileSync(join(dir, "renox.toml"), "utf8")).toContain('name = "x"');
    expect(existsSync(join(dir, ".gitignore"))).toBe(true);
    const r = await buildArtifact(dir, join(dir, ".renox/artifact"));
    expect(hashDir(r.dir)).toBe(r.hash);
    expect(validate(schemas.manifest, readJson(join(r.dir, "manifest.json")))).toEqual([]);
    expect(() => newApp("x", "hello", parent)).toThrow("not empty");
    expect(() => newApp("Bad Name", "hello", parent)).toThrow();
  });

  test("migrations, public files, permissions, limits, and vendored local imports", async () => {
    const out = tmp("full");
    const r = await buildArtifact(join(import.meta.dir, "fixtures/full"), out);
    const sums = readJson(join(r.dir, "migrations/checksums.json"));
    expect(validate(schemas.migrationsChecksums, sums)).toEqual([]);
    expect(Object.keys((sums as { files: Record<string, string> }).files)).toEqual(["app/001_init.sql", "app/002_index.sql"]);
    // Artifact v1: the public index is public.json at the root (artifact.md section 4).
    const pm = readJson(join(r.dir, "public.json"));
    expect(existsSync(join(r.dir, "public/manifest.json"))).toBe(false);
    expect(r.manifest.artifact.version).toBe(1);
    expect(validate(schemas.publicManifest, pm)).toEqual([]);
    expect((pm as { files: Record<string, { content_type: string }> }).files["/style.css"]?.content_type).toBe("text/css; charset=utf-8");
    expect(r.manifest.permissions).toEqual({ network: ["api.example.com"], secrets: ["API_KEY"] });
    expect(r.manifest.limits).toEqual({ cpu_ms: 40 });
    // lib/greet.ts is bundled into the module: no import is left to resolve.
    const code = readFileSync(join(r.dir, "code/functions/api/items.js"), "utf8");
    expect(code).toContain("salaam");
    expect(code).not.toMatch(/^import /mu);
  });

  // examples/shop has templates since #45: the worker compiles them.
  test.skipIf(!worker)("examples/shop: dependencies shared by modules are bundled once, in code/chunks/ (#143)", async () => {
    const out = tmp("shop");
    const r = await buildArtifact(join(repo, "examples/shop"), out);
    expect(hashDir(r.dir)).toBe(r.hash);
    expect(validate(schemas.manifest, readJson(join(r.dir, "manifest.json")))).toEqual([]);
    const code = join(r.dir, "code");
    const files = readdirSync(code, { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => join(d.parentPath, d.name));
    // zod is imported by cart.ts and checkout.ts: one copy, in a shared chunk.
    const withZod = files.filter((f) => readFileSync(f, "utf8").includes("function strictObject("));
    expect(withZod).toHaveLength(1);
    expect(withZod[0]).toContain(join(code, "chunks/"));
    expect(readFileSync(join(code, "functions/api/cart.js"), "utf8")).toMatch(/from "\.\.\/\.\.\/chunks\/chunk-[a-z0-9]+\.js"/u);
    // Every entry exists; no source map in code/.
    for (const p of Object.values(r.manifest.code.entry)) expect(existsSync(join(code, p))).toBe(true);
    expect(files.some((f) => f.endsWith(".map") || readFileSync(f, "utf8").includes("sourceMappingURL"))).toBe(false);
    expect(existsSync(join(r.mapsDir, "functions/api/checkout.js.map"))).toBe(true);
    // Reproducible with chunks too.
    expect((await buildArtifact(join(repo, "examples/shop"), tmp("shop2"))).hash).toBe(r.hash);
  });

  test("a route conflict fails the build", async () => {
    expect(buildArtifact(join(import.meta.dir, "fixtures/conflict"), tmp("conflict"))).rejects.toThrow("V8");
  });

  test("the built artifact is accepted by the contract checker's rules (schema + hash)", async () => {
    // The Rust loader's acceptance is covered end to end by dev.e2e.test.ts.
    const src = tmp("copy");
    cpSync(join(repo, "examples/hello"), src, { recursive: true, filter: (p) => !p.includes("node_modules") });
    const r = await buildArtifact(src, join(src, ".renox/artifact"));
    expect(validate(schemas.manifest, readJson(join(r.dir, "manifest.json")))).toEqual([]);
  });
});

describe("renox build with pages and templates (#41, #43)", () => {
  test.skipIf(!worker)("pages, templates/, fragment maps, and manifest v1", async () => {
    const r = await buildArtifact(join(import.meta.dir, "fixtures/pages"), tmp("pages"));
    expect(hashDir(r.dir)).toBe(r.hash);
    expect(validate(schemas.manifest, readJson(join(r.dir, "manifest.json")))).toEqual([]);
    expect(r.manifest.artifact.version).toBe(1);
    expect(Object.keys(r.manifest.code.entry).sort()).toEqual(["functions/api/health", "pages/logout", "pages/products/[id]", "pages/products/index"]);
    expect(r.manifest.templates?.["pages/products/[id]"]).toEqual({ kind: "page", fragments: {} });
    expect(r.manifest.templates?.["pages/_layouts/main"]).toEqual({ kind: "layout" });
    expect(r.manifest.templates?.["pages/_error"]?.kind).toBe("error");
    expect(r.manifest.templates?.["pages/_404"]?.kind).toBe("not_found");
    expect(readFileSync(join(r.dir, "templates/pages/products/[id].jinja"), "utf8")).toContain("{{ product.name }}");
    expect(existsSync(join(r.dir, "code/pages/products/[id].js"))).toBe(true);
  });

  test.skipIf(!worker)("renox check reports template diagnostics with file and line", async () => {
    const dir = tmp("tpl-diag");
    cpSync(join(import.meta.dir, "fixtures/pages"), dir, { recursive: true });
    await Bun.write(join(dir, "pages/about.html"), "<p>ok</p>\n<p>{{ range(10) }}</p>\n");
    await Bun.write(join(dir, "pages/index.html"), "<x-nope></x-nope>\n");
    const r = await check(dir);
    const where = r.errors.map((e) => `${e.file}:${e.line}`).sort();
    expect(where).toEqual(["pages/about.html:2", "pages/index.html:1"]);
    expect(r.errors.map((e) => e.message).join("\n")).toContain("unknown component");
  });
});

describe("renox check", () => {
  test("flags SQL interpolation and undeclared fetch hosts in the fixture", async () => {
    const { errors, findings } = await check(join(import.meta.dir, "fixtures/full"));
    expect(errors).toEqual([]);
    const sql = findings.filter((f) => f.rule === "sql-interpolation");
    expect(sql.map((f) => [f.file, f.line])).toEqual([
      ["functions/api/unsafe.ts", 4],
      ["functions/api/unsafe.ts", 5],
    ]);
    const net = findings.filter((f) => f.rule === "fetch-undeclared-host");
    expect(net.map((f) => f.file)).toEqual(["functions/api/unsafe.ts"]);
  });

  test("examples/hello passes; a conflicting app fails", async () => {
    expect(await check(join(repo, "examples/hello"))).toEqual({ errors: [], findings: [] });
    const r = await check(join(import.meta.dir, "fixtures/conflict"));
    expect(r.errors.map((e) => e.message).join("\n")).toContain("V8");
  });

  test("renox.toml is validated", async () => {
    const dir = tmp("toml");
    cpSync(join(import.meta.dir, "fixtures/routes"), dir, { recursive: true });
    await Bun.write(join(dir, "renox.toml"), '[app]\nname = "x"\ntimezone = "UTC"\n[permisions]\nnetwork = []\n');
    const r = await check(dir);
    expect(r.errors.map((e) => e.message).join("\n")).toContain('unknown table "permisions"');
  });
});

test("the app's catalogs i18n/<locale>.json go to code/i18n/ (#244); other files there do not", async () => {
  const parent = tmp("i18n");
  const dir = newApp("x", "hello", parent);
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(join(dir, "i18n"));
  writeFileSync(join(dir, "i18n/ar.json"), '{ "x": { "hello": "مرحباً" } }\n');
  writeFileSync(join(dir, "i18n/en.json"), '{ "x": { "hello": "Hello" } }\n');
  writeFileSync(join(dir, "i18n/notes.txt"), "not a catalog\n");
  const r = await buildArtifact(dir, join(dir, ".renox/artifact"));
  expect(readdirSync(join(r.dir, "code/i18n")).sort()).toEqual(["ar.json", "en.json"]);
  expect(readFileSync(join(r.dir, "code/i18n/ar.json"), "utf8")).toContain("مرحباً");
  expect(hashDir(r.dir)).toBe(r.hash);
});
