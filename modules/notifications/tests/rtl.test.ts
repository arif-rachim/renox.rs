// The notifications pages in both directions (#336; docs/08-template-engine.md,
// RTL): the list and the preferences, in `en` (ltr) and `ar` (rtl),
// snapshotted, with no English message of their keys left.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { bothDirections, member, stableIds } from "../../i18n/tests/rtl.ts";
import { app, type TestApp } from "../../../sdk/src/test.ts";

const MODULE = join(import.meta.dir, "..");
const worker = process.env.RENOX_TEST_SPEC ?? process.env.RENOX_WORKER_PATH;
const t = worker ? await app({ project: MODULE }) : (undefined as unknown as TestApp);

describe.skipIf(!worker)("notifications in both directions", () => {
  test("every page in en (ltr) and ar (rtl), snapshotted, no English left", async () => {
    const u = await member(t, "rtl");
    const id = t.db.query<{ id: string }>("select id from auth__users where email = 'rtl@example.com'")[0]?.id as string;
    expect((await t.request("POST", "/api/notify", { body: { user: id, item: { category: "orders", title: "Order #42 shipped", body: "On its way", link: "/orders/42" } } })).status).toBe(200);
    await bothDirections(
      MODULE,
      [
        { name: "list", path: "/notifications", as: u, template: "pages/index.html" },
        { name: "prefs", path: "/notifications/prefs", as: u, template: "pages/prefs.html" },
      ],
      (html) => stableIds(html).replace(/\bntf_[0-9a-z]+\b/gu, "<ntf>"),
    );
  });
});
