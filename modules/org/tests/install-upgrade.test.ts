// Install and upgrade with auth present (#242; docs/18-build-plan.md,
// module definition of done 6): org installed into the shop (which has
// auth) at 1.0.0, then upgraded to a 1.1.0 fixture with one expand
// migration. Migrations run auth, org, then the app's; the public view
// keeps `_v1`; nothing drifts.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { installModule } from "../../../sdk/src/test.ts";

const MODULE = join(import.meta.dir, "..");
const SHOP = join(MODULE, "../../examples/shop");
const worker = process.env.RENOX_TEST_SPEC ?? process.env.RENOX_WORKER_PATH;

/** org 1.1.0: an added column (expand only, D17). */
function nextVersion(): string {
  const dir = join(mkdtempSync(join(tmpdir(), "renox-org-next-")), "org");
  cpSync(MODULE, dir, { recursive: true, filter: (p) => !p.slice(MODULE.length).startsWith("/tests") });
  writeFileSync(join(dir, "module.toml"), readFileSync(join(dir, "module.toml"), "utf8").replace('version = "1.0.0"', 'version = "1.1.0"'));
  writeFileSync(join(dir, "migrations/003_orgs_logo.sql"), "-- 1.1.0: expand only (D17).\nalter table org__orgs add column logo_url text;\n");
  return dir;
}

const source = (from: string, tree: string): string => `path:${relative(from, tree)}`;

describe.skipIf(!worker)("install and upgrade", () => {
  test("into the shop with auth: 1.0.0, then 1.1.0; auth's migrations first, no drift, the view stays _v1", async () => {
    const v1 = await installModule("org", source(SHOP, MODULE), { project: SHOP });
    expect(v1.check.errors).toEqual([]);
    expect(v1.migrate?.modules.map((m) => [m.module, m.applied])).toEqual([
      ["audit", ["001_events.sql"]],
      ["i18n", ["001_prefs.sql", "002_prefs_digits.sql"]],
      ["auth", ["001_init.sql", "002_tokens_user_agent.sql", "003_agents.sql", "004_phone_passkeys_uaepass.sql", "005_login_tickets.sql"]],
      ["notifications", ["001_init.sql"]],
      ["org", ["001_init.sql", "002_orgs_locale.sql"]],
      ["twofa", ["001_init.sql"]],
      ["app", ["001_init.sql", "002_orders.sql", "003_orders_org.sql", "004_refunds.sql"]],
    ]);
    const v2 = await v1.upgrade(source(SHOP, nextVersion()));
    expect(v2.check.errors).toEqual([]);
    expect(v2.check.findings.filter((f) => f.rule === "override-drift")).toEqual([]);
    expect(v2.migrate?.modules.find((m) => m.module === "org")).toEqual({ module: "org", applied: ["003_orgs_logo.sql"], skipped: ["001_init.sql", "002_orgs_locale.sql"] });
    const db = new Database(join(v2.project, ".renox", "test", "module.db"), { readonly: true });
    try {
      expect(db.query("select name from pragma_table_info('org__public_members_v1')").all().map((c) => (c as { name: string }).name)).toEqual(["org_id", "user_id", "role"]);
      expect(db.query("select name from pragma_table_info('org__orgs') where name = 'logo_url'").all()).toHaveLength(1);
    } finally {
      db.close();
    }
  }, 120_000);
});
