// The org pages in both directions (#336; docs/08-template-engine.md, RTL):
// the organisation page, its members and an invitation, in `en` (ltr) and
// `ar` (rtl), snapshotted, with no English message of their keys left.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { bothDirections, member, stableIds } from "../../i18n/tests/rtl.ts";
import { app, type TestApp } from "../../../sdk/src/test.ts";

const MODULE = join(import.meta.dir, "..");
const worker = process.env.RENOX_TEST_SPEC ?? process.env.RENOX_WORKER_PATH;
const t = worker ? await app({ project: MODULE }) : (undefined as unknown as TestApp);

describe.skipIf(!worker)("org in both directions", () => {
  test("every page in en (ltr) and ar (rtl), snapshotted, no English left", async () => {
    const olive = await member(t, "olive");
    expect((await olive.action("/org", "create", { name: "Acme Trading", slug: "acme" })).status).toBeLessThan(400);
    expect((await olive.action("/org/members", "invite", { email: "ann@example.com", role: "admin" })).status).toBe(200);
    const url = t.db.query<{ url: string }>("select url from orgmail__sent where mail_to = 'ann@example.com' order by seq desc limit 1")[0]?.url as string;
    const ann = await member(t, "ann");
    await bothDirections(
      MODULE,
      [
        { name: "org", path: "/org", as: olive, template: "pages/index.html" },
        { name: "members", path: "/org/members", as: olive, template: "pages/members.html" },
        { name: "accept", path: new URL(url).pathname, as: ann, template: "pages/accept/[token].html" },
      ],
      (html) => stableIds(html).replace(/\b(org|inv)_[0-9A-Za-z]+\b/gu, "<$1>"),
    );
  });
});
