// The owner connector's bridge (#698; docs/20-ai-agents-mcp.md section 1b,
// "The bridge"; deploy-api.md 0.9 section 15, `nodeMintAgentToken`): how a
// platform MCP tool reaches one app's own `/mcp`.
//
// 1. The app is resolved inside the access token's tenant (#113: another
//    tenant's app is 404, as for every tool), and its owning node from the
//    route table.
// 2. The node mints a short-lived agent token of the app's own `auth` module
//    for the app user with the signed-in account's **verified** email (never
//    an argument of a tool): `tools:<name>` scopes only, at most 300 s, the
//    client "Renoxium connector", the access token's id as `grant_id`.
// 3. The platform calls `POST https://<app>.<platform domain>/mcp`
//    (`tools/call`) with it, exactly as an outside agent would, so the app's
//    scopes, rate limit, confirmation and Cedar policies decide as that user.
//
// The minted token lives in this process's memory only, per (access token,
// app, scopes), until 30 s before it expires, so the confirmation round of one
// tool uses the same app token. It is never written to the database, a log
// line, an audit row or a result: every answer is scrubbed of it. The app's
// answers are data written by the app and its users: they carry
// `untrusted: true` (section 5).

import { createHash } from "node:crypto";
import type { Deps } from "../context.ts";
import { withTenant } from "../tenancy/scope.ts";
import { nodeCall, nodeTarget, type NodeCall } from "../workers/failover.ts";

/** The longest token the bridge asks for (`agent_token_request.ttl_seconds`). */
export const MINT_TTL_SECONDS = 300;
/** A cached token is dropped this long before it expires. */
export const CACHE_MARGIN_MS = 30_000;
/** The client the app sees (its audit rows, the user's connected agents). */
export const CLIENT_NAME = "Renoxium connector";
const MINT_TIMEOUT_MS = 10_000;
const CALL_TIMEOUT_MS = 30_000;
const MAX_CACHE = 10_000;
const APP = /^[a-z][a-z0-9-]{0,49}$/u;
const TOOL = /^[a-z][a-z0-9_]{0,63}$/u;
const TOKEN = /^renox_agt_[0-9A-Za-z_-]{16,128}$/u;
const GRANT = /^[0-9A-Za-z_-]{1,64}$/u;
/** The MCP protocol version the bridge speaks to an app (ops.md section 19). */
const APP_PROTOCOL = "2025-06-18";

/** The connector's access token, as server.ts resolved it. */
export interface BridgeAgent {
  tokenId: string;
  tenantId: string;
  bearer: string;
}

/** An app tool's answer: always `untrusted`, never the minted token. */
export type AppToolResult =
  | { ok: true; untrusted: true; result: unknown }
  | { ok: false; untrusted: true; status: number; error: { code: string; message: string; details?: unknown } };

/** The HTTP call to an app's `/mcp`; tests replace it with a stub app. */
export type AppCall = (url: string, init: { headers: Record<string, string>; body: string }) => Promise<{ status: number; body: unknown }>;

/** The real call: HTTPS to the app, no redirects, 30 s. */
export const httpAppCall: AppCall = async (url, init) => {
  const res = await fetch(url, { method: "POST", headers: init.headers, body: init.body, redirect: "error", signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text === "" ? null : JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: res.status, body };
};

/** What tests replace: the app's `/mcp` and the node listener (default: `nodeCall(deps)`, see failover.ts). */
export interface BridgeInject {
  appCall?: AppCall;
  nodeCall?: NodeCall;
}

/**
 * `scopes`: the app tools the minted token may call (default `["tools:<tool>"]`).
 * `confirmation` (#700): the app's own confirmation token of a `confirm` tool's
 * preview, sent as `_meta["renox/confirmation"]` (section 2, step 5).
 */
export interface CallOptions {
  scopes?: string[];
  confirmation?: string;
}

/** The bridge of one API process; its token cache is per `deps`, shared by every bridge made from it. */
export interface Bridge {
  callAppTool(agent: BridgeAgent, app: string, tool: string, args: Record<string, unknown>, opts?: CallOptions): Promise<AppToolResult>;
  /**
   * The names of the app tools a token of `scopes` (`tools:<name>`) sees in the
   * app's `tools/list` (#751: which of two app tools the app has). Optional so a
   * test double need not offer it: a caller treats its absence as "none listed".
   */
  listAppTools?(agent: BridgeAgent, app: string, scopes: string[]): Promise<{ ok: true; untrusted: true; tools: string[] } | Extract<AppToolResult, { ok: false }>>;
}

export function createBridge(deps: Deps, inject: BridgeInject = {}): Bridge {
  return {
    callAppTool: (agent, app, tool, args, opts) => callAppTool(deps, inject, agent, app, tool, args, opts),
    listAppTools: (agent, app, scopes) => listAppTools(deps, inject, agent, app, scopes),
  };
}

interface Cached {
  token: string;
  expiresAt: number;
}

const caches = new WeakMap<Deps, Map<string, Cached>>();

function cacheOf(deps: Deps): Map<string, Cached> {
  let m = caches.get(deps);
  if (m === undefined) {
    m = new Map();
    caches.set(deps, m);
  }
  return m;
}

/** The cache key: the access token's hash (the bearer itself is not kept), the app, the scopes. */
const keyOf = (agent: BridgeAgent, app: string, scopes: string[]): string =>
  `${createHash("sha256").update(agent.bearer).digest("hex")}\n${app}\n${[...scopes].sort().join(" ")}`;

/** How many minted tokens this process holds now (tests). */
export function cachedTokens(deps: Deps): number {
  return cacheOf(deps).size;
}

const fail = (status: number, code: string, message: string, details?: unknown): AppToolResult => ({
  ok: false,
  untrusted: true,
  status,
  error: { code, message, ...(details === undefined ? {} : { details }) },
});

/** `value` with every occurrence of `secret` replaced: no answer carries the minted token. */
function scrub<T>(value: T, secret: string): T {
  const text = JSON.stringify(value);
  return text.includes(secret) ? (JSON.parse(text.split(secret).join("[redacted]")) as T) : value;
}

type Minted = { ok: true; token: string; expiresAt: number } | { ok: false; result: AppToolResult };

/** Asks the app's owning node for a token (deploy-api.md 0.9 section 15). */
async function mint(deps: Deps, inject: BridgeInject, agent: BridgeAgent, app: string, scopes: string[]): Promise<Minted> {
  const db = withTenant(deps.db, { kind: "tenant", via: "token", tenantId: agent.tenantId, tokenId: agent.tokenId, scopes: [], userId: null, role: null });
  // The signed-in account's verified email, while it is a live access token of a member of the team.
  const [who] = await db.query<{ email: string }>(
    `select u.email from tokens t
       join users u on u.id = t.user_id
       join memberships m on m.tenant_id = t.tenant_id and m.user_id = t.user_id
      where t.tenant_id = $1 and t.id = $2 and t.kind = 'access' and t.revoked_at is null and t.expires_at > $3 and u.email_verified_at is not null`,
    [agent.tenantId, agent.tokenId, deps.now()],
  );
  if (who === undefined) return { ok: false, result: fail(403, "no_verified_email", "Your Renoxium account has no verified email address. Verify it, then try again.") };
  const [entry] = await db.query<{ node_id: string }>("select node_id from route_entries where tenant_id = $1 and app = $2 and status = 'active' order by version desc limit 1", [agent.tenantId, app]);
  if (entry === undefined) return { ok: false, result: fail(503, "RENOX_UNAVAILABLE", `${app} is not running right now. Activate a deployment of it first.`) };
  const target = await nodeTarget(deps, db, entry.node_id);
  if (target.listen_url === null || target.token === null) return { ok: false, result: fail(503, "RENOX_UNAVAILABLE", `${app} cannot be reached right now. Try again in a minute.`) };
  const grant = GRANT.test(agent.tokenId) ? agent.tokenId : createHash("sha256").update(agent.tokenId).digest("hex").slice(0, 32);
  const body = { type: "agent_token_request", schema_version: 0, tenant_id: agent.tenantId, app, email: who.email, scopes, ttl_seconds: MINT_TTL_SECONDS, client_name: CLIENT_NAME, grant_id: grant };
  let res: { status: number; body: unknown };
  try {
    res = await (inject.nodeCall ?? nodeCall(deps))(target, "POST", `/nodes/${encodeURIComponent(entry.node_id)}/tenants/${encodeURIComponent(agent.tenantId)}/apps/${encodeURIComponent(app)}/agent-tokens`, body, MINT_TIMEOUT_MS);
  } catch {
    return { ok: false, result: fail(503, "RENOX_UNAVAILABLE", `${app} cannot be reached right now. Try again in a minute.`) };
  }
  const answer = (res.body ?? {}) as { token?: unknown; expires_at?: unknown; error?: { details?: { field?: unknown; reason?: unknown }[] } };
  if (res.status === 200 && typeof answer.token === "string" && TOKEN.test(answer.token) && typeof answer.expires_at === "number") {
    return { ok: true, token: answer.token, expiresAt: answer.expires_at };
  }
  if (res.status === 404) {
    // The app's auth answered: no app user has this account's verified email. Not retried.
    if (answer.error?.details?.some((d) => d?.reason === "not_an_app_user")) {
      return { ok: false, result: fail(404, "not_an_app_user", "Your account is not a user of this app. Ask the app's owner to invite your email address.") };
    }
    if (answer.error?.details?.some((d) => d?.reason === "no_auth_module")) {
      return { ok: false, result: fail(404, "not_supported", "This app has no sign-in module, so it cannot be changed through Renoxium.") };
    }
    return { ok: false, result: fail(503, "RENOX_UNAVAILABLE", `${app} is not running on its node right now. Try again in a minute.`) };
  }
  return { ok: false, result: fail(503, "RENOX_UNAVAILABLE", `${app} cannot be reached right now. Try again in a minute.`) };
}

/** The token for (agent, app, scopes): the cached one until 30 s before it expires, else a new one. */
async function tokenFor(deps: Deps, inject: BridgeInject, agent: BridgeAgent, app: string, scopes: string[], fresh: boolean): Promise<Minted & { cached?: boolean }> {
  const cache = cacheOf(deps);
  const key = keyOf(agent, app, scopes);
  const now = deps.now();
  const hit = cache.get(key);
  if (!fresh && hit !== undefined && now < hit.expiresAt - CACHE_MARGIN_MS) return { ok: true, token: hit.token, expiresAt: hit.expiresAt, cached: true };
  cache.delete(key);
  const m = await mint(deps, inject, agent, app, scopes);
  if (!m.ok) return m;
  for (const [k, v] of cache) if (now >= v.expiresAt - CACHE_MARGIN_MS) cache.delete(k);
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value as string);
  if (now < m.expiresAt - CACHE_MARGIN_MS) cache.set(key, { token: m.token, expiresAt: m.expiresAt });
  return m;
}

/** The text of a tool result's first content item. */
const textOf = (r: { content?: { type?: unknown; text?: unknown }[] }): string => {
  const t = Array.isArray(r.content) ? r.content.find((c) => c?.type === "text")?.text : undefined;
  return typeof t === "string" ? t.slice(0, 2000) : "";
};

/**
 * Calls `tool` of `app` (an app of the agent's tenant) with `args`, as the
 * signed-in owner's app user, through the bridge. `scopes` (default
 * `["tools:<tool>"]`) are the app tools the platform tool needs; they key
 * the token cache, so a tool that calls several app tools asks for all of
 * them each time. Never throws for an app-side failure: the answer is an
 * `AppToolResult`, `untrusted` either way.
 */
async function callAppTool(deps: Deps, inject: BridgeInject, agent: BridgeAgent, app: string, tool: string, args: Record<string, unknown>, opts: CallOptions = {}): Promise<AppToolResult> {
  if (!APP.test(app)) return fail(400, "invalid_input", "app is not an app name");
  if (!TOOL.test(tool)) return fail(400, "invalid_input", "tool is not a tool name");
  const scopes = [...new Set(opts.scopes ?? [`tools:${tool}`])];
  if (!scopes.includes(`tools:${tool}`) || scopes.length > 10 || !scopes.every((s) => /^tools:[a-z][a-z0-9_]{0,63}$/u.test(s))) {
    return fail(400, "invalid_input", "scopes are 1 to 10 tools:<name>, including the tool called");
  }
  const db = withTenant(deps.db, { kind: "tenant", via: "token", tenantId: agent.tenantId, tokenId: agent.tokenId, scopes: [], userId: null, role: null });
  const [known] = await db.query<{ name: string }>("select name from apps where tenant_id = $1 and name = $2 and deleted_at is null", [agent.tenantId, app]);
  if (known === undefined) return fail(404, "RENOX_NOT_FOUND", `No app named ${app} in this team.`);
  if (opts.confirmation !== undefined && (typeof opts.confirmation !== "string" || opts.confirmation.length === 0 || opts.confirmation.length > 2048)) return fail(400, "invalid_input", "confirmation is the app's confirmation token");
  const params = { name: tool, arguments: args, ...(opts.confirmation === undefined ? {} : { _meta: { "renox/confirmation": opts.confirmation } }) };
  return rpcApp(deps, inject, agent, app, scopes, "tools/call", params, answerOf);
}

type ListAnswer = { ok: true; untrusted: true; tools: string[] } | Extract<AppToolResult, { ok: false }>;

/** The names of the tools the app lists to a token of `scopes` (`tools/list`; #751). */
async function listAppTools(deps: Deps, inject: BridgeInject, agent: BridgeAgent, app: string, scopes: string[]): Promise<ListAnswer> {
  const bad = (message: string): ListAnswer => ({ ok: false, untrusted: true, status: 400, error: { code: "invalid_input", message } });
  if (!APP.test(app)) return bad("app is not an app name");
  const wanted = [...new Set(scopes)];
  if (wanted.length < 1 || wanted.length > 10 || !wanted.every((s) => /^tools:[a-z][a-z0-9_]{0,63}$/u.test(s))) return bad("scopes are 1 to 10 tools:<name>");
  const r = await rpcApp(deps, inject, agent, app, wanted, "tools/list", {}, (res) => {
    const list = ((res.body ?? {}) as { result?: { tools?: unknown } }).result?.tools;
    if (!Array.isArray(list)) return answerOf(res);
    return { ok: true, untrusted: true, result: list.map((x) => (x as { name?: unknown } | null)?.name).filter((n): n is string => typeof n === "string") };
  });
  return r.ok ? { ok: true, untrusted: true, tools: r.result as string[] } : r;
}

/** One JSON-RPC call to the app's `/mcp` as the signed-in owner's app user; `parse` reads the answer. */
async function rpcApp(deps: Deps, inject: BridgeInject, agent: BridgeAgent, app: string, scopes: string[], method: string, params: Record<string, unknown>, parse: (res: { status: number; body: unknown }) => AppToolResult): Promise<AppToolResult> {
  const call = inject.appCall ?? httpAppCall;
  const url = `https://${app}.${deps.config.platformDomain}/mcp`;
  const rpc = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  let t = await tokenFor(deps, inject, agent, app, scopes, false);
  for (let attempt = 0; ; attempt++) {
    if (!t.ok) return t.result;
    const token = t.token;
    let res: { status: number; body: unknown };
    try {
      res = await call(url, { headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": APP_PROTOCOL }, body: rpc });
    } catch {
      return fail(503, "RENOX_UNAVAILABLE", `${app} did not answer. Try again in a minute.`);
    }
    // A cached token the app no longer accepts (revoked in the app): drop it, mint once more.
    if (res.status === 401) {
      cacheOf(deps).delete(keyOf(agent, app, scopes));
      if (t.cached === true && attempt === 0) {
        t = await tokenFor(deps, inject, agent, app, scopes, true);
        continue;
      }
      return fail(503, "RENOX_UNAVAILABLE", `${app} refused the connector's sign-in. Try again in a minute.`);
    }
    return scrub(parse(res), token);
  }
}

/** The app's JSON-RPC answer as an `AppToolResult`. */
function answerOf(res: { status: number; body: unknown }): AppToolResult {
  const b = (res.body ?? {}) as { result?: { isError?: unknown; structuredContent?: unknown; content?: { type?: unknown; text?: unknown }[] }; error?: { message?: unknown; data?: { code?: unknown; details?: unknown } } };
  if (b.result !== undefined && b.result !== null && typeof b.result === "object") {
    if (b.result.isError === true) return fail(422, "app_tool_error", textOf(b.result) || "The app's tool failed.");
    let result: unknown = b.result.structuredContent;
    if (result === undefined) {
      const text = textOf(b.result);
      try {
        result = JSON.parse(text);
      } catch {
        result = text;
      }
    }
    return { ok: true, untrusted: true, result };
  }
  if (b.error !== undefined && b.error !== null && typeof b.error === "object") {
    const code = typeof b.error.data?.code === "string" ? b.error.data.code : "RENOX_APP_MCP";
    const message = typeof b.error.message === "string" ? b.error.message.slice(0, 2000) : "The app refused the call.";
    return fail(res.status >= 400 ? res.status : 502, code, message, b.error.data?.details);
  }
  return fail(502, "RENOX_APP_MCP", `The app answered HTTP ${res.status} without a result.`);
}
