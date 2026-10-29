// Operator actions (docs/contracts/deploy-api.md 0.3 section 17; #259):
// the `ops:write` scope, the tier change and its route sync, a move to a
// named node (restore before route, FO3), a move to a microVM through the
// node's hook, the reason rule, and the audit rows.
//
// docs/24-threat-model.md section E, "Operator console abuse": only an
// account flagged `operator` gets `ops:write`; tenant tokens and sessions are
// 403; every action is audited with the operator and the reason.

import { afterEach, describe, expect, test } from "bun:test";
import { contentHash } from "@renox/artifact-validate";
import type { RouteSnapshot } from "../src/routes/table.ts";
import { setNodeCall } from "../src/workers/failover.ts";
import { helloArtifact, upload } from "./artifacts.ts";
import { assertScoped, auditRows, createApp_, harness, nodeToken, OPERATOR_TOKEN, signup, tenant, type Harness, type Session } from "./helpers.ts";

afterEach(assertScoped);

const REASON = "ticket OPS-118: customer upgraded by invoice";

interface Call {
  node: string;
  method: string;
  path: string;
  body: Record<string, unknown>;
  entriesOn: string[];
  moving: boolean;
  exportStatus?: number;
}

async function register(h: Harness, node: string): Promise<string> {
  const token = await nodeToken(h, node);
  const res = await h.request("POST", "/v1/nodes/register", {
    token,
    json: { type: "node_register", schema_version: 0, node_id: node, worker_version: "0.3.0", region: "me-central-1", max_cells: 100, listen_url: `http://10.0.0.${node.endsWith("a") ? 10 : 11}:8790` },
  });
  expect(res.status).toBe(200);
  return token;
}

/** A tenant with an active app on one of two nodes, a fake node listener, and an operator account with a session. */
async function setup(opts: { hookExit?: number } = {}): Promise<{ h: Harness; owner: string; other: string; nodeTokens: Map<string, string>; tenantToken: string; calls: Call[]; operator: Session; userId: string }> {
  const h = await harness();
  const nodeTokens = new Map<string, string>();
  for (const n of ["node-a", "node-b"]) nodeTokens.set(n, await register(h, n));
  const tenantToken = await tenant(h, "t_ops");
  await createApp_(h, tenantToken, "shop");
  const files = helloArtifact((m) => ((m.app as Record<string, string>).name = "shop"));
  await upload(h, tenantToken, "shop", files);
  expect((await h.request("POST", "/v1/apps/shop/activate", { token: tenantToken, json: { hash: contentHash(files) } })).status).toBe(200);
  const [row] = await h.db.query<{ node_id: string }>("select node_id from route_entries where tenant_id = 't_ops'");
  const owner = (row as { node_id: string }).node_id;
  const other = owner === "node-a" ? "node-b" : "node-a";
  const calls: Call[] = [];
  setNodeCall(h.deps, async (target, method, path, body) => {
    const entries = await h.db.query<{ node_id: string }>("select node_id from route_entries where tenant_id = 't_ops'");
    const [t] = await h.db.query<{ moving_since: unknown }>("select moving_since from tenants where id = 't_ops'");
    const call: Call = { node: target.node_id, method, path, body: body as Record<string, unknown>, entriesOn: entries.map((e) => e.node_id), moving: t?.moving_since !== null };
    calls.push(call);
    if (path.endsWith("/move")) {
      // While the hook runs, the API refuses an export with RENOX_TENANT_MOVING.
      call.exportStatus = (await h.request("POST", "/v1/apps/shop/backups/export", { token: tenantToken, json: {} })).status;
      const code = opts.hookExit ?? 75;
      return { status: 200, body: { type: "move_result", schema_version: 0, node_id: target.node_id, tenant_id: "t_ops", target: "microvm", state: code === 0 ? "moved" : "failed", hook_exit_code: code } };
    }
    if (method === "DELETE") return { status: 200, body: { type: "tenant_dropped", schema_version: 0, node_id: target.node_id, tenant_id: "t_ops", cells_drained: 0, file: "kept" } };
    const req = body as { database: string };
    return { status: 200, body: { type: "restore_result", schema_version: 0, node_id: target.node_id, tenant_id: "t_ops", database: req.database, source: "replica", generation: "a1b2c3d4e5f60718", file_sha256: "0".repeat(64), restored_to: h.clock.now - 500, elapsed_ms: 800 } };
  });
  // An operator account: a member of the platform's own tenant, flagged by hand.
  const operator = await signup(h, "ops@renox.test", "t_platform");
  const [u] = await h.db.query<{ id: string }>("select id from users where email = 'ops@renox.test'");
  const userId = (u as { id: string }).id;
  await h.db.query("update users set operator = true where id = $1", [userId]);
  return { h, owner, other, nodeTokens, tenantToken, calls, operator, userId };
}

async function opToken(h: Harness, session: Session): Promise<string> {
  const res = await h.request("POST", "/v1/tokens", { session, json: { name: "ops console", scopes: ["ops:write"], expires_in_days: 7 } });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { token: string; scopes: string[] };
  expect(body.token).toMatch(/^renox_op_[a-z2-7]{32}$/u);
  expect(body.scopes).toEqual(["ops:write"]);
  return body.token;
}

type AuditRow = { tenant_id: string | null; action: string; status: number; target: Record<string, string> };
const audits = async (h: Harness, action: string) => ((await auditRows(h)) as unknown as AuditRow[]).filter((r) => r.action === action);

const tier = (h: Harness, token: string | undefined, json: unknown) => h.request("POST", "/v1/ops/tenants/t_ops/tier", { ...(token === undefined ? {} : { token }), json });
const move = (h: Harness, token: string | undefined, json: unknown) => h.request("POST", "/v1/ops/tenants/t_ops/move", { ...(token === undefined ? {} : { token }), json });

describe("ops:write (section 17)", () => {
  test("a non-operator cannot obtain ops:write; tenant tokens, sessions and no credential are refused on both endpoints", async () => {
    const { h, tenantToken, operator, userId } = await setup();
    // An account without the flag, and a tenant token no user created: 403.
    const plain = await signup(h, "dev@renox.test", "t_other");
    expect((await h.request("POST", "/v1/tokens", { session: plain, json: { name: "x", scopes: ["ops:write"], expires_in_days: 7 } })).status).toBe(403);
    expect((await h.request("POST", "/v1/tokens", { token: tenantToken, json: { name: "x", scopes: ["ops:write"], expires_in_days: 7 } })).status).toBe(403);
    // `*` never includes it, and it is never mixed with tenant scopes.
    expect((await h.request("POST", "/v1/tokens", { session: operator, json: { name: "x", scopes: ["ops:write", "apps:read"], expires_in_days: 7 } })).status).toBe(400);
    const body = { tier: "paid", reason: REASON };
    for (const call of [tier, move]) {
      const json = call === tier ? body : { target: "microvm", reason: REASON };
      expect((await call(h, tenantToken, json)).status).toBe(403);
      expect((await call(h, undefined, json)).status).toBe(401);
      expect((await h.request("POST", call === tier ? "/v1/ops/tenants/t_ops/tier" : "/v1/ops/tenants/t_ops/move", { session: operator, json })).status).toBe(403);
    }
    // An operator's token works until the account loses the flag.
    const op = await opToken(h, operator);
    expect((await tier(h, op, { tier: "free", reason: REASON })).status).toBe(200);
    await h.db.query("update users set operator = false where id = $1", [userId]);
    expect((await tier(h, op, { tier: "free", reason: REASON })).status).toBe(403);
    expect((await h.db.query("select 1 from tenants where id = 't_ops' and tier = 'free'")).length).toBe(1);
  });

  test("a missing or short reason, or a malformed body, is 400 and changes nothing", async () => {
    const { h } = await setup();
    for (const json of [{ tier: "paid" }, { tier: "paid", reason: "upgrade" }, { tier: "gold", reason: REASON }]) expect((await tier(h, OPERATOR_TOKEN, json)).status).toBe(400);
    for (const json of [{ target: "node", reason: REASON }, { target: "microvm", node_id: "node-b", reason: REASON }, { target: "microvm", reason: "short" }]) expect((await move(h, OPERATOR_TOKEN, json)).status).toBe(400);
    expect((await h.db.query("select 1 from tenants where id = 't_ops' and tier = 'free' and moving_since is null")).length).toBe(1);
  });
});

describe("operator actions (section 17)", () => {
  test("a tier change flips process on the route entry, and the node's next route sync shows it; unchanged is changed: false", async () => {
    const { h, owner, nodeTokens, operator } = await setup();
    const op = await opToken(h, operator);
    const res = await tier(h, op, { tier: "paid", reason: REASON });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ tenant_id: "t_ops", action: "setTenantTier", changed: true, tier: "paid", process: "own", node_id: owner });
    expect(body.audit_id).toMatch(/^aud_[0-9A-Za-z]{16,32}$/u);
    const snap = (await (await h.request("GET", `/v1/nodes/${owner}/routes`, { token: nodeTokens.get(owner) as string })).json()) as RouteSnapshot;
    const entries = snap.entries.filter((e) => e.tenant_id === "t_ops");
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) expect(e).toMatchObject({ tier: "paid", process: "own" });
    expect(snap.version).toBe(body.route_version as number);
    const again = (await (await tier(h, op, { tier: "paid", reason: REASON })).json()) as Record<string, unknown>;
    expect(again).toMatchObject({ changed: false, tier: "paid", process: "own" });
    // Back to free: the entries lose `process` (missing means shared).
    expect((await tier(h, OPERATOR_TOKEN, { tier: "free", reason: REASON })).status).toBe(200);
    const after = (await (await h.request("GET", `/v1/nodes/${owner}/routes`, { token: nodeTokens.get(owner) as string })).json()) as RouteSnapshot;
    for (const e of after.entries.filter((x) => x.tenant_id === "t_ops")) expect(e.process).toBeUndefined();

    const audit = await audits(h, "setTenantTier");
    expect(audit.map((r) => [r.tenant_id, r.status, r.target.from_tier, r.target.to_tier, r.target.reason])).toEqual([
      ["t_ops", 200, "free", "paid", REASON],
      ["t_ops", 200, "paid", "paid", REASON],
      ["t_ops", 200, "paid", "free", REASON],
    ]);
    expect(audit[0]?.target.operator).toMatch(/^usr_/u);
    expect(audit[2]?.target.operator).toBe("operator");
    expect(JSON.stringify(audit)).not.toContain("renox_op_");
  });

  test("a move to a named node restores there before the route changes, pins it, and drains the old node", async () => {
    const { h, owner, other, calls } = await setup();
    const res = await move(h, OPERATOR_TOKEN, { target: "node", node_id: other, reason: "drain the node for a kernel upgrade" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ action: "moveTenant", changed: true, node_id: other });
    const restore = calls.find((c) => c.path.endsWith("/restore"));
    expect(restore).toMatchObject({ node: other, body: { reason: "move", tenant_id: "t_ops" } });
    // FO3: the restore came while the entries still named the old node.
    expect(restore?.entriesOn.every((n) => n === owner)).toBe(true);
    expect((await h.db.query<{ node_id: string }>("select distinct node_id from route_entries where tenant_id = 't_ops'")).map((r) => r.node_id)).toEqual([other]);
    expect(await h.db.query("select node_id from tenant_pins where tenant_id = 't_ops'")).toEqual([{ node_id: other }]);
    // The current owner, an unknown node: 409, nothing called.
    const before = calls.length;
    expect((await move(h, OPERATOR_TOKEN, { target: "node", node_id: other, reason: "drain the node for a kernel upgrade" })).status).toBe(409);
    expect((await move(h, OPERATOR_TOKEN, { target: "node", node_id: "node-z", reason: "drain the node for a kernel upgrade" })).status).toBe(409);
    expect(calls.length).toBe(before);
    const audit = await audits(h, "moveTenant");
    expect(audit.map((r) => [r.status, r.target.from_node, r.target.to_node, r.target.result ?? null])).toEqual([
      [200, owner, other, "moved"],
      [409, other, other, null],
      [409, other, "node-z", null],
    ]);
  });

  test("a microVM move marks the tenant, calls the owning node, and reports the stub's exit code; the tenant serves where it was", async () => {
    const { h, owner, calls } = await setup();
    const res = await move(h, OPERATOR_TOKEN, { target: "microvm", reason: "abuse report 2026-118: isolate" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ action: "moveTenant", changed: false, node_id: owner, hook_exit_code: 75 });
    const call = calls.find((c) => c.path.endsWith("/move"));
    expect(call).toMatchObject({ node: owner, method: "POST", path: `/nodes/${owner}/tenants/t_ops/move`, moving: true, exportStatus: 503 });
    expect(call?.body).toEqual({ type: "move_request", schema_version: 0, tenant_id: "t_ops", target: "microvm", reason: "abuse report 2026-118: isolate", operator: "operator" });
    // Not moving any more: the tier can change again.
    expect((await h.db.query("select 1 from tenants where id = 't_ops' and moving_since is null and microvm_at is null")).length).toBe(1);
    expect((await tier(h, OPERATOR_TOKEN, { tier: "paid", reason: REASON })).status).toBe(200);
    const audit = await audits(h, "moveTenant");
    expect(audit[0]).toMatchObject({ tenant_id: "t_ops", status: 200, target: { target: "microvm", from_node: owner, hook_exit_code: "75", result: "hook_failed", reason: "abuse report 2026-118: isolate" } });
  });

  test("a microVM move whose hook exits 0 is recorded as moved", async () => {
    const { h } = await setup({ hookExit: 0 });
    const res = await move(h, OPERATOR_TOKEN, { target: "microvm", reason: "abuse report 2026-118: isolate" });
    expect(await res.json()).toMatchObject({ changed: true, hook_exit_code: 0 });
    expect((await h.db.query("select 1 from tenants where id = 't_ops' and microvm_at is not null")).length).toBe(1);
  });
});
