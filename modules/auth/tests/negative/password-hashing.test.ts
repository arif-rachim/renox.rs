// docs/24-threat-model.md F4 ("Login brute force": argon2id): the stored
// hash is argon2id v19 at m = 64 MiB, t = 3, p = 1 with a 16-byte salt and a
// 32-byte digest, made by the platform op (renox-runtime tests/password.rs
// asserts the op itself), and two users with one password get two hashes.

import { describe, expect, test } from "bun:test";

import { account, start, worker } from "./helpers.ts";

const t = await start();

describe.skipIf(!worker)("password hashing", () => {
  test("argon2id m=65536,t=3,p=1, salted per user", async () => {
    await account(t, "h1", "h1@example.com");
    await account(t, "h2", "h2@example.com");
    const rows = t.db.query<{ password_hash: string }>("select password_hash from auth__users order by email");
    for (const { password_hash } of rows) {
      const m = /^\$argon2id\$v=19\$m=65536,t=3,p=1\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/u.exec(password_hash);
      expect(m).not.toBeNull();
      expect(Buffer.from(m?.[1] as string, "base64").length).toBe(16);
      expect(Buffer.from(m?.[2] as string, "base64").length).toBe(32);
    }
    expect(rows[0]?.password_hash).not.toBe(rows[1]?.password_hash);
  });
});

// docs/24-threat-model.md A, "Login brute force" (#275 item 2): the length
// rule is the only composition rule; at the default password_min_length =
// 12, 11 characters are refused and 12 lowercase letters are accepted (no
// character-class rules, NIST SP 800-63B).
describe.skipIf(!worker)("password length", () => {
  test("an 11-character password is refused, 12 lowercase letters are accepted", async () => {
    const short = await t.as("len11").action("/auth/register", "default", { email: "len11@example.com", password: "abcdefghijk", display_name: "Len" });
    expect(short.html).toContain("Use a password of at least 12 characters.");
    expect(t.db.query("select id from auth__users where email = 'len11@example.com'")).toEqual([]);
    const ok = await t.as("len12").action("/auth/register", "default", { email: "len12@example.com", password: "abcdefghijkl", display_name: "Len" });
    expect(ok.status).toBe(200);
    expect(ok.html).not.toContain("Use a password of at least");
    expect(t.db.query<{ n: number }>("select count(*) as n from auth__users where email = 'len12@example.com'")).toEqual([{ n: 1 }]);
  });
});
