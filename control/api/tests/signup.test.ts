// Onboarding (#326; deploy-api.md 0.5 section 21): the DPA field at signup
// and its version recorded on the tenant, verification signing the user in,
// `first_deploy_at` and the new-tenant restrictions on getTenant, the first
// app from a template, and the activation funnel.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { contentHash } from "@renox/artifact-validate";

import { buildArtifact } from "../../../cli/src/lib/build.ts";
import { SESSION_COOKIE } from "../src/auth/sessions.ts";
import { DPA_VERSION } from "../src/signup/dpa.ts";
import { sweepBilling } from "../src/billing/sweep.ts";
import { funnel } from "../src/signup/funnel.ts";
import { helloArtifact, upload } from "./artifacts.ts";
import { assertScoped, harness, mailToken, registeredNode, setCookie, tenant } from "./helpers.ts";

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

test("the DPA version and time are recorded on the tenant; verifying the address signs the user in and names the tenant", async () => {
  const h = await harness();
  const email = "owner@new.ae";
  expect((await h.request("POST", "/v1/account/signup", { json: { email, password: "correct horse battery staple", tenant_id: "t_new", dpa_accepted: true, captcha_token: "x" } })).status).toBe(202);
  const t = (await h.db.query<{ dpa_version: string; dpa_accepted_at: unknown }>("select dpa_version, dpa_accepted_at from tenants where id = 't_new'"))[0];
  expect(t?.dpa_version).toBe(DPA_VERSION);
  expect(Number(t?.dpa_accepted_at)).toBe(h.clock.now);
  const res = await h.request("POST", "/v1/account/verify", { json: { token: mailToken(h, email, "verify_email") } });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ email_verified: true, tenant_id: "t_new" });
  const cookie = setCookie(res, SESSION_COOKIE);
  expect(cookie).not.toBeNull();
  const me = await h.request("GET", "/v1/account", { headers: { cookie: `${SESSION_COOKIE}=${cookie}` } });
  expect(me.status).toBe(200);
});

// The hello template, built from examples/ the way `templates.ts <out>` does.
let templates = "";
const saved = process.env.CONTROL_TEMPLATES_DIR;
beforeAll(async () => {
  templates = mkdtempSync(join(tmpdir(), "renox-templates-"));
  await buildArtifact(new URL("../../../examples/hello", import.meta.url).pathname, join(templates, "hello"));
  process.env.CONTROL_TEMPLATES_DIR = templates;
});
afterAll(() => {
  if (saved === undefined) delete process.env.CONTROL_TEMPLATES_DIR;
  else process.env.CONTROL_TEMPLATES_DIR = saved;
});

test("createAppFromTemplate: the app, the template's tree under the new name, uploaded and active; a template not built is 409, an unknown one 400", async () => {
  const h = await harness();
  const token = await tenant(h, "t_first");
  await registeredNode(h, "node-1");
  const r = await h.request("POST", "/v1/apps/from-template", { token, json: { name: "first-site", template: "hello" } });
  expect(r.status).toBe(201);
  const body = (await r.json()) as { app: string; template: string; hash: string; url: string };
  expect(body).toMatchObject({ app: "first-site", template: "hello", url: "https://first-site.renox.app" });
  const d = (await (await h.request("GET", `/v1/apps/first-site/deployments/${body.hash}`, { token })).json()) as { state: string };
  expect(d.state).toBe("active");
  const tenantView = (await (await h.request("GET", "/v1/tenants/t_first", { token })).json()) as { first_deploy_at: number | null };
  expect(tenantView.first_deploy_at).toBe(h.clock.now);
  // The same name again: the API's own 409.
  expect((await h.request("POST", "/v1/apps/from-template", { token, json: { name: "first-site", template: "hello" } })).status).toBe(409);
  const missing = await h.request("POST", "/v1/apps/from-template", { token, json: { name: "second", template: "shop" } });
  expect(missing.status).toBe(409);
  expect(JSON.stringify(await missing.json())).toContain("not available");
  expect((await h.request("POST", "/v1/apps/from-template", { token, json: { name: "third", template: "wordpress" } })).status).toBe(400);
  expect((await h.request("POST", "/v1/apps/from-template", { json: { name: "fourth", template: "hello" } })).status).toBe(401);
  // Audit rows: the operation and the three steps it ran.
  const actions = (await h.db.query<{ action: string }>("select action from audit where tenant_id = 't_first' order by id")).map((a) => a.action);
  expect(actions).toEqual(expect.arrayContaining(["createApp", "uploadDeployment", "activateDeployment", "createAppFromTemplate"]));
});

test("the activation funnel counts sign-ups, verified owners, apps and deploys within 10 minutes", async () => {
  const h = await harness();
  const start = h.clock.now;
  const fast = await tenant(h, "t_fast");
  await tenant(h, "t_idle");
  await registeredNode(h, "node-1");
  expect((await h.request("POST", "/v1/apps", { token: fast, json: { name: "fast" } })).status).toBe(201);
  const files = helloArtifact((m) => {
    (m.app as { name: string }).name = "fast";
  });
  expect((await upload(h, fast, "fast", files)).status).toBe(201);
  h.clock.now += 4 * 60_000;
  expect((await h.request("POST", "/v1/apps/fast/activate", { token: fast, json: { hash: contentHash(files) } })).status).toBe(200);
  const f = await funnel(h.db, start - 1, start + 1);
  expect(f).toMatchObject({ signed_up: 2, created_app: 1, deployed: 1, deployed_within_10_min: 1, median_to_first_deploy_ms: 4 * 60_000 });
});

test("reduced_quotas: a new free tenant is over quota at half of Free's requests; one past its 7 days is not", async () => {
  const h = await harness();
  const now = h.clock.now;
  await tenant(h, "t_young");
  await h.db.query("insert into tenants (id, name, tier, created_at) values ('t_old', 't_old', 'free', $1)", [now - 8 * 86_400_000]);
  await sweepBilling(h.deps, now);
  for (const t of ["t_young", "t_old"]) await h.db.query("insert into meters_hourly (tenant_id, deployment_hash, hour_start, requests) values ($1, $2, $3, 60000)", [t, "c".repeat(64), now]);
  await sweepBilling(h.deps, now + 1000);
  const states = await h.db.query<{ tenant_id: string; state: string }>("select tenant_id, state from tenant_billing order by tenant_id");
  expect(states.map((r) => [r.tenant_id, r.state])).toEqual([
    ["t_old", "active"],
    ["t_young", "over_quota"],
  ]);
});

test("a bot sign-up script from one address creates no more than the per-IP cap, 3 an hour (#123 acceptance 4; deploy-api.md 0.5 section 21)", async () => {
  const h = await harness();
  const statuses: number[] = [];
  for (let i = 0; i < 50; i++) {
    const r = await h.request("POST", "/v1/account/signup", { ip: "198.51.100.7", json: { email: `bot${i}@example.ae`, password: "correct horse battery staple", tenant_id: `t-bot-${i}`, dpa_accepted: true } });
    statuses.push(r.status);
  }
  const created = statuses.filter((s) => s < 300).length;
  expect(created).toBe(3);
  expect(statuses.slice(3).every((s) => s === 429)).toBe(true);
  expect((await h.db.query<{ n: number }>("select count(*)::int as n from tenants where id like 't-bot-%'"))[0]?.n).toBe(3);
  // Another address is not held back by the bot's bucket.
  expect((await h.request("POST", "/v1/account/signup", { ip: "198.51.100.8", json: { email: "owner@example.ae", password: "correct horse battery staple", tenant_id: "t-real", dpa_accepted: true } })).status).toBeLessThan(300);
  // Twenty minutes later the bot gets one more, not a new burst.
  h.clock.now += 20 * 60_000;
  const next = [];
  for (let i = 50; i < 53; i++) next.push((await h.request("POST", "/v1/account/signup", { ip: "198.51.100.7", json: { email: `bot${i}@example.ae`, password: "correct horse battery staple", tenant_id: `t-bot-${i}`, dpa_accepted: true } })).status);
  expect(next.filter((s) => s < 300)).toHaveLength(1);
});
