// The email module installed on the shop (#328): a sign-up's confirmation is
// queued from the module's bilingual template through auth.send_mail, and
// the shop's other routes keep working with the module installed.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { app as harness, type TestApp } from "renox/test";

const worker = process.env.RENOX_WORKER_PATH;
const t = worker ? await harness({ project: join(import.meta.dir, "..") }) : (undefined as unknown as TestApp);

describe.skipIf(!worker)("email on the shop", () => {
  test("registering queues the confirmation from the email module's template", async () => {
    const u = t.as("hala");
    expect((await u.action("/auth/register", "default", { email: "hala@example.com", password: "correct horse battery", display_name: "Hala" })).status).toBe(200);
    // The welcome email follows auth.user_registered through the outbox, after the commit.
    let rows = t.db.query<{ template: string; subject: string; status: string }>("select template, subject, status from email__messages where to_address = 'hala@example.com'");
    for (let i = 0; i < 60 && rows.length < 2; i++) {
      await Bun.sleep(50);
      rows = t.db.query<{ template: string; subject: string; status: string }>("select template, subject, status from email__messages where to_address = 'hala@example.com'");
    }
    expect(rows.map((r) => r.template).sort()).toEqual(["verify_email", "welcome"]);
    expect((await u.page("/products")).status).toBe(200);
  });
});
