// #769: a module's `[exports.errors]` (docs/contracts/manifest.md, MF18): the
// codes its services throw to callers. module.toml parsing keeps the list,
// `renox check` (projectProblems) refuses a code that is not the module's own
// (a `RENOX_*` code, lower case, too short or long) or more than 32 codes,
// and `renox build` carries the list as the artifact's `exports.errors`
// (artifact.md, "Modules"), where the broker reads it (ops.md 15.2, "Errors").

import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";

import { checkArtifactFiles } from "@renox/artifact-validate";

import { check } from "../src/commands/check.ts";
import { buildFiles } from "../src/lib/build.ts";
import { errorCodeProblems, readManifest } from "../src/lib/modules/manifest.ts";
import { projectProblems } from "../src/lib/modules/resolve.ts";
import { app, writeModule } from "./modules-fixture.ts";
import { AUTH_TOML, shopWithAuth } from "./shop-auth-fixture.ts";
import { testWorker } from "./worker-env.ts";

const worker = testWorker();

const errorsToml = (codes: Record<string, string>): string =>
  ["[exports.errors]", ...Object.entries(codes).map(([c, d]) => `${c} = ${JSON.stringify(d)}`), ""].join("\n");

test("MF18: own codes pass; RENOX_*, lower case, too short and too long are refused, each named", () => {
  expect(errorCodeProblems({ STEP_UP_REQUIRED: "x", SELF_RESET: "y", E42: "z" })).toEqual([]);
  expect(errorCodeProblems({ RENOX_FORBIDDEN: "x", step_up: "y", AB: "z", [`A${"B".repeat(64)}`]: "w", "1ABC": "v" })).toEqual([
    'MF18: [exports.errors] "RENOX_FORBIDDEN" starts with RENOX_, the platform\'s codes',
    'MF18: [exports.errors] "step_up" does not match ^[A-Z][A-Z0-9_]{2,63}$',
    'MF18: [exports.errors] "AB" does not match ^[A-Z][A-Z0-9_]{2,63}$',
    `MF18: [exports.errors] "A${"B".repeat(64)}" does not match ^[A-Z][A-Z0-9_]{2,63}$`,
    'MF18: [exports.errors] "1ABC" does not match ^[A-Z][A-Z0-9_]{2,63}$',
  ]);
  const many = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`CODE_${i}`, "x"]));
  expect(errorCodeProblems(many)).toEqual(["MF18: [exports.errors] declares 33 codes, more than 32"]);
  expect(errorCodeProblems(Object.fromEntries(Object.entries(many).slice(0, 32)))).toEqual([]);
});

test("module.toml parsing keeps the list and reports MF18 with the file", () => {
  const dir = app({}, [{ name: "twofa", version: "1.0.0", extra: errorsToml({ STEP_UP_REQUIRED: "Verify again", RENOX_INTERNAL: "no" }) }]);
  const { manifest, problems } = readManifest(`${dir}/modules/twofa`, "twofa/module.toml");
  expect(Object.keys((manifest?.doc.exports as { errors: Record<string, string> }).errors)).toEqual(["STEP_UP_REQUIRED", "RENOX_INTERNAL"]);
  expect(problems).toEqual([{ rule: "MF18", file: "twofa/module.toml", message: '[exports.errors] "RENOX_INTERNAL" starts with RENOX_, the platform\'s codes' }]);
  rmSync(dir, { recursive: true });
});

test("renox check's project rules refuse a bad code of an installed module (MF18)", () => {
  const dir = app({ twofa: '{ version = "^1.0", source = "path:modules/twofa" }' }, []);
  writeModule(`${dir}/modules`, { name: "twofa", version: "1.0.0", extra: errorsToml({ lower_case: "x" }) });
  const mf18 = projectProblems(dir).filter((p) => p.rule === "MF18");
  expect(mf18).toEqual([{ rule: "MF18", file: "twofa/module.toml", message: '[exports.errors] "lower_case" does not match ^[A-Z][A-Z0-9_]{2,63}$' }]);
  rmSync(dir, { recursive: true });
});

describe.skipIf(!worker)("renox build and check with [exports.errors]", () => {
  test("the artifact carries exports.errors, which the shared validator accepts", async () => {
    const dir = await shopWithAuth({}, { "module.toml": `${AUTH_TOML}\n${errorsToml({ AUTH_REQUIRED: "No signed-in user" })}` });
    const r = await buildFiles(dir);
    expect(checkArtifactFiles(r.files).violations).toEqual([]);
    const auth = r.manifest.modules?.[0] as { exports: Record<string, unknown> };
    expect(auth.exports.errors).toEqual(["AUTH_REQUIRED"]);
    expect((await check(dir)).errors.filter((e) => e.message.startsWith("MF18"))).toEqual([]);
  });

  test("a module without [exports.errors] has no errors key (artifacts stay as they were)", async () => {
    const dir = await shopWithAuth();
    const r = await buildFiles(dir);
    expect("errors" in ((r.manifest.modules?.[0] as { exports: Record<string, unknown> }).exports)).toBe(false);
  });
});
