// Onboarding (#326; deploy-api.md 0.5 section 21): the DPA field at signup
// and its version recorded on the tenant, verification signing the user in,
// `first_deploy_at` and the new-tenant restrictions on getTenant, the first
// app from a template, and the activation funnel.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHmac } from "node:crypto";

import { contentHash } from "@renox/artifact-validate";

import { buildArtifact } from "../../../cli/src/lib/build.ts";
import { SESSION_COOKIE } from "../src/auth/sessions.ts";
import { DPA_VERSION } from "../src/signup/dpa.ts";
import { sweepBilling } from "../src/billing/sweep.ts";
import { funnel } from "../src/signup/funnel.ts";
import { helloArtifact, upload } from "./artifacts.ts";
import { mintSetupToken, setupKey, SETUP_TOKEN_TTL_MS, verifySetupToken } from "../src/signup/templates.ts";
import { verifySetupToken as appVerifySetupToken } from "../../../examples/home-services/lib/setup-token.ts";
import { assertScoped, auditRows, harness, mailToken, registeredNode, setCookie, signup, tenant, TEST_MASTER_KEY } from "./helpers.ts";

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

// home-services with a `setup` (#689; deploy-api.md 0.9 section 21). The app side is stubbed: `deps.callApp`.
describe("createAppFromTemplate with setup (#689)", () => {
  const SETUP = {
    company: { name: "CoolAir", phone: "+971501234567", emirate: "dubai" },
    branches: [
      { name: "Dubai", emirate: "dubai" },
      { name: "Sharjah", emirate: "sharjah" },
    ],
    services: [{ name: "AC service", price_aed: 150 }],
    people: [
      { email: "tech@coolair.ae", role: "technician" },
      { email: "books@coolair.ae", role: "accountant" },
    ],
  };
  const master = Buffer.from(TEST_MASTER_KEY, "base64");
  type Call = { url: string; headers: Record<string, string>; body: Record<string, unknown> };
  type Answer = { status: number; body: unknown };

  beforeAll(async () => {
    await buildArtifact(new URL("../../../examples/home-services", import.meta.url).pathname, join(templates, "home-services"));
  });

  async function setUp(answer: () => Answer) {
    const h = await harness();
    const session = await signup(h, "owner@coolair.ae", "t_cool");
    await registeredNode(h, "node-1");
    const calls: Call[] = [];
    h.deps.callApp = async (url, init) => {
      calls.push({ url, headers: init.headers, body: JSON.parse(init.body) as Record<string, unknown> });
      return answer();
    };
    return { h, session, calls };
  }
  type Up = Awaited<ReturnType<typeof setUp>>;
  const create = (u: Up, json: unknown) => u.h.request("POST", "/v1/apps/from-template", { session: u.session, json });

  test("creates and activates the app, keeps the setup key as an app secret, and calls /api/setup with a token that verifies", async () => {
    const u = await setUp(() => ({ status: 200, body: { invited: SETUP.people, skipped: [] } }));
    const { h, session, calls } = u;
    const r = await create(u, { name: "coolair", template: "home-services", setup: SETUP });
    expect(r.status).toBe(201);
    const body = (await r.json()) as { app: string; hash: string; url: string; setup: { invited: unknown[] } };
    expect(body).toMatchObject({ app: "coolair", url: "https://coolair.renox.app", setup: { invited: SETUP.people } });
    const d = (await (await h.request("GET", `/v1/apps/coolair/deployments/${body.hash}`, { session })).json()) as { state: string };
    expect(d.state).toBe("active");

    expect(calls).toHaveLength(1);
    const call = calls[0] as Call;
    expect(call.url).toBe("https://coolair.renox.app/api/setup");
    expect(call.body).toEqual({ ...SETUP, owner: { email: "owner@coolair.ae" } });
    // The token: recomputed from the key derived from the master key.
    const key = setupKey(master, "t_cool", "coolair");
    const token = call.headers["renox-setup"] as string;
    const [v, app, hash, exp, mac] = token.split(".") as [string, string, string, string, string];
    expect([v, app, hash]).toEqual(["v1", "coolair", body.hash]);
    expect(Number(exp)).toBe(h.clock.now + SETUP_TOKEN_TTL_MS);
    expect(mac).toBe(createHmac("sha256", key).update(`${v}.${app}.${hash}.${exp}`).digest("base64url"));
    expect(verifySetupToken(key, token, "coolair", body.hash, h.clock.now)).toBe(true);

    // The secret is the app's: its name is visible, its value is not, and the manifest declares it.
    const secrets = await (await h.request("GET", "/v1/apps/coolair/secrets", { session })).text();
    expect(secrets).toContain("SETUP_KEY");
    expect(secrets).not.toContain(key);
    const stored = await h.db.query<{ name: string; ciphertext: Uint8Array }>("select name, ciphertext from secrets where tenant_id = 't_cool' and app = 'coolair'");
    expect(stored.map((x) => x.name)).toEqual(["SETUP_KEY"]);
    expect(Buffer.from(stored[0]?.ciphertext as Uint8Array).includes(Buffer.from(key))).toBe(false);
    const dep = JSON.stringify(await (await h.request("GET", `/v1/apps/coolair/deployments/${body.hash}`, { session })).json());
    expect(dep).toContain("SETUP_KEY");

    // Neither the key nor the token is in an audit row.
    const audit = JSON.stringify(await auditRows(h));
    expect(audit).not.toContain(key);
    expect(audit).not.toContain(token);
    const row = (await auditRows(h)).find((a) => a.action === "createAppFromTemplate");
    expect(row?.target).toMatchObject({ app: "coolair", template: "home-services", setup: "ok" });
    expect(h.unscoped).toEqual([]);
  });

  test("a setup that fails leaves the app created and live, answers 502 RENOX_SETUP_FAILED with the app, and audits the reason", async () => {
    const cases: [string, () => Answer, string][] = [
      ["no-route", () => ({ status: 404, body: null }), "app_status_404"],
      ["taken", () => ({ status: 409, body: null }), "already_set_up"],
      [
        "slow",
        () => {
          throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
        },
        "timeout",
      ],
      [
        "down",
        () => {
          throw new Error("connect refused");
        },
        "unreachable",
      ],
    ];
    for (const [name, answer, reason] of cases) {
      const u = await setUp(answer);
      const r = await create(u, { name, template: "home-services", setup: SETUP });
      expect(r.status).toBe(502);
      const body = (await r.json()) as { error: { code: string; details: unknown[] }; app: string; url: string; hash: string };
      expect(body.error).toMatchObject({ code: "RENOX_SETUP_FAILED", details: [{ field: "setup", reason }] });
      expect(body).toMatchObject({ app: name, url: `https://${name}.renox.app` });
      const d = (await (await u.h.request("GET", `/v1/apps/${name}/deployments/${body.hash}`, { session: u.session })).json()) as { state: string };
      expect(d.state).toBe("active");
      const row = (await auditRows(u.h)).find((a) => a.action === "createAppFromTemplate");
      expect(row?.target).toMatchObject({ app: name, setup: reason });
      expect(row?.status).toBe(502);
    }
  });

  test("setup with another template, out-of-range arrays or a bad value is 400 and creates nothing; so is a token without a verified account", async () => {
    const u = await setUp(() => ({ status: 200, body: {} }));
    const { h, session, calls } = u;
    const many = (n: number, f: (i: number) => unknown) => Array.from({ length: n }, (_, i) => f(i));
    const bad: [string, unknown][] = [
      ["other template", { name: "a1", template: "hello", setup: SETUP }],
      ["no branches", { name: "a2", template: "home-services", setup: { ...SETUP, branches: [] } }],
      ["six branches", { name: "a3", template: "home-services", setup: { ...SETUP, branches: many(6, (i) => ({ name: `B${i}`, emirate: "dubai" })) } }],
      ["no services", { name: "a4", template: "home-services", setup: { ...SETUP, services: [] } }],
      ["51 services", { name: "a5", template: "home-services", setup: { ...SETUP, services: many(51, (i) => ({ name: `S${i}`, price_aed: 1 })) } }],
      ["21 people", { name: "a6", template: "home-services", setup: { ...SETUP, people: many(21, (i) => ({ email: `p${i}@x.ae`, role: "technician" })) } }],
      ["emirate", { name: "a7", template: "home-services", setup: { ...SETUP, company: { ...SETUP.company, emirate: "riyadh" } } }],
      ["role", { name: "a8", template: "home-services", setup: { ...SETUP, people: [{ email: "p@x.ae", role: "admin" }] } }],
      ["phone", { name: "a9", template: "home-services", setup: { ...SETUP, company: { ...SETUP.company, phone: "050 123" } } }],
      ["extra key", { name: "b1", template: "home-services", setup: { ...SETUP, extra: 1 } }],
    ];
    for (const [label, json] of bad) {
      const r = await create(u, json);
      expect([label, r.status]).toEqual([label, 400]);
    }
    expect(((await (await h.request("GET", "/v1/apps", { session })).json()) as { apps: unknown[] }).apps).toEqual([]);
    // A tenant token that no user created has no email to make the first owner.
    const bare = await tenant(h, "t_bare");
    const r = await h.request("POST", "/v1/apps/from-template", { token: bare, json: { name: "bare", template: "home-services", setup: SETUP } });
    expect(r.status).toBe(400);
    expect(calls).toEqual([]);
  });

  test("setup tokens: another app, another hash, an expired token, a tampered one or another key fail verification", () => {
    const key = setupKey(master, "t_cool", "coolair");
    const hash = "a".repeat(64);
    const now = 1_000_000;
    const token = mintSetupToken(key, "coolair", hash, now);
    expect(verifySetupToken(key, token, "coolair", hash, now + 1)).toBe(true);
    expect(verifySetupToken(key, token, "other", hash, now)).toBe(false);
    expect(verifySetupToken(key, token, "coolair", "b".repeat(64), now)).toBe(false);
    expect(verifySetupToken(key, token, "coolair", hash, now + SETUP_TOKEN_TTL_MS)).toBe(false);
    expect(verifySetupToken(setupKey(master, "t_cool", "other"), token, "coolair", hash, now)).toBe(false);
    expect(verifySetupToken(setupKey(Buffer.alloc(32, 8), "t_cool", "coolair"), token, "coolair", hash, now)).toBe(false);
    // The expiry is covered by the HMAC: moving it is a forgery.
    const parts = token.split(".");
    parts[3] = String(now + 3_600_000);
    expect(verifySetupToken(key, parts.join("."), "coolair", hash, now)).toBe(false);
    // A token minted for another app (same key) names that app, so it fails here.
    expect(verifySetupToken(key, mintSetupToken(key, "other", hash, now), "coolair", hash, now)).toBe(false);
    expect(verifySetupToken(key, "garbage", "coolair", hash, now)).toBe(false);
  });

  // #711: the app side of the token is the real one (examples/home-services/lib/setup-token.ts),
  // which functions/api/setup.ts runs on the token of the request.
  test("the home-services app accepts the token the API sends and refuses another app's, an expired or a forged one", async () => {
    const key = setupKey(master, "t_cool", "coolair");
    const u = await setUp(() => ({ status: 500, body: null }));
    const seen: unknown[] = [];
    u.h.deps.callApp = async (_url, init) => {
      const r = await appVerifySetupToken(key, init.headers["renox-setup"] ?? "", "coolair", u.h.clock.now);
      seen.push(r);
      return r.ok ? { status: 200, body: { invited: [], skipped: [] } } : { status: 401, body: null };
    };
    const r = await create(u, { name: "coolair", template: "home-services", setup: SETUP });
    expect(r.status).toBe(201);
    const body = (await r.json()) as { hash: string };
    expect(seen).toEqual([{ ok: true, app: "coolair", hash: body.hash, exp: u.h.clock.now + SETUP_TOKEN_TTL_MS }]);

    const now = 1_000_000;
    const hash = "a".repeat(64);
    const token = mintSetupToken(key, "coolair", hash, now);
    expect(await appVerifySetupToken(key, token, "coolair", now + 1)).toEqual({ ok: true, app: "coolair", hash, exp: now + SETUP_TOKEN_TTL_MS });
    expect((await appVerifySetupToken(key, token, "other", now)).ok).toBe(false);
    expect((await appVerifySetupToken(key, token, "coolair", now + SETUP_TOKEN_TTL_MS)).ok).toBe(false);
    expect((await appVerifySetupToken(setupKey(master, "t_cool", "other"), token, "coolair", now)).ok).toBe(false);
    const parts = token.split(".");
    parts[3] = String(now + 3_600_000);
    expect((await appVerifySetupToken(key, parts.join("."), "coolair", now)).ok).toBe(false);
    expect((await appVerifySetupToken(key, mintSetupToken(key, "other", hash, now), "coolair", now)).ok).toBe(false);
    expect((await appVerifySetupToken("", token, "coolair", now)).ok).toBe(false);
  });
});
