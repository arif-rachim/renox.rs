// #284: `renox build` of tool routes (artifact.md 1.3; ops.md section 19):
// a `functions/tools/*.ts` default-exporting `tool(...)` becomes a `tool`
// entry with the JSON Schema of its input; a module's `[[tools]]` is
// carried and must agree with its file; V25 refuses an undeclared action
// and a duplicate name. The artifact validates against the 1.3 schema.

import { expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";

import { addModule } from "../src/commands/add.ts";
import { BuildError, buildFiles } from "../src/lib/build.ts";
import { validate } from "../src/lib/schema.ts";
import { schemas } from "../src/lib/schemas.ts";
import { app } from "./authz-fixture.ts";
import { testWorker } from "./worker-env.ts";

const worker = testWorker();
if (worker) process.env.RENOX_WORKER_PATH = worker;
const repo = join(import.meta.dir, "../..");

const TOML = `[app]
name = "billing"
timezone = "Asia/Dubai"

[authz]
actions = ["invoice.create", "invoice.read"]
`;
const TOOL = `import { tool } from "renox";
import { z } from "zod";
export default tool({
  name: "create_invoice",
  description: "Create a draft invoice for a customer",
  input: z.object({ customerId: z.string().min(1), qty: z.number().int().positive() }),
  action: "invoice.create",
  confirm: true,
  async run({ tool }) { return { id: "inv_1", customer: tool.input.customerId }; },
});
`;

/** An app whose node_modules resolve `renox` (the SDK) and `zod`. */
function project(files: Record<string, string>): string {
  const dir = app(files);
  mkdirSync(join(dir, "node_modules"), { recursive: true });
  symlinkSync(join(repo, "sdk"), join(dir, "node_modules/renox"));
  symlinkSync(join(repo, "sdk/node_modules/zod"), join(dir, "node_modules/zod"));
  return dir;
}

test.skipIf(!worker)("a tool module becomes a tool entry with its input's JSON Schema", async () => {
  const dir = project({ "renox.toml": TOML, "functions/tools/create-invoice.ts": TOOL, "functions/health.ts": "export const GET = () => new Response('ok');\n" });
  try {
    const built = await buildFiles(dir);
    const t = built.manifest.routes.find((r) => r.kind === "tool");
    expect(t).toEqual({
      kind: "tool",
      name: "create_invoice",
      module: "functions/tools/create-invoice",
      description: "Create a draft invoice for a customer",
      input: { type: "object", properties: { customerId: { type: "string", minLength: 1 }, qty: { type: "integer", exclusiveMinimum: 0 } }, required: ["customerId", "qty"] },
      action: "invoice.create",
      confirm: true,
    });
    expect(built.manifest.entries?.["functions/tools/create-invoice"]?.exports).toEqual(["default"]);
    expect(validate(schemas.manifest, built.manifest as never)).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.skipIf(!worker)("V25: an undeclared action and a duplicate tool name refuse the build", async () => {
  const undeclared = project({ "renox.toml": TOML, "functions/tools/create-invoice.ts": TOOL.replace('"invoice.create"', '"invoice.void"') });
  const twice = project({ "renox.toml": TOML, "functions/tools/create-invoice.ts": TOOL, "functions/tools/again.ts": TOOL });
  const notATool = project({ "renox.toml": TOML, "functions/tools/broken.ts": "export default { name: 'x' };\n" });
  try {
    const a = (await buildFiles(undeclared).catch((e: unknown) => e)) as Error;
    expect(a).toBeInstanceOf(BuildError);
    expect(a.message).toContain("V25: functions/tools/create-invoice: tool action invoice.void is not in the merged action set");
    const b = (await buildFiles(twice).catch((e: unknown) => e)) as Error;
    expect(b.message).toContain("V25: tool name create_invoice is used by functions/tools/again and functions/tools/create-invoice");
    const c = (await buildFiles(notATool).catch((e: unknown) => e)) as Error;
    expect(c.message).toContain("functions/tools/broken.ts: must default-export tool({ name, description, input, action, run })");
  } finally {
    for (const d of [undeclared, twice, notATool]) rmSync(d, { recursive: true, force: true });
  }
});

const MODULE_TOML = (description: string) => `[module]
name = "billing"
version = "1.0.0"

[permissions]
tables = "billing__*"

[authz]
actions = ["invoice.create"]

[[tools]]
name = "create_invoice"
file = "tools/create-invoice.ts"
action = "invoice.create"
confirm = true
description = "${description}"
`;

test.skipIf(!worker)("a module's [[tools]] is carried as a tool route and must agree with its file", async () => {
  for (const [description, ok] of [
    ["Create a draft invoice for a customer", true],
    ["Something else", false],
  ] as const) {
    const dir = project({
      "renox.toml": `[app]\nname = "shop"\ntimezone = "Asia/Dubai"\n`,
      "functions/health.ts": "export const GET = () => new Response('ok');\n",
      "modules/billing/module.toml": MODULE_TOML(description),
      "modules/billing/tools/create-invoice.ts": TOOL,
    });
    try {
      // The module's imports resolve through the app's node_modules (a module tree holds no links).
      const log = console.log;
      console.log = () => {};
      try {
        expect(await addModule(dir, "billing", { source: "path:modules/billing", yes: true }, async () => true)).toBe(0);
      } finally {
        console.log = log;
      }
      const r = await buildFiles(dir).catch((e: unknown) => e);
      if (ok) {
        const built = r as Awaited<ReturnType<typeof buildFiles>>;
        expect(built.manifest.routes.find((x) => x.kind === "tool")).toMatchObject({ kind: "tool", name: "create_invoice", module: "modules/billing/tools/create-invoice", confirm: true });
        expect((built.manifest.modules?.[0] as { authz?: unknown }).authz).toEqual({ actions: ["invoice.create"] });
      } else {
        expect((r as Error).message).toContain('[[tools]] description is "Something else" in module.toml but "Create a draft invoice for a customer" in the file');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}, 60_000);
