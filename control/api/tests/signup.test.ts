// Onboarding (#326; deploy-api.md 0.5 section 21): the DPA field at signup,
// `first_deploy_at` and the new-tenant restrictions on getTenant.
import { afterEach, expect, test } from "bun:test";

import { contentHash } from "@renox/artifact-validate";

import { helloArtifact, upload } from "./artifacts.ts";
import { assertScoped, harness, registeredNode, tenant } from "./helpers.ts";

afterEach(assertScoped);

test("signup refuses a DPA that is not accepted", async () => {
  const h = await harness();
  const r = await h.request("POST", "/v1/account/signup", { json: { email: "x@y.ae", password: "correct horse battery staple", tenant_id: "t_new", dpa_accepted: false, captcha_token: "x" } });
  expect(r.status).toBe(400);
  const ok = await h.request("POST", "/v1/account/signup", { json: { email: "x@y.ae", password: "correct horse battery staple", tenant_id: "t_new", dpa_accepted: true, captcha_token: "x" } });
  expect(ok.status).toBe(202);
});

test("getTenant answers first_deploy_at after the first activation, and the restrictions of a new free tenant", async () => {
  const h = await harness();
  const token = await tenant(h, "t_hello");
  const before = (await (await h.request("GET", "/v1/tenants/t_hello", { token })).json()) as Record<string, unknown>;
  expect(before).toMatchObject({ first_deploy_at: null, restrictions: ["reduced_quotas", "no_custom_domain"] });
  expect((await h.request("POST", "/v1/apps", { token, json: { name: "hello" } })).status).toBe(201);
  const files = helloArtifact();
  expect((await upload(h, token, "hello", files)).status).toBe(201);
  await registeredNode(h, "node-1");
  expect((await h.request("POST", "/v1/apps/hello/activate", { token, json: { hash: contentHash(files) } })).status).toBe(200);
  const after = (await (await h.request("GET", "/v1/tenants/t_hello", { token })).json()) as Record<string, unknown>;
  expect(typeof after.first_deploy_at).toBe("number");
  h.clock.now += 8 * 86_400_000;
  const later = (await (await h.request("GET", "/v1/tenants/t_hello", { token })).json()) as Record<string, unknown>;
  expect(later.restrictions).toEqual([]);
});
