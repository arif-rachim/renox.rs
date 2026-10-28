// Token auth (docs/contracts/deploy-api.md section 2; docs/24-threat-model.md
// E, "Leaked CLI or CI token" and the IDOR row).

import { describe, expect, test } from "bun:test";
import { allows, covers, newTokenValue, parseBearer, sha256hex } from "../src/auth/tokens.ts";
import { DAY_MS } from "../src/auth/tokens.ts";
import { auditRows, createApp_, harness, nodeToken, OPERATOR_TOKEN, scopedToken, tenant } from "./helpers.ts";

describe("token values", () => {
  test("format and parsing", () => {
    const t = newTokenValue("pat");
    expect(t).toMatch(/^renox_pat_[a-z2-7]{32}$/u);
    expect(parseBearer(`Bearer ${t}`)).toEqual({ kind: "pat", value: t });
    expect(parseBearer(t)).toBeNull();
    expect(parseBearer(`Bearer ${t}x`)).toBeNull();
    expect(parseBearer("Basic abc")).toBeNull();
    expect(new Set(Array.from({ length: 100 }, () => newTokenValue("node"))).size).toBe(100);
  });

  test("scopes", () => {
    expect(allows(["*"], "deploy", "a")).toBe(true);
    expect(allows(["deploy"], "deploy", "a")).toBe(true);
    expect(allows(["deploy:a"], "deploy", "a")).toBe(true);
    expect(allows(["deploy:a"], "deploy", "b")).toBe(false);
    expect(allows(["deploy:a"], "deploy")).toBe(false);
    expect(allows(["apps:read"], "deploy", "a")).toBe(false);
    expect(covers(["deploy"], "deploy:a")).toBe(true);
    expect(covers(["deploy:a"], "deploy")).toBe(false);
    expect(covers(["tokens:write"], "*")).toBe(false);
    expect(covers(["apps:read"], "apps:read")).toBe(true);
    expect(covers(["apps:read:a"], "apps:read:b")).toBe(false);
  });
});

describe("tenant token middleware", () => {
  test("missing, malformed, unknown → 401 with WWW-Authenticate and the fixed body", async () => {
    const h = await harness();
    for (const token of [undefined, "nonsense", newTokenValue("pat")]) {
      const res = await h.request("GET", "/v1/apps", token === undefined ? {} : { token });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe('Bearer realm="renox"');
      const body = (await res.json()) as { error: Record<string, string> };
      expect(body.error.code).toBe("RENOX_UNAUTHENTICATED");
      expect(body.error.message).toBe("Authentication is required.");
      expect(body.error.request_id).toBe(res.headers.get("x-renox-request-id") as string);
    }
  });

  test("expired and revoked tokens → 401", async () => {
    const h = await harness();
    const owner = await tenant(h, "t_a");
    const short = await scopedToken(h, "t_a", ["apps:read"], 1);
    expect((await h.request("GET", "/v1/apps", { token: short })).status).toBe(200);
    h.clock.now += DAY_MS;
    expect((await h.request("GET", "/v1/apps", { token: short })).status).toBe(401);

    const list = (await (await h.request("GET", "/v1/tokens", { token: owner })).json()) as { tokens: { id: string; name: string }[] };
    const id = list.tokens.find((t) => t.name === "test")?.id as string;
    expect((await h.request("DELETE", `/v1/tokens/${id}`, { token: owner })).status).toBe(204);
    expect((await h.request("GET", "/v1/apps", { token: owner })).status).toBe(401);
  });

  test("a node or operator token on a tenant endpoint → 401", async () => {
    const h = await harness();
    const node = await nodeToken(h, "node-1");
    expect((await h.request("GET", "/v1/apps", { token: node })).status).toBe(401);
    expect((await h.request("GET", "/v1/apps", { token: OPERATOR_TOKEN })).status).toBe(401);
  });

  test("missing scope → 403 RENOX_TOKEN_SCOPE; app-scoped token works on its app only", async () => {
    const h = await harness();
    const owner = await tenant(h, "t_a");
    await createApp_(h, owner, "alpha");
    await createApp_(h, owner, "beta");
    const reader = await scopedToken(h, "t_a", ["apps:read:alpha"]);
    expect((await h.request("GET", "/v1/apps/alpha", { token: reader })).status).toBe(200);
    const denied = await h.request("GET", "/v1/apps/beta", { token: reader });
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { error: { code: string } }).error.code).toBe("RENOX_TOKEN_SCOPE");
    expect((await h.request("POST", "/v1/apps", { token: reader, json: { name: "gamma" } })).status).toBe(403);
  });

  test("another tenant's app is 404, never 403", async () => {
    const h = await harness();
    const a = await tenant(h, "t_a");
    const b = await tenant(h, "t_b");
    await createApp_(h, a, "alpha");
    const res = await h.request("GET", "/v1/apps/alpha", { token: b });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("RENOX_NOT_FOUND");
    const list = (await (await h.request("GET", "/v1/apps", { token: b })).json()) as { apps: unknown[] };
    expect(list.apps).toEqual([]);
  });

  test("last_used_at is updated; only the hash is stored", async () => {
    const h = await harness();
    const token = await tenant(h, "t_a");
    h.clock.now += 5000;
    await h.request("GET", "/v1/apps", { token });
    const rows = await h.db.query<Record<string, unknown>>("select * from tokens");
    expect(Number(rows[0]?.last_used_at)).toBe(h.clock.now);
    expect(rows[0]?.token_sha256).toBe(sha256hex(token));
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  test("a token cannot create a stronger token", async () => {
    const h = await harness();
    await tenant(h, "t_a");
    const limited = await scopedToken(h, "t_a", ["tokens:write", "deploy:alpha"]);
    const ok = await h.request("POST", "/v1/tokens", { token: limited, json: { name: "ci", scopes: ["deploy:alpha"], expires_in_days: 30 } });
    expect(ok.status).toBe(201);
    const created = (await ok.json()) as { token: string };
    expect(created.token).toMatch(/^renox_pat_[a-z2-7]{32}$/u);
    for (const scopes of [["*"], ["deploy"], ["secrets:write"]]) {
      const res = await h.request("POST", "/v1/tokens", { token: limited, json: { name: "ci", scopes, expires_in_days: 30 } });
      expect(res.status).toBe(400);
    }
    const list = await (await h.request("GET", "/v1/tokens", { token: limited })).text();
    expect(list).not.toContain(created.token);
  });
});

describe("node and operator tokens", () => {
  test("operator endpoints need the configured operator token", async () => {
    const h = await harness();
    const json = { tenant_id: "t_new", name: "New", tier: "free" };
    expect((await h.request("POST", "/v1/admin/tenants", { json })).status).toBe(401);
    expect((await h.request("POST", "/v1/admin/tenants", { token: newTokenValue("op"), json })).status).toBe(401);
    const res = await h.request("POST", "/v1/admin/tenants", { token: OPERATOR_TOKEN, json });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { tenant: { state: string }; token: { token: string; scopes: string[] } };
    expect(body.tenant.state).toBe("active");
    expect(body.token.scopes).toEqual(["*"]);
    expect((await h.request("GET", "/v1/apps", { token: body.token.token })).status).toBe(200);
    expect((await h.request("POST", "/v1/admin/tenants", { token: OPERATOR_TOKEN, json })).status).toBe(409);
  });

  test("node tokens are issued once and bound to their node", async () => {
    const h = await harness();
    const res = await h.request("POST", "/v1/admin/nodes", { token: OPERATOR_TOKEN, json: { node_id: "node-dxb-01" } });
    expect(res.status).toBe(201);
    const { token } = (await res.json()) as { token: string };
    expect(token).toMatch(/^renox_node_[a-z2-7]{32}$/u);
    const rows = await h.db.query<{ token_sha256: string }>("select token_sha256 from node_tokens");
    expect(rows[0]?.token_sha256).toBe(sha256hex(token));
    expect((await h.request("POST", "/v1/admin/nodes", { token: OPERATOR_TOKEN, json: { node_id: "node-dxb-01" } })).status).toBe(409);
  });

  test("suspend and reinstate change the tenant state and are audited", async () => {
    const h = await harness();
    await tenant(h, "t_a");
    const s = await h.request("POST", "/v1/admin/tenants/t_a/suspend", { token: OPERATOR_TOKEN });
    expect(((await s.json()) as { state: string }).state).toBe("suspended");
    const r = await h.request("POST", "/v1/admin/tenants/t_a/reinstate", { token: OPERATOR_TOKEN });
    expect(((await r.json()) as { state: string }).state).toBe("active");
    expect((await h.request("POST", "/v1/admin/tenants/t_zz/suspend", { token: OPERATOR_TOKEN })).status).toBe(404);
    const audit = await auditRows(h);
    expect(audit.map((a) => [a.action, a.actor, a.tenant_id, a.status])).toEqual([
      ["suspendTenant", "operator", "t_a", 200],
      ["reinstateTenant", "operator", "t_a", 200],
      ["suspendTenant", "operator", "t_zz", 404],
    ]);
  });
});
