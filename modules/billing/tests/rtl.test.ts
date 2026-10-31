// The billing pages in both directions (#336; docs/08-template-engine.md,
// RTL): the plans, the invoices, a bank transfer's pending page and the
// statement import, in `en` (ltr) and `ar` (rtl), snapshotted, with no
// English message of their keys left.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { bothDirections, member, stableIds } from "../../i18n/tests/rtl.ts";
import { app, type TestApp } from "../../../sdk/src/test.ts";

const MODULE = join(import.meta.dir, "..");
const worker = process.env.RENOX_TEST_SPEC ?? process.env.RENOX_WORKER_PATH;
const t = worker ? await app({ project: MODULE }) : (undefined as unknown as TestApp);

describe.skipIf(!worker)("billing in both directions", () => {
  test("every page in en (ltr) and ar (rtl), snapshotted, no English left", async () => {
    expect((await t.request("POST", "/api/plan")).status).toBe(200);
    const admin = await member(t, "adel", "admin");
    const nour = await member(t, "nour");
    const order = (await nour.request("POST", "/api/order?order=o-rtl")).json<{ url: string }>();
    expect(order.url).toBe("/billing/checkout/pending?order=o-rtl");
    await bothDirections(
      MODULE,
      [
        { name: "plans", path: "/billing", as: nour, template: "pages/index.html" },
        { name: "pending", path: order.url, as: nour, template: "pages/checkout/pending.html" },
        { name: "invoices", path: "/billing/invoices", as: admin, template: "pages/invoices.html" },
        { name: "import", path: "/billing/checkout/import", as: admin, template: "pages/checkout/import.html" },
      ],
      // The transfer's reference is random.
      (html) => stableIds(html).replace(/\bRNX-[A-Z0-9]+\b|\bcs_[A-Za-z0-9]+\b/gu, "<reference>"),
    );
  });
});
