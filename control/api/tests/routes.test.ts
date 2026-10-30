// Activation, rollback and route publication (docs/contracts/deploy-api.md
// sections 6-8; docs/12-developer-experience.md "Deploy without downtime").

import { afterEach, describe, expect, test } from "bun:test";
import { contentHash } from "@renox/artifact-validate";
import { checkMessage } from "../src/contract.ts";
import { routeService } from "../src/routes/service.ts";
import { ownerOf } from "../src/workers/assign.ts";
import { sweep } from "../src/workers/health.ts";
import type { RouteDelta, RouteSnapshot } from "../src/routes/table.ts";
import { helloArtifact, upload } from "./artifacts.ts";
import { assertScoped, auditRows, createApp_, harness, nodeToken, OPERATOR_TOKEN, registeredNode, sseReader, tenant, type Harness } from "./helpers.ts";

afterEach(assertScoped);

const enc = new TextEncoder();
const variant = (n: number) => helloArtifact((_m, f) => f.set("code/n.json", enc.encode(String(n))));

/** R3 of deploy-api.md section 8, on top of the schema. */
function assertDelta(d: unknown): RouteDelta {
  const delta = checkMessage<RouteDelta>("route_delta", d);
  expect(delta.version).toBeGreaterThan(delta.prev_version);
  const versions = [...delta.upserts, ...delta.removals].map((c) => c.version);
  expect(new Set(versions).size).toBe(versions.length);
  for (const v of versions) {
    expect(v).toBeGreaterThan(delta.prev_version);
    expect(v).toBeLessThanOrEqual(delta.version);
  }
  return delta;
}

async function setup(): Promise<{ h: Harness; token: string; node: string; a: string; b: string }> {
  const h = await harness();
  const token = await tenant(h, "t_hello");
  await createApp_(h, token, "hello");
  const node = await registeredNode(h, "node-1");
  const a = contentHash(variant(1));
  const b = contentHash(variant(2));
  expect((await upload(h, token, "hello", variant(1))).status).toBe(201);
  expect((await upload(h, token, "hello", variant(2))).status).toBe(201);
  return { h, token, node, a, b };
}

const activateReq = (h: Harness, token: string, hash: string) => h.request("POST", "/v1/apps/hello/activate", { token, json: { hash } });
const snapshotOf = async (h: Harness, node: string) => (await (await h.request("GET", "/v1/nodes/node-1/routes", { token: node })).json()) as RouteSnapshot;
const stateOf = async (h: Harness, token: string, hash: string) =>
  ((await (await h.request("GET", `/v1/apps/hello/deployments/${hash}`, { token })).json()) as { state: string; last_error: unknown; secrets_version: number | null });

describe("activate", () => {
  test("publishes the route delta to a subscribed node within 100 ms", async () => {
    const { h, token, node, a } = await setup();
    const stream = sseReader(await h.request("GET", "/v1/nodes/node-1/stream", { token: node }));
    const first = await stream.next();
    expect(checkMessage("resync", first.data)).toEqual({ type: "resync", schema_version: 0, version: 0 });

    const started = performance.now();
    const res = await activateReq(h, token, a);
    expect(res.status).toBe(200);
    const event = await stream.next();
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(100);
    const delta = assertDelta(event.data);
    expect(delta.upserts).toEqual([
      {
        hostname: "hello.renox.app",
        tenant_id: "t_hello",
        app: "hello",
        deployment_hash: a,
        status: "active",
        updated_at: h.clock.now,
        version: 1,
        tier: "free",
        node_id: "node-1",
        secrets_version: 0,
      },
    ]);
    const body = (await res.json()) as { state: string; activated_at: number; secrets_version: number };
    expect(body).toMatchObject({ state: "active", activated_at: h.clock.now, secrets_version: 0 });
    await stream.close();
  });

  test("a second activation supersedes the first: new active, old draining, one delta", async () => {
    const { h, token, node, a, b } = await setup();
    await activateReq(h, token, a);
    const stream = sseReader(await h.request("GET", "/v1/nodes/node-1/stream", { token: node }));
    await stream.next();
    expect((await activateReq(h, token, b)).status).toBe(200);
    const delta = assertDelta((await stream.next()).data);
    expect(delta.upserts.map((u) => [u.deployment_hash, u.status])).toEqual([
      [a, "draining"],
      [b, "active"],
    ]);
    expect((await stateOf(h, token, a)).state).toBe("superseded");
    const snap = checkMessage<RouteSnapshot>("route_snapshot", await snapshotOf(h, node));
    expect(snap.entries.map((e) => [e.deployment_hash, e.status])).toEqual(
      [
        [a, "draining"],
        [b, "active"],
      ].sort(),
    );
    await stream.close();
  });

  test("activating the active deployment changes nothing; a superseded one needs rollback", async () => {
    const { h, token, a, b } = await setup();
    await activateReq(h, token, a);
    const before = routeService(h.deps).publisher;
    expect((await activateReq(h, token, a)).status).toBe(200);
    expect(routeService(h.deps).publisher).toBe(before);
    expect((await h.db.query("select 1 from route_changes")).length).toBe(1);
    await activateReq(h, token, b);
    const res = await activateReq(h, token, a);
    expect(res.status).toBe(409);
  });

  test("no healthy node → 503, back to validated with last_error, nothing published", async () => {
    const h = await harness();
    const token = await tenant(h, "t_hello");
    await createApp_(h, token, "hello");
    await upload(h, token, "hello", variant(1));
    const hash = contentHash(variant(1));
    const res = await activateReq(h, token, hash);
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("5");
    const d = await stateOf(h, token, hash);
    expect(d.state).toBe("validated");
    expect(d.last_error).toEqual({ stage: "no_worker", reason: "no healthy node can take the tenant" });
    expect((await h.db.query("select 1 from route_changes")).length).toBe(0);
  });

  test("a failed prepare leaves the old deployment serving and records the error", async () => {
    const { h, token, node, a, b } = await setup();
    await activateReq(h, token, a);
    routeService(h.deps).prepare = async () => ({ ok: false, error: { stage: "probe", reason: "GET / answered 500", http_status: 500 } });
    const res = await activateReq(h, token, b);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string; details: unknown[] } };
    expect(body.error.code).toBe("RENOX_ACTIVATION_FAILED");
    expect(body.error.details).toEqual([{ stage: "probe", reason: "GET / answered 500", http_status: 500 }]);
    expect((await stateOf(h, token, b)).state).toBe("validated");
    expect((await stateOf(h, token, a)).state).toBe("active");
    const snap = await snapshotOf(h, node);
    expect(snap.entries.map((e) => [e.deployment_hash, e.status])).toEqual([[a, "active"]]);
    const audit = (await auditRows(h)).filter((r) => r.action === "activateDeployment");
    expect(audit.map((r) => r.status)).toEqual([200, 422]);
  });

  test("activation keeps at most 50 superseded deployments", async () => {
    const h = await harness();
    const token = await tenant(h, "t_hello");
    await createApp_(h, token, "hello");
    await registeredNode(h, "node-1");
    const hashes: string[] = [];
    for (let i = 0; i < 52; i++) {
      // 6 s: one upload back in the token's bucket (10 per minute, #275).
      h.clock.now += 6_000;
      await upload(h, token, "hello", variant(i));
      hashes.push(contentHash(variant(i)));
      expect((await activateReq(h, token, hashes[i] as string)).status).toBe(200);
    }
    const counts = await h.db.query<{ state: string; n: unknown }>("select state, count(*) as n from deployments group by state order by state");
    expect(counts.map((c) => [c.state, Number(c.n)])).toEqual([
      ["active", 1],
      ["pruned", 1],
      ["superseded", 50],
    ]);
    expect((await stateOf(h, token, hashes[0] as string)).state).toBe("pruned");
  });
});

describe("rollback", () => {
  test("is a pointer switch back to the most recently superseded deployment, re-pinning secrets", async () => {
    const { h, token, node, a, b } = await setup();
    await activateReq(h, token, a);
    await activateReq(h, token, b);
    await h.db.query("update secret_sets set version = 3 where app = 'hello'");
    const stream = sseReader(await h.request("GET", "/v1/nodes/node-1/stream", { token: node }));
    await stream.next();
    const res = await h.request("POST", "/v1/apps/hello/rollback", { token });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { hash: string; secrets_version: number }).secrets_version).toBe(3);
    const delta = assertDelta((await stream.next()).data);
    expect(delta.upserts.map((u) => [u.deployment_hash, u.status, u.secrets_version])).toEqual([
      [b, "draining", 0],
      [a, "active", 3],
    ]);
    expect((await stateOf(h, token, b)).state).toBe("superseded");
    expect((await stateOf(h, token, a)).state).toBe("active");
    await stream.close();
  });

  test("an explicit hash must be superseded; nothing to roll back to → 409", async () => {
    const { h, token, a, b } = await setup();
    expect((await h.request("POST", "/v1/apps/hello/rollback", { token })).status).toBe(409);
    await activateReq(h, token, a);
    expect((await h.request("POST", "/v1/apps/hello/rollback", { token, json: { hash: b } })).status).toBe(409);
    expect((await h.request("POST", "/v1/apps/hello/rollback", { token, json: { hash: a } })).status).toBe(200);
    expect((await h.request("POST", "/v1/apps/hello/rollback", { token, json: { hash: a, migrate: true } })).status).toBe(400);
  });
});

describe("nodes", () => {
  test("register, heartbeat, snapshot with ETag; tokens are bound to their node", async () => {
    const { h, token, node, a } = await setup();
    await activateReq(h, token, a);
    const beat = await h.request("POST", "/v1/nodes/node-1/heartbeat", {
      token: node,
      json: { type: "heartbeat", schema_version: 0, node_id: "node-1", sent_at: h.clock.now, route_version: 1, cells: 1 },
    });
    expect(checkMessage("heartbeat_ack", await beat.json())).toEqual({ type: "heartbeat_ack", schema_version: 0, route_version: 1 });
    const snap = await h.request("GET", "/v1/nodes/node-1/routes", { token: node });
    expect(snap.headers.get("etag")).toBe('"1"');
    const unchanged = await h.request("GET", "/v1/nodes/node-1/routes", { token: node, headers: { "if-none-match": '"1"' } });
    expect(unchanged.status).toBe(304);
    expect((await h.request("GET", "/v1/nodes/node-2/routes", { token: node })).status).toBe(403);
    expect((await h.request("GET", "/v1/nodes/node-1/routes", { token })).status).toBe(401);
    const stranger = await nodeToken(h, "node-9");
    const unknown = await h.request("POST", "/v1/nodes/node-9/heartbeat", {
      token: stranger,
      json: { type: "heartbeat", schema_version: 0, node_id: "node-9", sent_at: 1, route_version: 0, cells: 0 },
    });
    expect(unknown.status).toBe(409);
    const wrong = await h.request("POST", "/v1/nodes/register", {
      token: stranger,
      json: { type: "node_register", schema_version: 0, node_id: "node-1", worker_version: "0.1.0", region: "x", max_cells: 1 },
    });
    expect(wrong.status).toBe(403);
  });

  test("a node silent for 30 s is unhealthy and its tenants move; it comes back on heartbeat", async () => {
    const h = await harness();
    const nodes = ["node-1", "node-2"];
    const tokens = new Map<string, string>();
    for (const n of nodes) tokens.set(n, await registeredNode(h, n));
    // Two tenants owned by different nodes.
    const names = Array.from({ length: 20 }, (_, i) => `t_${i}`);
    const t1 = names.find((t) => ownerOf(t, nodes) === "node-1") as string;
    const t2 = names.find((t) => ownerOf(t, nodes) === "node-2") as string;
    for (const [t, app] of [
      [t1, "one"],
      [t2, "two"],
    ] as const) {
      const token = await tenant(h, t);
      await createApp_(h, token, app);
      const files = helloArtifact((m) => ((m.app as Record<string, string>).name = app));
      await upload(h, token, app, files);
      expect((await h.request("POST", `/v1/apps/${app}/activate`, { token, json: { hash: contentHash(files) } })).status).toBe(200);
    }
    const stream = sseReader(await h.request("GET", "/v1/nodes/node-1/stream", { token: tokens.get("node-1") }));
    await stream.next();

    h.clock.now += 31_000;
    await h.request("POST", "/v1/nodes/node-1/heartbeat", {
      token: tokens.get("node-1"),
      json: { type: "heartbeat", schema_version: 0, node_id: "node-1", sent_at: h.clock.now, route_version: 2, cells: 1 },
    });
    const result = await sweep(h.deps);
    expect(result.unhealthy).toEqual(["node-2"]);
    const delta = assertDelta((await stream.next()).data);
    expect(delta.upserts.map((u) => [u.tenant_id, u.node_id])).toEqual([[t2, "node-1"]]);

    h.clock.now += 1000;
    await h.request("POST", "/v1/nodes/node-2/heartbeat", {
      token: tokens.get("node-2"),
      json: { type: "heartbeat", schema_version: 0, node_id: "node-2", sent_at: h.clock.now, route_version: 3, cells: 0 },
    });
    const back = assertDelta((await stream.next()).data);
    expect(back.upserts.map((u) => [u.tenant_id, u.node_id])).toEqual([[t2, "node-2"]]);
    await stream.close();
  });

  test("drained entries are removed 120 s after the switch", async () => {
    const { h, token, node, a, b } = await setup();
    await activateReq(h, token, a);
    await activateReq(h, token, b);
    const stream = sseReader(await h.request("GET", "/v1/nodes/node-1/stream", { token: node }));
    await stream.next();
    h.clock.now += 60_000;
    await h.request("POST", "/v1/nodes/node-1/heartbeat", {
      token: node,
      json: { type: "heartbeat", schema_version: 0, node_id: "node-1", sent_at: h.clock.now, route_version: 3, cells: 1 },
    });
    expect((await sweep(h.deps)).drained).toBe(0);
    h.clock.now += 61_000;
    await h.request("POST", "/v1/nodes/node-1/heartbeat", {
      token: node,
      json: { type: "heartbeat", schema_version: 0, node_id: "node-1", sent_at: h.clock.now, route_version: 3, cells: 1 },
    });
    expect((await sweep(h.deps)).drained).toBe(1);
    const delta = assertDelta((await stream.next()).data);
    expect(delta.removals.map((r) => r.deployment_hash)).toEqual([a]);
    expect((await snapshotOf(h, node)).entries.map((e) => e.deployment_hash)).toEqual([b]);
    await stream.close();
  });
});

describe("assignment", () => {
  test("rendezvous: removing a node moves only its own tenants", () => {
    const nodes = ["node-a", "node-b", "node-c"];
    const tenants = Array.from({ length: 300 }, (_, i) => `t_${i}`);
    const before = new Map(tenants.map((t) => [t, ownerOf(t, nodes)]));
    const counts = new Map<string, number>();
    for (const o of before.values()) counts.set(o as string, (counts.get(o as string) ?? 0) + 1);
    for (const n of nodes) expect(counts.get(n)).toBeGreaterThan(50);
    const after = new Map(tenants.map((t) => [t, ownerOf(t, ["node-a", "node-c"])]));
    for (const t of tenants) if (before.get(t) !== "node-b") expect(after.get(t)).toBe(before.get(t) as string);
    expect(ownerOf("t", [])).toBeNull();
  });
});

describe("suspension", () => {
  test("suspending removes the tenant's routes; reinstating restores them", async () => {
    const { h, token, node, a } = await setup();
    await activateReq(h, token, a);
    expect((await h.request("POST", "/v1/admin/tenants/t_hello/suspend", { token: OPERATOR_TOKEN })).status).toBe(200);
    expect((await stateOf(h, token, a)).state).toBe("suspended");
    expect((await snapshotOf(h, node)).entries).toEqual([]);
    expect((await activateReq(h, token, a)).status).toBe(409);
    expect((await h.request("POST", "/v1/admin/tenants/t_hello/reinstate", { token: OPERATOR_TOKEN })).status).toBe(200);
    expect((await stateOf(h, token, a)).state).toBe("active");
    expect((await snapshotOf(h, node)).entries.map((e) => [e.deployment_hash, e.status])).toEqual([[a, "active"]]);
  });
});
