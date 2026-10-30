// The heartbeat's `disk` stored and answered (#311; deploy-api.md 0.4
// section 7; docs/23-failure-modes.md "Disk full on node"): getNode, the
// control plane's renox_cp_node_disk_level family, and an old worker's
// heartbeat without the field.

import { afterEach, describe, expect, test } from "bun:test";
import { assertScoped, auditRows, harness, OPERATOR_TOKEN, registeredNode, type Harness } from "./helpers.ts";

afterEach(assertScoped);

const beat = (h: Harness, token: string, extra: Record<string, unknown> = {}) =>
  h.request("POST", "/v1/nodes/node-d/heartbeat", {
    token,
    json: { type: "heartbeat", schema_version: 0, node_id: "node-d", sent_at: h.clock.now, route_version: 0, cells: 3, ...extra },
  });

describe("disk on the heartbeat (deploy-api.md 0.4 section 7)", () => {
  test("stored as sent and answered by getNode; a heartbeat without it keeps the last report; an unknown level is refused", async () => {
    const h = await harness();
    const node = await registeredNode(h, "node-d");
    let res = await h.request("GET", "/v1/ops/nodes/node-d", { token: OPERATOR_TOKEN });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { disk: unknown }).disk).toBeNull();

    expect((await beat(h, node, { disk: { level: "warn", free_bytes: 12_884_901_888, watermark: 80 } })).status).toBe(200);
    res = await h.request("GET", "/v1/ops/nodes/node-d", { token: OPERATOR_TOKEN });
    expect(await res.json()).toMatchObject({ node_id: "node-d", healthy: true, cells: 3, max_cells: 100, disk: { level: "warn", free_bytes: 12_884_901_888, watermark: 80 } });

    // A worker older than 0.4 sends no disk: the last report stays.
    expect((await beat(h, node)).status).toBe(200);
    expect(((await (await h.request("GET", "/v1/ops/nodes/node-d", { token: OPERATOR_TOKEN })).json()) as { disk: { level: string } }).disk.level).toBe("warn");
    expect((await beat(h, node, { disk: { level: "full", free_bytes: 0, watermark: 95 } })).status).toBe(400);

    expect((await h.request("GET", "/v1/ops/nodes/node-x", { token: OPERATOR_TOKEN })).status).toBe(404);
    // A node token or no token cannot read it.
    expect((await h.request("GET", "/v1/ops/nodes/node-d", { token: node })).status).toBe(403);
    expect((await h.request("GET", "/v1/ops/nodes/node-d")).status).toBe(401);
    // Audited as a read of operator data.
    expect((await auditRows(h)).filter((r) => r.action === "getNode").length).toBeGreaterThan(0);
  });

  test("the control plane's renox_cp_node_disk_level pages on critical (RenoxNodeDiskCritical)", async () => {
    const h = await harness();
    const node = await registeredNode(h, "node-d");
    expect((await beat(h, node, { disk: { level: "critical", free_bytes: 1_073_741_824, watermark: 95 } })).status).toBe(200);
    const text = await (await h.request("GET", "/v1/ops/metrics", { token: OPERATOR_TOKEN })).text();
    expect(text).toContain('renox_cp_node_disk_level{node_id="node-d"} 2');
  });
});
