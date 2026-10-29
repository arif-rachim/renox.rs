// OAuth 2.0 / OpenID Connect sign-in with Google, GitHub and Microsoft
// (#240; docs/24-threat-model.md F4, "OAuth state / code injection"):
// authorization code flow, `state` in a short-lived `__Host-` cookie and
// compared in constant time, PKCE (S256) for Google and Microsoft, and the
// ID token of the OIDC providers verified (RS256 against the provider's
// keys, fetched through the module's `fetch` and cached per isolate; issuer,
// audience, expiry, nonce). Every network call goes through the `fetch`
// handed in: in the module that is `ctx.fetch`, limited to the hosts of
// `[permissions] network` the app approved.

import { type AuthCtx, GENERIC_LOGIN_ERROR, normalizeEmail, randomHex, startSession, type User } from "./core.ts";

export type ProviderName = "google" | "github" | "microsoft" | "uaepass";

export interface Provider {
  name: ProviderName;
  label: string;
  authorize: string;
  token: string;
  scope: string;
  pkce: boolean;
  /** OIDC providers: where the signing keys are, and whether an issuer is theirs. */
  oidc?: { jwks: string; issuer(iss: string, claims: Record<string, unknown>): boolean };
  /** OAuth 2 providers with a user-info endpoint (UAE PASS). */
  userinfo?: string;
  /** Extra authorize parameters (UAE PASS: `acr_values`). */
  extra?: Record<string, string>;
}

/**
 * UAE PASS (#291; docs/21-uae-gcc-strategy.md): the national digital
 * identity. Staging by default (config `uaepass_env`); production needs the
 * onboarding steps of the README. OAuth 2 with a user-info endpoint, no
 * PKCE, the `acr_values` of a web login.
 */
export const UAEPASS_HOSTS = { staging: "https://stg-id.uaepass.ae", production: "https://id.uaepass.ae" } as const;

function uaepass(env: keyof typeof UAEPASS_HOSTS): Provider {
  const host = UAEPASS_HOSTS[env];
  return {
    name: "uaepass",
    label: "UAE PASS",
    authorize: `${host}/idshub/authorize`,
    token: `${host}/idshub/token`,
    userinfo: `${host}/idshub/userinfo`,
    scope: "urn:uae:digitalid:profile:general",
    pkce: false,
    extra: { acr_values: "urn:safelayer:tws:policies:authentication:level:low", ui_locales: "en" },
  };
}

export const PROVIDERS: Record<ProviderName, Provider> = {
  google: {
    name: "google",
    label: "Google",
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    scope: "openid email profile",
    pkce: true,
    oidc: { jwks: "https://www.googleapis.com/oauth2/v3/certs", issuer: (iss) => iss === "https://accounts.google.com" || iss === "accounts.google.com" },
  },
  github: {
    name: "github",
    label: "GitHub",
    authorize: "https://github.com/login/oauth/authorize",
    token: "https://github.com/login/oauth/access_token",
    scope: "read:user user:email",
    pkce: false,
  },
  microsoft: {
    name: "microsoft",
    label: "Microsoft",
    authorize: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    token: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scope: "openid email profile",
    pkce: true,
    oidc: {
      jwks: "https://login.microsoftonline.com/common/discovery/v2.0/keys",
      // The multi-tenant endpoint: the issuer names the user's tenant.
      issuer: (iss, claims) => typeof claims.tid === "string" && iss === `https://login.microsoftonline.com/${claims.tid}/v2.0`,
    },
  },
  uaepass: uaepass("staging"),
};

/** The provider as configured: UAE PASS follows `uaepass_env` ("staging" or "production"). */
export function providerFor(ctx: { config: Readonly<Record<string, unknown>> }, name: string): Provider | undefined {
  if (name === "uaepass") return uaepass(ctx.config.uaepass_env === "production" ? "production" : "staging");
  return Object.hasOwn(PROVIDERS, name) ? PROVIDERS[name as ProviderName] : undefined;
}

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

const enc = new TextEncoder();

export function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

function fromBase64url(s: string): Uint8Array {
  const b = atob(s.replace(/-/gu, "+").replace(/_/gu, "/") + "===".slice((s.length + 3) % 4));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

const random = (n: number): string => {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return base64url(b);
};

/** The PKCE verifier (43 characters) and its S256 challenge. */
export async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = random(32);
  return { verifier, challenge: base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(verifier)))) };
}

/** What the flow keeps in the `__Host-renox_oauth` cookie between start and callback. */
export interface FlowState {
  provider: ProviderName;
  state: string;
  verifier: string;
  nonce: string;
  next: string;
}

export const OAUTH_COOKIE = "__Host-renox_oauth";

export async function startFlow(p: Provider, clientId: string, redirectUri: string, next: string): Promise<{ url: string; flow: FlowState }> {
  const { verifier, challenge } = await pkce();
  const flow: FlowState = { provider: p.name, state: random(24), verifier, nonce: random(16), next };
  const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: "code", scope: p.scope, state: flow.state });
  if (p.pkce) {
    q.set("code_challenge", challenge);
    q.set("code_challenge_method", "S256");
  }
  if (p.oidc) q.set("nonce", flow.nonce);
  for (const [k, v] of Object.entries(p.extra ?? {})) q.set(k, v);
  return { url: `${p.authorize}?${q}`, flow };
}

export const flowCookie = (flow: FlowState): string =>
  `${OAUTH_COOKIE}=${base64url(enc.encode(JSON.stringify(flow)))}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`;

export const clearFlowCookie = (): string => `${OAUTH_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

/** The flow of the request's cookie, or null. */
export function readFlow(headers: Headers): FlowState | null {
  for (const part of (headers.get("cookie") ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === OAUTH_COOKIE) {
      try {
        const f = JSON.parse(new TextDecoder().decode(fromBase64url(part.slice(eq + 1).trim()))) as FlowState;
        return typeof f.state === "string" && typeof f.verifier === "string" ? f : null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Constant-time string equality (the `state` check). */
export function sameString(a: string, b: string): boolean {
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export class OAuthError extends Error {
  constructor(readonly reason: string) {
    super(`oauth: ${reason}`);
    this.name = "OAuthError";
  }
}

/** The callback's `state` against the flow cookie's (before any network call). */
export function checkCallback(flow: FlowState | null, provider: ProviderName, state: string | null, code: string | null): FlowState {
  if (flow === null) throw new OAuthError("no_flow");
  if (flow.provider !== provider) throw new OAuthError("provider_mismatch");
  if (state === null || !sameString(flow.state, state)) throw new OAuthError("state_mismatch");
  if (!code) throw new OAuthError("no_code");
  return flow;
}

export async function exchange(fetch: Fetch, p: Provider, input: { clientId: string; clientSecret: string; code: string; redirectUri: string; verifier: string }): Promise<Record<string, unknown>> {
  const body = new URLSearchParams({ grant_type: "authorization_code", code: input.code, redirect_uri: input.redirectUri, client_id: input.clientId, client_secret: input.clientSecret });
  if (p.pkce) body.set("code_verifier", input.verifier);
  const res = await fetch(p.token, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body });
  if (!res.ok) throw new OAuthError("token_refused");
  const json = (await res.json()) as Record<string, unknown>;
  if (typeof json.access_token !== "string") throw new OAuthError("token_refused");
  return json;
}

/** Signing keys per JWKS URL, cached in the isolate for an hour. */
const keys = new Map<string, { at: number; keys: JsonWebKey[] }>();

async function jwks(fetch: Fetch, url: string, now: number, kid?: string): Promise<JsonWebKey[]> {
  const hit = keys.get(url);
  // A cached set without the token's key: the provider rotated, fetch again.
  const known = hit?.keys.some((k) => (k as { kid?: string }).kid === kid) ?? false;
  if (hit && now - hit.at < 3600 && (kid === undefined || known)) return hit.keys;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new OAuthError("keys_unavailable");
  const list = ((await res.json()) as { keys?: JsonWebKey[] }).keys ?? [];
  keys.set(url, { at: now, keys: list });
  return list;
}

/** Verify an OIDC ID token: RS256 signature, issuer, audience, expiry, nonce. Returns its claims. */
export async function verifyIdToken(fetch: Fetch, p: Provider, idToken: string, expect: { clientId: string; nonce: string; now?: number }): Promise<Record<string, unknown>> {
  if (!p.oidc) throw new OAuthError("not_oidc");
  const now = expect.now ?? Math.floor(Date.now() / 1000);
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new OAuthError("id_token_malformed");
  const [h, c, s] = parts as [string, string, string];
  let header: { alg?: string; kid?: string };
  let claims: Record<string, unknown>;
  try {
    header = JSON.parse(new TextDecoder().decode(fromBase64url(h)));
    claims = JSON.parse(new TextDecoder().decode(fromBase64url(c)));
  } catch {
    throw new OAuthError("id_token_malformed");
  }
  if (header.alg !== "RS256") throw new OAuthError("id_token_alg");
  const jwk = (await jwks(fetch, p.oidc.jwks, now, header.kid)).find((k) => (k as { kid?: string }).kid === header.kid);
  if (!jwk) throw new OAuthError("id_token_key");
  const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, fromBase64url(s), enc.encode(`${h}.${c}`));
  if (!ok) throw new OAuthError("id_token_signature");
  if (typeof claims.iss !== "string" || !p.oidc.issuer(claims.iss, claims)) throw new OAuthError("id_token_issuer");
  const aud = claims.aud;
  if (!(aud === expect.clientId || (Array.isArray(aud) && aud.includes(expect.clientId)))) throw new OAuthError("id_token_audience");
  if (typeof claims.exp !== "number" || claims.exp <= now - 60) throw new OAuthError("id_token_expired");
  if (claims.nonce !== expect.nonce) throw new OAuthError("id_token_nonce");
  if (typeof claims.sub !== "string" || claims.sub === "") throw new OAuthError("id_token_subject");
  return claims;
}

/** Who signed in: the provider's subject, the email, whether the provider verified it. */
export interface Profile {
  subject: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  /** UAE PASS: the person's UUID, and whether the identity is verified (an SOP3 account). */
  uaepass?: { uuid: string; verifiedIdentity: boolean };
}

/**
 * A UAE PASS user-info answer. `userType` is SOP1 (basic: unverified),
 * SOP2 or SOP3 (verified at a kiosk or with the Emirates ID); the email of
 * SOP2 and SOP3 accounts is verified by UAE PASS.
 */
export function uaepassProfile(info: Record<string, unknown>): Profile {
  const uuid = typeof info.uuid === "string" ? info.uuid : typeof info.sub === "string" ? info.sub : "";
  if (uuid === "") throw new OAuthError("profile_unavailable");
  const type = typeof info.userType === "string" ? info.userType : "SOP1";
  const email = typeof info.email === "string" && info.email.includes("@") ? info.email.toLowerCase() : null;
  const name = typeof info.fullnameEN === "string" ? info.fullnameEN : typeof info.firstnameEN === "string" ? info.firstnameEN : null;
  return { subject: uuid, email, emailVerified: type === "SOP2" || type === "SOP3", name, uaepass: { uuid, verifiedIdentity: type === "SOP3" } };
}

export async function profileOf(fetch: Fetch, p: Provider, tokens: Record<string, unknown>, expect: { clientId: string; nonce: string; now?: number }): Promise<Profile> {
  if (p.oidc) {
    if (typeof tokens.id_token !== "string") throw new OAuthError("no_id_token");
    const c = await verifyIdToken(fetch, p, tokens.id_token, expect);
    const email = typeof c.email === "string" ? c.email.toLowerCase() : null;
    // Microsoft does not send email_verified; its `email` claim is not verified for us.
    return { subject: c.sub as string, email, emailVerified: c.email_verified === true, name: typeof c.name === "string" ? c.name : null };
  }
  if (p.userinfo) {
    const res = await fetch(p.userinfo, { headers: { authorization: `Bearer ${tokens.access_token as string}`, accept: "application/json" } });
    if (!res.ok) throw new OAuthError("profile_unavailable");
    return uaepassProfile((await res.json()) as Record<string, unknown>);
  }
  // GitHub: the user, then the primary verified email.
  const auth = { authorization: `Bearer ${tokens.access_token as string}`, accept: "application/vnd.github+json", "user-agent": "renox-auth" };
  const u = await fetch("https://api.github.com/user", { headers: auth });
  if (!u.ok) throw new OAuthError("profile_unavailable");
  const user = (await u.json()) as { id?: number; name?: string; login?: string };
  const e = await fetch("https://api.github.com/user/emails", { headers: auth });
  const emails = e.ok ? ((await e.json()) as { email: string; primary: boolean; verified: boolean }[]) : [];
  const primary = emails.find((x) => x.primary) ?? null;
  if (typeof user.id !== "number") throw new OAuthError("profile_unavailable");
  return { subject: String(user.id), email: primary?.email.toLowerCase() ?? null, emailVerified: primary?.verified === true, name: user.name ?? user.login ?? null };
}

/** The provider's client id (config `<name>_client_id`) and secret (`AUTH_<NAME>_CLIENT_SECRET`); null when it is not set up. */
export function credentials(ctx: { config: Readonly<Record<string, unknown>>; secrets: Readonly<Record<string, string>> }, p: ProviderName): { clientId: string; clientSecret: string } | null {
  const id = ctx.config[`${p}_client_id`];
  const secret = ctx.secrets[`AUTH_${p.toUpperCase()}_CLIENT_SECRET`];
  return typeof id === "string" && id !== "" && typeof secret === "string" && secret !== "" ? { clientId: id, clientSecret: secret } : null;
}

/** The providers that are set up, for the buttons on the login and register pages. */
export function enabled(ctx: { config: Readonly<Record<string, unknown>>; secrets: Readonly<Record<string, string>> }): { name: ProviderName; label: string }[] {
  return (Object.keys(PROVIDERS) as ProviderName[]).filter((p) => credentials(ctx, p) !== null).map((p) => ({ name: p, label: PROVIDERS[p].label }));
}

/**
 * The user of a provider profile (`auth__identities`):
 *
 * - a known `(provider, subject)`: its user;
 * - else an account with the same email: linked only when the provider
 *   verified that email, otherwise refused with the generic message (an
 *   attacker cannot claim an account by an unverified address);
 * - else a new user (no password), with `auth.user_registered`, `source: "oauth"`.
 */
export async function userOfProfile(ctx: AuthCtx, provider: ProviderName, profile: Profile): Promise<{ ok: true; user: User; created: boolean } | { ok: false; error: string }> {
  const t = Math.floor(Date.now() / 1000);
  const known = await ctx.db.queryOne<User>(
    "select u.id, u.email, u.display_name, u.created_at from auth__identities i join auth__users u on u.id = i.user_id where i.provider = ? and i.subject = ?",
    [provider, profile.subject],
  );
  if (known !== null) {
    await recordUaepass(ctx, known.id, profile);
    return { ok: true, user: known, created: false };
  }
  if (profile.email === null) return { ok: false, error: GENERIC_LOGIN_ERROR };
  const email = normalizeEmail(profile.email);
  const existing = await ctx.db.queryOne<User>("select id, email, display_name, created_at from auth__users where email = ?", [email]);
  if (existing !== null) {
    if (!profile.emailVerified) return { ok: false, error: GENERIC_LOGIN_ERROR };
    await ctx.db.execute("insert into auth__identities (provider, subject, user_id, created_at) values (?, ?, ?, ?)", [provider, profile.subject, existing.id, t]);
    await recordUaepass(ctx, existing.id, profile);
    return { ok: true, user: existing, created: false };
  }
  const user: User = { id: randomHex(16), email, display_name: (profile.name ?? email.split("@")[0] ?? "").slice(0, 100), created_at: t };
  // `!oauth` is no PHC string: no password can match it until one is set (reset).
  await ctx.db.execute(
    "insert into auth__users (id, email, display_name, password_hash, email_verified_at, created_at, updated_at) values (?, ?, ?, '!oauth', ?, ?, ?)",
    [user.id, email, user.display_name, profile.emailVerified ? t : null, t, t],
  );
  await ctx.db.execute("insert into auth__identities (provider, subject, user_id, created_at) values (?, ?, ?, ?)", [provider, profile.subject, user.id, t]);
  await ctx.events.emit("auth.user_registered", { user_id: user.id, at: t, source: "oauth" });
  await recordUaepass(ctx, user.id, profile);
  return { ok: true, user, created: true };
}

/** UAE PASS: the person's UUID and whether the identity is verified, on the user. */
async function recordUaepass(ctx: AuthCtx, userId: string, profile: Profile): Promise<void> {
  if (!profile.uaepass) return;
  await ctx.db.execute("update auth__users set uaepass_uuid = ?, verified_identity = ? where id = ?", [profile.uaepass.uuid, profile.uaepass.verifiedIdentity ? 1 : 0, userId]);
}

/** After the profile: `auth.after_login`, the session, `auth.login`. */
export async function finishSignIn(ctx: AuthCtx, user: User): Promise<{ cookie: string; halt?: Response }> {
  const hook = await ctx.hooks.run("auth.after_login", { user_id: user.id });
  if (hook.halt) return { cookie: "", halt: hook.response };
  const session = await startSession(ctx, user.id);
  await ctx.events.emit("auth.login", { user_id: user.id, at: Math.floor(Date.now() / 1000) });
  return { cookie: session.cookie };
}
