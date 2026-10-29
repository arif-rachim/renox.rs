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
