// docs/24-threat-model.md F4, "Magic link and reset token replay";
// docs/23-failure-modes.md section 5, "password reset token reuse": magic
// and reset tokens are single use, live 15 minutes, and only work from the
// user agent family that asked for them.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { account, authCookie, PASSWORD, start, worker } from "./helpers.ts";

const t = await start();
const latest = (template: string): URL => new URL((t.db.query<{ url: string }>("select url from mailer__sent where template = ? order by seq desc limit 1", [template])[0] as { url: string }).url);

describe.skipIf(!worker)("token replay and expiry", () => {
  test("magic link: second use refused; tokens live 15 minutes; stored hashed", async () => {
    await account(t, "max", "max@example.com");
    await t.as("max").action("/auth/magic", "default", { email: "max@example.com" });
    const link = latest("magic_link");
    expect((await t.as("max-a").request("GET", link.pathname)).status).toBe(303);
    const replay = await t.as("max-b").request("GET", link.pathname);
    expect(replay.status).toBe(400);
    expect(authCookie(replay)).toBeUndefined();
    const rows = t.db.query<{ ttl: number; token_hash: string }>("select expires_at - created_at as ttl, token_hash from auth__tokens");
    expect(rows.every((r) => r.ttl === 900)).toBe(true);
    expect(rows.some((r) => r.token_hash === link.pathname.split("/").pop())).toBe(false);
  });

  test("magic link: from another browser family refused", async () => {
    await t.as("max").action("/auth/magic", "default", { email: "max@example.com" });
    const link = latest("magic_link");
    expect((await t.as("max-ff").request("GET", link.pathname, { headers: { "user-agent": "Mozilla/5.0 (X11) Gecko/20100101 Firefox/131.0" } })).status).toBe(400);
  });

  test("reset: reuse refused, expiry refused", async () => {
    await t.as("max").action("/auth/reset", "default", { email: "max@example.com" });
    const token = latest("password_reset").searchParams.get("token") as string;
    expect((await t.as("max").action("/auth/reset/confirm", "default", { token, password: "first new passphrase" })).status).toBe(303);
    const reuse = await t.as("max-2").action("/auth/reset/confirm", "default", { token, password: "attacker passphrase!" });
    expect(reuse.status).toBe(200);
    expect(reuse.html).toContain("expired or was already used");
    expect((await t.as("chk").action("/auth/login", "default", { email: "max@example.com", password: "attacker passphrase!" })).status).toBe(200);
    // A link past its 15 minutes.
    await t.as("max").action("/auth/reset", "default", { email: "max@example.com" });
    const late = latest("password_reset").searchParams.get("token") as string;
    const rw = new Database(t.dbFile);
    rw.exec("pragma busy_timeout = 5000");
    rw.exec("update auth__tokens set expires_at = unixepoch() - 1 where used_at is null");
    rw.close();
    const expired = await t.as("max").action("/auth/reset/confirm", "default", { token: late, password: "second new passphrase" });
    expect(expired.html).toContain("expired or was already used");
    void PASSWORD;
  });
});
