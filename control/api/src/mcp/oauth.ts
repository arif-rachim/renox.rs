// OAuth 2.1 for the remote platform MCP (docs/20-ai-agents-mcp.md sections 1
// and 5; the MCP authorization spec, protocol 2025-06-18 and later; #62).
// The control API is both the authorization server and the protected
// resource `<origin>/mcp`:
//
//   GET  /.well-known/oauth-protected-resource[/mcp]   RFC 9728
//   GET  /.well-known/oauth-authorization-server       RFC 8414
//   POST /oauth/register                               RFC 7591, public clients only
//   GET  /oauth/authorize                              consent page (dashboard session)
//   POST /oauth/authorize                              approve or deny
//   POST /oauth/token                                  authorization_code + PKCE S256, refresh_token
//   POST /oauth/revoke                                 RFC 7009
//
// An access token is a tenant token (`renox_pat_`, deploy-api.md section 2)
// named `mcp: <client name>`, created for the approving user, so it carries
// at most that user's role and shows up in `renox tokens list` where the
// tenant can revoke it. Scopes are the #113 token scopes. Client ids, the
// consent request and the code are sealed values (seal.ts); the code holds the
// token, which lives CODE_TTL_MS until the code is exchanged: the exchange
// extends it with a compare-and-set on `expires_at`, so a code works once.
//
// The exchange also answers a refresh token (`rnxrt_…`, #688): a sealed
// reference to a row of kind `refresh` that lives 30 days, is bound to the
// client id and shares the `family_id` of the access tokens. The refresh grant
// rotates it with a compare-and-set on `used_at`; a refresh token used twice
// revokes the family (RFC 6819 5.2.2.3).

import type { Context, Hono } from "hono";
import { createHash } from "node:crypto";
import { writeAudit } from "../audit.ts";
import { clientIp } from "../auth/ip.ts";
import { findSession, readCookie, SESSION_COOKIE } from "../auth/sessions.ts";
import { createTenantToken, parseScope, REFRESH_TTL_MS, revokeTokenFamily, sameDigest, sha256hex } from "../auth/tokens.ts";
import { ulid } from "../ids.ts";
import { jsonb, num } from "../db/db.ts";
import type { Deps, Env } from "../context.ts";
import { isRole, roleAllows, type Role } from "../tenancy/roles.ts";
import { withTenant } from "../tenancy/scope.ts";
import { escapeHtml, htmlPage, openAuthRequest, originOf, sealAuthRequest } from "./return.ts";
import { open, seal } from "./seal.ts";

export { originOf };

/** Scopes an MCP client may ask for. Never `secrets:write` or `tokens:write`: an agent does not set secrets or mint tokens. `domains:write`, `app:settings` and `app:people` are offered but never in the default grant. */
export const MCP_SCOPES = ["apps:read", "apps:write", "deploy", "logs:read", "secrets:read", "domains:write", "app:settings", "app:people"] as const;
/**
 * The owner connector's profile (docs/20-ai-agents-mcp.md section 1b, "Grant
 * profile and consent texts", #700): `scope=owner` asks for these. Never
 * `secrets:*`, `tokens:write`, `deploy` or `apps:delete`: a request naming the
 * profile drops any other scope it lists.
 */
export const OWNER_PROFILE = ["apps:read", "apps:write", "domains:write", "app:settings", "app:people"] as const;
/** What the consent page says for each scope, in plain words (section 1b). */
export const CONSENT_TEXTS: Record<(typeof MCP_SCOPES)[number], string> = {
  "apps:read": "See your apps and what they contain",
  "apps:write": "Create and change your apps",
  "domains:write": "Add your domains",
  "app:settings": "Change your app's settings",
  "app:people": "Invite people",
  deploy: "Put new versions of your apps live and roll them back",
  "logs:read": "Read your apps' logs",
  "secrets:read": "See the names of your apps' secrets, never their values",
};

/** The plain-words line of one granted scope (`<action>` or `<action>:<app>`). */
export function consentText(scope: string): string {
  const p = parseScope(scope);
  const text = p === null ? scope : (CONSENT_TEXTS[p.action as (typeof MCP_SCOPES)[number]] ?? scope);
  return p?.app === undefined ? text : `${text} (only the app ${p.app})`;
}
/** Granted when the client asks for no scope: read scopes plus deploy (docs/20-ai-agents-mcp.md section 1). */
export const DEFAULT_SCOPES = ["apps:read", "logs:read", "secrets:read", "deploy"];
export const TOKEN_PREFIX_NAME = "mcp: ";
export const ACCESS_TTL_MS = 3_600_000;
export const CODE_TTL_MS = 60_000;
const CONSENT_TTL_MS = 600_000;

interface ClientInfo {
  /** client_name */
  n: string;
  /** redirect_uris */
  r: string[];
  /** issued at */
  i: number;
}

interface ConsentRequest {
  c: string; // client_id
  r: string; // redirect_uri
  ch: string; // code_challenge
  st: string | null; // state
  sc: string[]; // scopes
  res: string; // resource
  ses: string; // session id
  su: boolean; // the user signed up in this flow
  e: number; // expires
}

interface Refresh {
  id: string; // row id of the refresh token
  ten: string; // tenant
  c: string; // client_id it is bound to
}

interface Code {
  t: string; // token value
  id: string; // token id
  ten: string; // tenant
  x: number; // initial expires_at of the token row
  c: string;
  r: string;
  ch: string;
  res: string;
  sc: string[];
  e: number;
}

export const resourceOf = (c: Context<Env>, deps: Deps): string => `${originOf(c, deps)}/mcp`;
export const resourceMetadataUrl = (c: Context<Env>, deps: Deps): string => `${originOf(c, deps)}/.well-known/oauth-protected-resource/mcp`;

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

/** The scopes of a `scope` parameter: known MCP scopes, `<action>:<app>` included; null when one is unknown. */
export function parseScopes(scope: string | undefined): string[] | null {
  if (scope === undefined || scope.trim() === "") return [...DEFAULT_SCOPES];
  const asked = scope.trim().split(/\s+/u);
  // `owner` (section 1b): the profile, and of the other scopes listed only those inside it.
  const owner = asked.includes("owner");
  const out: string[] = owner ? [...OWNER_PROFILE] : [];
  for (const s of asked) {
    if (s === "owner") continue;
    const p = parseScope(s);
    if (p === null) return null;
    if (p.app !== undefined && !/^[a-z][a-z0-9-]{0,49}$/u.test(p.app)) return null;
    if (owner) {
      // Never `secrets:*`, `deploy`, `tokens:write` or `apps:delete` with the profile: dropped, not an error.
      if (!(OWNER_PROFILE as readonly string[]).includes(p.action)) continue;
    } else if (!(MCP_SCOPES as readonly string[]).includes(p.action)) return null;
    if (!out.includes(s)) out.push(s);
  }
  return out.slice(0, 32);
}

/** A small HTML page: no script, no external resource, never framed. */
const page = (_c: Context<Env>, status: number, title: string, body: string): Response => htmlPage(status, title, body);

function oauthError(c: Context<Env>, status: number, error: string, description: string): Response {
  return c.json({ error, error_description: description }, status as 400, { "cache-control": "no-store" });
}

function redirectWith(redirectUri: string, params: Record<string, string | null>): Response {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== null) u.searchParams.set(k, v);
  return new Response(null, { status: 302, headers: { location: u.toString(), "cache-control": "no-store" } });
}

const s256 = (verifier: string): string => createHash("sha256").update(verifier).digest("base64url");

/** The signed-in user of the session cookie, with the tenant and role it is bound to. */
async function sessionOf(deps: Deps, c: Context<Env>): Promise<{ id: string; userId: string; tenantId: string | null; role: Role | null } | null> {
  const value = readCookie(c.req.header("cookie"), SESSION_COOKIE);
  if (value === null) return null;
  const s = await findSession(deps.db, value, deps.now());
  if (s === null) return null;
  if (s.tenant_id === null) return { id: s.id, userId: s.user_id, tenantId: null, role: null };
  const rows = await deps.db.query<{ role: string }>("select role from memberships where tenant_id = $1 and user_id = $2", [s.tenant_id, s.user_id]);
  const role = rows[0]?.role;
  return { id: s.id, userId: s.user_id, tenantId: s.tenant_id, role: isRole(role) ? role : null };
}

/** When the user was created (0 when unknown): a user created after the request was sealed signed up in the flow. */
async function createdAt(deps: Deps, userId: string): Promise<number> {
  const rows = await deps.db.query<{ created_at: unknown }>("select created_at from users where id = $1", [userId]);
  return rows[0] === undefined ? 0 : num(rows[0].created_at);
}

/** The scopes the user's role allows, of those asked for. */
const grantable = (scopes: string[], role: Role): string[] => scopes.filter((s) => roleAllows(role, (parseScope(s) as { action: (typeof MCP_SCOPES)[number] }).action));

async function audit(deps: Deps, c: Context<Env>, action: string, tenantId: string | null, actor: string, target: Record<string, string | boolean>, status: number): Promise<void> {
  try {
    await writeAudit(deps.db, { at: deps.now(), tenantId, actor, action, target, status, requestId: c.get("requestId"), ip: clientIp(c) });
  } catch (e) {
    deps.log.error("audit write failed", { action, request_id: c.get("requestId"), error: String(e) });
  }
}

/** Reads `client_id`, or null when it is not one this server issued. */
export const clientOf = (deps: Deps, clientId: string | undefined): ClientInfo | null => open<ClientInfo>(deps, "client", "rnxmcp_", clientId);

export function registerOAuth(app: Hono<Env>, deps: Deps): void {
  const protectedResource = (c: Context<Env>) => {
    c.set("action", "getProtectedResourceMetadata");
    return c.json({
      resource: resourceOf(c, deps),
      authorization_servers: [originOf(c, deps)],
      scopes_supported: [...MCP_SCOPES],
      bearer_methods_supported: ["header"],
      resource_name: "Renoxium platform MCP",
    });
  };
  app.get("/.well-known/oauth-protected-resource", protectedResource);
  app.get("/.well-known/oauth-protected-resource/mcp", protectedResource);

  app.get("/.well-known/oauth-authorization-server", (c) => {
    c.set("action", "getAuthorizationServerMetadata");
    const o = originOf(c, deps);
    return c.json({
      issuer: o,
      authorization_endpoint: `${o}/oauth/authorize`,
      token_endpoint: `${o}/oauth/token`,
      registration_endpoint: `${o}/oauth/register`,
      scopes_supported: [...MCP_SCOPES],
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      revocation_endpoint: `${o}/oauth/revoke`,
      revocation_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      authorization_response_iss_parameter_supported: true,
    });
  });

  // Dynamic client registration: the client id is the sealed metadata, nothing is stored.
  app.post("/oauth/register", async (c) => {
    c.set("action", "registerOAuthClient");
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return oauthError(c, 400, "invalid_client_metadata", "the body is not JSON");
    }
    const uris = body.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || uris.length > 5 || !uris.every(redirectUriOk)) {
      return oauthError(c, 400, "invalid_redirect_uri", "redirect_uris: 1 to 5 https URLs, or http URLs on localhost or 127.0.0.1");
    }
    const method = body.token_endpoint_auth_method ?? "none";
    if (method !== "none") return oauthError(c, 400, "invalid_client_metadata", "only public clients (token_endpoint_auth_method none) are supported");
    const grants = body.grant_types ?? ["authorization_code"];
    if (!Array.isArray(grants) || !grants.includes("authorization_code")) return oauthError(c, 400, "invalid_client_metadata", "grant_types must include authorization_code");
    const name = (typeof body.client_name === "string" ? body.client_name : "MCP client").replace(/[^\x20-\x7e]/gu, "").trim().slice(0, 48) || "MCP client";
    const issued = Math.floor(deps.now() / 1000);
    const clientId = seal(deps, "client", "rnxmcp_", { n: name, r: uris, i: issued } satisfies ClientInfo);
    return c.json(
      {
        client_id: clientId,
        client_id_issued_at: issued,
        client_name: name,
        redirect_uris: uris,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      },
      201,
    );
  });

  app.get("/oauth/authorize", async (c) => {
    c.set("action", "showOAuthConsent");
    let q: Record<string, string> = c.req.query();
    // #688: after sign-up the verification link comes back with the sealed authorization request instead of the parameters.
    let resumed: { issuedAt: number } | null = null;
    if (q.request !== undefined) {
      const r = openAuthRequest(deps, q.request, deps.now());
      if (r === null) return page(c, 400, "Invalid request", "<p>This link is not valid. Start the sign-in from the application again.</p>");
      if (r.expired) return page(c, 400, "This request expired", "<p>Start the sign-in from the application again.</p>");
      q = r.query;
      resumed = { issuedAt: r.issuedAt };
    }
    const client = clientOf(deps, q.client_id);
    // Before the redirect URI is known to be the client's, errors are shown here, never redirected.
    if (client === null) return page(c, 400, "Unknown client", "<p>This application is not registered with Renoxium.</p>");
    if (q.redirect_uri === undefined || !client.r.includes(q.redirect_uri)) return page(c, 400, "Wrong redirect address", "<p>The redirect address is not one this application registered.</p>");
    const state = q.state ?? null;
    const fail = (error: string, description: string) => redirectWith(q.redirect_uri as string, { error, error_description: description, state, iss: originOf(c, deps) });
    if (q.response_type !== "code") return fail("unsupported_response_type", "response_type must be code");
    if (q.code_challenge_method !== "S256" || !/^[A-Za-z0-9_-]{43}$/u.test(q.code_challenge ?? "")) return fail("invalid_request", "PKCE with code_challenge_method S256 is required");
    if (q.resource !== undefined && q.resource !== resourceOf(c, deps)) return fail("invalid_target", "resource must be this server's MCP endpoint");
    const scopes = parseScopes(q.scope);
    if (scopes === null) return fail("invalid_scope", `scopes: ${MCP_SCOPES.join(", ")} (optionally :<app>)`);

    const session = await sessionOf(deps, c);
    if (session === null) {
      // #688: the request is sealed for 30 minutes and travels as `return_to` through sign-up and the verification email.
      const returnTo = sealAuthRequest(deps, q, deps.now());
      const dashboard = escapeHtml(deps.config.dashboardUrl);
      // A script-free page cannot show a CAPTCHA widget: with one configured, sign-up happens in the dashboard.
      const signup =
        (process.env.RENOX_CAPTCHA_SECRET ?? "") !== ""
          ? `<p>New here? <a href="${dashboard}/signup?${escapeHtml(new URLSearchParams({ return_to: returnTo }).toString())}">Create an account</a>: the email link brings you back here.</p>`
          : `<form method="post" action="/v1/account/signup"><input type="hidden" name="return_to" value="${escapeHtml(returnTo)}">
<p><label>Email<br><input type="email" name="email" required maxlength="254" autocomplete="email"></label></p>
<p><label>Password<br><input type="password" name="password" required autocomplete="new-password"></label></p>
<p><label>Team id (letters, digits, - and _)<br><input name="tenant_id" required maxlength="63" pattern="[a-z0-9][a-z0-9_\\-]{0,62}"></label></p>
<p><label><input type="checkbox" name="dpa_accepted" value="true" required> I accept the <a href="${dashboard}/legal/dpa">Data Processing Agreement</a> and the <a href="${dashboard}/legal/terms">terms</a>.</label></p>
<p><button>Create account</button></p></form>
<p>We email a link to verify your address. It brings you back here to review the access.</p>`;
      return page(
        c,
        401,
        "Sign in to Renoxium",
        `<p>Sign in to the <a href="${dashboard}">Renoxium dashboard</a> in this browser, then reload this page to review the access <strong>${escapeHtml(client.n)}</strong> asks for.</p>
<h2>Create an account</h2>${signup}`,
      );
    }
    if (session.tenantId === null || session.role === null) return page(c, 403, "No team selected", "<p>Choose a team in the dashboard first, then reload this page.</p>");
    const granted = grantable(scopes, session.role);
    if (granted.length === 0) return fail("invalid_scope", `your role (${session.role}) holds none of the requested scopes`);
    const request = seal(deps, "consent", "rnxcon_", {
      c: q.client_id as string,
      r: q.redirect_uri,
      ch: q.code_challenge as string,
      st: state,
      sc: granted,
      res: resourceOf(c, deps),
      ses: session.id,
      su: resumed !== null && (await createdAt(deps, session.userId)) > resumed.issuedAt,
      e: deps.now() + CONSENT_TTL_MS,
    } satisfies ConsentRequest);
    const target = new URL(q.redirect_uri);
    return page(
      c,
      200,
      `Allow ${client.n} to use Renoxium?`,
      `<p><strong>${escapeHtml(client.n)}</strong> (returns to <code>${escapeHtml(target.host)}</code>) asks to act in team <code>${escapeHtml(session.tenantId)}</code> as an agent, with at most your role (<code>${escapeHtml(session.role)}</code>):</p>
<ul>${granted.map((s) => `<li>${escapeHtml(consentText(s))} <small>(<code>${escapeHtml(s)}</code>)</small></li>`).join("")}</ul>
<p>Tools that change something (create an app, change a setting, invite someone) still ask for a confirmation on each call. Secret values are never readable. The access token lasts one hour and is renewed without asking you for up to 30 days; you can revoke it under Tokens.</p>
<form method="post" action="/oauth/authorize"><input type="hidden" name="request" value="${escapeHtml(request)}"><button name="decision" value="approve">Allow</button> <button name="decision" value="deny">Deny</button></form>`,
    );
  });

  app.post("/oauth/authorize", async (c) => {
    c.set("action", "decideOAuthConsent");
    let form: Record<string, string | File>;
    try {
      form = await c.req.parseBody();
    } catch {
      return page(c, 400, "Invalid request", "<p>The form could not be read.</p>");
    }
    const req = open<ConsentRequest>(deps, "consent", "rnxcon_", typeof form.request === "string" ? form.request : null);
    const session = await sessionOf(deps, c);
    // The sealed request is bound to the session that saw the consent page (and the cookie is SameSite=Strict).
    if (req === null || req.e < deps.now() || session === null || session.id !== req.ses || session.tenantId === null || session.role === null) {
      return page(c, 400, "This request expired", "<p>Start the sign-in from the application again.</p>");
    }
    const client = clientOf(deps, req.c);
    if (client === null || !client.r.includes(req.r)) return page(c, 400, "Unknown client", "<p>This application is not registered with Renoxium.</p>");
    const actor = `user:${session.userId}`;
    if (form.decision !== "approve") {
      await audit(deps, c, "mcpAuthorize", session.tenantId, actor, { client: client.n, decision: "deny" }, 302);
      return redirectWith(req.r, { error: "access_denied", error_description: "the user denied the request", state: req.st, iss: originOf(c, deps) });
    }
    // The role may have changed since the page was shown.
    const scopes = grantable(req.sc, session.role);
    if (scopes.length === 0) return redirectWith(req.r, { error: "invalid_scope", error_description: "your role holds none of the requested scopes", state: req.st, iss: originOf(c, deps) });
    const db = withTenant(deps.db, { kind: "tenant", via: "session", tenantId: session.tenantId, sessionId: session.id, userId: session.userId, role: session.role });
    const now = deps.now();
    const token = await createTenantToken(db, session.tenantId, `${TOKEN_PREFIX_NAME}${client.n}`, scopes, 1, now, session.userId);
    // The token is dead until the code is exchanged (see the header comment).
    const pending = now + CODE_TTL_MS;
    // Its own id is the family of the connection (refresh tokens and later access tokens join it).
    await db.query("update tokens set expires_at = $3, family_id = id where tenant_id = $1 and id = $2", [session.tenantId, token.id, pending]);
    const code = seal(deps, "code", "rnxcode_", { t: token.token, id: token.id, ten: session.tenantId, x: pending, c: req.c, r: req.r, ch: req.ch, res: req.res, sc: scopes, e: pending } satisfies Code);
    await audit(deps, c, "mcpAuthorize", session.tenantId, actor, { client: client.n, decision: "approve", token_id: token.id, scopes: scopes.join(" "), ...(req.su ? { signup: true } : {}) }, 302);
    return redirectWith(req.r, { code, state: req.st, iss: originOf(c, deps) });
  });

  /** A new refresh token of the family: a sealed reference to a row of kind `refresh` (only its hash is stored). */
  async function issueRefresh(db: ReturnType<typeof withTenant>, tenantId: string, family: string, userId: string | null, scopes: string[], clientId: string, clientName: string, now: number): Promise<{ id: string; value: string }> {
    const id = `tok_${ulid(now)}`;
    const value = seal(deps, "refresh", "rnxrt_", { id, ten: tenantId, c: clientId } satisfies Refresh);
    await db.query(
      "insert into tokens (id, tenant_id, name, token_sha256, scopes, created_at, expires_at, user_id, kind, family_id) values ($1, $2, $3, $4, $5::text::jsonb, $6, $7, $8, 'refresh', $9)",
      [id, tenantId, `refresh: ${clientName}`, sha256hex(value), jsonb(scopes), now, now + REFRESH_TTL_MS, userId, family],
    );
    return { id, value };
  }

  const tokenHeaders = { "cache-control": "no-store", pragma: "no-cache" };

  /** grant_type=refresh_token: validates, rotates (compare-and-set on `used_at`) and issues a new pair. */
  async function refreshGrant(c: Context<Env>, f: (k: string) => string | undefined): Promise<Response> {
    const client = clientOf(deps, f("client_id"));
    if (client === null) return oauthError(c, 401, "invalid_client", "unknown client_id");
    const ref = open<Refresh>(deps, "refresh", "rnxrt_", f("refresh_token"));
    const now = deps.now();
    if (ref === null || typeof ref.id !== "string" || typeof ref.ten !== "string" || ref.c !== f("client_id")) return oauthError(c, 400, "invalid_grant", "the refresh token is invalid");
    const resource = f("resource");
    if (resource !== undefined && resource !== resourceOf(c, deps)) return oauthError(c, 400, "invalid_target", "resource must be this server's MCP endpoint");
    const db = withTenant(deps.db, { kind: "tenant", via: "token", tenantId: ref.ten, tokenId: ref.id, scopes: [], userId: null, role: null });
    type Row = { id: string; scopes: string[]; expires_at: unknown; revoked_at: unknown; used_at: unknown; user_id: string | null; family_id: string | null; token_sha256: string };
    const read = async (): Promise<Row | undefined> =>
      (await db.query<Row>("select id, scopes, expires_at, revoked_at, used_at, user_id, family_id, token_sha256 from tokens where tenant_id = $1 and id = $2 and kind = 'refresh'", [ref.ten, ref.id]))[0];
    const row = await read();
    if (row === undefined || !sameDigest(row.token_sha256, sha256hex(f("refresh_token") as string))) return oauthError(c, 400, "invalid_grant", "the refresh token is invalid");
    const family = row.family_id ?? row.id;
    // A refresh token used twice: the whole family is revoked (RFC 6819 5.2.2.3).
    const reuse = async (): Promise<Response> => {
      await revokeTokenFamily(db, ref.ten, row.id, now);
      await audit(deps, c, "mcpRefresh", ref.ten, `token:${row.id}`, { client: client.n, outcome: "reuse_detected" }, 400);
      return oauthError(c, 400, "invalid_grant", "the refresh token was already used");
    };
    if (row.used_at !== null) return reuse();
    if (row.revoked_at !== null || num(row.expires_at) <= now) return oauthError(c, 400, "invalid_grant", "the refresh token is expired or revoked");
    // The user's role now, not the one at consent: a member who left or lost a scope loses it here too.
    const m = row.user_id === null ? [] : await db.query<{ role: string }>("select role from memberships where tenant_id = $1 and user_id = $2", [ref.ten, row.user_id]);
    const role = m[0]?.role;
    if (!isRole(role)) {
      await revokeTokenFamily(db, ref.ten, row.id, now);
      return oauthError(c, 400, "invalid_grant", "the user no longer belongs to the team");
    }
    let scopes = grantable(row.scopes, role);
    const asked = f("scope");
    if (asked !== undefined && asked.trim() !== "") {
      const want = asked.trim().split(/\s+/u);
      if (!want.every((s) => scopes.includes(s))) return oauthError(c, 400, "invalid_scope", "scope exceeds the original grant");
      scopes = want;
    }
    if (scopes.length === 0) return oauthError(c, 400, "invalid_grant", "your role holds none of the granted scopes");
    // The compare-and-set: of two concurrent refreshes with the same token only one marks it used.
    const claimed = await db.query("update tokens set used_at = $3 where tenant_id = $1 and id = $2 and kind = 'refresh' and used_at is null and revoked_at is null and expires_at > $3 returning id", [ref.ten, row.id, now]);
    if (claimed.length === 0) {
      const again = await read();
      return again !== undefined && again.used_at !== null ? reuse() : oauthError(c, 400, "invalid_grant", "the refresh token is expired or revoked");
    }
    const access = await createTenantToken(db, ref.ten, `${TOKEN_PREFIX_NAME}${client.n}`, scopes, 0, now, row.user_id, family, ACCESS_TTL_MS);
    const next = await issueRefresh(db, ref.ten, family, row.user_id, scopes, ref.c, client.n, now);
    await audit(deps, c, "mcpRefresh", ref.ten, `token:${access.id}`, { client: client.n, outcome: "ok", token_id: access.id }, 200);
    await audit(deps, c, "mcpRefresh", ref.ten, `token:${access.id}`, { client: client.n, outcome: "rotated", token_id: row.id, next_token_id: next.id }, 200);
    return c.json({ access_token: access.token, token_type: "Bearer", expires_in: ACCESS_TTL_MS / 1000, refresh_token: next.value, scope: scopes.join(" ") }, 200, tokenHeaders);
  }

  app.post("/oauth/token", async (c) => {
    c.set("action", "exchangeOAuthCode");
    let form: Record<string, string | File>;
    try {
      form = await c.req.parseBody();
    } catch {
      return oauthError(c, 400, "invalid_request", "the body must be application/x-www-form-urlencoded");
    }
    const f = (k: string): string | undefined => (typeof form[k] === "string" ? (form[k] as string) : undefined);
    if (f("grant_type") === "refresh_token") return refreshGrant(c, f);
    if (f("grant_type") !== "authorization_code") return oauthError(c, 400, "unsupported_grant_type", "only authorization_code and refresh_token are supported");
    const client = clientOf(deps, f("client_id"));
    if (client === null) return oauthError(c, 401, "invalid_client", "unknown client_id");
    const code = open<Code>(deps, "code", "rnxcode_", f("code"));
    const verifier = f("code_verifier") ?? "";
    const now = deps.now();
    if (code === null || code.e < now || code.c !== f("client_id")) return oauthError(c, 400, "invalid_grant", "the code is invalid or expired");
    if (code.r !== f("redirect_uri")) return oauthError(c, 400, "invalid_grant", "redirect_uri does not match the authorization request");
    if (!/^[A-Za-z0-9._~-]{43,128}$/u.test(verifier) || s256(verifier) !== code.ch) return oauthError(c, 400, "invalid_grant", "the PKCE code_verifier does not match");
    const resource = f("resource");
    if (resource !== undefined && resource !== code.res) return oauthError(c, 400, "invalid_target", "resource must be this server's MCP endpoint");
    const db = withTenant(deps.db, { kind: "tenant", via: "token", tenantId: code.ten, tokenId: code.id, scopes: code.sc, userId: null, role: null });
    const claimed = await db.query<{ user_id: string | null }>("update tokens set expires_at = $3 where tenant_id = $1 and id = $2 and expires_at = $4 and revoked_at is null returning user_id", [code.ten, code.id, now + ACCESS_TTL_MS, code.x]);
    if (claimed.length === 0) {
      // A code used twice: revoke what it issued, its refresh tokens too (OAuth 2.1 section 4.1.3).
      await revokeTokenFamily(db, code.ten, code.id, now);
      await audit(deps, c, "mcpToken", code.ten, `token:${code.id}`, { client: client.n, outcome: "code_reused" }, 400);
      return oauthError(c, 400, "invalid_grant", "the code was already used");
    }
    // The access token's row is the family of the connection (set at consent).
    const refresh = await issueRefresh(db, code.ten, code.id, (claimed[0] as { user_id: string | null }).user_id, code.sc, code.c, client.n, now);
    await audit(deps, c, "mcpToken", code.ten, `token:${code.id}`, { client: client.n, outcome: "issued" }, 200);
    return c.json({ access_token: code.t, token_type: "Bearer", expires_in: ACCESS_TTL_MS / 1000, refresh_token: refresh.value, scope: code.sc.join(" ") }, 200, tokenHeaders);
  });

  // RFC 7009: an access or a refresh token; either revokes its whole family. The answer is 200 whatever the token was.
  app.post("/oauth/revoke", async (c) => {
    c.set("action", "revokeOAuthToken");
    let form: Record<string, string | File>;
    try {
      form = await c.req.parseBody();
    } catch {
      return oauthError(c, 400, "invalid_request", "the body must be application/x-www-form-urlencoded");
    }
    const value = typeof form.token === "string" ? form.token : "";
    if (value === "") return oauthError(c, 400, "invalid_request", "token is required");
    const now = deps.now();
    let found: { tenant: string; id: string; client: string; kind: string } | null = null;
    const ref = value.startsWith("rnxrt_") ? open<Refresh>(deps, "refresh", "rnxrt_", value) : null;
    if (ref !== null && typeof ref.id === "string" && typeof ref.ten === "string") {
      const clientId = typeof form.client_id === "string" ? form.client_id : undefined;
      const rows = await deps.db.query<{ token_sha256: string }>("select token_sha256 from tokens where tenant_id = $1 and id = $2 and kind = 'refresh'", [ref.ten, ref.id]);
      if (rows[0] !== undefined && sameDigest(rows[0].token_sha256, sha256hex(value)) && (clientId === undefined || clientId === ref.c)) {
        found = { tenant: ref.ten, id: ref.id, client: clientOf(deps, ref.c)?.n ?? "unknown", kind: "refresh_token" };
      }
    } else if (/^renox_pat_[a-z2-7]{32}$/u.test(value)) {
      const rows = await deps.db.query<{ id: string; tenant_id: string; name: string }>("select id, tenant_id, name from tokens where token_sha256 = $1 and kind = 'access'", [sha256hex(value)]);
      // Only the access tokens this server issued (`mcp: …`): this is not a second way to revoke a deploy-API token.
      if (rows[0] !== undefined && rows[0].name.startsWith(TOKEN_PREFIX_NAME)) found = { tenant: rows[0].tenant_id, id: rows[0].id, client: rows[0].name.slice(TOKEN_PREFIX_NAME.length), kind: "access_token" };
    }
    if (found !== null) {
      const db = withTenant(deps.db, { kind: "tenant", via: "token", tenantId: found.tenant, tokenId: found.id, scopes: [], userId: null, role: null });
      await revokeTokenFamily(db, found.tenant, found.id, now);
      await audit(deps, c, "mcpRevoke", found.tenant, `token:${found.id}`, { client: found.client, token_type: found.kind, token_id: found.id }, 200);
    }
    return c.body(null, 200, tokenHeaders);
  });
}
