// The admin pages in both directions (#336; docs/08-template-engine.md, RTL):
// the dashboard, the users and the audit trail in `en` (ltr) and `ar` (rtl), snapshotted, with no English message
// of their keys left.
import { describe, test } from "bun:test";
import { join } from "node:path";

import { bothDirections, member, stableIds } from "../../i18n/tests/rtl.ts";
import { app, type TestApp } from "../../../sdk/src/test.ts";

const MODULE = join(import.meta.dir, "..");
const worker = process.env.RENOX_TEST_SPEC ?? process.env.RENOX_WORKER_PATH;
const t = worker ? await app({ project: MODULE }) : (undefined as unknown as TestApp);

describe.skipIf(!worker)("admin in both directions", () => {
  test("every page in en (ltr) and ar (rtl), snapshotted, no English left", async () => {
    const u = await member(t, "rtl", "admin");
    await bothDirections(MODULE, [{ name: "dashboard", path: "/admin", as: u, template: "pages/index.html" }, { name: "users", path: "/admin/users", as: u, template: "pages/users.html" }, { name: "audit", path: "/admin/audit", as: u, template: "pages/audit.html" }], stableIds);
  });
});
