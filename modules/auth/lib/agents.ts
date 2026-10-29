// OAuth 2.1 for agents (#286; docs/20-ai-agents-mcp.md section 2,
// "Identity" and "Discovery"; ops.md 1.5.0 section 19): the auth module is
// the authorization server of the app's `/mcp`. The shapes follow the
// control plane's platform MCP (control/api/src/mcp/oauth.ts, #62): RFC 8414
// metadata, RFC 7591 registration of public clients, PKCE S256 required,
// single-use codes, one-hour access tokens, no refresh tokens.
//
// Clients are rows (`auth__oauth_clients`), not sealed values as in #62: the
// app has no platform key of its own, and rows can be listed and removed on
// the account page. Codes and tokens are stored as SHA-256 only.
//
// An agent token is `renox_agt_` + 32 random bytes (hex). `verifyAgentToken`
// answers `{ principal, scopes, client }` for the cell (#285), which caches
// it for 60 s and drops it on `auth.agent_token_revoked`.

import { type AuthCtx, randomHex, sha256Hex, type User } from "./core.ts";

export const TOKEN_PREFIX = "renox_agt_";
export const ACCESS_TTL_SECONDS = 3600;
export const CODE_TTL_SECONDS = 60;
/** Granted when the client asks for no scope. */
export const DEFAULT_SCOPE = "tools:*";

const now = (): number => Math.floor(Date.now() / 1000);

/** RFC 8414 metadata for `issuer` (`https://<host><mount>/oauth`). */
export function metadata(issuer: string): Record<string, unknown> {
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [DEFAULT_SCOPE],
  };
}

/** A redirect URI a public client may register: https, or http on the loopback interface; no fragment, no credentials. */
export function redirectUriOk(uri: unknown): uri is string {
  if (typeof uri !== "string" || uri.length > 512) return false;
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash !== "" || u.username !== "" || u.password !== "") return false;
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
}

/** The scopes of a `scope` parameter: `tools:*` or `tools:<name>` (ops.md section 19); null when one is malformed. */
export function parseScopes(scope: string | null | undefined): string[] | null {
  if (scope === undefined || scope === null || scope.trim() === "") return [DEFAULT_SCOPE];
  const out: string[] = [];
  for (const s of scope.trim().split(/\s+/u)) {
    if (s !== "tools:*" && !/^tools:[a-z][a-z0-9_]{0,63}$/u.test(s)) return null;
    if (!out.includes(s)) out.push(s);
  }
  return out.slice(0, 32);
}

/** RFC 7636: BASE64URL(SHA-256(verifier)). */
export async function challengeOf(verifier: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  let s = "";
  for (const b of d) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

export interface Client {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
}

/** RFC 7591: a public client (no secret), its redirect URIs checked. */
export async function registerClient(ctx: AuthCtx, input: { client_name?: unknown; redirect_uris?: unknown }): Promise<Client | { error: string; error_description: string }> {
  const name = typeof input.client_name === "string" ? input.client_name.trim().slice(0, 100) : "";
  const uris = Array.isArray(input.redirect_uris) ? input.redirect_uris : [];
  if (name === "") return { error: "invalid_client_metadata", error_description: "client_name is required" };
  if (uris.length === 0 || uris.length > 5 || !uris.every(redirectUriOk)) {
    return { error: "invalid_redirect_uri", error_description: "1 to 5 redirect_uris, each https or http on localhost, without a fragment" };
  }
  const id = `agt_client_${randomHex(12)}`;
  await ctx.db.execute("insert into auth__oauth_clients (client_id, client_name, redirect_uris, created_at) values (?, ?, ?, ?)", [id, name, JSON.stringify(uris), now()]);
  return { client_id: id, client_name: name, redirect_uris: uris as string[] };
}

export async function client(ctx: AuthCtx, id: string): Promise<Client | null> {
  const row = await ctx.db.queryOne<{ client_id: string; client_name: string; redirect_uris: string }>("select client_id, client_name, redirect_uris from auth__oauth_clients where client_id = ?", [id]);
  return row ? { client_id: row.client_id, client_name: row.client_name, redirect_uris: JSON.parse(row.redirect_uris) as string[] } : null;
}

/** A checked authorization request (the consent page shows it, Allow issues the code). */
export interface AuthorizeRequest {
  client: Client;
  redirect_uri: string;
  state: string | null;
  code_challenge: string;
  scopes: string[];
}

/**
 * Checks `/authorize`'s parameters. Errors that can be sent back to the
 * client (a bad scope, no PKCE) carry `redirect`; a bad client or redirect
 * URI must not redirect (RFC 6749 section 4.1.2.1).
 */
export async function checkAuthorize(ctx: AuthCtx, q: URLSearchParams): Promise<AuthorizeRequest | { error: string; description: string; redirect?: string }> {
  const c = await client(ctx, q.get("client_id") ?? "");
  if (c === null) return { error: "invalid_client", description: "unknown client_id" };
  const redirect_uri = q.get("redirect_uri") ?? "";
  if (!c.redirect_uris.includes(redirect_uri)) return { error: "invalid_request", description: "redirect_uri is not registered for this client" };
  const back = (error: string, description: string) => {
    const u = new URL(redirect_uri);
    u.searchParams.set("error", error);
    u.searchParams.set("error_description", description);
    const state = q.get("state");
    if (state !== null) u.searchParams.set("state", state);
    return { error, description, redirect: u.toString() };
  };
  if (q.get("response_type") !== "code") return back("unsupported_response_type", "response_type must be code");
  const challenge = q.get("code_challenge") ?? "";
  if (q.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/u.test(challenge)) return back("invalid_request", "PKCE with code_challenge_method=S256 is required");
  const scopes = parseScopes(q.get("scope"));
  if (scopes === null) return back("invalid_scope", "scopes are tools:* or tools:<name>");
  return { client: c, redirect_uri, state: q.get("state"), code_challenge: challenge, scopes };
}

/** Allow: a single-use code for `user`, valid 60 s; returns the client's redirect with `code` and `state`. */
export async function issueCode(ctx: AuthCtx, user: User, r: AuthorizeRequest): Promise<string> {
  const code = randomHex(32);
  await ctx.db.execute(
    "insert into auth__oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, scopes, expires_at) values (?, ?, ?, ?, ?, ?, ?)",
    [await sha256Hex(code), r.client.client_id, user.id, r.redirect_uri, r.code_challenge, JSON.stringify(r.scopes), now() + CODE_TTL_SECONDS],
  );
  const u = new URL(r.redirect_uri);
  u.searchParams.set("code", code);
  if (r.state !== null) u.searchParams.set("state", r.state);
  return u.toString();
}

/** Deny: the client's redirect with `access_denied`. */
export function denied(r: AuthorizeRequest): string {
  const u = new URL(r.redirect_uri);
  u.searchParams.set("error", "access_denied");
  if (r.state !== null) u.searchParams.set("state", r.state);
  return u.toString();
}

export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  scope: string;
}

/**
 * The token endpoint (authorization_code + PKCE). The code is consumed
 * with one conditional UPDATE, so a second exchange fails even when the
 * first one is still running; a failed verifier burns the code too.
 */
export async function exchange(ctx: AuthCtx, f: URLSearchParams): Promise<TokenResponse | { error: string; error_description: string }> {
  const bad = (error: string, error_description: string) => ({ error, error_description });
  if (f.get("grant_type") !== "authorization_code") return bad("unsupported_grant_type", "only authorization_code");
  const code = f.get("code") ?? "";
  const verifier = f.get("code_verifier") ?? "";
  if (!/^[0-9a-f]{64}$/u.test(code)) return bad("invalid_grant", "the code is invalid, expired, or used");
  if (!/^[A-Za-z0-9._~-]{43,128}$/u.test(verifier)) return bad("invalid_request", "code_verifier is 43 to 128 characters");
  const hash = await sha256Hex(code);
  const t = now();
  const used = await ctx.db.execute("update auth__oauth_codes set used_at = ? where code_hash = ? and used_at is null and expires_at > ?", [t, hash, t]);
  if (used.changes !== 1) return bad("invalid_grant", "the code is invalid, expired, or used");
  const row = await ctx.db.queryOne<{ client_id: string; user_id: string; redirect_uri: string; code_challenge: string; scopes: string }>(
    "select client_id, user_id, redirect_uri, code_challenge, scopes from auth__oauth_codes where code_hash = ?",
    [hash],
  );
  if (row === null || row.client_id !== f.get("client_id") || row.redirect_uri !== f.get("redirect_uri")) return bad("invalid_grant", "the code does not match the client or redirect_uri");
  if ((await challengeOf(verifier)) !== row.code_challenge) return bad("invalid_grant", "the code_verifier does not match the code_challenge");
  const c = await client(ctx, row.client_id);
  const token = `${TOKEN_PREFIX}${randomHex(32)}`;
  await ctx.db.execute(
    "insert into auth__agent_tokens (id, token_hash, user_id, client_id, client_name, scopes, created_at, expires_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
    [`agt_${randomHex(12)}`, await sha256Hex(token), row.user_id, row.client_id, c?.client_name ?? "agent", row.scopes, t, t + ACCESS_TTL_SECONDS],
  );
  const scopes = JSON.parse(row.scopes) as string[];
  await ctx.hooks.run("auth.agent_audit", { action: "connect", user_id: row.user_id, client_name: c?.client_name ?? "agent", scopes, at: t });
  return { access_token: token, token_type: "Bearer", expires_in: ACCESS_TTL_SECONDS, scope: scopes.join(" ") };
}

/** What the cell needs for one token (ops.md section 19). */
export interface VerifiedAgent {
  principal: { id: string; attrs: Record<string, unknown> };
  scopes: string[];
  client: { name: string };
}

/** The token's user, scopes and client, or null (unknown, expired, revoked, or a deleted user). Updates `last_used_at`. */
export async function verify(ctx: AuthCtx, token: string): Promise<VerifiedAgent | null> {
  if (typeof token !== "string" || !token.startsWith(TOKEN_PREFIX) || token.length !== TOKEN_PREFIX.length + 64) return null;
  const hash = await sha256Hex(token);
  const t = now();
  const row = await ctx.db.queryOne<{ id: string; user_id: string; client_name: string; scopes: string; email_verified_at: number | null }>(
    `select a.id, a.user_id, a.client_name, a.scopes, u.email_verified_at
       from auth__agent_tokens a join auth__users u on u.id = a.user_id
      where a.token_hash = ? and a.revoked_at is null and a.expires_at > ?`,
    [hash, t],
  );
  if (row === null) return null;
  await ctx.db.execute("update auth__agent_tokens set last_used_at = ? where id = ?", [t, row.id]);
  return {
    principal: { id: row.user_id, attrs: { email_verified: row.email_verified_at !== null, mfa_verified: false } },
    scopes: JSON.parse(row.scopes) as string[],
    client: { name: row.client_name },
  };
}

export interface AgentTokenRow {
  id: string;
  client_name: string;
  scopes: string[];
  created_at: number;
  expires_at: number;
  last_used_at: number | null;
}

/** The user's live agent tokens (account page, "Connected agents"). */
export async function list(ctx: AuthCtx, userId: string): Promise<AgentTokenRow[]> {
  const rows = await ctx.db.query<{ id: string; client_name: string; scopes: string; created_at: number; expires_at: number; last_used_at: number | null }>(
    "select id, client_name, scopes, created_at, expires_at, last_used_at from auth__agent_tokens where user_id = ? and revoked_at is null and expires_at > ? order by created_at desc",
    [userId, now()],
  );
  return rows.map((r) => ({ ...r, scopes: JSON.parse(r.scopes) as string[] }));
}

/** Revoke one of `userId`'s tokens: the cell drops it on the event (`auth.agent_token_revoked`). */
export async function revoke(ctx: AuthCtx, userId: string, id: string): Promise<boolean> {
  const row = await ctx.db.queryOne<{ token_hash: string; client_name: string; scopes: string }>(
    "select token_hash, client_name, scopes from auth__agent_tokens where id = ? and user_id = ? and revoked_at is null",
    [id, userId],
  );
  if (row === null) return false;
  const t = now();
  await ctx.db.execute("update auth__agent_tokens set revoked_at = ? where id = ?", [t, id]);
  await ctx.events.emit("auth.agent_token_revoked", { token_hash: row.token_hash, user_id: userId, at: t });
  await ctx.hooks.run("auth.agent_audit", { action: "revoke", user_id: userId, client_name: row.client_name, scopes: JSON.parse(row.scopes) as string[], at: t });
  return true;
}
