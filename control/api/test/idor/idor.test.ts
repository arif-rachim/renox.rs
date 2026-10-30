// The IDOR suite of #113 (docs/24-threat-model.md E, "Tenant-scoping bug in
// the control-plane API (IDOR)"; deploy-api.md section 2: a resource outside
// the caller's tenant is 404, never 403).
//
// Two tenants, A and B, each with an app, an active deployment, a secret, a
// token, an invitation, and a signed-in owner. For every route the API
// registers, the suite is generated: a route with ids in its path is called
// as A (with A's token and with A's session) with B's ids, and with A's app
// and B's other ids, and must answer 404. A route without ids must name
// its case in NO_ID_CASES, which sends B's ids in the body where the route
// takes one and checks that no B identifier comes back. A registered route
// with no case fails the suite, so adding an endpoint without a test fails CI.
// At the end, B's data must be exactly as it was.

import { afterEach, describe, expect, test } from "bun:test";
import { contentHash } from "@renox/artifact-validate";
import spec from "../../../../docs/contracts/schemas/deploy-api.yaml";
import type { RouteModule } from "../../src/app.ts";
import { MFA_ROUTE_PERMISSIONS } from "../../src/auth/mfa.ts";
import { isTokenPermission, ROUTE_PERMISSIONS, type Permission } from "../../src/tenancy/roles.ts";

/** The permission of an operation: the table of roles.ts, or the MFA operations' own (#293). */
const permOf = (op: string): string | undefined => ROUTE_PERMISSIONS[op] ?? MFA_ROUTE_PERMISSIONS[op];
import { named, upload } from "../../tests/artifacts.ts";
import { assertScoped, harness, login, mailToken, registeredNode, signup, type Harness, type Session } from "../../tests/helpers.ts";

afterEach(assertScoped);

const METHODS = new Set(["get", "post", "put", "patch", "delete"]);

/** "METHOD /path/:param" → operationId, from the OpenAPI file. */
export function contractRoutes(): Map<string, string> {
  const out = new Map<string, string>();
  const paths = (spec as { paths: Record<string, Record<string, { operationId?: string }>> }).paths;
  for (const [path, item] of Object.entries(paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (METHODS.has(method) && op.operationId !== undefined) out.set(`${method.toUpperCase()} ${path.replace(/\{([^}]+)\}/gu, ":$1")}`, op.operationId);
    }
  }
  return out;
}

/** Routes outside the deploy-api contract (accounts and team, #113; usage, #56): "METHOD /path" → operationId. */
export const EXTRA_ROUTES: Record<string, string> = {
  // The signed download of an export (src/tenants/backups.ts): the signature
  // is the credential; a bare or foreign id is 404.
  "GET /v1/exports/:id": "downloadExport",
  "POST /v1/account/signup": "signup",
  "POST /v1/account/verify": "verifyEmail",
  "POST /v1/account/verify/resend": "resendVerification",
  "POST /v1/account/login": "login",
  "POST /v1/account/logout": "logout",
  "POST /v1/account/password-reset": "requestPasswordReset",
  "POST /v1/account/password-reset/confirm": "confirmPasswordReset",
  "GET /v1/account": "getAccount",
  "POST /v1/account/tenant": "switchTenant",
  "GET /v1/account/sessions": "listSessions",
  "DELETE /v1/account/sessions/:session_id": "revokeSession",
  "POST /v1/account/sessions/revoke-all": "revokeAllSessions",
  "POST /v1/account/invitations/accept": "acceptInvitation",
  "POST /v1/account/device": "startDeviceLogin",
  "POST /v1/account/device/approve": "approveDeviceLogin",
  "POST /v1/account/device/token": "pollDeviceLogin",
  "GET /v1/team/members": "listMembers",
  "POST /v1/team/invitations": "inviteMember",
  "GET /v1/team/invitations": "listInvitations",
  "DELETE /v1/team/invitations/:invitation_id": "revokeInvitation",
  "PUT /v1/team/members/:user_id": "changeMemberRole",
  "DELETE /v1/team/members/:user_id": "removeMember",
  "POST /v1/team/owner-transfer": "proposeOwnerTransfer",
  "POST /v1/team/owner-transfer/accept": "acceptOwnerTransfer",
  "DELETE /v1/team/owner-transfer": "cancelOwnerTransfer",
  "GET /v1/apps/:app/usage": "getUsage",
  // Second factors (#293, src/auth/mfa.ts): the caller's own account only, by session or (0.4, #307) the user's own token.
  "GET /v1/account/mfa": "getMfa",
  "POST /v1/account/mfa/totp": "startTotp",
  "POST /v1/account/mfa/totp/confirm": "confirmTotp",
  "POST /v1/account/mfa/passkeys/options": "passkeyOptions",
  "POST /v1/account/mfa/passkeys": "registerPasskey",
  "POST /v1/account/mfa/challenge": "mfaChallenge",
  "POST /v1/account/mfa/verify": "verifyMfa",
  "POST /v1/account/mfa/recovery-codes": "regenerateRecoveryCodes",
  "POST /v1/account/mfa/disable": "disableMfa",
  "POST /v1/team/mfa-required": "setTeamMfaRequired",
  // Remote MCP and OAuth (#62): no tenant id is taken from the request; tests/mcp.test.ts checks another tenant's app is 404 through the tools.
  "GET /.well-known/oauth-protected-resource": "getProtectedResourceMetadata",
  "GET /.well-known/oauth-protected-resource/mcp": "getProtectedResourceMetadata",
  "GET /.well-known/oauth-authorization-server": "getAuthorizationServerMetadata",
  "POST /oauth/register": "registerOAuthClient",
  "GET /oauth/authorize": "showOAuthConsent",
  "POST /oauth/authorize": "decideOAuthConsent",
  "POST /oauth/token": "exchangeOAuthCode",
  "POST /mcp": "callMcp",
  "GET /mcp": "mcpMethodNotAllowed",
  "DELETE /mcp": "mcpMethodNotAllowed",
  // The control plane's Prometheus families (src/ops/metrics.ts, #296): the
  // same operator credential and scope as getOpsTenant, no tenant id in it.
  "GET /v1/ops/metrics": "getOpsTenant",
  // RFC 9116 on the API host (src/well-known.ts, #310): public, no tenant.
  "GET /.well-known/security.txt": "getSecurityTxt",
};

/** Callers that are not tenant principals: not part of this suite, with the reason. */
const EXEMPT: Record<string, string> = {
  public: "no principal, so no tenant to cross; covered by tests/accounts.test.ts",
  node: "node tokens are not tenants; node scoping is tested in tests/secrets.test.ts and tests/routes.test.ts",
  operator: "the operator acts across tenants by design",
};

interface Tenant {
  tenant: string;
  email: string;
  app: string;
  hash: string;
  token: string;
  tokenId: string;
  session: Session;
  userId: string;
  sessionId: string;
  invitationId: string;
  invitationToken: string;
}

const json = async (res: Response): Promise<Record<string, unknown>> => (await res.json()) as Record<string, unknown>;

async function seed(h: Harness, name: "a" | "b"): Promise<Tenant> {
  const tenant = `t-${name}`;
  const email = `${name}@idor.test`;
  const app = `${name}-app`;
  const session = await signup(h, email, tenant);
  const created = await json(await h.request("POST", "/v1/tokens", { session, json: { name: "idor", scopes: ["*"], expires_in_days: 30 } }));
  const token = created.token as string;
  expect((await h.request("POST", "/v1/apps", { token, json: { name: app } })).status).toBe(201);
  const files = named(app);
  expect((await upload(h, token, app, files)).status).toBe(201);
  const hash = contentHash(files);
  expect((await h.request("POST", `/v1/apps/${app}/activate`, { token, json: { hash } })).status).toBe(200);
  expect((await h.request("PUT", `/v1/apps/${app}/secrets/${name.toUpperCase()}_SECRET`, { token, json: { value: "a long enough value" } })).status).toBe(200);
  expect((await h.request("POST", `/v1/apps/${app}/domains`, { token, json: { hostname: `www.${app}.example` } })).status).toBe(201);
  const inv = await json(await h.request("POST", "/v1/team/invitations", { session, json: { email: `invitee-${name}@idor.test`, role: "developer" } }));
  const account = await json(await h.request("GET", "/v1/account", { session }));
  const sessions = (await json(await h.request("GET", "/v1/account/sessions", { session }))).sessions as { id: string; current: boolean }[];
  return {
    tenant,
    email,
    app,
    hash,
    token,
    tokenId: created.id as string,
    session,
    userId: account.user_id as string,
    sessionId: sessions.find((s) => s.current)?.id as string,
    invitationId: inv.id as string,
    invitationToken: mailToken(h, `invitee-${name}@idor.test`, "invitation"),
  };
}

/** B's value for each path parameter name. */
const idsOf = (b: Tenant): Record<string, string> => ({
  app: b.app,
  hash: b.hash,
  name: "B_SECRET",
  token_id: b.tokenId,
  hostname: `www.${b.app}.example`,
  user_id: b.userId,
  session_id: b.sessionId,
  invitation_id: b.invitationId,
  tenant_id: b.tenant,
});

/** Request bodies that let a route reach its lookup. */
const BODIES: Record<string, (b: Tenant) => unknown> = {
  putSecret: () => ({ value: "another long value" }),
  activateDeployment: (b) => ({ hash: b.hash }),
  rollbackDeployment: (b) => ({ hash: b.hash }),
  changeMemberRole: () => ({ role: "viewer" }),
  addDomain: (b) => ({ hostname: `shop.${b.app}.example` }),
};

interface NoIdCase {
  json?: (b: Tenant) => unknown;
  /** Expected status for A's session; A's token gets this too for a token permission, else 403 (session-only) or 401 (account). */
  session: number;
  token?: number;
  /** Sign in again first: the route ends the session it is called with. */
  fresh?: boolean;
  why: string;
}

/** Routes without ids in the path: what is sent, what A must get. Order matters only for `LAST`. */
const NO_ID_CASES: Record<string, NoIdCase> = {
  listApps: { session: 200, why: "A's list holds no B app" },
  createApp: { json: (b) => ({ name: b.app }), session: 409, why: "app names are one namespace; the answer names no owner" },
  createToken: { json: (b) => ({ name: "x", scopes: [`deploy:${b.app}`], expires_in_days: 1 }), session: 201, why: "a scope naming B's app gives A nothing of B's" },
  listTokens: { session: 200, why: "A's list holds no B token" },
  getAccount: { session: 200, token: 401, why: "the account of A's user only" },
  listSessions: { session: 200, token: 401, why: "A's user's sessions only" },
  switchTenant: { json: (b) => ({ tenant_id: b.tenant }), session: 404, token: 401, why: "A's user is not a member of B" },
  acceptInvitation: { json: (b) => ({ token: b.invitationToken }), session: 404, token: 401, why: "B's invitation is for another address" },
  approveDeviceLogin: { json: () => ({ user_code: "BBBB-BBBB" }), session: 404, token: 403, why: "device codes are approved by sessions only" },
  listMembers: { session: 200, why: "A's members only" },
  inviteMember: { json: (b) => ({ email: b.email, role: "viewer" }), session: 201, why: "inviting B's address reveals nothing about B" },
  listInvitations: { session: 200, why: "A's invitations only" },
  proposeOwnerTransfer: { json: (b) => ({ user_id: b.userId }), session: 404, why: "B's owner is not a member of A" },
  acceptOwnerTransfer: { session: 404, why: "no transfer to A's user" },
  cancelOwnerTransfer: { session: 404, why: "A has no open transfer" },
  resendVerification: { session: 202, token: 401, why: "A's own address" },
  revokeAllSessions: { session: 200, token: 401, why: "A's user's sessions only" },
  logout: { session: 204, token: 401, fresh: true, why: "A's session only" },
  // #293: every MFA operation acts on the session's own user; nothing in the request names another.
  // deploy-api.md 0.4 section 18 (#307): A's own token acts for A's user on the MFA operations.
  getMfa: { session: 200, token: 200, why: "A's user's factors only" },
  startTotp: { session: 201, token: 201, why: "a secret for A's user" },
  confirmTotp: { json: () => ({ code: "000000" }), session: 400, token: 400, why: "A's own pending secret" },
  passkeyOptions: { session: 200, token: 200, why: "options for A's user" },
  registerPasskey: { json: () => ({ client_data: "e30", attestation_object: "e30" }), session: 400, token: 400, why: "a challenge of A's user only" },
  mfaChallenge: { session: 404, token: 404, why: "A's user has no passkey" },
  verifyMfa: { json: () => ({ method: "totp", code: "000000" }), session: 401, token: 401, why: "A's own factors only" },
  regenerateRecoveryCodes: { session: 409, token: 409, why: "A's user has no factor" },
  // The token's attempt and the two verifyMfa attempts spend the verify bucket of A's address first.
  disableMfa: { json: () => ({ password: "wrong", code: "000000" }), session: 429, token: 401, why: "A's password and factors only" },
  setTeamMfaRequired: { json: () => ({ required: false }), session: 200, why: "the flag of A's own team" },
};
/** Runs after every other case: it ends all of A's sessions. */
const LAST = ["revokeAllSessions"];

interface Registered {
  key: string;
  method: string;
  path: string;
  opId: string | undefined;
}

function registered(h: Harness): Registered[] {
  const contract = contractRoutes();
  const seen = new Map<string, Registered>();
  for (const r of h.app.routes) {
    if (r.method === "ALL") continue;
    const key = `${r.method} ${r.path}`;
    if (!seen.has(key)) seen.set(key, { key, method: r.method, path: r.path, opId: contract.get(key) ?? EXTRA_ROUTES[key] });
  }
  return [...seen.values()];
}

const paramsOf = (path: string): string[] => [...path.matchAll(/:([a-z_]+)/gu)].map((m) => m[1] as string);
const fill = (path: string, values: Record<string, string>): string => path.replace(/:([a-z_]+)/gu, (_, p: string) => encodeURIComponent(values[p] as string));

/** Registered routes the suite cannot cover, with the reason. */
function uncovered(h: Harness): string[] {
  const missing: string[] = [];
  for (const r of registered(h)) {
    if (r.opId === undefined) {
      missing.push(`${r.key}: no operationId (add it to deploy-api.yaml or EXTRA_ROUTES)`);
      continue;
    }
    const perm = permOf(r.opId);
    if (perm === undefined) missing.push(`${r.key}: ${r.opId} is not in ROUTE_PERMISSIONS`);
    else if (!(perm in EXEMPT) && paramsOf(r.path).length === 0 && NO_ID_CASES[r.opId] === undefined) missing.push(`${r.key}: ${r.opId} has no NO_ID_CASES entry`);
  }
  return missing;
}

describe("IDOR: tenant A with tenant B's ids", () => {
  test("every registered route has a case, and the operation table names it", async () => {
    expect(uncovered(await harness())).toEqual([]);
  });

  test("a new endpoint without a case is reported", async () => {
    const extra: RouteModule = (app) => {
      app.get("/v1/apps/:app/widgets", (c) => c.json({}));
      app.get("/v1/widgets", (c) => c.json({}));
    };
    expect(uncovered(await harness([extra]))).toEqual([
      "GET /v1/apps/:app/widgets: no operationId (add it to deploy-api.yaml or EXTRA_ROUTES)",
      "GET /v1/widgets: no operationId (add it to deploy-api.yaml or EXTRA_ROUTES)",
    ]);
    try {
      // With an operation, a route with ids is generated; one without ids needs a NO_ID_CASES entry.
      EXTRA_ROUTES["GET /v1/apps/:app/widgets"] = "getApp";
      EXTRA_ROUTES["GET /v1/widgets"] = "listSecrets";
      expect(uncovered(await harness([extra]))).toEqual(["GET /v1/widgets: listSecrets has no NO_ID_CASES entry"]);
    } finally {
      delete EXTRA_ROUTES["GET /v1/widgets"];
      delete EXTRA_ROUTES["GET /v1/apps/:app/widgets"];
    }
  });

  test("404 for every id of B, through A's token and A's session; nothing of B leaks; B unchanged", async () => {
    const h = await harness();
    await registeredNode(h, "node-1");
    const a = await seed(h, "a");
    const b = await seed(h, "b");
    const bIds = idsOf(b);
    const leaks = [b.app, b.hash, b.tokenId, b.userId, b.sessionId, b.invitationId, b.email, b.tenant, "B_SECRET"];
    const before = await snapshot(h, b);

    const failures: string[] = [];
    // What A sent itself (a scope naming B's app, B's address in an invitation) may come back to A.
    const sentByA = new Set<string>();
    const call = async (label: string, method: string, path: string, init: { token?: string; session?: Session; json?: unknown }, want: number): Promise<void> => {
      if (init.json !== undefined) for (const id of leaks) if (JSON.stringify(init.json).includes(id)) sentByA.add(id);
      const res = await h.request(method, path, init);
      const text = await res.text();
      if (res.status !== want) failures.push(`${label}: ${method} ${path} → ${res.status}, want ${want}: ${text.slice(0, 200)}`);
      if (want === 404 && res.status === 404 && !text.includes("RENOX_NOT_FOUND")) failures.push(`${label}: 404 without RENOX_NOT_FOUND`);
      for (const id of leaks) if (text.includes(id) && !sentByA.has(id)) failures.push(`${label}: ${method} ${path} leaks ${id}`);
    };

    const routes = registered(h).filter((r) => r.opId !== undefined && !((permOf(r.opId) as string) in EXEMPT));
    routes.sort((x, y) => Number(LAST.indexOf(x.opId as string)) - Number(LAST.indexOf(y.opId as string)));
    let covered = 0;
    for (const r of routes) {
      const opId = r.opId as string;
      const perm = permOf(opId) as Permission | "account";
      const params = paramsOf(r.path);
      if (params.length > 0) {
        const body = BODIES[opId]?.(b);
        const variants: [string, Record<string, string>][] = [["all of B", bIds]];
        // A secret name is a key within an app, not an id of B: A may hold the same name.
        if (params.includes("app") && params.some((p) => p !== "app" && p !== "name")) variants.push(["A's app, B's ids", { ...bIds, app: a.app }]);
        for (const [label, values] of variants) {
          const path = fill(r.path, values);
          const init = body === undefined ? {} : { json: body };
          await call(`${opId} (${label}, session)`, r.method, path, { ...init, session: a.session }, 404);
          const tokenWant = perm === "account" ? 401 : isTokenPermission(perm) ? 404 : 403;
          await call(`${opId} (${label}, token)`, r.method, path, { ...init, token: a.token }, tokenWant);
        }
        covered++;
        continue;
      }
      const c = NO_ID_CASES[opId] as NoIdCase;
      const body = c.json?.(b);
      const init = body === undefined ? {} : { json: body };
      const tokenWant = c.token ?? (perm !== "account" && isTokenPermission(perm) ? c.session : 403);
      await call(`${opId} (token)`, r.method, r.path, { ...init, token: a.token }, tokenWant);
      const session = c.fresh === true ? await login(h, a.email) : a.session;
      await call(`${opId} (session)`, r.method, r.path, { ...init, session }, c.session);
      covered++;
    }
    expect(failures).toEqual([]);
    expect(covered).toBe(routes.length);
    expect(await snapshot(h, b)).toEqual(before);
  }, 60_000);
});

/** Everything of B that a cross-tenant write could change. */
async function snapshot(h: Harness, b: Tenant): Promise<unknown> {
  return {
    apps: await h.db.query("select name from apps where tenant_id = $1 order by name", [b.tenant]),
    deployments: await h.db.query("select app, hash, state, secrets_version from deployments where tenant_id = $1 order by hash", [b.tenant]),
    secrets: await h.db.query("select name, version_from, version_to from secrets where tenant_id = $1 order by name, version_from", [b.tenant]),
    tokens: await h.db.query("select id, revoked_at from tokens where tenant_id = $1 order by id", [b.tenant]),
    members: await h.db.query("select user_id, role from memberships where tenant_id = $1 order by user_id", [b.tenant]),
    invitations: await h.db.query("select id, accepted_at, revoked_at from invitations where tenant_id = $1 order by id", [b.tenant]),
    sessions: await h.db.query("select id, tenant_id, revoked_at from sessions where user_id = $1 order by id", [b.userId]),
    transfers: await h.db.query("select id from owner_transfers where tenant_id = $1", [b.tenant]),
    routes: await h.db.query("select hostname, deployment_hash, status from route_entries where tenant_id = $1 order by hostname", [b.tenant]),
    domains: await h.db.query("select hostname, app, state from domains where tenant_id = $1 order by hostname", [b.tenant]),
  };
}
