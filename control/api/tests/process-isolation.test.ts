// The heartbeat's `process_isolation` end to end in the control plane (#460;
// docs/contracts/deploy-api.md 0.6.2 sections 7 and 17): stored per node,
// answered by getNode, and turned into getOpsTenant's `process_effective`.
// The fixtures are the contract examples of #454.
//
// docs/24-threat-model.md "Isolate escape (V8 bug)" (paid tier: one process
// per tenant): a paid tenant that runs in the shared process is shown as
// `shared`, never as the tier's `own`, and a node that never reported is
// `unknown`.

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { contentHash } from "@renox/artifact-validate";
import { check } from "../src/contract.ts";
import { processEffective } from "../src/workers/repo.ts";
import { helloArtifact, upload } from "./artifacts.ts";
import { assertScoped, createApp_, harness, nodeToken, OPERATOR_TOKEN, tenant, type Harness } from "./helpers.ts";

afterEach(assertScoped);

const EXAMPLES = new URL("../../../docs/contracts/examples/deploy-api/", import.meta.url);
const example = (name: string): Record<string, unknown> => {
  const { $comment: _, ...body } = JSON.parse(readFileSync(new URL(name, EXAMPLES), "utf8")) as Record<string, unknown>;
  return body;
};
/** The two valid heartbeats of #454, `process_isolation` only. */
const OFF = example("heartbeat.process-off.valid.json").process_isolation as { enabled: boolean; own_ignored: string[] };
const ON = example("heartbeat.process-on.valid.json").process_isolation as { enabled: boolean; own_ignored: string[] };

const NODE = "node-dxb-01";

/** A registered node (a 0.6.2 worker) and a tenant `renoxium` with an active app on it. */
async function setup(tier: "free" | "paid"): Promise<{ h: Harness; node: string }> {
  const h = await harness();
  const node = await nodeToken(h, NODE);
  const reg = await h.request("POST", "/v1/nodes/register", {
    token: node,
    json: { type: "node_register", schema_version: 0, node_id: NODE, worker_version: "0.7.0", region: "me-central-1", max_cells: 400 },
  });
  expect(reg.status).toBe(200);
  const token = await tenant(h, "renoxium", tier);
  await createApp_(h, token, "shop");
  const files = helloArtifact((m) => ((m.app as Record<string, string>).name = "shop"));
  await upload(h, token, "shop", files);
  expect((await h.request("POST", "/v1/apps/shop/activate", { token, json: { hash: contentHash(files) } })).status).toBe(200);
  return { h, node };
}

/** The heartbeat example of #454 with this node's route version, plus `process_isolation` when given. */
const beat = (h: Harness, token: string, isolation?: unknown) => {
  const { process_isolation: _, ...base } = example("heartbeat.process-off.valid.json");
  return h.request("POST", `/v1/nodes/${NODE}/heartbeat`, {
    token,
    json: { ...base, sent_at: h.clock.now, route_version: 0, ...(isolation === undefined ? {} : { process_isolation: isolation }) },
  });
};

const getNode = async (h: Harness) => check<Record<string, unknown>>("NodeDetail", await (await h.request("GET", `/v1/ops/nodes/${NODE}`, { token: OPERATOR_TOKEN })).json());
const getOpsTenant = async (h: Harness) => check<Record<string, unknown>>("OpsTenant", await (await h.request("GET", "/v1/ops/tenants/renoxium", { token: OPERATOR_TOKEN })).json());

describe("process_isolation on the heartbeat (deploy-api.md 0.6.2 section 7)", () => {
  test("stored and answered by getNode as the contract's examples; a heartbeat without it is accepted and clears it", async () => {
    const { h, node } = await setup("paid");
    // Registered, no heartbeat yet: never reported.
    expect((await getNode(h)).process_isolation).toBeNull();

    expect((await beat(h, node, OFF)).status).toBe(200);
    expect(await getNode(h)).toMatchObject({ node_id: NODE, process_isolation: { enabled: false, own_ignored: ["renoxium"] } });
    const [row] = await h.db.query<{ at: unknown }>("select process_isolation_reported_at as at from workers where node_id = $1", [NODE]);
    expect(Number(row?.at)).toBe(h.clock.now);

    expect((await beat(h, node, ON)).status).toBe(200);
    expect((await getNode(h)).process_isolation).toEqual({ enabled: true, own_ignored: [] });

    // A worker of 0.6.1 sends no process_isolation: accepted, and shown as unknown.
    const old = await beat(h, node);
    expect(old.status).toBe(200);
    expect((await getNode(h)).process_isolation).toBeNull();
  });

  test("the invalid examples of #454 are refused with 400 and change nothing", async () => {
    const { h, node } = await setup("paid");
    expect((await beat(h, node, OFF)).status).toBe(200);
    for (const name of [
      "heartbeat.process-enabled-not-boolean.invalid.json",
      "heartbeat.process-missing-list.invalid.json",
      "heartbeat.process-bad-tenant-id.invalid.json",
      "heartbeat.process-on-with-ignored.invalid.json",
      "heartbeat.process-duplicate-id.invalid.json",
      "heartbeat.process-too-many.invalid.json",
    ]) {
      expect({ name, status: (await beat(h, node, example(name).process_isolation)).status }).toEqual({ name, status: 400 });
    }
    expect((await getNode(h)).process_isolation).toEqual(OFF);
  });
});

describe("getOpsTenant's process_effective (deploy-api.md 0.6.2 section 17)", () => {
  test("a paid tenant: unknown before a report, shared on a node with [process] off, own with it on (example paid-on-shared-node)", async () => {
    const { h, node } = await setup("paid");
    expect(await getOpsTenant(h)).toMatchObject({ tier: "paid", process: "own", process_effective: "unknown", node_id: NODE });
    expect((await beat(h, node, OFF)).status).toBe(200);
    expect(await getOpsTenant(h)).toMatchObject({ tenant_id: "renoxium", tier: "paid", process: "own", process_effective: "shared", node_id: NODE });
    expect((await beat(h, node, ON)).status).toBe(200);
    expect((await getOpsTenant(h)).process_effective).toBe("own");
    expect((await beat(h, node)).status).toBe(200);
    expect((await getOpsTenant(h)).process_effective).toBe("unknown");
  });

  test("a free tenant is shared whatever the node reports", async () => {
    const { h, node } = await setup("free");
    expect((await getOpsTenant(h)).process_effective).toBe("shared");
    expect((await beat(h, node, ON)).status).toBe(200);
    expect((await getOpsTenant(h)).process_effective).toBe("shared");
  });

  test("the rule's order: no owning node is unknown before the tier is looked at", () => {
    expect(processEffective("shared", null, ON)).toBe("unknown");
    expect(processEffective("own", null, OFF)).toBe("unknown");
    expect(processEffective("shared", NODE, null)).toBe("shared");
    expect(processEffective("own", NODE, null)).toBe("unknown");
    expect(processEffective("own", NODE, OFF)).toBe("shared");
    expect(processEffective("own", NODE, ON)).toBe("own");
  });
});
