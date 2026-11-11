// OAuth 2.1 for agents (#286; `oauth.test.ts` is the sign-in with providers; docs/20-ai-agents-mcp.md section 2, section
// 5; docs/24-threat-model.md "Account takeover of a tenant developer": agent
// tokens are hashed, one hour, listed and revocable). The full flow with a
// fake agent: registration, authorize, the consent page, the code, the
// token, `verifyAgentToken`; then the refusals: a wrong verifier, a reused
// code, a revoked token, a narrowed scope, a denied consent.

import { Database, type SQLQueryBindings } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { app, ServiceError, type TestApp } from "../../../sdk/src/test.ts";
import { challengeOf } from "../lib/agents.ts";
import { mintAgentToken } from "../services.ts";

const MODULE = join(import.meta.dir, "..");
const worker = process.env.RENOX_TEST_SPEC ?? process.env.RENOX_WORKER_PATH;
const t = worker ? await app({ project: MODULE }) : (undefined as unknown as TestApp);

const REDIRECT = "https://agent.example/callback";
const VERIFIER = "v".repeat(20) + "-verifier_0123456789abcdefghij";

async function user(name: string): Promise<TestApp> {
  const u = t.as(name);
  const email = `${name}@example.com`;
  expect((await u.action("/auth/register", "default", { email, password: "correct horse battery", display_name: name, next: "/" })).status).toBe(200);
  expect((await u.action("/auth/login", "default", { email, password: "correct horse battery" })).status).toBe(303);
  return u;
}

async function client(): Promise<string> {
  const r = await t.request("POST", "/auth/oauth/register", { body: { client_name: "Test Agent", redirect_uris: [REDIRECT] } });
  expect(r.status).toBe(201);
  const c = r.json<{ client_id: string; token_endpoint_auth_method: string }>();
  expect(c.token_endpoint_auth_method).toBe("none");
  return c.client_id;
}

/** /authorize → consent → Allow; the code from the client redirect. */
async function code(u: TestApp, clientId: string, scope?: string): Promise<string> {
  const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, state: "s1", code_challenge: await challengeOf(VERIFIER), code_challenge_method: "S256" });
  if (scope) q.set("scope", scope);
  const auth = await u.request("GET", `/auth/oauth/authorize?${q}`);
  expect(auth.status).toBe(303);
  const consent = auth.headers.get("location") as string;
  expect(consent).toStartWith("/auth/oauth/consent?");
  const page = await u.page(consent);
  expect(page.status).toBe(200);
  expect(page.html).toContain(">Test Agent</h1>");
  const fields = Object.fromEntries(new URL(consent, "https://x").searchParams);
  const allow = await u.action("/auth/oauth/consent", "allow", fields);
  expect(allow.status).toBe(303);
  const back = new URL(allow.headers.get("location") as string);
  expect(back.origin + back.pathname).toBe(REDIRECT);
  expect(back.searchParams.get("state")).toBe("s1");
  return back.searchParams.get("code") as string;
}

async function token(clientId: string, c: string, verifier = VERIFIER) {
  return t.request("POST", "/auth/oauth/token", {
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code: c, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier }).toString(),
  });
}

describe.skipIf(!worker)("OAuth for agents", () => {
  test("the full flow: register, consent, code, token, verifyAgentToken; the token is hashed and one hour", async () => {
    const alice = await user("agent-alice");
    const clientId = await client();
    const r = await token(clientId, await code(alice, clientId));
    expect(r.status).toBe(200);
    const body = r.json<{ access_token: string; token_type: string; expires_in: number; scope: string }>();
    expect(body.access_token).toMatch(/^renox_agt_[0-9a-f]{64}$/u);
    expect(body).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "tools:*" });
    expect(r.headers.get("cache-control")).toBe("no-store");
    const v = (await t.service("auth").verifyAgentToken(body.access_token)) as { principal: { id: string }; scopes: string[]; client: { name: string } };
    expect(v.scopes).toEqual(["tools:*"]);
    expect(v.client).toEqual({ name: "Test Agent" });
    const id = t.db.query<{ id: string }>("select id from auth__users where email = 'agent-alice@example.com'")[0]?.id;
    expect(v.principal.id).toBe(id as string);
    // Only the hash is stored; one hour.
    const rows = t.db.query<{ token_hash: string; expires_at: number; created_at: number }>("select token_hash, expires_at, created_at from auth__agent_tokens where user_id = ?", [id as string]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token_hash).not.toContain(body.access_token.slice(10));
    expect((rows[0]?.expires_at as number) - (rows[0]?.created_at as number)).toBe(3600);
    // The metadata the cell serves (RFC 8414).
    const meta = (await t.service("auth").oauthMetadata("https://shop.example/auth/oauth")) as Record<string, unknown>;
    expect(meta).toMatchObject({ issuer: "https://shop.example/auth/oauth", token_endpoint: "https://shop.example/auth/oauth/token", code_challenge_methods_supported: ["S256"] });
  });

  test("a wrong verifier and a reused code are refused", async () => {
    const bob = await user("agent-bob");
    const clientId = await client();
    const c = await code(bob, clientId);
    const wrong = await token(clientId, c, "w".repeat(43));
    expect(wrong.status).toBe(400);
    expect(wrong.json<{ error: string }>().error).toBe("invalid_grant");
    // The failed exchange burnt the code: it does not work with the right verifier either.
    const again = await token(clientId, c);
    expect(again.json<{ error: string }>().error).toBe("invalid_grant");
    const c2 = await code(bob, clientId);
    expect((await token(clientId, c2)).status).toBe(200);
    const reused = await token(clientId, c2);
    expect(reused.status).toBe(400);
    expect(reused.json<{ error: string }>().error).toBe("invalid_grant");
  });

  test("a narrowed scope stays narrow; a denied consent sends access_denied; no PKCE is refused", async () => {
    const carol = await user("agent-carol");
    const clientId = await client();
    const r = await token(clientId, await code(carol, clientId, "tools:list_notes"));
    const tok = r.json<{ access_token: string; scope: string }>();
    expect(tok.scope).toBe("tools:list_notes");
    expect(((await t.service("auth").verifyAgentToken(tok.access_token)) as { scopes: string[] }).scopes).toEqual(["tools:list_notes"]);
    // Deny.
    const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, state: "s2", code_challenge: await challengeOf(VERIFIER), code_challenge_method: "S256" });
    const deny = await carol.action("/auth/oauth/consent", "deny", Object.fromEntries(q));
    expect(deny.status).toBe(303);
    expect(deny.headers.get("location")).toBe(`${REDIRECT}?error=access_denied&state=s2`);
    // Without PKCE: back to the client with invalid_request; an unregistered redirect: 400, no redirect.
    const noPkce = await carol.request("GET", `/auth/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}&state=s3`);
    expect(noPkce.status).toBe(302);
    expect(noPkce.headers.get("location")).toContain("error=invalid_request");
    const evil = await carol.request("GET", `/auth/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent("https://evil.example/cb")}`);
    expect(evil.status).toBe(400);
    expect(evil.headers.get("location")).toBeNull();
  });

  test("the account page lists the agent and revokes it; verifyAgentToken then answers null and the event is emitted", async () => {
    const dan = await user("agent-dan");
    const clientId = await client();
    const tok = (await token(clientId, await code(dan, clientId))).json<{ access_token: string }>().access_token;
    const account = await dan.page("/auth/account");
    expect(account.html).toContain(">Test Agent</strong>");
    const id = t.db.query<{ id: string }>("select a.id from auth__agent_tokens a join auth__users u on u.id = a.user_id where u.email = 'agent-dan@example.com'")[0]?.id as string;
    const revoked = await dan.action("/auth/account", "agent", { agent: id });
    expect(revoked.status).toBe(200);
    expect(revoked.html).toContain("Agent disconnected.");
    expect(await t.service("auth").verifyAgentToken(tok)).toBeNull();
    const events = t.db.query<{ name: string; payload: string }>("select name, payload from renox__outbox union all select name, payload from renox__outbox_dead");
    // Delivered (no handler in this app: the fan-out drops it) or pending: either way it was written; the payload names the hash, never the token.
    const all = t.logs().map((l) => JSON.stringify(l)).join("\n") + JSON.stringify(events);
    expect(all).not.toContain(tok);
  });

  test("the consent page cannot be framed, runs no script, and sets no auth cookie", async () => {
    const eve = await user("agent-eve");
    const clientId = await client();
    const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: await challengeOf(VERIFIER), code_challenge_method: "S256" });
    const page = await eve.page(`/auth/oauth/consent?${q}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy") ?? "").toContain("frame-ancestors 'none'");
    expect(page.headers.getSetCookie().filter((c) => c.startsWith("__Host-renox_auth="))).toEqual([]);
    // No script of its own: only the platform's client script tag, nothing inline.
    expect(page.html.match(/<script(?![^>]*src="\/__renox\/client\.js)/gu) ?? []).toEqual([]);
    // Signed out: the consent page sends to the login page, coming back.
    const anon = await t.as("agent-anon").page(`/auth/oauth/consent?${q}`);
    expect(anon.status).toBe(303);
    expect(anon.headers.get("location")).toStartWith("/auth/login?next=");
  });
});

// #590: the principal of an agent token is the user's (attributes from the
// auth.principal hook, roles), in the organisation chosen at consent. The
// otpbox fixture fills auth.agent_orgs from otpbox__orgs and, for an agent,
// sets `org` from `org_id` while the user still has it (as org does).
describe.skipIf(!worker)("an agent token's principal (#590)", () => {
  type Verified = { principal: { id: string; attrs: Record<string, unknown>; roles: { role: string; scope_type: string; scope_id: string | null }[] } };
  const idOf = (email: string) => t.db.query<{ id: string }>("select id from auth__users where email = ?", [email])[0]?.id as string;
  const addOrg = (userId: string, org: string, name: string) => t.service("otpbox").addOrg(userId, org, name);
  async function consent(u: TestApp, clientId: string): Promise<{ consent: string; fields: Record<string, string>; html: string }> {
    const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, state: "s1", code_challenge: await challengeOf(VERIFIER), code_challenge_method: "S256" });
    const consent = (await u.request("GET", `/auth/oauth/authorize?${q}`)).headers.get("location") as string;
    const page = await u.page(consent);
    expect(page.status).toBe(200);
    return { consent, fields: Object.fromEntries(new URL(consent, "https://x").searchParams), html: page.html };
  }
  async function allow(u: TestApp, clientId: string, fields: Record<string, string>): Promise<string> {
    const r = await u.action("/auth/oauth/consent", "allow", fields);
    expect(r.status).toBe(303);
    const c = new URL(r.headers.get("location") as string).searchParams.get("code") as string;
    const tok = await token(clientId, c);
    expect(tok.status).toBe(200);
    return tok.json<{ access_token: string }>().access_token;
  }

  test("no organisation: no choice, no org; the hook ran (filler attrs, mfa_verified forced false); the user's roles", async () => {
    const u = await user("agent-nora");
    const id = idOf("agent-nora@example.com");
    // A role through the app (app code may assign any): /api/principal POST grants `editor` to the signed-in user.
    expect((await u.request("POST", "/api/principal")).status).toBe(200);
    const clientId = await client();
    const c = await consent(u, clientId);
    expect(c.html).not.toContain('name="org_id"');
    const tok = await allow(u, clientId, c.fields);
    expect(t.db.query("select org_id from auth__agent_tokens where user_id = ?", [id])).toEqual([{ org_id: null }]);
    const v = (await t.service("auth").verifyAgentToken(tok)) as Verified;
    expect(v.principal.attrs).toEqual({ email_verified: false, phone_verified: false, created_at: expect.any(Number), mfa_verified: false });
    expect(v.principal.roles).toEqual([{ role: "editor", scope_type: "global", scope_id: null }]);
  });

  test("one organisation: no select, the token carries it; verifyAgentToken returns attrs.org and roles", async () => {
    const u = await user("agent-omar");
    const id = idOf("agent-omar@example.com");
    await addOrg(id, "o_one", "Only Org");
    const clientId = await client();
    const c = await consent(u, clientId);
    expect(c.html).not.toContain("<select");
    expect(c.html).toContain('name="org_id" value="o_one"');
    // Allowed without the field too (an agent's own form): the only organisation.
    const tok = await allow(u, clientId, c.fields);
    expect(t.db.query("select org_id from auth__agent_tokens where user_id = ?", [id])).toEqual([{ org_id: "o_one" }]);
    const v = (await t.service("auth").verifyAgentToken(tok)) as Verified;
    expect(v.principal.id).toBe(id);
    expect(v.principal.attrs.org).toBe("o_one");
    expect(v.principal.attrs.mfa_verified).toBe(false);
    expect(v.principal.attrs).not.toHaveProperty("not_in_the_schema");
    expect(v.principal.roles).toEqual([]);
  });

  test("two organisations: the page asks; an org not in the list is 422; a valid one is stored; removed from it, no org", async () => {
    const u = await user("agent-tara");
    const id = idOf("agent-tara@example.com");
    await addOrg(id, "o_a", "Alpha");
    await addOrg(id, "o_b", "Beta");
    const clientId = await client();
    const c = await consent(u, clientId);
    expect(c.html).toContain('<select name="org_id">');
    expect(c.html).toContain('<option value="o_a" dir="auto">Alpha</option>');
    expect(c.html).toContain('<option value="o_b" dir="auto">Beta</option>');
    expect(c.html).toContain("Organisation the agent acts in");
    // Not a member of o_other, and no choice among two: 422, no code.
    for (const org_id of ["o_other", undefined]) {
      const bad = await u.action("/auth/oauth/consent", "allow", org_id === undefined ? c.fields : { ...c.fields, org_id });
      expect(bad.status).toBe(422);
    }
    expect(t.db.query("select count(*) as n from auth__oauth_codes where user_id = ?", [id])).toEqual([{ n: 0 }]);
    const tok = await allow(u, clientId, { ...c.fields, org_id: "o_b" });
    expect(t.db.query("select org_id from auth__oauth_codes where user_id = ?", [id])).toEqual([{ org_id: "o_b" }]);
    expect(t.db.query("select org_id from auth__agent_tokens where user_id = ?", [id])).toEqual([{ org_id: "o_b" }]);
    expect(((await t.service("auth").verifyAgentToken(tok)) as Verified).principal.attrs.org).toBe("o_b");
    // Removed from o_b after the consent: the token has no org any more.
    await t.service("otpbox").removeOrg(id, "o_b");
    const after = (await t.service("auth").verifyAgentToken(tok)) as Verified;
    expect(after.principal.attrs).not.toHaveProperty("org");
  });
});

// #698: the owner connector's bridge. `mintAgentToken` runs in the app's cell
// for the node operation `nodeMintAgentToken` (deploy-api.md 0.9 section 15),
// as `Renox::System::"renox"`. Here the platform's call is the service with
// a ctx over the test app's own file (bun:sqlite) carrying that principal;
// the token it writes is then checked by the worker's `verifyAgentToken`.
// From tenant code (the harness's service route) the service refuses.
describe.skipIf(!worker)("mintAgentToken: the owner connector's bridge (#698)", () => {
  type Principal = { kind: string; id: string } | null;
  const PLATFORM: Principal = { kind: "system", id: "renox" };
  const GRANT = "tok_01JBQ40000000000000000AB";
  const request = (email: string, over: Record<string, unknown> = {}) => ({ email, scopes: ["tools:update_settings"], ttl_seconds: 300, client_name: "Renoxium connector", grant_id: GRANT, ...over });

  /** The ctx the cell gives auth's service, over the tenant file, with `principal`; hook runs are recorded. */
  function ctxAs(principal: Principal) {
    const rw = new Database(t.dbFile);
    rw.exec("pragma busy_timeout = 5000");
    const hooks: { name: string; args: unknown }[] = [];
    type P = SQLQueryBindings[];
    const ctx = {
      principal,
      headers: new Headers(),
      config: {},
      db: {
        query: async (sql: string, params: P = []) => rw.query(sql).all(...params),
        queryOne: async (sql: string, params: P = []) => rw.query(sql).get(...params) ?? null,
        execute: async (sql: string, params: P = []) => ({ changes: rw.query(sql).run(...params).changes }),
      },
      events: { emit: async () => "evt" },
      hooks: {
        run: async (name: string, args: unknown) => {
          hooks.push({ name, args: structuredClone(args) });
          return { halt: false };
        },
      },
    } as unknown as Parameters<typeof mintAgentToken>[0];
    return { ctx, hooks, close: () => rw.close() };
  }

  /** A registered user whose email is verified (`verified: false`: left unverified). */
  async function appUser(name: string, verified = true): Promise<{ email: string; id: string }> {
    const email = `${name}@example.com`;
    expect((await t.as(name).action("/auth/register", "default", { email, password: "correct horse battery", display_name: name, next: "/" })).status).toBe(200);
    const rw = new Database(t.dbFile);
    rw.exec("pragma busy_timeout = 5000");
    try {
      if (verified) rw.query("update auth__users set email_verified_at = unixepoch() where email = ?").run(email);
      return { email, id: (rw.query("select id from auth__users where email = ?").get(email) as { id: string }).id };
    } finally {
      rw.close();
    }
  }

  const rowsOf = (userId: string) => t.db.query<Record<string, unknown>>("select * from auth__agent_tokens where user_id = ?", [userId]);

  test("as the platform: a token for the verified user, tools:<name> only, at most 300 s, client renoxium-platform, the grant kept; verifyAgentToken accepts it until expires_at", async () => {
    const u = await appUser("mint-owner");
    const { ctx, hooks, close } = ctxAs(PLATFORM);
    try {
      const before = Date.now();
      const minted = (await mintAgentToken(ctx, request(u.email))) as { token: string; expires_at: number };
      expect(minted.token).toMatch(/^renox_agt_[0-9a-f]{64}$/u);
      expect(minted.expires_at).toBeGreaterThan(before + 290_000);
      expect(minted.expires_at).toBeLessThanOrEqual(Date.now() + 300_000);
      const [row] = rowsOf(u.id);
      expect(row).toMatchObject({ client_id: "renoxium-platform", client_name: "Renoxium connector", scopes: '["tools:update_settings"]', grant_id: GRANT, revoked_at: null });
      expect((row?.expires_at as number) - (row?.created_at as number)).toBe(300);
      // Stored as its hash only.
      expect(JSON.stringify(rowsOf(u.id))).not.toContain(minted.token.slice(10));
      const v = (await t.service("auth").verifyAgentToken(minted.token)) as { principal: { id: string }; scopes: string[]; client: unknown; expires_at: number };
      expect(v.principal.id).toBe(u.id);
      expect(v.scopes).toEqual(["tools:update_settings"]);
      expect(v.client).toEqual({ name: "Renoxium connector", grant_id: GRANT });
      expect(v.expires_at).toBe(minted.expires_at);
      // The audit hook ran for the connection, with the grant and never the token.
      expect(hooks.filter((h) => h.name === "auth.agent_audit")).toEqual([
        { name: "auth.agent_audit", args: { action: "connect", user_id: u.id, client_name: "Renoxium connector", scopes: ["tools:update_settings"], at: expect.any(Number), grant_id: GRANT } },
      ]);
      expect(JSON.stringify(hooks)).not.toContain(minted.token);
      // A shorter ttl is honoured; several named tools are fine.
      const short = (await mintAgentToken(ctx, request(u.email, { ttl_seconds: 30, scopes: ["tools:list_branches", "tools:get_settings"] }))) as { token: string; expires_at: number };
      expect(short.expires_at).toBeLessThanOrEqual(Date.now() + 30_000);
      expect(((await t.service("auth").verifyAgentToken(short.token)) as { scopes: string[] }).scopes).toEqual(["tools:list_branches", "tools:get_settings"]);
      // Past expires_at: refused.
      const rw = new Database(t.dbFile);
      rw.exec("pragma busy_timeout = 5000");
      try {
        rw.query("update auth__agent_tokens set expires_at = unixepoch() - 1 where user_id = ?").run(u.id);
      } finally {
        rw.close();
      }
      expect(await t.service("auth").verifyAgentToken(minted.token)).toBeNull();
      expect(await t.service("auth").verifyAgentToken(short.token)).toBeNull();
      expect(t.logs().map((l) => JSON.stringify(l)).join("\n")).not.toContain(minted.token);
    } finally {
      close();
    }
  });

  test("no app user with the email, or an unverified one: null, and nothing is written", async () => {
    const unverified = await appUser("mint-unverified", false);
    const { ctx, hooks, close } = ctxAs(PLATFORM);
    try {
      expect(await mintAgentToken(ctx, request("nobody-here@example.com"))).toBeNull();
      expect(await mintAgentToken(ctx, request(unverified.email))).toBeNull();
      expect(rowsOf(unverified.id)).toEqual([]);
      expect(hooks.filter((h) => h.name === "auth.agent_audit")).toEqual([]);
    } finally {
      close();
    }
  });

  test("a ttl above 300 s or below 30 s, tools:*, a bare tool name, too many scopes, a bad grant: RENOX_VALIDATION, nothing written", async () => {
    const u = await appUser("mint-strict");
    const { ctx, close } = ctxAs(PLATFORM);
    try {
      const bad: [Record<string, unknown>, string][] = [
        [{ ttl_seconds: 301 }, "ttl_seconds"],
        [{ ttl_seconds: 3600 }, "ttl_seconds"],
        [{ ttl_seconds: 29 }, "ttl_seconds"],
        [{ ttl_seconds: 120.5 }, "ttl_seconds"],
        [{ scopes: ["tools:*"] }, "scopes"],
        [{ scopes: ["update_settings"] }, "scopes"],
        [{ scopes: [] }, "scopes"],
        [{ scopes: Array.from({ length: 11 }, (_, i) => `tools:t${i}`) }, "scopes"],
        [{ scopes: ["tools:a", "tools:a"] }, "scopes"],
        [{ grant_id: "" }, "grant_id"],
        [{ grant_id: "has space" }, "grant_id"],
        [{ client_name: "" }, "client_name"],
        [{ email: "not-an-email" }, "email"],
      ];
      for (const [over, field] of bad) {
        const e = (await mintAgentToken(ctx, request(u.email, over)).catch((x: unknown) => x)) as { code?: string; details?: { field: string }[] };
        expect(e.code).toBe("RENOX_VALIDATION");
        expect(e.details?.[0]?.field).toBe(field);
      }
      expect(rowsOf(u.id)).toEqual([]);
    } finally {
      close();
    }
  });

  test("only the platform: tenant code (a route), a user, another system principal (a job), no principal: AUTH_PLATFORM_ONLY, nothing written", async () => {
    const u = await appUser("mint-guarded");
    // A route of the app calling the service (the harness's service route).
    const viaRoute = (await t
      .service("auth")
      .mintAgentToken!(request(u.email))
      .catch((x: unknown) => x)) as ServiceError;
    // A throwing service reaches its caller as RENOX_MODULE_SERVICE with the callee's message (errors.md).
    expect(viaRoute).toBeInstanceOf(ServiceError);
    expect(viaRoute.code).toBe("RENOX_MODULE_SERVICE");
    expect(viaRoute.details).toMatchObject({ module: "auth", service: "mintAgentToken" });
    expect(viaRoute.message).toContain("Only the platform may mint an agent token.");
    for (const p of [{ kind: "user", id: u.id }, { kind: "system", id: "audit" }, { kind: "system", id: "app" }, { kind: "user", id: "renox" }, null]) {
      const { ctx, close } = ctxAs(p);
      try {
        const e = (await mintAgentToken(ctx, request(u.email)).catch((x: unknown) => x)) as { code?: string };
        expect(e.code).toBe("AUTH_PLATFORM_ONLY");
      } finally {
        close();
      }
    }
    expect(rowsOf(u.id)).toEqual([]);
  });
});
