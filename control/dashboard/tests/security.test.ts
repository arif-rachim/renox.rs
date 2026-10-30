// The account security page (#307; deploy-api.md 0.4 section 18, "User
// token rule"; docs/24-threat-model.md E, "Account takeover of a tenant
// developer") against the real control API in process: a user's own token
// enrols TOTP, gets recovery codes, is asked for a code when its own
// verification is older than 15 minutes (step-up) and then gets the action
// it asked for; the team's requirement is shown but never sent with a
// token; each account sees and changes only its own factors.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";

import { totp } from "../../../sdk/src/totp.ts";
import { assertScoped, signup } from "../../api/tests/helpers.ts";
import { STEP_UP_MS } from "../../api/src/auth/mfa.ts";
import { actions as signinActions } from "../pages/signin.ts";
import { actions, load } from "../pages/account/security.ts";
import { actionCtx, dash, loaderCtx, type Dash } from "./helpers.ts";

setDefaultTimeout(30_000);
afterEach(assertScoped);

type Data = Record<string, unknown> & { status: Record<string, unknown> | null };
const data = (v: unknown): Data => {
  expect(v).not.toBeInstanceOf(Response);
  return v as Data;
};

/** A user with their own token (created by their API session), signed in to a dashboard session of their own. */
async function user(d: Dash, email: string, tenantId: string): Promise<Dash> {
  const s = await signup(d.h, email, tenantId);
  const made = await d.h.request("POST", "/v1/tokens", { session: s, json: { name: "dashboard", scopes: ["*"], expires_in_days: 30 } });
  expect(made.status).toBe(201);
  const token = ((await made.json()) as { token: string }).token;
  const mine: Dash = { ...d, sessionId: `S${email.replace(/[^a-z]/gu, "").padEnd(21, "A").slice(0, 21)}` };
  expect(await signinActions.default(actionCtx(mine, "/signin", "default", { token, next: "/account/security" }))).toBeInstanceOf(Response);
  return mine;
}

/** A TOTP code `steps` periods ahead: the API refuses a code it has already accepted (replay). */
const code = (d: Dash, secret: string, steps = 0) => totp(secret, d.h.clock.now / 1000 + steps * 30);

async function enrol(d: Dash): Promise<{ secret: string; codes: string[] }> {
  const started = data(await actions.totp_start(actionCtx(d, "/account/security", "totp_start", {})));
  const setup = started.totp_setup as { secret: string; uri: string };
  expect(setup.uri).toStartWith("otpauth://totp/");
  const done = data(await actions.totp_confirm(actionCtx(d, "/account/security", "totp_confirm", { code: await code(d, setup.secret) })));
  expect(done.status?.totp).toBe(true);
  return { secret: setup.secret, codes: done.recovery_codes as string[] };
}

describe("account security", () => {
  test("a signed-out visitor goes to /signin before any API call", async () => {
    const d = await dash();
    const r = await load(loaderCtx(d, "/account/security"));
    expect((r as Response).status).toBe(303);
    expect(d.calls.sent).toEqual([]);
  });

  test("enrol an authenticator app with the user's token: recovery codes once, the factor on the page", async () => {
    const d = await user(await dash(), "ada@example.test", "t-ada");
    const before = data(await load(loaderCtx(d, "/account/security")));
    expect(before.status).toMatchObject({ totp: false, passkeys: 0, enrolled: false });
    const { codes } = await enrol(d);
    expect(codes).toHaveLength(10);
    const after = data(await load(loaderCtx(d, "/account/security")));
    expect(after.status).toMatchObject({ totp: true, enrolled: true, recovery_left: 10 });
    expect(after.recovery_codes).toBeNull();
    // The token went to the API on every call; the team flag never did.
    expect(d.calls.sent.every((c) => c.authorization?.startsWith("Bearer renox_pat_"))).toBe(true);
    expect(d.calls.sent.some((c) => c.url.endsWith("/v1/team/mfa-required"))).toBe(false);
  });

  test("step-up: after 15 minutes new recovery codes ask for a code, then are made", async () => {
    const d = await user(await dash(), "bo@example.test", "t-bo");
    const { secret } = await enrol(d);
    d.h.clock.now += STEP_UP_MS + 60_000;
    const asked = data(await actions.recovery(actionCtx(d, "/account/security", "recovery", {})));
    expect(asked.step_up).toBe("recovery");
    expect(asked.recovery_codes).toBeNull();
    const wrong = data(await actions.verify(actionCtx(d, "/account/security", "verify", { code: "000000", then: "recovery" })));
    expect(wrong.step_up).toBe("recovery");
    expect(wrong.problem).not.toBeNull();
    const ok = data(await actions.verify(actionCtx(d, "/account/security", "verify", { code: await code(d, secret), then: "recovery" })));
    expect(ok.step_up).toBeNull();
    expect(ok.recovery_codes as string[]).toHaveLength(10);
  });

  test("each account sees and removes only its own factors", async () => {
    const base = await dash();
    const ada = await user(base, "cy@example.test", "t-cy");
    const ben = await user(base, "dee@example.test", "t-dee");
    const { secret } = await enrol(ada);
    expect(data(await load(loaderCtx(ben, "/account/security"))).status).toMatchObject({ totp: false, enrolled: false });
    // Ben cannot remove Ada's factor with Ada's code: his account has none, and his password is checked against his own.
    const tried = data(await actions.disable(actionCtx(ben, "/account/security", "disable", { password: "correct horse battery", code: await code(ada, secret, 1) })));
    expect(tried.problem).not.toBeNull();
    // A refused code keeps the sign-in.
    expect(data(await load(loaderCtx(ben, "/account/security"))).status).toMatchObject({ enrolled: false });
    expect(data(await load(loaderCtx(ada, "/account/security"))).status).toMatchObject({ totp: true });
    const removed = data(await actions.disable(actionCtx(ada, "/account/security", "disable", { password: "correct horse battery", code: await code(ada, secret, 1) })));
    expect(removed.notice).toBe("Second factors removed from your account.");
    expect(removed.status).toMatchObject({ totp: false, enrolled: false });
  });
});
