// Break-glass impersonation, security.txt on the API host, ops:read-only
// tokens, operator ids on the wire (#310; deploy-api.md 0.4 sections 2 and
// 17; docs/24-threat-model.md G "Operator reads tenant data" and
// "Vulnerability disclosure"; ops/security/access-review.md).

import { afterEach, describe, expect, test } from "bun:test";
import { endExpiredImpersonations, TIME_BOX_MS } from "../src/ops/breakglass.ts";
import { assertScoped, auditRows, createApp_, harness, OPERATOR_TOKEN, signup, type Harness, type Session } from "./helpers.ts";

afterEach(assertScoped);

const T = "t_bg";
const REASON = "ticket 2026-311: owner reports missing orders since 09:00";

interface Setup {
  h: Harness;
  owner: Session;
  operator: Session;
  userId: string;
}

async function setup(): Promise<Setup> {
  const h = await harness();
  const owner = await signup(h, "owner@bg.test", T);
  await signup(h, "other@bg.test", "t_other");
  const operator = await signup(h, "ops@renox.test", "t_platform");
  const [u] = await h.db.query<{ id: string }>("select id from users where email = 'ops@renox.test'");
  const userId = (u as { id: string }).id;
  await h.db.query("update users set operator = true where id = $1", [userId]);
  return { h, owner, operator, userId };
}

async function opToken(h: Harness, session: Session, scopes: string[], days = 1): Promise<Response> {
  return h.request("POST", "/v1/tokens", { session, json: { name: "console", scopes, expires_in_days: days } });
}

const token = async (res: Response): Promise<string> => {
  expect(res.status).toBe(201);
  return ((await res.json()) as { token: string }).token;
};

const start = (h: Harness, tok: string, json: unknown, tenant = T) => h.request("POST", `/v1/ops/tenants/${tenant}/impersonate`, { token: tok, json });

describe("break-glass (deploy-api.md 0.4 section 17)", () => {
  test("only an ops:impersonate token starts one: not the bootstrap token, not ops:write, not a tenant token; the reason is 10 to 500 characters", async () => {
    const { h, owner, operator } = await setup();
    expect((await start(h, OPERATOR_TOKEN, { reason: REASON })).status).toBe(403);
    const write = await token(await opToken(h, operator, ["ops:write"], 7));
    expect((await start(h, write, { reason: REASON })).status).toBe(403);
    const tenantToken = await token(await h.request("POST", "/v1/tokens", { session: owner, json: { name: "ci", scopes: ["*"], expires_in_days: 7 } }));
    expect((await start(h, tenantToken, { reason: REASON })).status).toBe(403);
    // ops:impersonate lasts at most a day and never comes with a tenant scope.
    expect((await opToken(h, operator, ["ops:impersonate"], 7)).status).toBe(400);
    expect((await opToken(h, operator, ["ops:impersonate", "deploy"])).status).toBe(400);
    const imp = await token(await opToken(h, operator, ["ops:impersonate", "ops:read"]));
    expect((await start(h, imp, { reason: "look" })).status).toBe(400);
    expect((await start(h, imp, { reason: REASON, scopes: ["apps:write"] })).status).toBe(400);
    expect((await start(h, imp, { reason: REASON }, "t_missing")).status).toBe(404);
  });

  test("start: a read-only tenant token for 60 minutes, audited with the reason, the owner emailed; its requests are the operator's in the audit; getOpsTenant lists it first; a second one is 409", async () => {
    const { h, operator, userId } = await setup();
    await createApp_(h, await token(await h.request("POST", "/v1/tokens", { session: (await setup2(h)).owner, json: { name: "x", scopes: ["*"], expires_in_days: 7 } })), "shop");
    const imp = await token(await opToken(h, operator, ["ops:impersonate", "ops:read"]));
    const res = await start(h, imp, { reason: REASON });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { impersonation_id: string; token: string; scopes: string[]; operator: string; expires_at: number; started_at: number };
    expect(body.scopes).toEqual(["apps:read", "logs:read", "secrets:read"]);
    expect(body.operator).toBe(`acct_${userId.slice(4)}`);
    expect(body.expires_at - body.started_at).toBe(TIME_BOX_MS);
    expect(body.token).toMatch(/^renox_pat_[a-z2-7]{32}$/u);
    // Read-only: it lists apps, it cannot create one (the refused write is audited as the operator's).
    expect((await h.request("GET", "/v1/apps", { token: body.token })).status).toBe(200);
    expect((await h.request("POST", "/v1/apps", { token: body.token, json: { name: "evil" } })).status).toBe(403);
    const rows = (await auditRows(h)) as { tenant_id: string; actor: string; action: string; target: Record<string, string> }[];
    const startRow = rows.find((r) => r.action === "impersonateTenant");
    expect(startRow?.target).toMatchObject({ tenant_id: T, reason: REASON, impersonation_id: body.impersonation_id, operator: body.operator });
    expect(rows.filter((r) => r.actor === `operator:${body.operator}/${body.impersonation_id}`).map((r) => r.action)).toEqual(["createApp"]);
    expect(h.mailer.last("owner@bg.test", "breakglass_started")?.text).toContain(REASON);
    // The console's read: the active impersonation first.
    const ops = await h.request("GET", `/v1/ops/tenants/${T}`, { token: imp });
    expect(ops.status).toBe(200);
    expect(((await ops.json()) as { actions: { action: string; result: string; impersonation_id?: string }[] }).actions[0]).toMatchObject({ action: "impersonateTenant", result: "active", impersonation_id: body.impersonation_id });
    expect((await start(h, imp, { reason: REASON })).status).toBe(409);
  });

  test("end: by the operator now, or by the time box; the token stops; both audit rows; the owner emailed again; another tenant's id is 404", async () => {
    const { h, operator } = await setup();
    const imp = await token(await opToken(h, operator, ["ops:impersonate"]));
    const a = (await (await start(h, imp, { reason: REASON })).json()) as { impersonation_id: string; token: string };
    // IDOR: the id under another tenant's path is 404.
    expect((await h.request("DELETE", `/v1/ops/tenants/t_other/impersonate/${a.impersonation_id}`, { token: imp })).status).toBe(404);
    const ended = await h.request("DELETE", `/v1/ops/tenants/${T}/impersonate/${a.impersonation_id}`, { token: imp });
    expect(ended.status).toBe(200);
    expect(((await ended.json()) as { ended_at: number | null }).ended_at).toBe(h.clock.now);
    expect((await h.request("GET", "/v1/apps", { token: a.token })).status).toBe(401);
    expect(h.mailer.last("owner@bg.test", "breakglass_ended")?.text).toContain("ended by the operator");
    // The time box: a second impersonation ends by itself after 60 minutes.
    const b = (await (await start(h, imp, { reason: REASON })).json()) as { impersonation_id: string; token: string };
    h.clock.now += TIME_BOX_MS;
    expect((await h.request("GET", "/v1/apps", { token: b.token })).status).toBe(401);
    expect(await endExpiredImpersonations(h.deps)).toBe(1);
    expect(await endExpiredImpersonations(h.deps)).toBe(0);
    const rows = (await auditRows(h)) as { actor: string; action: string; target: Record<string, string> }[];
    expect(rows.filter((r) => r.action === "endImpersonation" && r.target.ended_by !== undefined).map((r) => [r.actor === "platform" ? "platform" : "operator", r.target.ended_by])).toEqual([
      ["operator", "operator"],
      ["platform", "timeout"],
    ]);
    expect(h.mailer.last("owner@bg.test", "breakglass_ended")?.text).toContain("60-minute limit");
  });
});

/** A second tenant owner session on T (helper for the app creation above). */
async function setup2(h: Harness): Promise<{ owner: Session }> {
  const { login } = await import("./helpers.ts");
  return { owner: await login(h, "owner@bg.test") };
}

describe("ops:read-only tokens and operator ids (#310)", () => {
  test("an ops:read token reaches getOpsTenant and nothing that writes", async () => {
    const { h, operator } = await setup();
    const read = await token(await opToken(h, operator, ["ops:read"], 30));
    expect((await h.request("GET", `/v1/ops/tenants/${T}`, { token: read })).status).toBe(200);
    expect((await h.request("POST", `/v1/ops/tenants/${T}/tier`, { token: read, json: { tier: "paid", reason: REASON } })).status).toBe(403);
    expect((await start(h, read, { reason: REASON })).status).toBe(403);
    expect((await opToken(h, operator, ["ops:read", "ops:write"])).status).toBe(400);
  });

  test("an operator action's audit row names the operator as acct_, never usr_", async () => {
    const { h, operator, userId } = await setup();
    const write = await token(await opToken(h, operator, ["ops:write"], 7));
    await h.request("POST", `/v1/ops/tenants/${T}/tier`, { token: write, json: { tier: "paid", reason: REASON } });
    const rows = (await auditRows(h)) as { action: string; target: Record<string, string> }[];
    const tierRow = rows.find((r) => r.action === "setTenantTier");
    expect(tierRow?.target.operator).toBe(`acct_${userId.slice(4)}`);
    expect(JSON.stringify(rows)).not.toContain(`"operator":"${userId}"`);
  });
});

describe("security.txt on the API host (RFC 9116, #310)", () => {
  test("contacts, Expires within a year, the canonical URL, English and Arabic", async () => {
    const h = await harness();
    const res = await h.request("GET", "/.well-known/security.txt");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toStartWith("text/plain");
    const text = await res.text();
    expect(text).toContain("Contact: mailto:security@renox.app\n");
    expect(text).toContain("Canonical: https://api.renox.app/.well-known/security.txt\n");
    expect(text).toContain("Preferred-Languages: en, ar\n");
    const expires = /Expires: (\S+)\n/u.exec(text)?.[1] as string;
    expect(expires).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u);
    const ms = Date.parse(expires) - h.clock.now;
    expect(ms > 0 && ms < 365 * 86_400_000).toBe(true);
  });
});
