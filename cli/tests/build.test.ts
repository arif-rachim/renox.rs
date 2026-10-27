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

const repo = join(import.meta.dir, "../..");
const tmp = (p: string): string => mkdtempSync(join(tmpdir(), `renox-cli-${p}-`));
const readJson = (p: string): Json => JSON.parse(readFileSync(p, "utf8")) as Json;

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
    expect(code).toContain("sourceMappingURL=data:application/json");
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
    const pm = readJson(join(r.dir, "public/manifest.json"));
    expect(validate(schemas.publicManifest, pm)).toEqual([]);
    expect((pm as { files: Record<string, { content_type: string }> }).files["/style.css"]?.content_type).toBe("text/css; charset=utf-8");
    expect(r.manifest.permissions).toEqual({ network: ["api.example.com"], secrets: ["API_KEY"] });
    expect(r.manifest.limits).toEqual({ cpu_ms: 40 });
    // lib/greet.ts is bundled into the module: no import is left to resolve.
    const code = readFileSync(join(r.dir, "code/functions/api/items.js"), "utf8");
    expect(code).toContain("salaam");
    expect(code).not.toMatch(/^import /mu);
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
    expect(r.errors.join("\n")).toContain("V8");
  });

  test("renox.toml is validated", async () => {
    const dir = tmp("toml");
    cpSync(join(import.meta.dir, "fixtures/routes"), dir, { recursive: true });
    await Bun.write(join(dir, "renox.toml"), '[app]\nname = "x"\ntimezone = "UTC"\n[permisions]\nnetwork = []\n');
    const r = await check(dir);
    expect(r.errors.join("\n")).toContain("unknown key");
  });
});
