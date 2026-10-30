// Tenant erasure (#308; docs/contracts/deploy-api.md 0.4 section 3;
// docs/24-threat-model.md G "Erasure incomplete (PDPL right to erasure)"):
// deleteTenant, the state machine, the node drop, the exports and records
// deleted, the audit rows, the owner's email, the refusals.

import { afterEach, describe, expect, test } from "bun:test";
import { contentHash } from "@renox/artifact-validate";
import { erasureOf, runErasure, TIME_BOX_MS } from "../src/tenants/erasure.ts";
import { setNodeCall } from "../src/workers/failover.ts";
import { helloArtifact, upload } from "./artifacts.ts";
import { addMember, assertScoped, auditRows, createApp_, harness, login, nodeToken, scopedToken, signup, type Harness, type Session } from "./helpers.ts";

afterEach(assertScoped);

const T = "t_er";

interface Setup {
  h: Harness;
  owner: Session;
  token: string;
  calls: { method: string; path: string }[];
  nodeUp: { up: boolean };
}

async function setup(): Promise<Setup> {
  const h = await harness();
  const node = await nodeToken(h, "node-1");
  const reg = await h.request("POST", "/v1/nodes/register", {
    token: node,
    json: { type: "node_register", schema_version: 0, node_id: "node-1", worker_version: "0.4.0", region: "me-central-1", max_cells: 100, listen_url: "http://10.0.0.10:8790" },
  });
  expect(reg.status).toBe(200);
  const owner = await signup(h, "owner@er.test", T);
  const token = await scopedToken(h, T, ["*"]);
  await createApp_(h, token, "shop");
  const files = helloArtifact((m) => ((m.app as Record<string, string>).name = "shop"));
  await upload(h, token, "shop", files);
  expect((await h.request("POST", "/v1/apps/shop/activate", { token, json: { hash: contentHash(files) } })).status).toBe(200);
  // An export object of the tenant.
  await h.store.put(`exports/${T}/${T}/1.db`, new TextEncoder().encode("SQLite format 3\u0000"));
  await h.db.query("insert into exports (id, tenant_id, app, object_key, sha256, size_bytes, created_at, expires_at) values ($1, $2, $3, $4, $5, $6, $7, $8)", [
    "exp_01JBQ40000000000000000EXP1",
    T,
    "shop",
    `exports/${T}/${T}/1.db`,
    "0".repeat(64),
    16,
    h.clock.now,
    h.clock.now + 86_400_000,
  ]);
  const calls: { method: string; path: string }[] = [];
  const nodeUp = { up: true };
  setNodeCall(h.deps, async (_target, method, path) => {
    calls.push({ method, path });
    if (!nodeUp.up) throw new Error("unreachable");
    return { status: 200, body: { type: "tenant_dropped", schema_version: 0, node_id: "node-1", tenant_id: T, cells_drained: 1 } };
  });
  return { h, owner, token, calls, nodeUp };
}

/** Runs the erasure until it leaves `pending`/`erasing` or `max` rounds pass. */
async function settle(h: Harness, max = 20): Promise<string | null> {
  let state: string | null = null;
  for (let i = 0; i < max; i++) {
    state = (await runErasure(h.deps, T)) ?? state;
    if (state === "done" || state === "failed") return state;
    await Bun.sleep(5);
  }
  return (await erasureOf(h.db, T))?.state ?? null;
}

const count = async (h: Harness, table: string): Promise<number> =>
  Number((await h.db.query<{ n: unknown }>(`select count(*) as n from ${table} where tenant_id = $1`, [T]))[0]?.n ?? 0);

describe("deleteTenant (deploy-api.md 0.4 section 3)", () => {
  test("the owner erases the tenant: 202 pending, then done with the routes, tokens, node file, exports and records gone; audited; emailed", async () => {
    const { h, owner, token, calls } = await setup();
    expect(await count(h, "route_entries")).toBeGreaterThan(0);
    const res = await h.request("DELETE", `/v1/tenants/${T}`, { session: owner, json: { confirm: T } });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ state: "pending", requested_at: h.clock.now, completed_at: null, failure: null });
    expect(await settle(h)).toBe("done");

    expect(await count(h, "route_entries")).toBe(0);
    expect(await count(h, "apps")).toBe(0);
    expect(await count(h, "deployments")).toBe(0);
    expect(await count(h, "exports")).toBe(0);
    expect([...h.store.objects.keys()].some((k) => k.startsWith(`exports/${T}/`))).toBe(false);
    expect(calls.some((c) => c.method === "DELETE" && c.path === `/nodes/node-1/tenants/${T}`)).toBe(true);
    // Every token is revoked.
    expect((await h.request("GET", "/v1/apps", { token })).status).toBe(401);
    // The tombstone: the owner's session still reads the tenant and its erasure.
    const view = await h.request("GET", `/v1/tenants/${T}`, { session: owner });
    expect(view.status).toBe(200);
    expect(await view.json()).toMatchObject({ tenant_id: T, state: "suspended", erasure: { state: "done", completed_at: h.clock.now, failure: null } });
    const audit = (await auditRows(h)).filter((r) => r.action === "deleteTenant");
    expect(audit.map((r) => [r.actor === "platform" ? "platform" : "user", r.status])).toEqual([
      ["user", 202],
      ["platform", 200],
    ]);
    expect(h.mailer.last("owner@er.test", "tenant_erased")?.text).toContain("Erasure completed at");
  });

  test("a second DELETE answers the same record; a token, a non-owner and a wrong confirm are refused; another tenant is 404", async () => {
    const { h, owner, token } = await setup();
    // A token never holds tenant:delete, even with `*`.
    expect((await h.request("DELETE", `/v1/tenants/${T}`, { token, json: { confirm: T } })).status).toBe(403);
    const admin = await signup(h, "admin@er.test");
    await addMember(h, T, "admin@er.test", "admin");
    const adminSession = await login(h, "admin@er.test", undefined, { tenant_id: T });
    void admin;
    expect((await h.request("DELETE", `/v1/tenants/${T}`, { session: adminSession, json: { confirm: T } })).status).toBe(403);
    const wrong = await h.request("DELETE", `/v1/tenants/${T}`, { session: owner, json: { confirm: "t_other" } });
    expect(wrong.status).toBe(400);
    expect(JSON.stringify(await wrong.json())).toContain("confirm");
    expect((await h.request("DELETE", "/v1/tenants/t_other", { session: owner, json: { confirm: "t_other" } })).status).toBe(404);
    expect((await h.request("GET", "/v1/tenants/t_other", { session: owner })).status).toBe(404);
    const first = await h.request("DELETE", `/v1/tenants/${T}`, { session: owner, json: { confirm: T } });
    const again = await h.request("DELETE", `/v1/tenants/${T}`, { session: owner, json: { confirm: T } });
    expect(again.status).toBe(202);
    expect((await again.json()).requested_at).toBe((await first.json()).requested_at);
    await settle(h);
  });

  test("409 while the tenant is moving", async () => {
    const { h, owner } = await setup();
    await h.db.query("update tenants set moving_since = $2 where id = $1", [T, h.clock.now]);
    const res = await h.request("DELETE", `/v1/tenants/${T}`, { session: owner, json: { confirm: T } });
    expect(res.status).toBe(409);
    expect(await erasureOf(h.db, T)).toBeNull();
  });

  test("a node that is down keeps the erasure in erasing; past the 24 h time box it is failed at node_drop with an alert; the node's return lets an operator retry to done", async () => {
    const { h, owner, nodeUp } = await setup();
    nodeUp.up = false;
    expect((await h.request("DELETE", `/v1/tenants/${T}`, { session: owner, json: { confirm: T } })).status).toBe(202);
    await Bun.sleep(20);
    await runErasure(h.deps, T);
    expect(await erasureOf(h.db, T)).toMatchObject({ state: "erasing", completed_at: null });
    // Routes and tokens went first; the records wait for the node.
    expect(await count(h, "route_entries")).toBe(0);
    expect(await count(h, "apps")).toBe(1);
    h.clock.now += TIME_BOX_MS;
    expect(await runErasure(h.deps, T)).toBe("failed");
    expect(await erasureOf(h.db, T)).toMatchObject({ state: "failed", failure: "node_drop" });
    expect((await h.db.query("select kind from alerts where tenant_id = $1", [T])).map((r) => (r as { kind: string }).kind)).toEqual(["erasure_failed"]);
    // The operator's retry once the node is back (deploy-api.md: failed -> erasing).
    nodeUp.up = true;
    await h.db.query("update tenant_erasures set state = 'erasing', next_at = 0 where tenant_id = $1", [T]);
    expect(await settle(h)).toBe("done");
    expect(await count(h, "apps")).toBe(0);
  });
});
