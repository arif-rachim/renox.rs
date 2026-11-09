// #659, docs/24-threat-model.md "Security events not visible to operators":
// a failed password sign-in emits `auth.login_failed { reason, ip_hash }`,
// which the cell counts as renox_security_events_total{kind="login_failed"}.
// The payload never carries the email, the password or a user id.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { account, PASSWORD, start, worker } from "./helpers.ts";

const t = await start();
const login = (as: string, email: string, password: string) => t.as(as).action("/auth/login", "default", { email, password });

/** The `auth.login_failed` payloads the outbox holds, oldest first. */
function failedLogins(): string[] {
  const db = new Database(t.dbFile, { readonly: true });
  db.exec("pragma busy_timeout = 5000");
  try {
    return db
      .query("select payload from renox__outbox where name = 'auth.login_failed' order by rowid")
      .all()
      .map((r) => (r as { payload: string }).payload);
  } finally {
    db.close();
  }
}

describe.skipIf(!worker)("auth.login_failed", () => {
  test("a wrong password and an unknown user emit it, with no email in the payload", async () => {
    await account(t, "lf", "lf@example.com");
    const before = failedLogins().length;
    await login("lf-bad", "lf@example.com", "wrong guess");
    await login("lf-ghost", "ghost-user@example.com", PASSWORD);
    const rows = failedLogins().slice(before);
    expect(rows.length).toBe(2);
    const events = rows.map((p) => JSON.parse(p) as { reason: string; ip_hash: string });
    expect(events.map((e) => e.reason)).toEqual(["password", "unknown_user"]);
    for (const [i, e] of events.entries()) {
      expect(Object.keys(e).sort()).toEqual(["ip_hash", "reason"]);
      expect(e.ip_hash).toMatch(/^[0-9a-f]{16}$/u);
      const text = rows[i] as string;
      expect(text).not.toContain("example.com");
      expect(text).not.toContain("wrong guess");
    }
  }, 60_000);

  test("a locked account reports reason locked", async () => {
    await account(t, "lk", "lk@example.com");
    for (let i = 0; i < 10; i++) await login("lk-bad", "lk@example.com", `wrong ${i}`);
    const before = failedLogins().length;
    await login("lk-real", "lk@example.com", PASSWORD);
    const last = JSON.parse(failedLogins().slice(before)[0] as string) as { reason: string };
    expect(last.reason).toBe("locked");
  }, 60_000);
});
