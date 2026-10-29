// #236: the module types. The fixture app (tests/fixtures/modules-app)
// installs `auth` and `billing`; the CLI's generator writes
// .renox/types/modules.d.ts and renox-modules.d.ts from the lock and the
// manifests; then `tsc` checks the app, the modules, and the negative files.

import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { addModule } from "../../cli/src/commands/add.ts";
import { modulesDts, schemaToTs } from "../../cli/src/lib/types/modules.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "modules-app");
const SDK = resolve(import.meta.dir, "..");
const TSC = resolve(import.meta.dir, "../../node_modules/.bin/tsc");

/** A copy of the fixture with both modules installed and the types generated. */
async function installed(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "renox-types-"));
  cpSync(FIXTURE, dir, { recursive: true });
  const log = console.log;
  console.log = () => {};
  try {
    for (const m of ["auth", "billing"]) expect(await addModule(dir, m, { source: `path:modules/${m}`, yes: true })).toBe(0);
  } finally {
    console.log = log;
  }
  const types = modulesDts(dir);
  if (types === null) throw new Error("no modules");
  const out = join(dir, ".renox", "types");
  Bun.spawnSync(["mkdir", "-p", out]);
  writeFileSync(join(out, "modules.d.ts"), types.modules);
  writeFileSync(join(out, "renox-modules.d.ts"), types.ambient);
  return dir;
}

/** `tsc --noEmit` over the app, the module trees, and `extra`; the exit code and output. */
function tsc(dir: string, extra: string[] = []): { code: number; out: string } {
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      extends: resolve(SDK, "../tsconfig.base.json"),
      compilerOptions: { types: [], paths: { renox: [join(SDK, "src/index.ts")] } },
      files: ["app.ts", "modules/auth/services.ts", "modules/billing/services.ts", ".renox/types/renox-modules.d.ts", ...extra],
    }),
  );
  const r = Bun.spawnSync([TSC, "--noEmit", "-p", dir], { stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode ?? 1, out: `${r.stdout.toString()}${r.stderr.toString()}` };
}

test("the fixture manifests produce modules.d.ts (snapshot)", async () => {
  const dir = await installed();
  expect(readFileSync(join(dir, ".renox", "types", "modules.d.ts"), "utf8")).toMatchSnapshot();
  expect(readFileSync(join(dir, ".renox", "types", "renox-modules.d.ts"), "utf8")).toMatchSnapshot();
  rmSync(dir, { recursive: true });
});

test("the app and the modules type-check against the generated types", async () => {
  const dir = await installed();
  const r = tsc(dir);
  expect(r.out).toBe("");
  expect(r.code).toBe(0);
  rmSync(dir, { recursive: true });
});

test("a service call with a wrong argument type fails tsc", async () => {
  const dir = await installed();
  const r = tsc(dir, ["negative/wrong-argument.ts"]);
  expect(r.code).not.toBe(0);
  expect(r.out).toContain("negative/wrong-argument.ts");
  expect(r.out).toContain("Argument of type 'number' is not assignable to parameter of type 'string'");
  rmSync(dir, { recursive: true });
});

test("an event emit with a missing required field fails tsc", async () => {
  const dir = await installed();
  const r = tsc(dir, ["negative/missing-payload-field.ts"]);
  expect(r.code).not.toBe(0);
  expect(r.out).toContain("negative/missing-payload-field.ts");
  expect(r.out).toContain("user_id");
  const other = tsc(dir, ["negative/unknown-event.ts"]);
  expect(other.code).not.toBe(0);
  expect(other.out).toContain('"auth.user_registered"');
  rmSync(dir, { recursive: true });
});

test("JSON schema to TypeScript: the manifest subset", () => {
  expect(schemaToTs({ type: "object", additionalProperties: false, required: ["a"], properties: { a: { type: "string" }, b: { type: "array", items: { enum: ["x", "y"] } }, c: { type: ["integer", "null"] } } })).toBe(
    '{\n  a: string;\n  b?: ("x" | "y")[];\n  c?: number | null;\n}',
  );
  expect(schemaToTs({ type: "object" })).toBe("{\n  [key: string]: unknown;\n}");
  expect(schemaToTs({ const: 3 })).toBe("3");
  expect(schemaToTs({ oneOf: [{ type: "string" }, { type: "boolean" }] })).toBe("string | boolean");
  expect(schemaToTs(undefined)).toBe("unknown");
});
