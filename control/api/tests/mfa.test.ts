// Second factors for control-plane accounts (#293; docs/24-threat-model.md
// E, "Account takeover of a tenant developer"): TOTP enrolment, the
// sign-in challenge, a replayed code refused, recovery codes single use,
// passkeys with the recorded vectors (sdk/tests/fixtures/webauthn), step-up
// on secrets, tokens and the team, the grace period for owners and
// admins, the team's `mfa_required`, disabling with the password and a
// code, the notices, and one account never touching another's factors.

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { totp } from "../../../sdk/src/totp.ts";
import { STEP_UP_MS } from "../src/auth/mfa.ts";
import { addMember, assertScoped, harness, login, PASSWORD, signup, type Harness, type Session } from "./helpers.ts";

afterEach(assertScoped);

const V = (JSON.parse(readFileSync(join(import.meta.dir, "../../../sdk/tests/fixtures/webauthn/webauthn.json"), "utf8")) as {
  es256: { registration: { challenge: string; response: { clientDataJSON: string; attestationObject: string } }; assertion: { challenge: string; response: { clientDataJSON: string; authenticatorData: string; signature: string } }; credentialId: string };
}).es256;

beforeAll(() => {
  // The recorded vectors were made for shop.example.
  process.env.MFA_RP_ID = "shop.example";
  process.env.MFA_ORIGIN = "https://shop.example";
});

const DAY = 86_400_000;
const json = async (r: Response) => (await r.json()) as Record<string, unknown>;
const code = (h: Harness, secret: string, steps = 0) => totp(secret, h.clock.now / 1000 + steps * 30);

async function loginRaw(h: Harness, email: string) {
  const res = await h.request("POST", "/v1/account/login", { json: { email, password: PASSWORD } });
  expect(res.status).toBe(200);
  const body = await json(res);
  const cookie = /__Host-renox_session=([^;]+)/u.exec(res.headers.getSetCookie().join("\n"))?.[1] as string;
  return { session: { cookie, csrf: body.csrf as string } as Session, mfa: body.mfa };
}

async function enrolTotp(h: Harness, s: Session): Promise<{ secret: string; codes: string[] }> {
  const start = await h.request("POST", "/v1/account/mfa/totp", { session: s, json: {} });
  expect(start.status).toBe(201);
  const { secret, otpauth_uri } = (await start.json()) as { secret: string; otpauth_uri: string };
  expect(otpauth_uri).toStartWith("otpauth://totp/");
  const ok = await h.request("POST", "/v1/account/mfa/totp/confirm", { session: s, json: { code: await code(h, secret) } });
  expect(ok.status).toBe(200);
  const body = (await ok.json()) as { recovery_codes: string[] };
  return { secret, codes: body.recovery_codes };
}

describe("TOTP and the sign-in challenge", () => {
  test("enrol, then a password sign-in is held until the second factor; a replayed code is refused", async () => {
    const h = await harness();
    const s = await signup(h, "owner@example.test", "t-mfa");
    const { secret, codes } = await enrolTotp(h, s);
    expect(codes).toHaveLength(10);
    expect(h.mailer.last("owner@example.test", "new_device")?.subject).toBe("A second factor was added to your account");
    // At rest: sealed secret, hashed codes.
    const [row] = await h.db.query<{ secret_sealed: string }>("select secret_sealed from account_mfa_totp");
    expect(row?.secret_sealed).not.toContain(secret);
    expect(JSON.stringify(await h.db.query("select code_sha256 from account_recovery_codes"))).not.toContain(codes[0] as string);

    h.clock.now += 60_000;
    const { session, mfa } = await loginRaw(h, "owner@example.test");
    expect(mfa).toBe("verify");
    const held = await h.request("GET", "/v1/apps", { session });
    expect(held.status).toBe(401);
    expect(JSON.stringify(await held.json())).toContain('"reason":"required"');
    expect((await h.request("GET", "/v1/account/mfa", { session })).status).toBe(200);
    const wrong = await h.request("POST", "/v1/account/mfa/verify", { session, json: { method: "totp", code: "000000" } });
    expect(wrong.status).toBe(401);
    const good = await code(h, secret);
    expect((await h.request("POST", "/v1/account/mfa/verify", { session, json: { method: "totp", code: good } })).status).toBe(200);
    expect((await h.request("GET", "/v1/apps", { session })).status).toBe(200);
    // The same code on another sign-in, within its window: refused.
    const again = await loginRaw(h, "owner@example.test");
    expect((await h.request("POST", "/v1/account/mfa/verify", { session: again.session, json: { method: "totp", code: good } })).status).toBe(401);
  });

  test("a recovery code works once", async () => {
    const h = await harness();
    const s = await signup(h, "rec@example.test", "t-rec");
    const { codes } = await enrolTotp(h, s);
    const first = await loginRaw(h, "rec@example.test");
    expect((await h.request("POST", "/v1/account/mfa/verify", { session: first.session, json: { method: "recovery", code: (codes[0] as string).toUpperCase() } })).status).toBe(200);
    const second = await loginRaw(h, "rec@example.test");
    expect((await h.request("POST", "/v1/account/mfa/verify", { session: second.session, json: { method: "recovery", code: codes[0] } })).status).toBe(401);
    expect((await h.request("GET", "/v1/account/mfa", { session: first.session }).then(json)).recovery_left).toBe(9);
  });
});

describe("step-up", () => {
  test("secrets, tokens and the team need a verification within 15 minutes", async () => {
    const h = await harness();
    const s = await signup(h, "step@example.test", "t-step");
    const { secret } = await enrolTotp(h, s);
    // Just enrolled: the session counts as verified.
    expect((await h.request("POST", "/v1/tokens", { session: s, json: { name: "ci", scopes: ["apps:read"], expires_in_days: 30 } })).status).toBe(201);
    h.clock.now += STEP_UP_MS + 60_000;
    const stale = await h.request("POST", "/v1/tokens", { session: s, json: { name: "ci2", scopes: ["apps:read"], expires_in_days: 30 } });
    expect(stale.status).toBe(403);
    expect(JSON.stringify(await stale.json())).toContain("step_up_required");
    // Reading is not stepped up.
    expect((await h.request("GET", "/v1/apps", { session: s })).status).toBe(200);
    expect((await h.request("POST", "/v1/account/mfa/verify", { session: s, json: { method: "totp", code: await code(h, secret) } })).status).toBe(200);
    expect((await h.request("POST", "/v1/tokens", { session: s, json: { name: "ci2", scopes: ["apps:read"], expires_in_days: 30 } })).status).toBe(201);
  });
});

describe("the grace period and the team requirement", () => {
  test("an owner without a factor is held at enrolment after MFA_GRACE_DAYS; a developer is not, until the team requires it", async () => {
    const h = await harness();
    await signup(h, "boss@example.test", "t-grace");
    await signup(h, "dev@example.test");
    await addMember(h, "t-grace", "dev@example.test", "developer");
    // Within the grace period: no state.
    expect((await loginRaw(h, "boss@example.test")).mfa).toBeNull();
    h.clock.now += 15 * DAY;
    const boss = await loginRaw(h, "boss@example.test");
    expect(boss.mfa).toBe("enrol");
    const held = await h.request("GET", "/v1/apps", { session: boss.session });
    expect(held.status).toBe(401);
    expect(JSON.stringify(await held.json())).toContain('"reason":"enrol"');
    expect((await loginRaw(h, "dev@example.test")).mfa).toBeNull();
    // Enrolling lifts the hold.
    await enrolTotp(h, boss.session);
    expect((await h.request("GET", "/v1/apps", { session: boss.session })).status).toBe(200);
    // The team requires a factor of every member (team:write, stepped up: the session just enrolled).
    expect((await h.request("POST", "/v1/team/mfa-required", { session: boss.session, json: { required: true } })).status).toBe(200);
    expect((await loginRaw(h, "dev@example.test")).mfa).toBe("enrol");
  });
});

describe("disable", () => {
  test("needs the password and a current code; the account is told; an owner past the grace period is back to enrolment", async () => {
    const h = await harness();
    const s = await signup(h, "dis@example.test", "t-dis");
    const { secret, codes } = await enrolTotp(h, s);
    expect((await h.request("POST", "/v1/account/mfa/disable", { session: s, json: { password: "wrong password", code: await code(h, secret, 1) } })).status).toBe(401);
    expect((await h.request("POST", "/v1/account/mfa/disable", { session: s, json: { password: PASSWORD, code: "000000" } })).status).toBe(401);
    h.clock.now += 15 * DAY;
    const fresh = await loginRaw(h, "dis@example.test");
    await h.request("POST", "/v1/account/mfa/verify", { session: fresh.session, json: { method: "recovery", code: codes[1] } });
    const off = await h.request("POST", "/v1/account/mfa/disable", { session: fresh.session, json: { password: PASSWORD, code: codes[2] } });
    expect(off.status).toBe(200);
    expect(await off.json()).toEqual({ enrolled: false, session_state: "enrol" });
    expect(h.mailer.last("dis@example.test", "new_device")?.subject).toBe("Two-step verification was turned off");
    expect(await h.db.query("select 1 from account_mfa_totp")).toEqual([]);
  });
});

describe("passkeys", () => {
  test("register and verify with the recorded ES256 vectors; a replay is refused", async () => {
    const h = await harness();
    const s = await signup(h, "pk@example.test", "t-pk");
    const [u] = await h.db.query<{ id: string }>("select id from users where email = 'pk@example.test'");
    const opts = await h.request("POST", "/v1/account/mfa/passkeys/options", { session: s, json: {} });
    expect(opts.status).toBe(200);
    await h.db.query("insert into account_mfa_challenges (challenge, user_id, purpose, expires_at) values ($1, $2, 'register', $3)", [V.registration.challenge, u?.id, h.clock.now + 60_000]);
    const reg = await h.request("POST", "/v1/account/mfa/passkeys", { session: s, json: { name: "Key", client_data: V.registration.response.clientDataJSON, attestation_object: V.registration.response.attestationObject } });
    expect(reg.status).toBe(201);
    expect(((await reg.json()) as { recovery_codes: string[] }).recovery_codes).toHaveLength(10);
    const next = await loginRaw(h, "pk@example.test");
    expect(next.mfa).toBe("verify");
    expect((await h.request("POST", "/v1/account/mfa/challenge", { session: next.session, json: {} })).status).toBe(200);
    await h.db.query("insert into account_mfa_challenges (challenge, user_id, purpose, expires_at) values ($1, $2, 'verify', $3)", [V.assertion.challenge, u?.id, h.clock.now + 60_000]);
    const assertion = { method: "passkey", credential_id: V.credentialId, client_data: V.assertion.response.clientDataJSON, authenticator_data: V.assertion.response.authenticatorData, signature: V.assertion.response.signature };
    expect((await h.request("POST", "/v1/account/mfa/verify", { session: next.session, json: assertion })).status).toBe(200);
    const replay = await loginRaw(h, "pk@example.test");
    expect((await h.request("POST", "/v1/account/mfa/verify", { session: replay.session, json: assertion })).status).toBe(401);
  });
});

describe("one account, its own factors", () => {
  test("a user's verify, status and disable act on their own account only", async () => {
    const h = await harness();
    const a = await signup(h, "a@example.test", "t-a");
    const b = await signup(h, "b@example.test", "t-b");
    const { secret } = await enrolTotp(h, a);
    // B cannot verify with A's code, and B's status shows nothing of A's.
    const bStatus = await h.request("GET", "/v1/account/mfa", { session: b }).then(json);
    expect(bStatus).toMatchObject({ totp: false, passkeys: 0, enrolled: false });
    expect((await h.request("POST", "/v1/account/mfa/verify", { session: b, json: { method: "totp", code: await code(h, secret, 1) } })).status).toBe(401);
    expect((await h.request("POST", "/v1/account/mfa/disable", { session: b, json: { password: PASSWORD, code: await code(h, secret, 1) } })).status).toBe(401);
    expect(await h.db.query("select user_id from account_mfa_totp where confirmed_at is not null")).toHaveLength(1);
  });
});
