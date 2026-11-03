// The platform tenant (#396): one tenant, marked by an operator call, may use
// reserved app names and has no new-tenant restrictions; no other tenant
// gains anything.
//
// docs/24-threat-model.md section C, "Custom domain takeover" and
// "Shared-domain reputation" (a reserved name such as `dashboard` or `www`
// stays refused for every ordinary tenant, through the API and in the
// database); section E, "Operator console abuse" (only an operator token
// sets the flag, every call is audited with the operator and the reason).

import { afterEach, describe, expect, test } from "bun:test";
import { RESERVED_SLUGS, slugState } from "../src/apps/slugs.ts";
import { newTenantRestrictions } from "../src/tenants/erasure.ts";
import { assertScoped, auditRows, harness, OPERATOR_TOKEN, signup, type Harness, type Session } from "./helpers.ts";

afterEach(assertScoped);

const REASON = "bootstrap: the platform's own dashboard and site (#396)";

async function tokenOf(h: Harness, session: Session): Promise<string> {
  const res = await h.request("POST", "/v1/tokens", { session, json: { name: "t", scopes: ["*"], expires_in_days: 30 } });
  expect(res.status).toBe(201);
  return ((await res.json()) as { token: string }).token;
}

/** Two tenants signed up just now: free, inside their first 7 days, no payment method. */
async function setup(): Promise<{ h: Harness; platform: string; other: string }> {
  const h = await harness();
  const platform = await tokenOf(h, await signup(h, "owner@renoxium.test", "renoxium"));
  const other = await tokenOf(h, await signup(h, "someone@else.test", "t-other"));
  return { h, platform, other };
}

const mark = (h: Harness, tenantId: string, platform: boolean, opts: { token?: string; reason?: string } = {}) =>
  h.request("POST", `/v1/ops/tenants/${tenantId}/platform`, { token: opts.token ?? OPERATOR_TOKEN, json: { platform, reason: opts.reason ?? REASON } });
const createApp = (h: Harness, token: string, name: string) => h.request("POST", "/v1/apps", { token, json: { name } });
const addDomain = (h: Harness, token: string, app: string, hostname: string) => h.request("POST", `/v1/apps/${app}/domains`, { token, json: { hostname } });

describe("before the operator call", () => {
  test("the would-be platform tenant is an ordinary new tenant: reserved names 409, custom domains 409 no_custom_domain", async () => {
    const { h, platform } = await setup();
    for (const name of ["dashboard", "www"]) {
      const res = await createApp(h, platform, name);
      expect(res.status).toBe(409);
      expect(await res.text()).toContain('"reason":"not available"');
    }
    expect((await createApp(h, platform, "renoxium-site")).status).toBe(201);
    const res = await addDomain(h, platform, "renoxium-site", "www.renoxium.com");
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("no_custom_domain");
  });
});

describe("POST /v1/ops/tenants/{id}/platform", () => {
  test("needs an operator token, a reason, a boolean and an existing tenant", async () => {
    const { h, platform, other } = await setup();
    expect((await h.request("POST", "/v1/ops/tenants/renoxium/platform", { json: { platform: true, reason: REASON } })).status).toBe(401);
    // A tenant token, even the tenant's own owner token, is not enough.
    expect((await mark(h, "renoxium", true, { token: platform })).status).toBe(403);
    expect((await mark(h, "t-other", true, { token: other })).status).toBe(403);
    expect((await mark(h, "renoxium", true, { reason: "short" })).status).toBe(400);
    const notBool = await h.request("POST", "/v1/ops/tenants/renoxium/platform", { token: OPERATOR_TOKEN, json: { platform: "yes", reason: REASON } });
    expect(notBool.status).toBe(400);
    const extra = await h.request("POST", "/v1/ops/tenants/renoxium/platform", { token: OPERATOR_TOKEN, json: { platform: true, reason: REASON, tier: "paid" } });
    expect(extra.status).toBe(400);
    expect((await mark(h, "t-nobody", true)).status).toBe(404);
    const [row] = await h.db.query<{ n: unknown }>("select count(*) as n from tenants where platform");
    expect(Number(row?.n)).toBe(0);
  });

  test("marks the tenant, is audited with the operator and the reason, and a repeat is unchanged", async () => {
    const { h } = await setup();
    const res = await mark(h, "renoxium", true);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tenant_id: string; action: string; changed: boolean; platform: boolean; audit_id: string };
    expect(body).toMatchObject({ tenant_id: "renoxium", action: "setTenantPlatform", changed: true, platform: true });
    expect(body.audit_id).toMatch(/^aud_/u);
    const again = (await (await mark(h, "renoxium", true)).json()) as { changed: boolean };
    expect(again.changed).toBe(false);
    const rows = (await auditRows(h)).filter((r) => r.action === "setTenantPlatform");
    expect(rows.map((r) => (r.target as { result: string }).result)).toEqual(["changed", "unchanged"]);
    expect(rows[0]).toMatchObject({ tenant_id: "renoxium", actor: "operator", target: { operator: "operator", reason: REASON, platform: "true", audit_id: body.audit_id } });
    // A refused call (unknown tenant) keeps its reason in the audit row too.
    expect((await mark(h, "t-nobody", true)).status).toBe(404);
    const refused = (await auditRows(h)).filter((r) => r.action === "setTenantPlatform" && r.status === 404);
    expect(refused).toMatchObject([{ target: { tenant_id: "t-nobody", reason: REASON } }]);
  });

  test("at most one platform tenant: a second one is 409 until the first is cleared", async () => {
    const { h } = await setup();
    expect((await mark(h, "renoxium", true)).status).toBe(200);
    const second = await mark(h, "t-other", true);
    expect(second.status).toBe(409);
    expect(await second.text()).toContain("another tenant is the platform tenant");
    expect((await mark(h, "renoxium", false)).status).toBe(200);
    expect((await mark(h, "t-other", true)).status).toBe(200);
  });
});

describe("after the operator call", () => {
  test("the platform tenant takes every reserved name and attaches custom domains in its first days", async () => {
    const { h, platform } = await setup();
    expect((await mark(h, "renoxium", true)).status).toBe(200);
    for (const name of ["dashboard", "www"]) expect((await createApp(h, platform, name)).status).toBe(201);
    for (const name of RESERVED_SLUGS) expect(await slugState(h.db, name, "renoxium", h.clock.now)).toBe("available");
    expect((await addDomain(h, platform, "dashboard", "dashboard.renoxium.com")).status).toBe(201);
    expect((await addDomain(h, platform, "www", "renoxium.com")).status).toBe(201);
    expect((await addDomain(h, platform, "www", "www.renoxium.com")).status).toBe(201);
    const [t] = await h.db.query<{ created_at: unknown }>("select created_at from tenants where id = 'renoxium'");
    expect(await newTenantRestrictions(h.db, "renoxium", Number(t?.created_at), h.clock.now)).toEqual([]);
    const view = (await (await h.request("GET", "/v1/tenants/renoxium", { token: platform })).json()) as { restrictions: string[]; tier: string };
    expect(view.restrictions).toEqual([]);
    // The flag is not the paid tier: tier and process stay as they were.
    expect(view.tier).toBe("free");
  });

  test("no other tenant gains anything: reserved names stay refused through the API and in the database, and its restrictions stay", async () => {
    const { h, other } = await setup();
    expect((await mark(h, "renoxium", true)).status).toBe(200);
    for (const name of ["dashboard", "www", "admin", "api"]) {
      const res = await createApp(h, other, name);
      expect(res.status).toBe(409);
      expect(await res.text()).toContain('"reason":"not available"');
      expect(await slugState(h.db, name, "t-other", h.clock.now)).toBe("reserved");
    }
    // Past the API, the trigger still skips the insert for an ordinary tenant.
    const inserted = await h.db.query("insert into apps (tenant_id, name, created_at) values ('t-other', 'status', $1) returning name", [h.clock.now]);
    expect(inserted).toEqual([]);
    expect((await createApp(h, other, "other-site")).status).toBe(201);
    const res = await addDomain(h, other, "other-site", "www.other.test");
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("no_custom_domain");
    const [t] = await h.db.query<{ created_at: unknown }>("select created_at from tenants where id = 't-other'");
    expect(await newTenantRestrictions(h.db, "t-other", Number(t?.created_at), h.clock.now)).toEqual(["reduced_quotas", "no_custom_domain"]);
  });

  test("cleared: existing apps stay, a new reserved name and a new tenant's custom domain are refused again", async () => {
    const { h, platform } = await setup();
    expect((await mark(h, "renoxium", true)).status).toBe(200);
    expect((await createApp(h, platform, "dashboard")).status).toBe(201);
    expect((await mark(h, "renoxium", false)).status).toBe(200);
    expect(await h.db.query("select name from apps where tenant_id = 'renoxium' and name = 'dashboard'")).toHaveLength(1);
    expect((await createApp(h, platform, "www")).status).toBe(409);
    expect((await addDomain(h, platform, "dashboard", "dashboard.renoxium.com")).status).toBe(409);
  });

  test("a quarantined name stays refused for the platform tenant too", async () => {
    const { h, other, platform } = await setup();
    expect((await createApp(h, other, "shop")).status).toBe(201);
    await h.db.query("delete from secret_sets where app = 'shop'");
    await h.db.query("delete from apps where name = 'shop'");
    expect((await mark(h, "renoxium", true)).status).toBe(200);
    expect((await createApp(h, platform, "shop")).status).toBe(409);
  });
});
