// The jobs pages in both directions (#336; docs/08-template-engine.md, RTL):
// the jobs page in `en` (ltr) and `ar` (rtl), snapshotted, with no English message
// of their keys left.
import { describe, test } from "bun:test";
import { join } from "node:path";

import { bothDirections, member, stableIds } from "../../i18n/tests/rtl.ts";
import { app, type TestApp } from "../../../sdk/src/test.ts";

const MODULE = join(import.meta.dir, "..");
const worker = process.env.RENOX_TEST_SPEC ?? process.env.RENOX_WORKER_PATH;
const t = worker ? await app({ project: MODULE }) : (undefined as unknown as TestApp);

describe.skipIf(!worker)("jobs in both directions", () => {
  test("every page in en (ltr) and ar (rtl), snapshotted, no English left", async () => {
    const u = await member(t, "rtl", "admin");
    await bothDirections(MODULE, [{ name: "jobs", path: "/jobs", as: u, template: "pages/index.html" }], stableIds);
  });
});
