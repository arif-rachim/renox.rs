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
// it for 60 s and drops it on `auth.agent_token_revoked`, and a user's
// tokens on `authz.roles_changed` and `auth.principal_changed` (#590).
//
// #590: the principal is the user's as for a session: the same attributes,
// extended by the `auth.principal` hook (with `agent: true` and the token's
// `org_id`, the organisation picked at consent from the `auth.agent_orgs`
// hook's list), and the user's role assignments; `mfa_verified` is false.

import { type AuthCtx, randomHex, sha256Hex, type User } from "./core.ts";

/** The user attributes the platform's Cedar schema knows (renox-authz USER_ATTRS); a filler's other keys are dropped, except the app's own (below). */
export const PRINCIPAL_ATTRS = ["created_at", "email_verified", "has_password", "mfa_verified", "org", "phone_verified"] as const;

/** The name of an app attribute (`renox.toml [authz] user_attrs`, manifest.md MF19). */
export const APP_ATTR_NAME = /^[a-z][a-z0-9_]{1,31}$/u;
/** At most this many app attributes (MF19). */
export const MAX_APP_ATTRS = 8;

const isPlatformAttr = (k: string | symbol): boolean => typeof k === "string" && (PRINCIPAL_ATTRS as readonly string[]).includes(k);

/**
 * An `attrs` object for the `auth.principal` hook's fillers (ops.md 1.23.0
 * section 17): a write of a key outside the platform's user attributes is
 * kept only when the filler is the app's own (`ctx.caller` is undefined
 * there; a module filler's is its name, read per async context). A module
 * cannot set, change or delete an app attribute, whatever its value. The
 * platform's own keys are open to every filler, as before.
 */
function guardAttrs(ctx: { readonly caller?: unknown }, target: Record<string, unknown>): Record<string, unknown> {
  const blocked = (k: string | symbol): boolean => !isPlatformAttr(k) && ctx.caller !== undefined;
  return new Proxy(target, {
    set: (t, k, v, r) => (blocked(k) ? true : Reflect.set(t, k, v, r)),
    defineProperty: (t, k, d) => (blocked(k) ? false : Reflect.defineProperty(t, k, d)),
    deleteProperty: (t, k) => (blocked(k) ? true : Reflect.deleteProperty(t, k)),
  });
}

/**
 * The principal handed to `auth.principal` fillers, with `attrs` guarded
 * (see `guardAttrs`); a filler that replaces `attrs` gets the new object
 * guarded too. `read()` is what the fillers left.
 */
export function principalForFillers<T extends { attrs: Record<string, unknown> }>(ctx: { readonly caller?: unknown }, p: T): { principal: T; read(): T } {
  let attrs = p.attrs;
  const principal = new Proxy(p, {
    get: (t, k, r) => (k === "attrs" ? guardAttrs(ctx, attrs) : Reflect.get(t, k, r)),
    set: (t, k, v, r) => {
      if (k !== "attrs") return Reflect.set(t, k, v, r);
      // Replacing attrs: a module filler may only carry the platform keys over.
      const next: Record<string, unknown> = {};
      if (v !== null && typeof v === "object") for (const [key, val] of Object.entries(v as Record<string, unknown>)) if (isPlatformAttr(key) || ctx.caller === undefined) next[key] = val;
      if (ctx.caller !== undefined) for (const key of Object.keys(attrs)) if (!isPlatformAttr(key)) next[key] = attrs[key];
      attrs = next;
      return true;
    },
  });
  return { principal, read: () => ({ ...p, attrs }) };
}

/**
 * What auth keeps of the attributes the fillers left: the platform's user
 * attributes, and the app's own, which are booleans under an `APP_ATTR_NAME`
 * name (at most `MAX_APP_ATTRS`, in the order set); anything else is
 * dropped. The cell and the Cedar schema keep only the names the app
 * declares in `[authz] user_attrs`; an undeclared one is inert there.
 */
export function keptAttrs(attrs: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of PRINCIPAL_ATTRS) if (attrs[k] !== undefined) out[k] = attrs[k];
  let app = 0;
  for (const [k, v] of Object.entries(attrs)) {
    if (isPlatformAttr(k) || typeof v !== "boolean" || !APP_ATTR_NAME.test(k) || app >= MAX_APP_ATTRS) continue;
    out[k] = v;
    app++;
  }
  return out;
}

/** One organisation an agent may act in, from the `auth.agent_orgs` hook's fillers (org). */
export interface AgentOrg {
  id: string;
  name: string;
}

/** The user's organisations: the `auth.agent_orgs` hook (`{ user_id, orgs }`, fillers append `{ id, name }`); empty without a filler. */
export async function agentOrgs(ctx: AuthCtx, userId: string): Promise<AgentOrg[]> {
  const args = { user_id: userId, orgs: [] as AgentOrg[] };
  await ctx.hooks.run("auth.agent_orgs", args);
  const out: AgentOrg[] = [];
  for (const o of Array.isArray(args.orgs) ? args.orgs : []) {
    if (o === null || typeof o !== "object" || typeof o.id !== "string" || o.id === "") continue;
    if (out.some((x) => x.id === o.id)) continue;
    out.push({ id: o.id, name: typeof o.name === "string" && o.name !== "" ? o.name : o.id });
  }
  return out;
}

/**
 * The organisation of an Allow (#590): `chosen` must be one of `orgs`;
 * without a choice, the only one, or none when there is none. Null (the
 * page answers 422) for a choice not in the list, or no choice among two
 * or more.
 */
export function pickOrg(orgs: AgentOrg[], chosen: string | null): { org_id: string | null } | null {
  if (chosen !== null && chosen !== "") return orgs.some((o) => o.id === chosen) ? { org_id: chosen } : null;
  if (orgs.length === 0) return { org_id: null };
  if (orgs.length === 1) return { org_id: (orgs[0] as AgentOrg).id };
  return null;
}

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

/** Allow: a single-use code for `user` acting in `orgId` (#590; the caller checked it), valid 60 s; returns the client's redirect with `code` and `state`. */
export async function issueCode(ctx: AuthCtx, user: User, r: AuthorizeRequest, orgId: string | null = null): Promise<string> {
  const code = randomHex(32);
  await ctx.db.execute(
    "insert into auth__oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, scopes, expires_at, org_id) values (?, ?, ?, ?, ?, ?, ?, ?)",
    [await sha256Hex(code), r.client.client_id, user.id, r.redirect_uri, r.code_challenge, JSON.stringify(r.scopes), now() + CODE_TTL_SECONDS, orgId],
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
  const row = await ctx.db.queryOne<{ client_id: string; user_id: string; redirect_uri: string; code_challenge: string; scopes: string; org_id: string | null }>(
    "select client_id, user_id, redirect_uri, code_challenge, scopes, org_id from auth__oauth_codes where code_hash = ?",
    [hash],
  );
  if (row === null || row.client_id !== f.get("client_id") || row.redirect_uri !== f.get("redirect_uri")) return bad("invalid_grant", "the code does not match the client or redirect_uri");
  if ((await challengeOf(verifier)) !== row.code_challenge) return bad("invalid_grant", "the code_verifier does not match the code_challenge");
  const c = await client(ctx, row.client_id);
  const token = `${TOKEN_PREFIX}${randomHex(32)}`;
  await ctx.db.execute(
    "insert into auth__agent_tokens (id, token_hash, user_id, client_id, client_name, scopes, created_at, expires_at, org_id) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [`agt_${randomHex(12)}`, await sha256Hex(token), row.user_id, row.client_id, c?.client_name ?? "agent", row.scopes, t, t + ACCESS_TTL_SECONDS, row.org_id],
  );
  const scopes = JSON.parse(row.scopes) as string[];
  await ctx.hooks.run("auth.agent_audit", { action: "connect", user_id: row.user_id, client_name: c?.client_name ?? "agent", scopes, at: t });
  return { access_token: token, token_type: "Bearer", expires_in: ACCESS_TTL_SECONDS, scope: scopes.join(" ") };
}

/** One of the user's role assignments (`renox__role_assignments`), as the principal carries it. */
export interface AgentRole {
  role: string;
  scope_type: string;
  scope_id: string | null;
}

/** What the cell needs for one token (ops.md section 19). */
export interface VerifiedAgent {
  principal: { id: string; attrs: Record<string, unknown>; roles: AgentRole[] };
  scopes: string[];
  /** `grant_id`: a token minted for the owner connector (#698) carries the connector's grant. */
  client: { name: string; grant_id?: string };
  /** When the token stops working (unix ms): the cell keeps it in its cache no longer (#698). */
  expires_at: number;
}

type RolesCtx = AuthCtx & { authz?: { roles?: { list(userId: string): Promise<{ role: string; scope_type: string; scope_id: string | null }[]> } } };

/**
 * The token's user, scopes and client, or null (unknown, expired, revoked,
 * or a deleted user). Updates `last_used_at`. The principal is built as
 * for a session (`services.ts` `principal`): the `auth.principal` hook runs
 * with `agent: true` and the token's `org_id` (org sets `org` while the
 * user is still a member), only the platform's user attributes are kept,
 * `mfa_verified` is false; `roles` are the user's role assignments.
 */
export async function verify(ctx: AuthCtx, token: string): Promise<VerifiedAgent | null> {
  if (typeof token !== "string" || !token.startsWith(TOKEN_PREFIX) || token.length !== TOKEN_PREFIX.length + 64) return null;
  const hash = await sha256Hex(token);
  const t = now();
  const row = await ctx.db.queryOne<{
    id: string;
    user_id: string;
    client_name: string;
    scopes: string;
    org_id: string | null;
    expires_at: number;
    grant_id: string | null;
    email_verified_at: number | null;
    phone_verified_at: number | null;
    created_at: number;
  }>(
    `select a.id, a.user_id, a.client_name, a.scopes, a.org_id, a.expires_at, a.grant_id, u.email_verified_at, u.phone_verified_at, u.created_at
       from auth__agent_tokens a join auth__users u on u.id = a.user_id
      where a.token_hash = ? and a.revoked_at is null and a.expires_at > ?`,
    [hash, t],
  );
  if (row === null) return null;
  await ctx.db.execute("update auth__agent_tokens set last_used_at = ? where id = ?", [t, row.id]);
  const base = { id: row.user_id, attrs: { email_verified: row.email_verified_at !== null, phone_verified: row.phone_verified_at !== null, created_at: row.created_at } as Record<string, unknown> };
  const f = principalForFillers(ctx, base);
  await ctx.hooks.run("auth.principal", { principal: f.principal, agent: true, org_id: row.org_id });
  const attrs = keptAttrs(f.read().attrs);
  // No second factor and no password for an agent token, whatever a filler set.
  attrs.mfa_verified = false;
  attrs.has_password = false;
  const assigned = (await (ctx as RolesCtx).authz?.roles?.list(row.user_id)) ?? [];
  const roles = assigned.map((r) => ({ role: r.role, scope_type: r.scope_type, scope_id: r.scope_id ?? null }));
  return {
    principal: { id: row.user_id, attrs, roles },
    scopes: JSON.parse(row.scopes) as string[],
    client: row.grant_id === null ? { name: row.client_name } : { name: row.client_name, grant_id: row.grant_id },
    expires_at: row.expires_at * 1000,
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

// ---------------------------------------------------------------------------
// The owner connector's bridge (#698; docs/20-ai-agents-mcp.md section 1b,
// "The bridge"; deploy-api.md 0.9 section 15, `nodeMintAgentToken`): the
// node runs `mintAgentToken` in the app's cell as the platform, and the
// control plane calls the app's own `/mcp` with the token, so the app's
// scopes, rate limit, confirmation and Cedar policies apply as the owner's
// app user. Nothing new reaches the app: the token is an ordinary row of
// `auth__agent_tokens`, listed, revocable and verified like any other.

/** The client id of every minted token (deploy-api.md 0.9 section 15). */
export const PLATFORM_CLIENT_ID = "renoxium-platform";
/** A minted token lives at most this long (seconds). */
export const MINT_MAX_TTL_SECONDS = 300;
/** And at least this long, as `agent_token_request` allows. */
export const MINT_MIN_TTL_SECONDS = 30;
const MINT_SCOPE = /^tools:[a-z][a-z0-9_]{0,63}$/u;
const MINT_EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/u;
const MINT_GRANT = /^[0-9A-Za-z_-]{1,64}$/u;

export interface MintInput {
  email: string;
  scopes: string[];
  ttl_seconds: number;
  client_name: string;
  grant_id: string;
}

/** `{ token, expires_at }` (unix ms, as `agent_token_minted`), or null when no app user has that verified email. */
export type Minted = { token: string; expires_at: number } | null;

/** The first problem of a mint request as `{ field, reason }` (the shape of `agent_token_request`), or null. */
export function mintProblem(input: unknown): { field: string; reason: string } | null {
  const i = (input ?? {}) as Partial<Record<keyof MintInput, unknown>>;
  if (typeof i.email !== "string" || i.email.length > 254 || !MINT_EMAIL.test(i.email)) return { field: "email", reason: "an email address" };
  if (!Array.isArray(i.scopes) || i.scopes.length < 1 || i.scopes.length > 10) return { field: "scopes", reason: "1 to 10 scopes" };
  for (const s of i.scopes) {
    // `tools:*` is never minted: the bridge names the tools it needs.
    if (typeof s !== "string" || !MINT_SCOPE.test(s)) return { field: "scopes", reason: "each scope is tools:<name>" };
  }
  if (new Set(i.scopes).size !== i.scopes.length) return { field: "scopes", reason: "scopes are unique" };
  if (typeof i.ttl_seconds !== "number" || !Number.isInteger(i.ttl_seconds) || i.ttl_seconds < MINT_MIN_TTL_SECONDS || i.ttl_seconds > MINT_MAX_TTL_SECONDS) {
    return { field: "ttl_seconds", reason: `an integer from ${MINT_MIN_TTL_SECONDS} to ${MINT_MAX_TTL_SECONDS}` };
  }
  if (typeof i.client_name !== "string" || i.client_name.length < 1 || i.client_name.length > 80) return { field: "client_name", reason: "1 to 80 characters" };
  if (typeof i.grant_id !== "string" || !MINT_GRANT.test(i.grant_id)) return { field: "grant_id", reason: "1 to 64 of [0-9A-Za-z_-]" };
  return null;
}

/**
 * Mints a token for the app user whose **verified** email is `email` (a
 * user without a verified email is no such user), with exactly `scopes`,
 * `expires_at` at most `ttl_seconds` (≤ 300) ahead, the client
 * `renoxium-platform` named `client_name`, and `grant_id` (the connector's
 * access-token id on the control plane) kept on the row for the audit
 * trail. The organisation is the user's only one, as on the consent page
 * without a choice (#590); none when they have none or several. The caller
 * checked the input (`mintProblem`) and that it is the platform.
 */
export async function mint(ctx: AuthCtx, input: MintInput): Promise<Minted> {
  const user = await ctx.db.queryOne<{ id: string }>("select id from auth__users where email = ? and email_verified_at is not null", [input.email]);
  if (user === null) return null;
  const org = pickOrg(await agentOrgs(ctx, user.id), null)?.org_id ?? null;
  const token = `${TOKEN_PREFIX}${randomHex(32)}`;
  const t = now();
  const expires = t + Math.min(input.ttl_seconds, MINT_MAX_TTL_SECONDS);
  await ctx.db.execute(
    "insert into auth__agent_tokens (id, token_hash, user_id, client_id, client_name, scopes, created_at, expires_at, org_id, grant_id) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [`agt_${randomHex(12)}`, await sha256Hex(token), user.id, PLATFORM_CLIENT_ID, input.client_name, JSON.stringify(input.scopes), t, expires, org, input.grant_id],
  );
  await ctx.hooks.run("auth.agent_audit", { action: "connect", user_id: user.id, client_name: input.client_name, scopes: input.scopes, at: t, grant_id: input.grant_id });
  return { token, expires_at: expires * 1000 };
}
