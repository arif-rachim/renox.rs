// #283: `renox test` runs `policies/tests/*.json` (docs/11-authorization.md,
// "renox test"): every case through the engine the cell builds, a wrong
// expectation fails the run (exit 2); the modules' own cases pass.

import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";

import { runTests } from "../src/commands/test.ts";
import { evaluatePolicies, prepare } from "../src/lib/test-harness.ts";
import { app, BASE } from "./authz-fixture.ts";
import { testWorker } from "./worker-env.ts";

const worker = testWorker();
if (worker) process.env.RENOX_WORKER_PATH = worker;

const CASES = [
  { description: "the owner reads", principal: { type: "User", id: "u_a" }, action: "doc.read", resource: { type: "Doc", id: "d1", owner: "u_a" }, expected: "allow" },
  { description: "another user does not", principal: { type: "User", id: "u_b" }, action: "doc.read", resource: { type: "Doc", id: "d1", owner: "u_a" }, expected: "deny" },
  { description: "an editor edits", principal: { type: "User", id: "u_c", roles: ["editor"] }, action: "doc.edit", resource: { type: "Doc", id: "d1", owner: "u_a" }, expected: "allow" },
];

test.skipIf(!worker)("policy cases run in renox test; a wrong expectation fails the run", async () => {
  const ok = app({ ...BASE, "policies/tests/docs.json": JSON.stringify(CASES), "tests/smoke.test.ts": `import { test, expect } from "bun:test";\ntest("smoke", () => expect(1).toBe(1));\n` });
  const bad = app({
    ...BASE,
    "policies/tests/docs.json": JSON.stringify([...CASES, { description: "wrong", principal: { type: "User", id: "u_b" }, action: "doc.edit", resource: { type: "Doc", id: "d1", owner: "u_a" }, expected: "allow" }]),
    "tests/smoke.test.ts": `import { test, expect } from "bun:test";\ntest("smoke", () => expect(1).toBe(1));\n`,
  });
  try {
    const spec = await prepare(ok, [], worker);
    const outcomes = await evaluatePolicies(spec);
    expect(outcomes.map((o) => [o.case.description, o.ok])).toEqual([
      ["the owner reads", true],
      ["another user does not", true],
      ["an editor edits", true],
    ]);
    const passed = await runTests(ok, [], "pipe");
    expect(passed.code).toBe(0);
    expect(passed.out).toContain("(pass) policy policies/tests/docs.json: an editor edits -> allow");
    const failed = await runTests(bad, [], "pipe");
    expect(failed.code).toBe(2);
    expect(failed.out).toContain("(fail) policy policies/tests/docs.json: wrong -> deny (expected allow, deny)");
  } finally {
    rmSync(ok, { recursive: true, force: true });
    rmSync(bad, { recursive: true, force: true });
  }
}, 120_000);

test.skipIf(!worker)("the auth and org modules' policy cases pass against their policies", async () => {
  for (const name of ["auth", "org"]) {
    const module = join(import.meta.dir, "../../modules", name);
    const spec = await prepare(module, [], worker);
    const outcomes = await evaluatePolicies(spec, module);
    expect(outcomes.length).toBeGreaterThan(0);
    expect(outcomes.filter((o) => !o.ok).map((o) => `${name}: ${o.case.description}: ${o.result.reason}`)).toEqual([]);
  }
}, 120_000);
