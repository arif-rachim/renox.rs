// The AI gateway (#327; deploy-api.md 0.5 section 23): nodes only, for a
// tenant they own; the plan's monthly token quota; tokens metered; the
// per-tenant cache; the next provider of the row on failure; no provider
// key ever in the answer.
import { afterAll, afterEach, expect, test } from "bun:test";

import { contentHash } from "@renox/artifact-validate";

import { anthropic, DEFAULT_MODEL, setModelTable } from "../src/ai/gateway.ts";
import { helloArtifact, upload } from "./artifacts.ts";
import { assertScoped, harness, registeredNode, tenant, type Harness } from "./helpers.ts";

afterEach(assertScoped);
afterAll(() => setModelTable({ [DEFAULT_MODEL]: [anthropic] }));

let calls = 0;
const ok = { call: async () => (calls++, { model: DEFAULT_MODEL, content: [{ type: "text", text: "AED 5" }], stop_reason: "end_turn", usage: { input_tokens: 40, output_tokens: 10 } }) };
const broken = { call: async () => { throw new Error("down"); } };

async function setup(plan: string): Promise<{ h: Harness; node: string }> {
  const h = await harness();
  const token = await tenant(h, "t_ai");
  expect((await h.request("POST", "/v1/apps", { token, json: { name: "hello" } })).status).toBe(201);
  const files = helloArtifact();
  expect((await upload(h, token, "hello", files)).status).toBe(201);
  const node = await registeredNode(h, "node-1");
  expect((await h.request("POST", "/v1/apps/hello/activate", { token, json: { hash: contentHash(files) } })).status).toBe(200);
  await h.db.query("insert into tenant_billing (tenant_id, plan, state_since, period_start) values ('t_ai', $1, 0, 0)", [plan]);
  return { h, node };
}

const req = (text: string, max = 100) => ({ tenant_id: "t_ai", app: "hello", request_id: "req_1", model: "default", messages: [{ role: "user", content: text }], max_tokens: max });

test("a node answers for its tenant, tokens metered, the cache per tenant, the next provider on failure", async () => {
  setModelTable({ [DEFAULT_MODEL]: [broken, ok] });
  const { h, node } = await setup("starter");
  calls = 0;
  const first = await h.request("POST", "/v1/ai/chat", { token: node, json: req("VAT on 100?") });
  expect(first.status).toBe(200);
  const a = (await first.json()) as Record<string, unknown>;
  expect(a).toMatchObject({ model: DEFAULT_MODEL, cached: false, usage: { input_tokens: 40, output_tokens: 10 } });
  expect(JSON.stringify(a)).not.toContain("x-api-key");
  const again = (await (await h.request("POST", "/v1/ai/chat", { token: node, json: req("VAT on 100?") })).json()) as Record<string, unknown>;
  expect(again).toMatchObject({ cached: true, usage: { input_tokens: 0, output_tokens: 0 } });
  expect(calls).toBe(1);
  const used = await h.db.query<{ i: number; o: number }>("select tokens_in::int as i, tokens_out::int as o from ai_usage where tenant_id = 't_ai'");
  expect(used[0]).toEqual({ i: 40, o: 10 });
  // A tenant the node does not own; a tenant token.
  expect((await h.request("POST", "/v1/ai/chat", { token: node, json: { ...req("x"), tenant_id: "t_other" } })).status).toBe(403);
  expect((await h.request("POST", "/v1/ai/chat", { token: await tenant(h, "t_other"), json: req("x") })).status).toBe(401);
  expect((await h.request("POST", "/v1/ai/chat", { token: node, json: { ...req("x"), model: "gpt-9" } })).status).toBe(400);
});

test("the plan's quota: free has none, a paid plan stops at its monthly tokens; every provider down is 503", async () => {
  setModelTable({ [DEFAULT_MODEL]: [ok] });
  const free = await setup("free");
  const r = await free.h.request("POST", "/v1/ai/chat", { token: free.node, json: req("hi") });
  expect(r.status).toBe(429);
  expect(((await r.json()) as { error: { code: string } }).error.code).toBe("RENOX_AI_QUOTA");
  const paid = await setup("starter");
  await paid.h.db.query("insert into ai_usage (tenant_id, month, tokens_in, tokens_out) values ('t_ai', $1, 999901, 0)", [new Date(paid.h.clock.now).toISOString().slice(0, 7)]);
  expect((await paid.h.request("POST", "/v1/ai/chat", { token: paid.node, json: req("hi", 100) })).status).toBe(429);
  expect((await paid.h.request("POST", "/v1/ai/chat", { token: paid.node, json: req("hi", 10) })).status).toBe(200);
  setModelTable({ [DEFAULT_MODEL]: [broken] });
  const down = await paid.h.request("POST", "/v1/ai/chat", { token: paid.node, json: req("other question", 10) });
  expect(down.status).toBe(503);
});
