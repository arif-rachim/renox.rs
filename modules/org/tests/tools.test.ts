// The `invite_member` App MCP tool end to end (#286; docs/20-ai-agents-mcp.md
// sections 3 and 5): an agent token from the auth module's OAuth flow,
// `tools/list`, a preview call (rolled back: no invitation), the confirmed
// call (one invitation, as the user), and the refusals: an org the user is
// not an admin of, and a token narrowed to another tool
// (docs/23-failure-modes.md "App MCP: tool call without the Cedar action").

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { app, type TestApp } from "../../../sdk/src/test.ts";
import { challengeOf } from "../../auth/lib/agents.ts";

const MODULE = join(import.meta.dir, "..");
const worker = process.env.RENOX_TEST_SPEC ?? process.env.RENOX_WORKER_PATH;
const t = worker ? await app({ project: MODULE }) : (undefined as unknown as TestApp);

const PASSWORD = "correct horse battery";
const REDIRECT = "https://agent.example/callback";
const VERIFIER = "agent-verifier-0123456789abcdefghijklmnopqrstuvwxyz";

async function user(name: string): Promise<TestApp> {
  const u = t.as(name);
  expect((await u.action("/auth/register", "default", { email: `${name}@example.com`, password: PASSWORD, display_name: name })).status).toBe(200);
  expect((await u.action("/auth/login", "default", { email: `${name}@example.com`, password: PASSWORD })).status).toBe(303);
  return u;
}

/** An agent token for `u` through registration, consent and the token endpoint. */
async function agentToken(u: TestApp, scope?: string): Promise<string> {
  const reg = await t.request("POST", "/auth/oauth/register", { body: { client_name: "Invite Agent", redirect_uris: [REDIRECT] } });
  const clientId = reg.json<{ client_id: string }>().client_id;
  const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: await challengeOf(VERIFIER), code_challenge_method: "S256" });
  if (scope) q.set("scope", scope);
  const allow = await u.action("/auth/oauth/consent", "allow", Object.fromEntries(q));
  expect(allow.status).toBe(303);
  const code = new URL(allow.headers.get("location") as string).searchParams.get("code") as string;
  const tok = await t.request("POST", "/auth/oauth/token", {
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: VERIFIER }).toString(),
  });
  expect(tok.status).toBe(200);
  return tok.json<{ access_token: string }>().access_token;
}

let seq = 0;
async function rpc(token: string, method: string, params: unknown) {
  return t.request("POST", "/mcp", { headers: { authorization: `Bearer ${token}` }, body: { jsonrpc: "2.0", id: ++seq, method, params } });
}

const invites = (email: string) => t.db.query("select role from org__invites where email = ? and revoked_at is null", [email]);

describe.skipIf(!worker)("invite_member through /mcp", () => {
  test("list, preview (rolled back), confirmed call as the user; another org and a narrowed token are refused", async () => {
    const olive = await user("tool-olive");
    expect((await olive.action("/org", "create", { name: "Tool Org", slug: "" })).status).toBe(303);
    const A = ((await olive.service("org").currentOrg()) as { id: string }).id;
    const bob = await user("tool-bob");
    await bob.action("/org", "create", { name: "Bob Tools", slug: "" });
    const B = ((await bob.service("org").currentOrg()) as { id: string }).id;

    const token = await agentToken(olive);
    const list = await rpc(token, "tools/list", {});
    expect(list.status).toBe(200);
    const tools = list.json<{ result: { tools: { name: string; annotations: Record<string, boolean>; inputSchema: { required: string[] } }[] } }>().result.tools;
    const invite = tools.find((x) => x.name === "invite_member");
    expect(invite?.annotations).toEqual({ readOnlyHint: false, destructiveHint: true });
    expect(invite?.inputSchema.required).toEqual(["org", "email"]);

    // Invalid input never reaches the tool.
    const bad = await rpc(token, "tools/call", { name: "invite_member", arguments: { org: A } });
    expect(bad.status).toBe(400);

    // Preview: rolled back, a confirmation token.
    const args = { org: A, email: "newbie@example.com", role: "member" };
    const preview = await rpc(token, "tools/call", { name: "invite_member", arguments: args });
    expect(preview.status).toBe(200);
    const p = preview.json<{ result: { structuredContent: { preview: { preview: boolean; invited: boolean }; confirmation: { token: string } } } }>().result.structuredContent;
    expect(p.preview).toMatchObject({ preview: true, invited: false });
    expect(invites("newbie@example.com")).toEqual([]);

    // Confirmed: one invitation, invited by olive.
    const done = await rpc(token, "tools/call", { name: "invite_member", arguments: args, _meta: { "renox/confirmation": p.confirmation.token } });
    expect(done.status).toBe(200);
    expect(done.json<{ result: { structuredContent: { invited: boolean } } }>().result.structuredContent.invited).toBe(true);
    expect(invites("newbie@example.com")).toEqual([{ role: "member" }]);
    const by = t.db.query<{ email: string }>("select u.email from org__invites i join auth__users u on u.id = i.invited_by where i.email = 'newbie@example.com'");
    expect(by).toEqual([{ email: "tool-olive@example.com" }]);
    // The confirmation is single use.
    const again = await rpc(token, "tools/call", { name: "invite_member", arguments: args, _meta: { "renox/confirmation": p.confirmation.token } });
    expect(again.status).toBe(409);

    // Org B: olive is not a member; the org services refuse, nothing is written.
    const other = { org: B, email: "intruder@example.com" };
    const pv = await rpc(token, "tools/call", { name: "invite_member", arguments: other });
    const body = pv.json<{ result: { isError: boolean; structuredContent?: { preview: { invited: boolean; error?: string } } } }>().result;
    expect(body.isError || body.structuredContent?.preview.error !== undefined).toBe(true);
    expect(invites("intruder@example.com")).toEqual([]);

    // A token narrowed to another tool: the tool is not listed, the call is refused.
    const narrow = await agentToken(olive, "tools:something_else");
    const nl = await rpc(narrow, "tools/list", {});
    expect(nl.json<{ result: { tools: unknown[] } }>().result.tools).toEqual([]);
    const nc = await rpc(narrow, "tools/call", { name: "invite_member", arguments: args });
    expect(nc.status).toBe(403);
  });
});

// #590: org fills auth.agent_orgs (the consent page's choice) and sets an
// agent principal's `org` to the organisation chosen at consent, while the
// user is still a member of it.
describe.skipIf(!worker)("the organisation of an agent token", () => {
  type Verified = { principal: { id: string; attrs: Record<string, unknown>; roles: unknown[] } };
  test("one org: no choice, it is the token's; two: the user picks one, another is 422; removed from it, no org", async () => {
    const lena = await user("tool-lena");
    expect((await lena.action("/org", "create", { name: "Lena Labs", slug: "" })).status).toBe(303);
    const L = ((await lena.service("org").currentOrg()) as { id: string }).id;
    const kai = await user("tool-kai");
    expect((await kai.action("/org", "create", { name: "Kai Kitchens", slug: "" })).status).toBe(303);
    const K = ((await kai.service("org").currentOrg()) as { id: string }).id;
    const kaiId = ((await kai.service("auth").currentUser()) as { id: string }).id;

    // One organisation: the page has no select, only K as a hidden field; the token carries K.
    const reg = await t.request("POST", "/auth/oauth/register", { body: { client_name: "Org Agent", redirect_uris: [REDIRECT] } });
    const clientId = reg.json<{ client_id: string }>().client_id;
    const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: await challengeOf(VERIFIER), code_challenge_method: "S256" });
    const one = await kai.page(`/auth/oauth/consent?${q}`);
    expect(one.status).toBe(200);
    expect(one.html).not.toContain("<select");
    expect(one.html).toContain(`name="org_id" value="${K}"`);
    const first = (await t.service("auth").verifyAgentToken(await agentToken(kai))) as Verified;
    expect(first.principal.attrs.org).toBe(K);
    expect(first.principal.attrs.mfa_verified).toBe(false);

    // Kai joins Lena Labs as a member: two organisations, the page asks.
    expect((await lena.action("/org/members", "invite", { email: "tool-kai@example.com", role: "member" })).status).toBe(200);
    const rows = t.db.query<{ url: string }>("select url from orgmail__sent where mail_to = 'tool-kai@example.com' order by seq desc limit 1");
    const path = new URL(rows[0]?.url as string).pathname;
    expect((await kai.action(path, "accept", {})).status).toBe(303);
    const two = await kai.page(`/auth/oauth/consent?${q}`);
    expect(two.html).toContain('<select name="org_id">');
    expect(two.html).toContain(`<option value="${K}" dir="auto">Kai Kitchens</option>`);
    expect(two.html).toContain(`<option value="${L}" dir="auto">Lena Labs</option>`);
    // An organisation Kai is not a member of, or no choice: 422.
    const other = await user("tool-other");
    await other.action("/org", "create", { name: "Other Org", slug: "" });
    const O = ((await other.service("org").currentOrg()) as { id: string }).id;
    expect((await kai.action("/auth/oauth/consent", "allow", { ...Object.fromEntries(q), org_id: O })).status).toBe(422);
    expect((await kai.action("/auth/oauth/consent", "allow", Object.fromEntries(q))).status).toBe(422);
    // Kai picks Lena Labs: the token acts there, whatever the session's active organisation.
    const allow = await kai.action("/auth/oauth/consent", "allow", { ...Object.fromEntries(q), org_id: L });
    expect(allow.status).toBe(303);
    const code = new URL(allow.headers.get("location") as string).searchParams.get("code") as string;
    const tok = await t.request("POST", "/auth/oauth/token", {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: VERIFIER }).toString(),
    });
    const token = tok.json<{ access_token: string }>().access_token;
    expect(t.db.query("select org_id from auth__agent_tokens where user_id = ? order by created_at desc, rowid desc limit 1", [kaiId])).toEqual([{ org_id: L }]);
    expect(((await t.service("auth").verifyAgentToken(token)) as Verified).principal.attrs.org).toBe(L);

    // Lena removes Kai: the token has no organisation any more.
    expect(await lena.service("org").removeMember({ org: L, user: kaiId })).toEqual({ ok: true });
    const after = (await t.service("auth").verifyAgentToken(token)) as Verified;
    expect(after.principal.attrs).not.toHaveProperty("org");
    expect(after.principal.id).toBe(kaiId);
  });
});
