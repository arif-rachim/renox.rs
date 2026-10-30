// Abuse controls (#123; deploy-api.md 0.5 sections 21-22): a public report
// becomes a ticket for the hostname's tenant, an operator takes it down
// (routes suspended) and restores it, transitions follow the abuse table,
// and a disposable sign-up domain is refused.
import { afterEach, expect, test } from "bun:test";

import { contentHash } from "@renox/artifact-validate";

import { ABUSE_TRANSITIONS } from "../src/abuse/routes.ts";
import { disposable } from "../src/signup/friction.ts";
import spec from "../../../docs/contracts/schemas/deploy-api.yaml";
import { helloArtifact, upload } from "./artifacts.ts";
import { assertScoped, harness, OPERATOR_TOKEN, registeredNode, tenant } from "./helpers.ts";

afterEach(assertScoped);

test("the transitions are deploy-api.yaml's abuse machine", () => {
  const machine = (spec as any)["x-renox-state-machines"].abuse.transitions;
  for (const [s, to] of Object.entries(ABUSE_TRANSITIONS)) expect([...to].sort()).toEqual([...(machine[s] as string[])].sort());
});

test("report, take down (routes gone), a refused transition, restore (routes back)", async () => {
  const h = await harness();
  const token = await tenant(h, "t_phish");
  expect((await h.request("POST", "/v1/apps", { token, json: { name: "hello" } })).status).toBe(201);
  const files = helloArtifact();
  expect((await upload(h, token, "hello", files)).status).toBe(201);
  await registeredNode(h, "node-1");
  expect((await h.request("POST", "/v1/apps/hello/activate", { token, json: { hash: contentHash(files) } })).status).toBe(200);
  const host = (await h.db.query<{ hostname: string }>("select hostname from route_entries where tenant_id = 't_phish' limit 1"))[0]?.hostname as string;
  const routes = async () => (await h.db.query<{ n: number }>("select count(*)::int as n from route_entries where tenant_id = 't_phish'"))[0]?.n;
  expect((await h.request("POST", "/v1/abuse", { json: { url: `https://${host}/login`, category: "phishing", description: "x", captcha_token: "t" } })).status).toBe(400);
  const r = await h.request("POST", "/v1/abuse", { json: { url: `https://${host}/login`, category: "phishing", description: "Imitates a bank login page", captcha_token: "t", reporter_email: "r@x.ae" } });
  expect(r.status).toBe(202);
  const { ticket_id } = (await r.json()) as { ticket_id: string };
  const list = (await (await h.request("GET", "/v1/ops/abuse?state=open", { token: OPERATOR_TOKEN })).json()) as { items: Record<string, unknown>[] };
  expect(list.items[0]).toMatchObject({ id: ticket_id, hostname: host, tenant_id: "t_phish", state: "open" });
  expect(JSON.stringify(list)).not.toContain("r@x.ae");
  expect((await h.request("GET", "/v1/ops/abuse", { token })).status).toBe(403);
  const down = await h.request("POST", `/v1/ops/abuse/${ticket_id}`, { token: OPERATOR_TOKEN, json: { state: "taken_down", reason: "Confirmed bank phishing page" } });
  expect(down.status).toBe(200);
  expect(await routes()).toBe(0);
  expect((await h.request("POST", `/v1/ops/abuse/${ticket_id}`, { token: OPERATOR_TOKEN, json: { state: "dismissed", reason: "changed my mind about it" } })).status).toBe(409);
  expect((await h.request("POST", `/v1/ops/abuse/${ticket_id}`, { token: OPERATOR_TOKEN, json: { state: "restored", reason: "The site was cleaned up" } })).status).toBe(200);
  expect(await routes()).toBeGreaterThan(0);
});

test("a disposable sign-up domain is refused", async () => {
  expect(disposable("x@mailinator.com")).toBe(true);
  expect(disposable("x@sub.yopmail.com")).toBe(true);
  expect(disposable("owner@hello.ae")).toBe(false);
  const h = await harness();
  const r = await h.request("POST", "/v1/account/signup", { json: { email: "bot@mailinator.com", password: "correct horse battery staple", tenant_id: "t_bot" } });
  expect(r.status).toBe(400);
});
