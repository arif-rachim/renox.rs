// The gcc areas page in both directions (#336; docs/08-template-engine.md,
// RTL): the bilingual list of areas in `en` (ltr) and `ar` (rtl),
// snapshotted. It has no catalog keys: every area is shown in both languages.
import { describe, test } from "bun:test";
import { join } from "node:path";

import { bothDirections } from "../../i18n/tests/rtl.ts";
import { app, type TestApp } from "../../../sdk/src/test.ts";

const MODULE = join(import.meta.dir, "..");
const worker = process.env.RENOX_TEST_SPEC ?? process.env.RENOX_WORKER_PATH;
const t = worker ? await app({ project: MODULE }) : (undefined as unknown as TestApp);

describe.skipIf(!worker)("gcc in both directions", () => {
  test("the areas page in en (ltr) and ar (rtl), snapshotted", async () => {
    await bothDirections(MODULE, [{ name: "areas", path: "/gcc/areas?q=Dub", as: t.as("rtl"), template: "pages/areas.html", arabic: "دبي" }]);
  });
});
