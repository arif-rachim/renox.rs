// Passkeys as a sign-in method (#291) with the recorded vectors of #284
// (sdk/tests/fixtures/webauthn: ES256, rpId shop.example): registration
// from the account, sign-in with the discoverable credential, a replayed
// assertion refused (the challenge is single use; then the counter), an
// unknown credential, a challenge not issued by us, and the halt of
// auth.after_login.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { app, snapshot, type TestApp } from "../../../sdk/src/test.ts";

const MODULE = join(import.meta.dir, "..");
const worker = process.env.RENOX_TEST_SPEC ?? process.env.RENOX_WORKER_PATH;
const t = worker ? await app({ project: MODULE }) : (undefined as unknown as TestApp);

interface Vector {
  registration: { challenge: string; response: { clientDataJSON: string; attestationObject: string } };
  assertion: { challenge: string; response: { clientDataJSON: string; authenticatorData: string; signature: string } };
  credentialId: string;
}
const V = (JSON.parse(readFileSync(join(MODULE, "../../sdk/tests/fixtures/webauthn/webauthn.json"), "utf8")) as { es256: Vector }).es256;

function plant(challenge: string, purpose: "register" | "login", userId: string | null) {
  const rw = new Database(t.dbFile);
  rw.exec("pragma busy_timeout = 5000");
  try {
    rw.query("insert or replace into auth__webauthn_challenges (challenge, purpose, user_id, expires_at, used_at) values (?, ?, ?, ?, null)").run(challenge, purpose, userId, Math.floor(Date.now() / 1000) + 300);
  } finally {
    rw.close();
  }
}

const assertion = (next = "/") => ({ next, credential_id: V.credentialId, client_data: V.assertion.response.clientDataJSON, authenticator_data: V.assertion.response.authenticatorData, signature: V.assertion.response.signature });
const stable = (html: string): string => html.replace(/\b[0-9a-f]{32}\b/gu, "<id>").replace(/\b1[0-9]{9}\b/gu, "<time>").replace(/data-options="[^"]*"/gu, 'data-options="<options>"');

describe.skipIf(!worker)("passkeys", () => {
  let userId = "";

  test("register a passkey from the account (a recorded ES256 attestation)", async () => {
    const sara = t.as("sara");
    await sara.action("/auth/register", "default", { email: "sara@example.com", password: "correct horse battery", display_name: "Sara" });
    expect((await sara.action("/auth/login", "default", { email: "sara@example.com", password: "correct horse battery" })).status).toBe(303);
    userId = t.db.query<{ id: string }>("select id from auth__users where email = 'sara@example.com'")[0]?.id as string;
    const page = await sara.page("/auth/passkeys/register");
    expect(page.status).toBe(200);
    expect(page.html).toContain("navigator.credentials.create");
    snapshot(stable(page.html), { role: "passkey register" });
    // The page issued its own challenge; the recorded one is planted for this user.
    plant(V.registration.challenge, "register", userId);
    const r = await sara.action("/auth/passkeys/register", "default", { name: "Test key", client_data: V.registration.response.clientDataJSON, attestation_object: V.registration.response.attestationObject });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/auth/account");
    expect(t.db.query("select credential_id, name, algorithm from auth__passkeys where user_id = ?", [userId])).toEqual([{ credential_id: V.credentialId, name: "Test key", algorithm: -7 }]);
    expect((await sara.page("/auth/account")).html).toContain(">Test key</strong>");
    // The same attestation again: the challenge is used.
    const again = await sara.action("/auth/passkeys/register", "default", { client_data: V.registration.response.clientDataJSON, attestation_object: V.registration.response.attestationObject });
    expect(again.html).toContain("That passkey could not be used.");
  });

  test("sign in with the passkey; a replay, an unknown credential and a challenge not ours are refused", async () => {
    const v = t.as("passkey-visitor");
    const page = await v.page("/auth/passkeys/login");
    expect(page.html).toContain("navigator.credentials.get");
    // Not issued by us: refused.
    expect((await v.action("/auth/passkeys/login", "default", assertion())).html).toContain("That passkey could not be used.");
    plant(V.assertion.challenge, "login", null);
    const ok = await v.action("/auth/passkeys/login", "default", assertion());
    expect(ok.status).toBe(303);
    expect(ok.headers.getSetCookie().some((c) => c.startsWith("__Host-renox_auth="))).toBe(true);
    expect(t.db.query("select counter from auth__passkeys where credential_id = ?", [V.credentialId])).toEqual([{ counter: 1 }]);
    // Replayed: the challenge is used.
    expect((await t.as("replayer").action("/auth/passkeys/login", "default", assertion())).html).toContain("That passkey could not be used.");
    // The same assertion under a fresh copy of the challenge: the counter did not grow.
    plant(V.assertion.challenge, "login", null);
    expect((await t.as("cloner").action("/auth/passkeys/login", "default", assertion())).html).toContain("That passkey could not be used.");
    // An unknown credential.
    plant(V.assertion.challenge, "login", null);
    expect((await t.as("stranger").action("/auth/passkeys/login", "default", { ...assertion(), credential_id: "AAAAAAAAAAAAAAAAAAAAAA" })).html).toContain("That passkey could not be used.");
  });

  test("the halt of auth.after_login stops a passkey sign-in too", async () => {
    const rw = new Database(t.dbFile);
    rw.exec("pragma busy_timeout = 5000");
    try {
      rw.query("update auth__passkeys set counter = 0 where credential_id = ?").run(V.credentialId);
      rw.query("insert or replace into otpbox__halt (user_id) values (?)").run(userId);
    } finally {
      rw.close();
    }
    plant(V.assertion.challenge, "login", null);
    const halted = await t.as("halted").action("/auth/passkeys/login", "default", assertion());
    expect(halted.status).toBe(401);
    expect(halted.headers.getSetCookie().filter((c) => c.startsWith("__Host-renox_auth="))).toEqual([]);
  });
});
