// Node failover (docs/contracts/deploy-api.md 0.3 section 16, FO1-FO6; #257),
// with fake nodes behind setNodeCall: the call log shows the order of
// restores and route changes.
//
// docs/23-failure-modes.md rows "Node dies" and "Node dies, restore fails".

import { afterEach, describe, expect, test } from "bun:test";
import { contentHash } from "@renox/artifact-validate";
import { checkMessage } from "../src/contract.ts";
import { logIngest } from "../src/ingest/logs.ts";
import { rendezvous } from "../src/workers/assign.ts";
import { setNodeCall, type NodeCall } from "../src/workers/failover.ts";
import { sweep } from "../src/workers/health.ts";
import { helloArtifact, upload } from "./artifacts.ts";
import { assertScoped, auditRows, createApp_, harness, nodeToken, scopedToken, tenant, type Harness } from "./helpers.ts";

afterEach(assertScoped);

const NODES = ["node-a", "node-b", "node-c"];

async function register(h: Harness, node: string, token?: string): Promise<{ token: string; callback: string }> {
  const t = token ?? (await nodeToken(h, node));
  const res = await h.request("POST", "/v1/nodes/register", {
    token: t,
    json: { type: "node_register", schema_version: 0, node_id: node, worker_version: "0.3.0", region: "me-central-1", max_cells: 100, listen_url: `http://10.0.0.${NODES.indexOf(node) + 10}:8790` },
  });
  expect(res.status).toBe(200);
  const body = checkMessage<{ callback_token?: string }>("node_registered", await res.json());
  expect(body.callback_token).toMatch(/^renox_cb_[a-z2-7]{32}$/u);
  return { token: t, callback: body.callback_token as string };
}

const heartbeat = (h: Harness, node: string, token: string) =>
  h.request("POST", `/v1/nodes/${node}/heartbeat`, {
    token,
    json: { type: "heartbeat", schema_version: 0, node_id: node, sent_at: h.clock.now, route_version: 0, cells: 1 },
  });

interface Call {
  node: string;
  method: string;
  path: string;
  token: string | null;
  /** Where the tenant's route entries pointed when the call came. */
  entriesOn: string[];
}

/** Three tenants all owned by node-a, each with an app and an active deployment. */
async function setup(failing: Map<string, Set<string>>): Promise<{ h: Harness; calls: Call[]; tokens: Map<string, string>; callbacks: Map<string, string>; tenants: string[] }> {
  const h = await harness();
  const tokens = new Map<string, string>();
  const callbacks = new Map<string, string>();
  for (const n of NODES) {
    const r = await register(h, n);
    tokens.set(n, r.token);
    callbacks.set(n, r.callback);
  }
  const tenants = Array.from({ length: 60 }, (_, i) => `t_f${i}`)
    .filter((t) => rendezvous(t, NODES)[0] === "node-a")
    .slice(0, 3);
  for (const [i, t] of tenants.entries()) {
    const token = await tenant(h, t);
    const app = `app-${i}`;
    await createApp_(h, token, app);
    const files = helloArtifact((m) => ((m.app as Record<string, string>).name = app));
    await upload(h, token, app, files);
    expect((await h.request("POST", `/v1/apps/${app}/activate`, { token, json: { hash: contentHash(files) } })).status).toBe(200);
  }
  const calls: Call[] = [];
  const fake: NodeCall = async (target, method, path, body) => {
    const tenantId = path.split("/")[4] as string;
    const rows = await h.db.query<{ node_id: string }>("select node_id from route_entries where tenant_id = $1", [tenantId]);
    calls.push({ node: target.node_id, method, path, token: target.token, entriesOn: rows.map((r) => r.node_id) });
    if (failing.get(target.node_id)?.has(tenantId)) return { status: 503, body: { error: { code: "RENOX_BACKUP_UNAVAILABLE" } } };
    if (method === "DELETE") return { status: 200, body: { type: "tenant_dropped", schema_version: 0, node_id: target.node_id, tenant_id: tenantId, cells_drained: 0, file: "kept" } };
    const req = body as { database: string };
    return {
      status: 200,
      body: { type: "restore_result", schema_version: 0, node_id: target.node_id, tenant_id: tenantId, database: req.database, source: "replica", generation: "a1b2c3d4e5f60718", file_sha256: "0".repeat(64), restored_to: h.clock.now - 800, elapsed_ms: 1200 },
    };
  };
  setNodeCall(h.deps, fake);
  return { h, calls, tokens, callbacks, tenants };
}

describe("failover (FO1-FO6)", () => {
  test("an unhealthy node's tenants are restored on healthy nodes before their routes change; failures fall through, then stay with an alert; the returning node drops them", async () => {
    const failing = new Map<string, Set<string>>();
    const { h, calls, tokens, callbacks, tenants } = await setup(failing);
    const [t0, t1, t2] = tenants as [string, string, string];
    // t1: its first candidate fails, the second succeeds. t2: every candidate fails.
    const order = (t: string) => rendezvous(t, ["node-b", "node-c"]);
    failing.set(order(t1)[0] as string, new Set([t1, t2]));
    failing.set(order(t2)[1] as string, new Set([t2]));
    if (order(t2)[0] !== order(t1)[0]) failing.set(order(t2)[0] as string, new Set([...(failing.get(order(t2)[0] as string) ?? []), t2]));

    // FO1: node-a misses heartbeats for 31 s; the others keep beating.
    h.clock.now += 31_000;
    for (const n of ["node-b", "node-c"]) expect((await heartbeat(h, n, tokens.get(n) as string)).status).toBe(200);
    const result = await sweep(h.deps);
    expect(result.unhealthy).toEqual(["node-a"]);

    // FO3: every restore came while the tenant's entries still named node-a,
    // with the callback token of the node called.
    const restores = calls.filter((c) => c.path.endsWith("/restore"));
    for (const c of restores) {
      expect(c.entriesOn.every((n) => n === "node-a")).toBe(true);
      expect(c.token).toBe(callbacks.get(c.node) as string);
    }
    const nodeOf = async (t: string) => (await h.db.query<{ node_id: string }>("select distinct node_id from route_entries where tenant_id = $1", [t])).map((r) => r.node_id);
    expect(await nodeOf(t0)).toEqual([order(t0)[0] as string]);
    // FO2: t1 tried its first candidate, then moved to the second.
    expect(restores.filter((c) => c.path.includes(`/${t1}/`)).map((c) => c.node)).toEqual(order(t1));
    expect(await nodeOf(t1)).toEqual([order(t1)[1] as string]);
    // Every candidate failed: t2 stays on node-a, with an alert row.
    expect(await nodeOf(t2)).toEqual(["node-a"]);
    const alerts = await h.db.query<{ kind: string; tenant_id: string }>("select kind, tenant_id from alerts");
    expect(alerts).toEqual([{ kind: "failover_restore_failed", tenant_id: t2 }]);
    expect(result.failovers.map((m) => [m.tenant_id, m.status])).toEqual([
      [t0, "moved"],
      [t1, "moved"],
      [t2, "failed"],
    ]);

    // FO5: a platform log line and an audit row per move.
    const { store } = logIngest(h.deps);
    for (const [t, app] of [
      [t0, "app-0"],
      [t1, "app-1"],
    ] as const) {
      const lines = await store.read(t, app, { source: "platform" });
      expect(lines.length).toBe(1);
      expect(lines[0]?.fields).toMatchObject({ kind: "failover", from_node: "node-a", generation: "a1b2c3d4e5f60718" });
    }
    const audits = (await auditRows(h)).filter((r) => r.action === "failover");
    expect(audits.map((r) => [r.tenant_id, r.status]).sort()).toEqual([
      [t0, 200],
      [t1, 200],
      [t2, 503],
    ]);

    // FO4: node-a comes back and is told to drop the two moved tenants.
    h.clock.now += 1_000;
    expect((await heartbeat(h, "node-a", tokens.get("node-a") as string)).status).toBe(200);
    for (let i = 0; i < 50 && calls.filter((c) => c.method === "DELETE").length < 2; i++) await Bun.sleep(10);
    const drops = calls.filter((c) => c.method === "DELETE");
    expect(drops.map((c) => [c.node, c.path]).sort()).toEqual(
      [t0, t1].map((t) => ["node-a", `/nodes/node-a/tenants/${t}`]).sort(),
    );
    // The moved tenants are pinned: they do not move back to node-a.
    expect(await nodeOf(t0)).toEqual([order(t0)[0] as string]);
    const pending = await h.db.query("select tenant_id from failovers where status = 'moved' and dropped_at is null");
    expect(pending).toEqual([]);
  });

  test("getBackups reports the node's status and the last failover; stale when the node does not answer", async () => {
    const failing = new Map<string, Set<string>>();
    const { h, tokens, tenants } = await setup(failing);
    const t0 = tenants[0] as string;
    h.clock.now += 31_000;
    for (const n of ["node-b", "node-c"]) await heartbeat(h, n, tokens.get(n) as string);
    await sweep(h.deps);
    // The fake answers replication status for GET.
    let up = true;
    setNodeCall(h.deps, async (target, method, path) => {
      if (!up) throw new Error("connect timeout");
      if (method !== "GET") return { status: 404, body: null };
      return {
        status: 200,
        body: { type: "replication_status", schema_version: 0, node_id: target.node_id, tenant_id: t0, database: t0, replication: "litestream", state: "replicating", replica: { kind: "s3", region: "me-central-1" }, last_sync_at: h.clock.now - 1000, lag_seconds: 0.5, retention_hours: 24, snapshot_interval_seconds: 3600, generations: [{ id: "a1b2c3d4e5f60718", start: 1, end: h.clock.now }], db: { size_bytes: 4096, quota_bytes: 0, wal_bytes: 0 } },
      };
    });
    const token = await scopedToken(h, t0, ["apps:read"]);
    const res = await h.request("GET", "/v1/apps/app-0/backups", { token });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ app: "app-0", database: t0, replication: "litestream", state: "replicating", stale: false, db: { quota_bytes: 100 * 1024 * 1024 } });
    expect(body.last_failover).toMatchObject({ from_node: "node-a", generation: "a1b2c3d4e5f60718" });
    up = false;
    const stale = (await (await h.request("GET", "/v1/apps/app-0/backups", { token })).json()) as Record<string, unknown>;
    expect(stale).toMatchObject({ replication: "litestream", stale: true });
  });
});
