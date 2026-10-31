// Install and upgrade (#241; docs/18-build-plan.md, module definition of
// done 6): auth installed into the shop at 1.0.0, then upgraded to a 1.1.0
// fixture with one expand migration and one changed template. Without an
// override nothing drifts; with one, `renox check` reports the drift with a
// diff. Migrations run in order; the public view keeps `_v1`.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { installModule } from "../../../sdk/src/test.ts";

const MODULE = join(import.meta.dir, "..");
const SHOP = join(MODULE, "../../examples/shop");
const worker = process.env.RENOX_TEST_SPEC ?? process.env.RENOX_WORKER_PATH;

/** auth 1.1.0: an added column (expand), and the login page changed. */
function nextVersion(): string {
  const dir = join(mkdtempSync(join(tmpdir(), "renox-auth-next-")), "auth");
  cpSync(MODULE, dir, { recursive: true, filter: (p) => !p.slice(MODULE.length).startsWith("/tests") });
  writeFileSync(join(dir, "module.toml"), readFileSync(join(dir, "module.toml"), "utf8").replace('version = "1.0.0"', 'version = "1.1.0"'));
  writeFileSync(join(dir, "migrations/006_users_locale.sql"), "-- 1.1.0: expand only (D17).\nalter table auth__users add column locale text;\n");
  writeFileSync(join(dir, "pages/login.html"), readFileSync(join(dir, "pages/login.html"), "utf8").replace("<h1><r-t key=\"auth.login.title\" /></h1>", "<h1><r-t key=\"auth.login.title\" /></h1>\n  <p class=\"lede\">Welcome back.</p>"));
  return dir;
}

const source = (from: string, tree: string): string => `path:${relative(from, tree)}`;

describe.skipIf(!worker)("install and upgrade", () => {
  test("into the shop: 1.0.0, then 1.1.0; migrations in order, no drift, the view stays _v1", async () => {
    const next = nextVersion();
    const v1 = await installModule("auth", source(SHOP, MODULE), { project: SHOP });
    expect(v1.check.errors).toEqual([]);
    expect(v1.migrate?.modules.map((m) => [m.module, m.applied])).toEqual([
      ["audit", ["001_events.sql"]],
      ["i18n", ["001_prefs.sql", "002_prefs_digits.sql", "003_prefs_calendar.sql"]],
      ["auth", ["001_init.sql", "002_tokens_user_agent.sql", "003_agents.sql", "004_phone_passkeys_uaepass.sql", "005_login_tickets.sql"]],
      ["notifications", ["001_init.sql"]],
      ["org", ["001_init.sql", "002_orgs_locale.sql"]],
      ["twofa", ["001_init.sql"]],
      ["app", ["001_init.sql", "002_orders.sql", "003_orders_org.sql", "004_refunds.sql", "005_product_images.sql"]],
    ]);
    const v2 = await v1.upgrade(source(SHOP, next));
    expect(v2.check.errors).toEqual([]);
    expect(v2.check.findings.filter((f) => f.rule === "override-drift")).toEqual([]);
    expect(v2.migrate?.modules.find((m) => m.module === "auth")).toEqual({ module: "auth", applied: ["006_users_locale.sql"], skipped: ["001_init.sql", "002_tokens_user_agent.sql", "003_agents.sql", "004_phone_passkeys_uaepass.sql", "005_login_tickets.sql"] });
    const db = new Database(join(v2.project, ".renox", "test", "module.db"), { readonly: true });
    try {
      expect(db.query("select name from pragma_table_info('auth__public_users_v1')").all().map((c) => (c as { name: string }).name)).toEqual(["id", "email", "display_name", "created_at"]);
      expect(db.query("select name from pragma_table_info('auth__users') where name = 'locale'").all()).toHaveLength(1);
    } finally {
      db.close();
    }
  }, 120_000);

  test("with a tenant override of the login page, the upgrade reports the drift with a diff", async () => {
    const next = nextVersion();
    const app = join(mkdtempSync(join(tmpdir(), "renox-shop-override-")), "shop");
    cpSync(SHOP, app, { recursive: true, filter: (p) => !/\/(\.renox|node_modules)(\/|$)/u.test(p.slice(SHOP.length)) });
    writeFileSync(join(app, "overrides.json"), "");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(app, "overrides/auth/pages"), { recursive: true });
    writeFileSync(join(app, "overrides/auth/pages/login.html"), readFileSync(join(MODULE, "pages/login.html"), "utf8").replace("<h1><r-t key=\"auth.login.title\" /></h1>", "<h1>Sign in to Renox Shop</h1>"));
    cpSync(join(SHOP, "node_modules"), join(app, "node_modules"), { recursive: true, dereference: true });
    const v1 = await installModule("auth", source(app, MODULE), { project: app });
    expect(v1.check.errors).toEqual([]);
    const v2 = await v1.upgrade(source(app, next));
    const drift = v2.check.findings.filter((f) => f.rule === "override-drift");
    expect(drift).toHaveLength(1);
    expect(drift[0]?.file).toBe("overrides/auth/pages/login.html");
    expect(drift[0]?.message).toContain('+  <p class="lede">Welcome back.</p>');
    expect(drift[0]?.severity).toBe("warning");
  }, 120_000);
});
