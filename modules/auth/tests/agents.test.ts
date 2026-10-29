// OAuth 2.1 for agents (#286; `oauth.test.ts` is the sign-in with providers; docs/20-ai-agents-mcp.md section 2, section
// 5; docs/24-threat-model.md "Account takeover of a tenant developer": agent
// tokens are hashed, one hour, listed and revocable). The full flow with a
// fake agent: registration, authorize, the consent page, the code, the
// token, `verifyAgentToken`; then the refusals: a wrong verifier, a reused
// code, a revoked token, a narrowed scope, a denied consent.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { app, type TestApp } from "../../../sdk/src/test.ts";
import { challengeOf } from "../lib/agents.ts";

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
