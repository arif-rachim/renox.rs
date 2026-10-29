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
//   POST /oauth/token                                  authorization_code + PKCE S256
//
// An access token is a tenant token (`renox_pat_`, deploy-api.md section 2)
// named `mcp: <client name>`, created for the approving user, so it carries
// at most that user's role and shows up in `renox tokens list` where the
// tenant can revoke it. Scopes are the #113 token scopes. Client ids, the
// consent request and the code are sealed values (seal.ts); the code holds the
// token, which lives CODE_TTL_MS until the code is exchanged: the exchange
// extends it with a compare-and-set on `expires_at`, so a code works once.

import type { Context, Hono } from "hono";
import { createHash } from "node:crypto";
import { writeAudit } from "../audit.ts";
import { clientIp } from "../auth/ip.ts";
import { findSession, readCookie, SESSION_COOKIE } from "../auth/sessions.ts";
import { createTenantToken, parseScope } from "../auth/tokens.ts";
import type { Deps, Env } from "../context.ts";
import { isRole, roleAllows, type Role } from "../tenancy/roles.ts";
import { withTenant } from "../tenancy/scope.ts";
import { open, seal } from "./seal.ts";

/** Scopes an MCP client may ask for. Never `secrets:write` or `tokens:write`: an agent does not set secrets or mint tokens. */
export const MCP_SCOPES = ["apps:read", "apps:write", "deploy", "logs:read", "secrets:read"] as const;
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
  e: number; // expires
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

/** The origin clients use for this API (the issuer), from the request. */
export const originOf = (c: Context<Env>): string => new URL(c.req.url).origin;
export const resourceOf = (c: Context<Env>): string => `${originOf(c)}/mcp`;
export const resourceMetadataUrl = (c: Context<Env>): string => `${originOf(c)}/.well-known/oauth-protected-resource/mcp`;

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
  const out: string[] = [];
  for (const s of scope.trim().split(/\s+/u)) {
    const p = parseScope(s);
    if (p === null || !(MCP_SCOPES as readonly string[]).includes(p.action)) return null;
    if (p.app !== undefined && !/^[a-z][a-z0-9-]{0,49}$/u.test(p.app)) return null;
    if (!out.includes(s)) out.push(s);
  }
  return out.slice(0, 32);
}

const escapeHtml = (s: string): string => s.replace(/[&<>"']/gu, (ch) => `&#${ch.charCodeAt(0)};`);

/** A small HTML page: no script, no external resource, never framed. */
function page(c: Context<Env>, status: number, title: string, body: string): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title></head><body style="font-family:system-ui,sans-serif;max-width:36rem;margin:3rem auto;padding:0 1rem"><h1>${escapeHtml(title)}</h1>${body}</body></html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
      "x-frame-options": "DENY",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}

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

/** The scopes the user's role allows, of those asked for. */
const grantable = (scopes: string[], role: Role): string[] => scopes.filter((s) => roleAllows(role, (parseScope(s) as { action: (typeof MCP_SCOPES)[number] }).action));

async function audit(deps: Deps, c: Context<Env>, action: string, tenantId: string | null, actor: string, target: Record<string, string>, status: number): Promise<void> {
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
      resource: resourceOf(c),
      authorization_servers: [originOf(c)],
      scopes_supported: [...MCP_SCOPES],
      bearer_methods_supported: ["header"],
      resource_name: "Renox platform MCP",
    });
  };
  app.get("/.well-known/oauth-protected-resource", protectedResource);
  app.get("/.well-known/oauth-protected-resource/mcp", protectedResource);

  app.get("/.well-known/oauth-authorization-server", (c) => {
    c.set("action", "getAuthorizationServerMetadata");
    const o = originOf(c);
    return c.json({
      issuer: o,
      authorization_endpoint: `${o}/oauth/authorize`,
      token_endpoint: `${o}/oauth/token`,
      registration_endpoint: `${o}/oauth/register`,
      scopes_supported: [...MCP_SCOPES],
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
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
        grant_types: ["authorization_code"],
        response_types: ["code"],
      },
      201,
    );
  });

  app.get("/oauth/authorize", async (c) => {
    c.set("action", "showOAuthConsent");
    const q = c.req.query();
    const client = clientOf(deps, q.client_id);
    // Before the redirect URI is known to be the client's, errors are shown here, never redirected.
    if (client === null) return page(c, 400, "Unknown client", "<p>This application is not registered with Renox.</p>");
    if (q.redirect_uri === undefined || !client.r.includes(q.redirect_uri)) return page(c, 400, "Wrong redirect address", "<p>The redirect address is not one this application registered.</p>");
    const state = q.state ?? null;
    const fail = (error: string, description: string) => redirectWith(q.redirect_uri as string, { error, error_description: description, state, iss: originOf(c) });
    if (q.response_type !== "code") return fail("unsupported_response_type", "response_type must be code");
    if (q.code_challenge_method !== "S256" || !/^[A-Za-z0-9_-]{43}$/u.test(q.code_challenge ?? "")) return fail("invalid_request", "PKCE with code_challenge_method S256 is required");
    if (q.resource !== undefined && q.resource !== resourceOf(c)) return fail("invalid_target", "resource must be this server's MCP endpoint");
    const scopes = parseScopes(q.scope);
    if (scopes === null) return fail("invalid_scope", `scopes: ${MCP_SCOPES.join(", ")} (optionally :<app>)`);

    const session = await sessionOf(deps, c);
    if (session === null) {
      return page(
        c,
        401,
        "Sign in to Renox",
        `<p>Sign in to the <a href="${escapeHtml(deps.config.dashboardUrl)}">Renox dashboard</a> in this browser, then reload this page to review the access <strong>${escapeHtml(client.n)}</strong> asks for.</p>`,
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
      res: resourceOf(c),
      ses: session.id,
      e: deps.now() + CONSENT_TTL_MS,
    } satisfies ConsentRequest);
    const target = new URL(q.redirect_uri);
    return page(
      c,
      200,
      `Allow ${client.n} to use Renox?`,
      `<p><strong>${escapeHtml(client.n)}</strong> (returns to <code>${escapeHtml(target.host)}</code>) asks to act in team <code>${escapeHtml(session.tenantId)}</code> as an agent, with at most your role (<code>${escapeHtml(session.role)}</code>):</p>
<ul>${granted.map((s) => `<li><code>${escapeHtml(s)}</code></li>`).join("")}</ul>
<p>Tools that change something (create an app, activate, roll back) still ask for a confirmation on each call. Secret values are never readable. The access lasts one hour; you can revoke it under Tokens.</p>
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
    if (client === null || !client.r.includes(req.r)) return page(c, 400, "Unknown client", "<p>This application is not registered with Renox.</p>");
    const actor = `user:${session.userId}`;
    if (form.decision !== "approve") {
      await audit(deps, c, "mcpAuthorize", session.tenantId, actor, { client: client.n, decision: "deny" }, 302);
      return redirectWith(req.r, { error: "access_denied", error_description: "the user denied the request", state: req.st, iss: originOf(c) });
    }
    // The role may have changed since the page was shown.
    const scopes = grantable(req.sc, session.role);
    if (scopes.length === 0) return redirectWith(req.r, { error: "invalid_scope", error_description: "your role holds none of the requested scopes", state: req.st, iss: originOf(c) });
    const db = withTenant(deps.db, { kind: "tenant", via: "session", tenantId: session.tenantId, sessionId: session.id, userId: session.userId, role: session.role });
    const now = deps.now();
    const token = await createTenantToken(db, session.tenantId, `${TOKEN_PREFIX_NAME}${client.n}`, scopes, 1, now, session.userId);
    // The token is dead until the code is exchanged (see the header comment).
    const pending = now + CODE_TTL_MS;
    await db.query("update tokens set expires_at = $3 where tenant_id = $1 and id = $2", [session.tenantId, token.id, pending]);
    const code = seal(deps, "code", "rnxcode_", { t: token.token, id: token.id, ten: session.tenantId, x: pending, c: req.c, r: req.r, ch: req.ch, res: req.res, sc: scopes, e: pending } satisfies Code);
    await audit(deps, c, "mcpAuthorize", session.tenantId, actor, { client: client.n, decision: "approve", token_id: token.id, scopes: scopes.join(" ") }, 302);
    return redirectWith(req.r, { code, state: req.st, iss: originOf(c) });
  });

  app.post("/oauth/token", async (c) => {
    c.set("action", "exchangeOAuthCode");
    let form: Record<string, string | File>;
    try {
      form = await c.req.parseBody();
    } catch {
      return oauthError(c, 400, "invalid_request", "the body must be application/x-www-form-urlencoded");
    }
    const f = (k: string): string | undefined => (typeof form[k] === "string" ? (form[k] as string) : undefined);
    if (f("grant_type") !== "authorization_code") return oauthError(c, 400, "unsupported_grant_type", "only authorization_code is supported");
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
    const claimed = await db.query("update tokens set expires_at = $3 where tenant_id = $1 and id = $2 and expires_at = $4 and revoked_at is null returning id", [code.ten, code.id, now + ACCESS_TTL_MS, code.x]);
    if (claimed.length === 0) {
      // A code used twice: revoke what it issued (OAuth 2.1 section 4.1.3).
      await db.query("update tokens set revoked_at = $3 where tenant_id = $1 and id = $2 and revoked_at is null", [code.ten, code.id, now]);
      await audit(deps, c, "mcpToken", code.ten, `token:${code.id}`, { client: client.n, outcome: "code_reused" }, 400);
      return oauthError(c, 400, "invalid_grant", "the code was already used");
    }
    await audit(deps, c, "mcpToken", code.ten, `token:${code.id}`, { client: client.n, outcome: "issued" }, 200);
    return c.json({ access_token: code.t, token_type: "Bearer", expires_in: ACCESS_TTL_MS / 1000, scope: code.sc.join(" ") }, 200, { "cache-control": "no-store", pragma: "no-cache" });
  });
}
