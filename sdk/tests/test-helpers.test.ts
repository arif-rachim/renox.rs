// #593: the requests behind `t.tool` against a fake app: the auth module's
// OAuth flow (resource metadata, registration, consent, token) and the
// `confirm` loop of `tools/call`. The end-to-end test on a worker is in
// cli/tests/test-command.test.ts.

import { describe, expect, test } from "bun:test";

import { agentToken, callTool, listTools, type Reply, type RequestInitLite, TOOL_REDIRECT_URI, type ToolClient } from "../src/test.ts";

interface Sent {
  method: string;
  path: string;
  init: RequestInitLite | undefined;
}

const reply = (status: number, body: unknown, headers: Record<string, string> = {}): Reply => {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return { status, headers: new Headers(headers), html: text, json: <T>() => JSON.parse(text) as T };
};

/** A fake client: `answer` maps each request to a reply; every request is recorded. */
function fake(answer: (method: string, path: string, init?: RequestInitLite) => Reply): ToolClient & { sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    sent,
    async request(method, path, init) {
      sent.push({ method, path, init });
      return answer(method, path, init);
    },
    async action(path, name, form) {
      sent.push({ method: "ACTION", path: `${path}?/${name}`, init: { body: form } });
      return answer("ACTION", `${path}?/${name}`, { body: form });
    },
  };
}

const challengeOf = async (verifier: string): Promise<string> => {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return btoa(String.fromCharCode(...d)).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
};

describe("agentToken", () => {
  test("discovery, registration, the consent's allow action, the code exchange with the PKCE verifier", async () => {
    const answer = (method: string, path: string): Reply => {
      if (path === "/.well-known/oauth-protected-resource/mcp") return reply(200, { resource: "https://test.localhost/mcp", authorization_servers: ["https://test.localhost/account/oauth"] });
      if (path === "/account/oauth/register") return reply(201, { client_id: "cl_1" });
      if (path === "/account/oauth/consent?/allow") return reply(303, "", { location: `${TOOL_REDIRECT_URI}?code=c0de` });
      if (path === "/account/oauth/token") return reply(200, { access_token: "renox_agt_x", token_type: "Bearer" });
      return reply(404, { method });
    };
    const app = fake(answer);
    const user = fake(answer);
    expect(await agentToken(app, user, "tools:echo")).toBe("renox_agt_x");

    expect(app.sent.map((s) => `${s.method} ${s.path}`)).toEqual(["GET /.well-known/oauth-protected-resource/mcp", "POST /account/oauth/register", "POST /account/oauth/token"]);
    expect(app.sent[1]?.init?.body).toEqual({ client_name: "renox test agent", redirect_uris: ["https://test.localhost/cb"] });
    // The consent is the user's: their session allows the agent.
    expect(user.sent).toHaveLength(1);
    const form = user.sent[0]?.init?.body as Record<string, string>;
    expect(form).toMatchObject({ response_type: "code", client_id: "cl_1", redirect_uri: TOOL_REDIRECT_URI, code_challenge_method: "S256", scope: "tools:echo" });
    const token = new URLSearchParams(app.sent[2]?.init?.body as string);
    expect(app.sent[2]?.init?.headers?.["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(token)).toMatchObject({ grant_type: "authorization_code", code: "c0de", redirect_uri: TOOL_REDIRECT_URI, client_id: "cl_1" });
    expect(await challengeOf(token.get("code_verifier") as string)).toBe(form.code_challenge as string);
  });

  test("no scope: the form has none (the token covers every tool)", async () => {
    const answer = (_m: string, path: string): Reply => {
      if (path.startsWith("/.well-known")) return reply(200, { authorization_servers: ["https://test.localhost/auth/oauth"] });
      if (path.endsWith("/register")) return reply(201, { client_id: "c" });
      if (path.endsWith("?/allow")) return reply(303, "", { location: `${TOOL_REDIRECT_URI}?code=k` });
      return reply(200, { access_token: "t" });
    };
    const user = fake(answer);
    await agentToken(fake(answer), user);
    expect(user.sent[0]?.path).toBe("/auth/oauth/consent?/allow");
    expect(user.sent[0]?.init?.body).not.toHaveProperty("scope");
  });

  test("without the auth module the resource metadata is 404: a clear error", async () => {
    const app = fake(() => reply(404, { error: { code: "RENOX_NOT_FOUND" } }));
    await expect(agentToken(app, app)).rejects.toThrow("t.tool needs the auth module");
  });

  test("a consent that does not redirect with a code (not signed in) fails", async () => {
    const answer = (_m: string, path: string): Reply => {
      if (path.startsWith("/.well-known")) return reply(200, { authorization_servers: ["https://test.localhost/auth/oauth"] });
      if (path.endsWith("/register")) return reply(201, { client_id: "c" });
      return reply(303, "", { location: "/auth/login?next=x" });
    };
    await expect(agentToken(fake(answer), fake(answer))).rejects.toThrow("without a code");
  });
});

describe("callTool", () => {
  const preview = { jsonrpc: "2.0", id: 1, result: { isError: false, structuredContent: { preview: { would: 1 }, confirmation: { token: "cf_1", expires_at: 99 } } } };

  test("a confirm tool: the preview and its confirmation", async () => {
    const app = fake(() => reply(200, preview));
    expect(await callTool(app, "tok", "echo", { x: 1 })).toEqual({ ok: true, preview: { would: 1 }, confirmation: { token: "cf_1", expires_at: 99 } });
    expect(app.sent).toHaveLength(1);
    const s = app.sent[0] as Sent;
    expect([s.method, s.path, s.init?.headers?.authorization]).toEqual(["POST", "/mcp", "Bearer tok"]);
    expect(s.init?.body).toMatchObject({ jsonrpc: "2.0", method: "tools/call", params: { name: "echo", arguments: { x: 1 } } });
  });

  test("confirm: true sends the confirmation back with the same arguments and returns the final result", async () => {
    const app = fake((_m, _p, init) => {
      const params = (init?.body as { params: { _meta?: Record<string, string> } }).params;
      return params._meta ? reply(200, { result: { isError: false, structuredContent: { done: true } } }) : reply(200, preview);
    });
    expect(await callTool(app, "tok", "echo", { x: 1 }, true)).toEqual({ ok: true, result: { done: true } });
    expect(app.sent).toHaveLength(2);
    expect((app.sent[1]?.init?.body as { params: unknown }).params).toEqual({ name: "echo", arguments: { x: 1 }, _meta: { "renox/confirmation": "cf_1" } });
  });

  test("a tool without confirm is called once, confirm or not", async () => {
    const app = fake(() => reply(200, { result: { isError: false, structuredContent: { n: 2 } } }));
    expect(await callTool(app, "tok", "count", {}, true)).toEqual({ ok: true, result: { n: 2 } });
    expect(app.sent).toHaveLength(1);
  });

  test("errors: a JSON-RPC error carries the platform code; isError is RENOX_TOOL_ERROR; a body-less answer its status", async () => {
    const forbidden = fake(() => reply(403, { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "You are not allowed to do this.", data: { code: "RENOX_FORBIDDEN", request_id: "r" } } }));
    expect(await callTool(forbidden, "tok", "echo", {}, true)).toEqual({ ok: false, error: { code: "RENOX_FORBIDDEN", message: "You are not allowed to do this." } });
    expect(forbidden.sent).toHaveLength(1);
    const unknown = fake(() => reply(200, { error: { code: -32602, message: "Unknown tool" } }));
    expect(await callTool(unknown, "tok", "nope", {})).toEqual({ ok: false, error: { code: "-32602", message: "Unknown tool" } });
    const failed = fake(() => reply(200, { result: { isError: true, content: [{ type: "text", text: "The tool failed." }] } }));
    expect(await callTool(failed, "tok", "echo", {})).toEqual({ ok: false, error: { code: "RENOX_TOOL_ERROR", message: "The tool failed." } });
    const limited = fake(() => reply(429, ""));
    expect(await callTool(limited, "tok", "echo", {})).toEqual({ ok: false, error: { code: "HTTP_429", message: "HTTP 429" } });
  });
});

describe("callTool with a confirmation", () => {
  test("`confirmation` is sent as given in one call, with no preview first (a made-up or replayed token)", async () => {
    const app = fake(() => reply(409, { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "The confirmation is not valid.", data: { code: "RENOX_TOOL_CONFIRM" } } }));
    expect(await callTool(app, "tok", "echo", { x: 1 }, false, "any-token")).toEqual({ ok: false, error: { code: "RENOX_TOOL_CONFIRM", message: "The confirmation is not valid." } });
    expect(app.sent).toHaveLength(1);
    expect((app.sent[0]?.init?.body as { params: unknown }).params).toEqual({ name: "echo", arguments: { x: 1 }, _meta: { "renox/confirmation": "any-token" } });
  });

  test("`confirmation` wins over `confirm`: the real result of a good token, still one call", async () => {
    const app = fake(() => reply(200, { result: { isError: false, structuredContent: { done: true } } }));
    expect(await callTool(app, "tok", "echo", {}, true, "cf_1")).toEqual({ ok: true, result: { done: true } });
    expect(app.sent).toHaveLength(1);
  });
});

describe("listTools", () => {
  test("sends tools/list with the bearer token and returns the tools", async () => {
    const tools = [{ name: "echo", annotations: { readOnlyHint: true }, inputSchema: { required: ["x"] } }];
    const app = fake(() => reply(200, { jsonrpc: "2.0", id: 1, result: { tools } }));
    expect(await listTools(app, "tok")).toEqual({ status: 200, tools });
    const s = app.sent[0] as Sent;
    expect([s.method, s.path, s.init?.headers?.authorization]).toEqual(["POST", "/mcp", "Bearer tok"]);
    expect(s.init?.body).toMatchObject({ jsonrpc: "2.0", method: "tools/list", params: {} });
  });

  test("a refused token throws with the status", async () => {
    const app = fake(() => reply(401, "unauthorized"));
    await expect(listTools(app, "bad")).rejects.toThrow("tools/list answered 401");
  });
});
