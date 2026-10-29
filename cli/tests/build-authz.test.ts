// #283: `renox build` carries authorization (artifact.md 1.3): the app's
// `[authz]` block on the manifest, `policies/app/*.cedar` and the schema in
// the artifact, each route module's `export const guard` in its route
// entry; V25 (references) and V24 (policies against the merged schema,
// through `renox-worker check-policies`) refuse the build.

import { expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { BuildError, buildArtifact, buildFiles } from "../src/lib/build.ts";
import { PolicyError, readGuard } from "../src/lib/policies.ts";
import { app, BASE, DOC_TS, POLICY } from "./authz-fixture.ts";
import { testWorker } from "./worker-env.ts";

const worker = testWorker();
if (worker) process.env.RENOX_WORKER_PATH = worker;

test("readGuard reads an object literal, with or without defineGuard, and refuses anything else", () => {
  expect(readGuard(`export const guard = { action: "doc.read" };`, "a.ts")).toEqual({ action: "doc.read" });
  expect(readGuard(`export const guard = defineGuard({ action: 'doc.read', resource: { type: 'Doc', id: ':id', }, });`, "a.ts")).toEqual({
    action: "doc.read",
    resource: { type: "Doc", id: ":id" },
  });
  expect(readGuard(`export async function GET() {}`, "a.ts")).toBeNull();
  expect(() => readGuard(`const a = "doc.read";\nexport const guard = { action: a };`, "a.ts")).toThrow(/object literal of strings/u);
  expect(() => readGuard(`export const guard = { action: "Doc read" };`, "a.ts")).toThrow(/<resource>.<verb>/u);
  expect(() => readGuard(`export const guard = { action: "doc.read", extra: "x" };`, "a.ts")).toThrow(/unknown keys extra/u);
});

test.skipIf(!worker)("build carries [authz], the policies and the guard into the artifact", async () => {
  const dir = app(BASE);
  try {
    const built = await buildArtifact(dir, join(dir, ".renox", "artifact"));
    expect(built.manifest.authz).toEqual({
      actions: ["doc.read", "doc.edit"],
      sensitive: ["doc.edit"],
      ownership: { app__docs: { owner: "owner" } },
      entities: { Doc: { table: "app__docs", attrs: ["owner"] } },
      default_roles: { editor: ["doc.edit"] },
    });
    const route = built.manifest.routes.find((r) => r.path === "/docs/:id");
    expect(route?.guard).toEqual({ action: "doc.read", resource: { type: "Doc", id: ":id" } });
    expect(readFileSync(join(built.dir, "policies/app/docs.cedar"), "utf8")).toBe(POLICY);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.skipIf(!worker)("V25: a guard naming an undeclared action, or a parameter the route lacks, refuses the build", async () => {
  for (const [ts, message] of [
    [DOC_TS.replace('"doc.read"', '"doc.delete"'), /guard action doc.delete is not in the merged action set/u],
    [DOC_TS.replace('":id"', '":slug"'), /guard resource id :slug is not a parameter of \/docs\/:id/u],
  ] as const) {
    const dir = app({ ...BASE, "functions/docs/[id].ts": ts });
    try {
      const e = await buildFiles(dir).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(BuildError);
      expect((e as BuildError).message).toMatch(message);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test.skipIf(!worker)("V24: a policy that does not validate against the merged schema refuses the build with its file and line", async () => {
  const dir = app({ ...BASE, "policies/app/docs.cedar": `${POLICY}permit (principal, action == Renox::Action::"doc.purge", resource);\n` });
  try {
    const e = await buildFiles(dir).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(PolicyError);
    const p = e as PolicyError;
    expect(p.message).toMatch(/^RENOX_POLICY_INVALID/u);
    expect(p.diagnostics[0]).toMatchObject({ file: "policies/app/docs.cedar", line: 5 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
