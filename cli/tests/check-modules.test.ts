// #235: `renox check` refuses a broken module contract before anything runs
// (docs/23-failure-modes.md, "Module contract broken on upgrade";
// docs/contracts/manifest.md MF7): a missing service, a view at the wrong
// version, a module used without a declared dependency. Each names the
// module and what it uses.

import { expect, test } from "bun:test";
import { join } from "node:path";

import { addModule } from "../src/commands/add.ts";
import { check } from "../src/commands/check.ts";
import { shopWithAuth, write } from "./shop-auth-fixture.ts";
import { testWorker } from "./worker-env.ts";

const worker = testWorker();

const ORG_TOML = `[module]
name = "org"
version = "1.0.0"

[dependencies]
auth = "^1.0"

[permissions]
tables = "org__*"

[imports]
services = ["auth.currentUser"]
views = ["auth__public_users_v1"]

[exports.services]
members = "The members of the current org"
`;

const ORG_SERVICES = `import { auth } from "renox:modules";
export async function members(ctx) {
  const me = await auth.currentUser();
  return ctx.db.query("select id from auth__public_users_v1 where id = ?", [me?.id]);
}
`;

async function withOrg(services: string, extra: Record<string, string> = {}, toml = ORG_TOML): Promise<string> {
  const dir = await shopWithAuth();
  write(join(dir, "modules/org"), { "module.toml": toml, "services.ts": services, "migrations/001_init.sql": "create table org__orgs (id text primary key);\n", ...extra });
  const log = console.log;
  console.log = () => {};
  try {
    expect(await addModule(dir, "org", { source: "path:modules/org", yes: true }, async () => true)).toBe(0);
  } finally {
    console.log = log;
  }
  return dir;
}

const mf7 = async (dir: string): Promise<{ file?: string; message: string }[]> =>
  (await check(dir)).errors.filter((e) => e.message.startsWith("MF7")).map((e) => ({ ...(e.file ? { file: e.file } : {}), message: e.message }));

test.skipIf(!worker)("a consistent org + auth passes", async () => {
  const dir = await withOrg(ORG_SERVICES);
  expect(await mf7(dir)).toEqual([]);
});

test.skipIf(!worker)("a service the dependency does not export", async () => {
  const dir = await withOrg(ORG_SERVICES.replace("auth.currentUser()", "auth.signIn()"));
  expect(await mf7(dir)).toEqual([{ file: "org/services.ts", message: "MF7: org calls auth.signIn, which auth 1.0.0 does not export" }]);
});

test.skipIf(!worker)("a view at another version names both versions", async () => {
  const dir = await withOrg(ORG_SERVICES.replace("auth__public_users_v1 where", "auth__public_users_v2 where"));
  expect(await mf7(dir)).toEqual([
    { file: "org/services.ts", message: "MF7: org reads auth__public_users_v2, but auth 1.0.0 exports auth__public_users_v1 (version v1, not v2)" },
  ]);
});

test.skipIf(!worker)("a module used without a declared dependency", async () => {
  const toml = ORG_TOML.replace('[dependencies]\nauth = "^1.0"\n', "").replace("[imports]\nservices = [\"auth.currentUser\"]\nviews = [\"auth__public_users_v1\"]\n", "");
  const dir = await withOrg(ORG_SERVICES, {}, toml);
  const errors = await mf7(dir);
  expect(errors).toContainEqual({ file: "org/services.ts", message: "MF7: org imports auth from renox:modules, but auth is not in its [dependencies]" });
  expect(errors).toContainEqual({ file: "org/services.ts", message: "MF7: org reads auth__public_users_v1, but auth is not in its [dependencies]" });
});
