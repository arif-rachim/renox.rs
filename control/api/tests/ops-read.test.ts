// The operator read (docs/contracts/deploy-api.md 0.3.1 section 17,
// `getOpsTenant`; #296): the tenant as the console's status panel shows it,
// served from Postgres only, audited as a read of operator data. And the
// control plane's Prometheus families (`GET /v1/ops/metrics`, src/ops/metrics.ts)
// that ops/observability scrapes with the same credential.
//
// docs/24-threat-model.md section E, "Operator console abuse": a tenant
// token, a session and no credential are refused; every read leaves an audit
// row with the operator.

import { afterEach, describe, expect, test } from "bun:test";
import { contentHash } from "@renox/artifact-validate";
import { check } from "../src/contract.ts";
import { setNodeCall } from "../src/workers/failover.ts";
import { REPORT_STALE_MS } from "../src/workers/health.ts";
import { helloArtifact, upload } from "./artifacts.ts";
import { assertScoped, auditRows, createApp_, harness, nodeToken, OPERATOR_TOKEN, signup, tenant, type Harness } from "./helpers.ts";

afterEach(assertScoped);

const REASON = "ticket OPS-204: customer upgraded by invoice";

/** A tenant with an active app on a node, a fake node listener, and an operator token of an operator account. */
async function setup(): Promise<{ h: Harness; tenantToken: string; opToken: string; node: string; nodeCalls: string[] }> {
  const h = await harness();
  const node = "node-a";
  const token = await nodeToken(h, node);
  const reg = await h.request("POST", "/v1/nodes/register", {
    token,
    json: { type: "node_register", schema_version: 0, node_id: node, worker_version: "0.3.0", region: "me-central-1", max_cells: 100, listen_url: "http://10.0.0.10:8790" },
  });
  expect(reg.status).toBe(200);
  const tenantToken = await tenant(h, "t_obs");
  await createApp_(h, tenantToken, "shop");
  const files = helloArtifact((m) => ((m.app as Record<string, string>).name = "shop"));
  await upload(h, tenantToken, "shop", files);
  expect((await h.request("POST", "/v1/apps/shop/activate", { token: tenantToken, json: { hash: contentHash(files) } })).status).toBe(200);
  const nodeCalls: string[] = [];
  setNodeCall(h.deps, async (_target, method, path) => {
    nodeCalls.push(`${method} ${path}`);
    return {
      status: 200,
      body: {
        type: "replication_status",
        schema_version: 0,
        node_id: node,
        tenant_id: "t_obs",
        database: "t_obs",
        replication: "litestream",
        state: "replicating",
        replica: { kind: "s3", region: "me-central-1" },
        last_sync_at: h.clock.now - 400,
        lag_seconds: 0.4,
        retention_hours: 168,
        snapshot_interval_seconds: 3600,
        generations: [],
        db: { size_bytes: 8192, quota_bytes: 0, wal_bytes: 0 },
      },
    };
  });
  const operator = await signup(h, "ops@renox.test", "t_platform");
  const [u] = await h.db.query<{ id: string }>("select id from users where email = 'ops@renox.test'");
  await h.db.query("update users set operator = true where id = $1", [(u as { id: string }).id]);
  const res = await h.request("POST", "/v1/tokens", { session: operator, json: { name: "console", scopes: ["ops:write"], expires_in_days: 7 } });
  expect(res.status).toBe(201);
  const opToken = ((await res.json()) as { token: string }).token;
  return { h, tenantToken, opToken, node, nodeCalls };
}

const read = (h: Harness, token: string | undefined, tenantId = "t_obs") =>
  h.request("GET", `/v1/ops/tenants/${tenantId}`, token === undefined ? {} : { token });

type AuditRow = { tenant_id: string | null; actor: string; action: string; status: number; target: Record<string, string> };

describe("getOpsTenant (0.3.1 section 17)", () => {
  test("a non-operator gets 403, no credential 401, each audited; an unknown tenant is 404", async () => {
    const { h, tenantToken, opToken } = await setup();
    expect((await read(h, tenantToken)).status).toBe(403);
    const session = await signup(h, "dev@obs.test", "t_dev");
    const bySession = await h.request("GET", "/v1/ops/tenants/t_obs", { session });
    expect(bySession.status).toBe(403);
    expect((await read(h, undefined)).status).toBe(401);
    expect((await read(h, opToken, "t_nobody")).status).toBe(404);
    const rows = ((await auditRows(h)) as unknown as AuditRow[]).filter((r) => r.action === "getOpsTenant");
    expect(rows.map((r) => r.status)).toEqual([403, 403, 401, 404]);
  });

  test("an operator gets the shape of 0.3.1 from Postgres alone, and the read is audited", async () => {
    const { h, tenantToken, opToken, node, nodeCalls } = await setup();

    // Before any report and any action: no replication entry, no action.
    const first = await read(h, opToken);
    expect(first.status).toBe(200);
    const empty = check<Record<string, unknown>>("OpsTenant", await first.json());
    expect(empty).toMatchObject({ tenant_id: "t_obs", tier: "free", state: "active", process: "shared", node_id: node, pinned_node: null, moving: false, moving_since: null, microvm_at: null, replication: [], actions: [] });

    // A tier change (an operator action) and a getBackups (the node's replication report).
    expect((await h.request("POST", "/v1/ops/tenants/t_obs/tier", { token: opToken, json: { tier: "paid", reason: REASON } })).status).toBe(200);
    expect((await h.request("GET", "/v1/apps/shop/backups", { token: tenantToken })).status).toBe(200);
    const callsBefore = nodeCalls.length;

    const res = await read(h, opToken);
    expect(res.status).toBe(200);
    const body = check<{ tier: string; process: string; replication: Record<string, unknown>[]; actions: Record<string, unknown>[] }>("OpsTenant", await res.json());
    expect(nodeCalls.length).toBe(callsBefore);
    expect(body.tier).toBe("paid");
    expect(body.process).toBe("own");
    expect(body.replication).toEqual([
      { database: "t_obs", replication: "litestream", state: "replicating", replica: { kind: "s3", region: "me-central-1" }, last_sync_at: h.clock.now - 400, lag_seconds: 0.4, reported_at: h.clock.now, stale: false },
    ]);
    expect(body.actions).toHaveLength(1);
    expect(body.actions[0]).toMatchObject({ action: "setTenantTier", reason: REASON, result: "changed" });
    expect(String(body.actions[0]?.operator)).toMatch(/^acct_/u);

    // Two heartbeats later the report is stale.
    h.clock.now += REPORT_STALE_MS + 1;
    const later = check<{ replication: { stale: boolean }[] }>("OpsTenant", await (await read(h, opToken)).json());
    expect(later.replication[0]?.stale).toBe(true);

    const rows = ((await auditRows(h)) as unknown as AuditRow[]).filter((r) => r.action === "getOpsTenant");
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.status).toBe(200);
      expect(r.tenant_id).toBe("t_obs");
      expect(r.target.tenant_id).toBe("t_obs");
      expect(r.target.operator).toMatch(/^acct_/u);
    }
  });

  test("the bootstrap operator token reads too", async () => {
    const { h } = await setup();
    const res = await read(h, OPERATOR_TOKEN);
    expect(res.status).toBe(200);
    check("OpsTenant", await res.json());
  });
});

describe("GET /v1/ops/metrics (ops/observability)", () => {
  test("refused without an operator token (audited); an operator gets the families from Postgres", async () => {
    const { h, tenantToken, opToken } = await setup();
    expect((await h.request("GET", "/v1/ops/metrics", { token: tenantToken })).status).toBe(403);
    expect((await h.request("GET", "/v1/ops/metrics", {})).status).toBe(401);
    const refused = ((await auditRows(h)) as unknown as AuditRow[]).filter((r) => r.action === "getOpsMetrics");
    expect(refused.map((r) => r.status)).toEqual([403, 401]);

    // A replication report with a lag over the FO6 threshold, through getBackups.
    expect((await h.request("GET", "/v1/apps/shop/backups", { token: tenantToken })).status).toBe(200);
    const res = await h.request("GET", "/v1/ops/metrics", { token: opToken });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toStartWith("text/plain; version=0.0.4");
    const text = await res.text();
    expect(text).toContain('renox_cp_node_healthy{node_id="node-a",region="me-central-1"} 1');
    expect(text).toContain('renox_cp_tenants{tier="free",state="active"}');
    expect(text).toContain("renox_cp_replication_databases 1");
    expect(text).toContain("renox_cp_replication_lag_max_seconds 0.4");
    expect(text).toContain("renox_cp_replication_lagging_databases 0");
    expect(text).toContain("renox_cp_up 1");
    expect(text).not.toContain("t_obs");
    // Every sample line is `name{labels} value` after its HELP and TYPE.
    for (const line of text.trim().split("\n")) {
      expect(line).toMatch(/^(# (HELP|TYPE) renox_cp_[a-z_]+ .+|renox_cp_[a-z_]+(\{[a-z_]+="[^"]*"(,[a-z_]+="[^"]*")*\})? -?[0-9.e+]+)$/u);
    }
    // A scrape is not audited.
    expect(((await auditRows(h)) as unknown as AuditRow[]).filter((r) => r.action === "getOpsMetrics")).toHaveLength(2);

    // The sweep marks the node unhealthy once its heartbeats stop.
    h.clock.now += 120_000;
    const { sweep } = await import("../src/workers/health.ts");
    await sweep(h.deps);
    const after = await (await h.request("GET", "/v1/ops/metrics", { token: opToken })).text();
    expect(after).toContain('renox_cp_node_healthy{node_id="node-a",region="me-central-1"} 0');
  });
});
