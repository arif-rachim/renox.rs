// The dashboard's /device page (#446): look up a `renox login` request by its
// user code, and deny it. A signed-in session only (a token never approves or
// denies a device; docs/24-threat-model.md E, "Leaked CLI or CI token"); a
// code of another tenant's request is just as reachable as any pending code
// (codes belong to no tenant until approved), so the answer carries nothing
// but the name `renox login` sent and the times.

import { afterEach, describe, expect, test } from "bun:test";

import { assertScoped, harness, login, signup, type Harness } from "./helpers.ts";

afterEach(assertScoped);

async function start(h: Harness, name?: string): Promise<{ device_code: string; user_code: string }> {
  const res = await h.request("POST", "/v1/account/device", name === undefined ? {} : { json: { name } });
  expect(res.status).toBe(201);
  return (await res.json()) as { device_code: string; user_code: string };
}

describe("renox login from the dashboard's /device page", () => {
  test("a session sees the request's name and times; a token, an unknown and an expired code get nothing", async () => {
    const h = await harness();
    const owner = await signup(h, "dev@example.test", "t-dev");
    const d = await start(h, "laptop (linux x64)");
    const got = await h.request("POST", "/v1/account/device/lookup", { session: owner, json: { user_code: d.user_code.toLowerCase() } });
    expect(got.status).toBe(200);
    const body = (await got.json()) as Record<string, unknown>;
    expect(body).toEqual({ user_code: d.user_code, name: "laptop (linux x64)", created_at: h.clock.now, expires_at: h.clock.now + 900_000 });
    expect(JSON.stringify(body)).not.toContain(d.device_code);
    const tok = await h.request("POST", "/v1/tokens", { session: owner, json: { name: "ci", scopes: ["tokens:write"], expires_in_days: 1 } });
    const { token } = (await tok.json()) as { token: string };
    expect((await h.request("POST", "/v1/account/device/lookup", { token, json: { user_code: d.user_code } })).status).toBe(403);
    expect((await h.request("POST", "/v1/account/device/lookup", { session: owner, json: { user_code: "BBBB-BBBB" } })).status).toBe(404);
    expect((await h.request("POST", "/v1/account/device/lookup", { json: { user_code: d.user_code } })).status).toBe(401);
    h.clock.now += 901_000;
    expect((await h.request("POST", "/v1/account/device/lookup", { session: owner, json: { user_code: d.user_code } })).status).toBe(404);
  });

  test("deny: the CLI's next poll is told access_denied at once; the code can no longer be approved", async () => {
    const h = await harness();
    const owner = await signup(h, "deny@example.test", "t-deny");
    const d = await start(h);
    const poll = () => h.request("POST", "/v1/account/device/token", { json: { device_code: d.device_code } });
    expect((await poll()).status).toBe(202);
    const denied = await h.request("POST", "/v1/account/device/deny", { session: owner, json: { user_code: d.user_code } });
    expect(denied.status).toBe(200);
    const after = await poll();
    expect(after.status).toBe(403);
    expect(JSON.stringify(await after.json())).toContain("access_denied");
    expect((await h.request("POST", "/v1/account/device/approve", { session: owner, json: { user_code: d.user_code } })).status).toBe(404);
    expect((await h.request("POST", "/v1/account/device/deny", { session: owner, json: { user_code: d.user_code } })).status).toBe(404);
    expect(await h.db.query("select count(*)::int as n from tokens")).toEqual([{ n: 0 }]);
  });

  test("deny needs a session of a role that holds tokens:write, and the CSRF header", async () => {
    const h = await harness();
    await signup(h, "owner@example.test", "t-own");
    const d = await start(h);
    const viewer = await signup(h, "viewer@example.test");
    await h.db.query("insert into memberships (tenant_id, user_id, role, created_at) select 't-own', id, 'viewer', 0 from users where email = 'viewer@example.test'");
    const v = await login(h, "viewer@example.test", undefined, { tenant_id: "t-own" });
    expect((await h.request("POST", "/v1/account/device/deny", { session: v, json: { user_code: d.user_code } })).status).toBe(403);
    const o = await login(h, "owner@example.test");
    expect((await h.request("POST", "/v1/account/device/deny", { session: o, json: { user_code: d.user_code }, headers: { "x-renox-csrf": "wrong" } })).status).toBe(403);
    void viewer;
  });
});
