// Passkeys as a sign-in method (#291): a discoverable credential registered
// from the account page, used from the login page. Verification is the
// SDK's (`verifyRegistration`, `verifyAssertion`, #284: ES256 and RS256,
// `none` and self `packed` attestation). Challenges are single use and
// live 5 minutes; the signature counter must grow when the authenticator
// keeps one. A passkey here signs in; a second factor is the 2fa module's
// (#287), with its own table.

import { base64url, fromBase64url, verifyAssertion, verifyRegistration, WebAuthnError } from "renox";

import { afterLogin, type AuthCtx, now, randomHex, startSession, type User } from "./core.ts";

export const CHALLENGE_TTL_SECONDS = 5 * 60;
export const GENERIC_PASSKEY_ERROR = "That passkey could not be used. Try again, or sign in another way.";

type Ctx = AuthCtx & { url: URL };

/** The relying party: config `passkey_rp_id` / `passkey_origin`, else the request's host. */
export function relyingParty(ctx: Ctx): { rpId: string; origin: string } {
  const rpId = typeof ctx.config.passkey_rp_id === "string" && ctx.config.passkey_rp_id !== "" ? ctx.config.passkey_rp_id : ctx.url.hostname;
  const origin = typeof ctx.config.passkey_origin === "string" && ctx.config.passkey_origin !== "" ? ctx.config.passkey_origin : `https://${ctx.url.host}`;
  return { rpId, origin };
}

async function newChallenge(ctx: AuthCtx, purpose: "register" | "login", userId: string | null): Promise<string> {
  const challenge = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const t = now();
  await ctx.db.execute("delete from auth__webauthn_challenges where expires_at < ?", [t]);
  await ctx.db.execute("insert into auth__webauthn_challenges (challenge, purpose, user_id, expires_at) values (?, ?, ?, ?)", [challenge, purpose, userId, t + CHALLENGE_TTL_SECONDS]);
  return challenge;
}

/** The challenge the browser signed (from clientDataJSON), consumed if it is ours, unused, unexpired, of this purpose and user. */
async function takeChallenge(ctx: AuthCtx, clientDataJSON: string, purpose: "register" | "login", userId: string | null): Promise<string | null> {
  let challenge: unknown;
  try {
    challenge = (JSON.parse(new TextDecoder().decode(fromBase64url(clientDataJSON))) as { challenge?: unknown }).challenge;
  } catch {
    return null;
  }
  if (typeof challenge !== "string" || challenge.length > 128) return null;
  const t = now();
  const r = await ctx.db.execute(
    `update auth__webauthn_challenges set used_at = ? where challenge = ? and purpose = ? and used_at is null and expires_at > ? and ${userId === null ? "user_id is null" : "user_id = ?"}`,
    userId === null ? [t, challenge, purpose, t] : [t, challenge, purpose, t, userId],
  );
  return r.changes === 1 ? challenge : null;
}

/** `navigator.credentials.create` options (JSON; binary fields base64url) for the signed-in user. */
export async function registrationOptions(ctx: Ctx, user: User) {
  const { rpId } = relyingParty(ctx);
  const existing = await ctx.db.query<{ credential_id: string }>("select credential_id from auth__passkeys where user_id = ?", [user.id]);
  return {
    challenge: await newChallenge(ctx, "register", user.id),
    rp: { id: rpId, name: rpId },
    user: { id: base64url(new TextEncoder().encode(user.id)), name: user.email, displayName: user.display_name },
    pubKeyCredParams: [
      { type: "public-key", alg: -7 },
      { type: "public-key", alg: -257 },
    ],
    authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
    excludeCredentials: existing.map((c) => ({ type: "public-key", id: c.credential_id })),
    timeout: CHALLENGE_TTL_SECONDS * 1000,
  };
}

export async function finishRegistration(ctx: Ctx, user: User, input: { clientDataJSON: unknown; attestationObject: unknown; name?: unknown }): Promise<{ ok: true } | { ok: false; error: string }> {
  if (typeof input.clientDataJSON !== "string" || typeof input.attestationObject !== "string") return { ok: false, error: GENERIC_PASSKEY_ERROR };
  const challenge = await takeChallenge(ctx, input.clientDataJSON, "register", user.id);
  if (challenge === null) return { ok: false, error: GENERIC_PASSKEY_ERROR };
  const { rpId, origin } = relyingParty(ctx);
  try {
    const c = await verifyRegistration({ expectedChallenge: challenge, expectedOrigin: origin, expectedRpId: rpId, response: { clientDataJSON: input.clientDataJSON, attestationObject: input.attestationObject } });
    const taken = await ctx.db.queryOne("select 1 as x from auth__passkeys where credential_id = ?", [c.credentialId]);
    if (taken !== null) return { ok: false, error: GENERIC_PASSKEY_ERROR };
    const name = typeof input.name === "string" && input.name.trim() ? input.name.trim().slice(0, 60) : "Passkey";
    await ctx.db.execute("insert into auth__passkeys (id, credential_id, user_id, public_key, algorithm, counter, name, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)", [`pk_${randomHex(12)}`, c.credentialId, user.id, c.publicKey, c.algorithm, c.counter, name, now()]);
    return { ok: true };
  } catch (e) {
    if (e instanceof WebAuthnError) return { ok: false, error: GENERIC_PASSKEY_ERROR };
    throw e;
  }
}

/** `navigator.credentials.get` options: no allow list (a discoverable credential names its user). */
export async function loginOptions(ctx: Ctx) {
  return { challenge: await newChallenge(ctx, "login", null), rpId: relyingParty(ctx).rpId, userVerification: "preferred", timeout: CHALLENGE_TTL_SECONDS * 1000 };
}

export type PasskeyLogin = { ok: true; user: User; cookie: string; halt?: Response } | { ok: false; error: string };

export async function finishLogin(ctx: Ctx, input: { credentialId: unknown; clientDataJSON: unknown; authenticatorData: unknown; signature: unknown }, next?: string): Promise<PasskeyLogin> {
  const fail = { ok: false as const, error: GENERIC_PASSKEY_ERROR };
  const { credentialId, clientDataJSON, authenticatorData, signature } = input;
  if (typeof credentialId !== "string" || typeof clientDataJSON !== "string" || typeof authenticatorData !== "string" || typeof signature !== "string") return fail;
  const challenge = await takeChallenge(ctx, clientDataJSON, "login", null);
  if (challenge === null) return fail;
  const pk = await ctx.db.queryOne<{ id: string; user_id: string; public_key: string; counter: number }>("select id, user_id, public_key, counter from auth__passkeys where credential_id = ?", [credentialId]);
  if (pk === null) return fail;
  const { rpId, origin } = relyingParty(ctx);
  let counter: number;
  try {
    ({ counter } = await verifyAssertion({ expectedChallenge: challenge, expectedOrigin: origin, expectedRpId: rpId, response: { clientDataJSON, authenticatorData, signature }, credential: { publicKey: pk.public_key, counter: pk.counter } }));
  } catch (e) {
    if (e instanceof WebAuthnError) return fail;
    throw e;
  }
  // A cloned authenticator: the counter did not grow (0 = the authenticator keeps none).
  if ((counter !== 0 || pk.counter !== 0) && counter <= pk.counter) return fail;
  await ctx.db.execute("update auth__passkeys set counter = ?, last_used_at = ? where id = ?", [counter, now(), pk.id]);
  const user = await ctx.db.queryOne<User>("select id, email, display_name, created_at from auth__users where id = ?", [pk.user_id]);
  if (user === null) return fail;
  const hook = await afterLogin(ctx, user.id, next);
  if (hook.halt) return { ok: true, user, cookie: "", halt: hook.response };
  const session = await startSession(ctx, user.id);
  await ctx.events.emit("auth.login", { user_id: user.id, at: now() });
  return { ok: true, user, cookie: session.cookie };
}

export async function list(ctx: AuthCtx, userId: string) {
  return ctx.db.query<{ id: string; name: string; created_at: number; last_used_at: number | null }>("select id, name, created_at, last_used_at from auth__passkeys where user_id = ? order by created_at", [userId]);
}

export async function remove(ctx: AuthCtx, userId: string, id: string): Promise<boolean> {
  return (await ctx.db.execute("delete from auth__passkeys where id = ? and user_id = ?", [id, userId])).changes === 1;
}
