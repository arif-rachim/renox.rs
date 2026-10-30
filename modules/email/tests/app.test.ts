// The email module installed in an app, on the real worker (#328): auth's
// confirmation email goes through the module's template (auth.send_mail),
// the welcome email follows auth.user_registered, the log page needs
// email.read_log (docs/24-threat-model.md E, "Teammate with too much power"),
// and it never shows a body.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { app, type TestApp } from "../../../sdk/src/test.ts";

const MODULE = join(import.meta.dir, "..");
const worker = process.env.RENOX_TEST_SPEC ?? process.env.RENOX_WORKER_PATH;
const t = worker ? await app({ project: MODULE }) : (undefined as unknown as TestApp);
const PASSWORD = "correct horse battery";

async function user(name: string, role?: string): Promise<TestApp> {
  const u = t.as(name);
  expect((await u.action("/auth/register", "default", { email: `${name}@example.com`, password: PASSWORD, display_name: name })).status).toBe(200);
  expect((await u.action("/auth/login", "default", { email: `${name}@example.com`, password: PASSWORD })).status).toBe(303);
  if (role) expect((await u.request("POST", `/api/grant?role=${role}`)).status).toBe(200);
  return u;
}

describe.skipIf(!worker)("email in an app", () => {
  test("registering queues auth's confirmation from the module's template, and the welcome email", async () => {
    await user("sara");
    // The welcome email follows auth.user_registered through the outbox, after the commit.
    let rows = t.db.query<{ template: string; to_address: string; subject: string }>("select template, to_address, subject from email__messages where to_address = 'sara@example.com' order by at");
    for (let i = 0; i < 60 && rows.length < 2; i++) {
      await Bun.sleep(50);
      rows = t.db.query<{ template: string; to_address: string; subject: string }>("select template, to_address, subject from email__messages where to_address = 'sara@example.com' order by at");
    }
    expect(rows.map((r) => r.template).sort()).toEqual(["verify_email", "welcome"]);
    expect(rows.find((r) => r.template === "verify_email")?.subject).toBe("Confirm your email address");
  });

  test("the log page: a user without the role is refused, an admin sees recipients and templates but no body", async () => {
    const plain = await user("omar");
    expect((await plain.page("/email")).status).toBe(403);
    const admin = await user("lina", "admin");
    const r = await admin.page("/email");
    expect(r.status).toBe(200);
    expect(r.html).toContain("sara@example.com");
    expect(r.html).toContain("verify_email");
    expect(r.html).not.toContain("#token=");
    expect(r.html).not.toContain("expires_minutes");
  });
});
