// The operator console's process isolation (#460; deploy-api.md 0.6.2
// sections 7 and 17) against the real control API (in process): the node
// page lists the paid tenants a node runs in the shared process, and the
// tenant page shows `process_effective` beside the tier's promise. The
// heartbeats are the contract examples of #454. With RENOX_WORKER_PATH, both
// pages are rendered by the worker and their HTML is checked.
//
// docs/24-threat-model.md "Isolate escape (V8 bug)" (paid tier: one process
// per tenant): the console never shows an isolation that does not exist;
// section E, "Operator console abuse": the operator token is used for one
// call and never kept.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { contentHash } from "@renox/artifact-validate";

import { helloArtifact, upload } from "../../api/tests/artifacts.ts";
import { assertScoped, createApp_, OPERATOR_TOKEN, registeredNode, tenant } from "../../api/tests/helpers.ts";
import { load as loadNode, actions as nodeActions } from "../pages/ops/nodes/[node].ts";
import { load as loadTenant, actions as tenantActions } from "../pages/ops/tenants/[tenant].ts";
import { actions as signinActions } from "../pages/signin.ts";
import { actionCtx, dash, devWithData, loaderCtx, SECRETS, type Dash } from "./helpers.ts";

setDefaultTimeout(30_000);
afterEach(assertScoped);

const NODE = "node-1";
const N = { node: NODE };
const T = { tenant: "renoxium" };
const worker = process.env.RENOX_WORKER_PATH;
type Data = Record<string, any>;
const data = (v: unknown): Data => {
  expect(v).not.toBeInstanceOf(Response);
  return v as Data;
};

const EXAMPLES = new URL("../../../docs/contracts/examples/deploy-api/", import.meta.url);
const isolation = (name: string): unknown => (JSON.parse(readFileSync(new URL(name, EXAMPLES), "utf8")) as { process_isolation: unknown }).process_isolation;
const OFF = isolation("heartbeat.process-off.valid.json");
const ON = isolation("heartbeat.process-on.valid.json");

/** A paid tenant `renoxium` with an active app on node-1, and a signed-in dashboard session. */
async function setup(enabled = true): Promise<{ d: Dash; nodeToken: string }> {
  const d = await dash({ secrets: enabled ? { ...SECRETS, OPS_CONSOLE: "operators" } : SECRETS });
  const owner = await tenant(d.h, "renoxium", "paid");
  await createApp_(d.h, owner, "shop");
  const files = helloArtifact((m) => ((m.app as Record<string, string>).name = "shop"));
  expect((await upload(d.h, owner, "shop", files)).status).toBe(201);
  const nodeToken = await registeredNode(d.h, NODE);
  expect((await d.h.request("POST", "/v1/apps/shop/activate", { token: owner, json: { hash: contentHash(files) } })).status).toBe(200);
  expect(await signinActions.default(actionCtx(d, "/signin", "default", { token: owner, next: "/apps" }))).toBeInstanceOf(Response);
  return { d, nodeToken };
}

async function beat(d: Dash, token: string, process_isolation?: unknown): Promise<void> {
  const res = await d.h.request("POST", `/v1/nodes/${NODE}/heartbeat`, {
    token,
    json: { type: "heartbeat", schema_version: 0, node_id: NODE, sent_at: d.h.clock.now, route_version: 0, cells: 1, ...(process_isolation === undefined ? {} : { process_isolation }) },
  });
  expect(res.status).toBe(200);
}

const nodeStatus = async (d: Dash) => data(await nodeActions.status(actionCtx(d, `/ops/nodes/${NODE}`, "status", { token: OPERATOR_TOKEN }, { params: N })));
const tenantStatus = async (d: Dash) => data(await tenantActions.status(actionCtx(d, "/ops/tenants/renoxium", "status", { token: OPERATOR_TOKEN }, { params: T })));

describe("process isolation in the operator console (0.6.2)", () => {
  test("the node page is 403 unless the console is on; bad input never reaches the API", async () => {
    const { d } = await setup(false);
    expect(((await loadNode(loaderCtx(d, `/ops/nodes/${NODE}`, { params: N }))) as Response).status).toBe(403);
    expect(((await nodeActions.status(actionCtx(d, `/ops/nodes/${NODE}`, "status", { token: OPERATOR_TOKEN }, { params: N }))) as Response).status).toBe(403);
    const on = (await setup()).d;
    const before = on.calls.sent.length;
    expect(data(await nodeActions.status(actionCtx(on, `/ops/nodes/${NODE}`, "status", { token: "renox_pat_" + "a".repeat(32) }, { params: N }))).form_error).not.toBeNull();
    expect(((await loadNode(loaderCtx(on, "/ops/nodes/Bad%20Node", { params: { node: "Bad Node" } }))) as Response).status).toBe(404);
    expect(on.calls.sent.length).toBe(before);
  });

  test("never reported, then [process] off, then on: the node page and the tenant page follow the heartbeats", async () => {
    const { d, nodeToken } = await setup();
    expect(data(await loadNode(loaderCtx(d, `/ops/nodes/${NODE}`, { params: N })))).toMatchObject({ node: NODE, node_view: null });

    // A worker older than 0.6.2: unknown on both pages, never "own".
    await beat(d, nodeToken);
    let n = await nodeStatus(d);
    expect(n.node_view).toMatchObject({ isolation: "unknown (this worker does not report it)", reported_off: false, ignored: [] });
    let t = await tenantStatus(d);
    expect(t.status).toMatchObject({ tier: "paid", process: "own", effective: "unknown (the node has not reported it)", broken: false, node_link: `/ops/nodes/${NODE}` });

    // [process] off: the paid tenant runs in the shared process.
    await beat(d, nodeToken, OFF);
    n = await nodeStatus(d);
    expect(n.node_view).toMatchObject({ isolation: "off: every tenant runs in the shared process", reported_off: true, ignored: [{ tenant: "renoxium", href: "/ops/tenants/renoxium" }] });
    t = await tenantStatus(d);
    expect(t.status).toMatchObject({ process: "own", effective: "the shared process", broken: true });

    // [process] on: nothing ignored, the tier's promise is kept.
    await beat(d, nodeToken, ON);
    n = await nodeStatus(d);
    expect(n.node_view).toMatchObject({ isolation: "on: tenants of the paid tier run in their own process", reported_off: false, ignored: [] });
    t = await tenantStatus(d);
    expect(t.status).toMatchObject({ process: "own", effective: "its own process", broken: false });

    const reads = d.calls.sent.filter((c) => c.method === "GET" && c.url.includes("/v1/ops/nodes/"));
    expect(reads.map((c) => [new URL(c.url).pathname, c.authorization])).toEqual(Array(3).fill([`/v1/ops/nodes/${NODE}`, `Bearer ${OPERATOR_TOKEN}`]));
    expect(JSON.stringify([n, t])).not.toContain(OPERATOR_TOKEN);
  });

  test.skipIf(!worker)(
    "rendered by the worker: the node page lists the ignored tenant; the tenant page shows where it runs, in both cases",
    async () => {
      const { d, nodeToken } = await setup();
      const nodePage = data(await loadNode(loaderCtx(d, `/ops/nodes/${NODE}`, { params: N })));
      const tenantPage = data(await loadTenant(loaderCtx(d, "/ops/tenants/renoxium", { params: T })));
      await beat(d, nodeToken, OFF);
      const off = { node: (await nodeStatus(d)).node_view, tenant: (await tenantStatus(d)).status };
      await beat(d, nodeToken, ON);
      const on = { node: (await nodeStatus(d)).node_view, tenant: (await tenantStatus(d)).status };
      for (const [name, v] of [["off", off], ["on", on]] as const) {
        const dev = await devWithData({ "pages/ops/nodes/[node].ts": { ...nodePage, node_view: v.node }, "pages/ops/tenants/[tenant].ts": { ...tenantPage, status: v.tenant } });
        try {
          const nodeHtml = (await (await fetch(`${dev.base}/ops/nodes/${NODE}`)).text()).replaceAll(' dir="auto"', "");
          const tenantHtml = (await (await fetch(`${dev.base}/ops/tenants/renoxium`)).text()).replaceAll(' dir="auto"', "");
          expect(nodeHtml).toContain('<button type="submit">Show node</button>');
          expect(tenantHtml).toContain(`<td><a href="/ops/nodes/${NODE}"><code>${NODE}</code></a></td>`);
          if (name === "off") {
            expect(nodeHtml).toContain("<td>off: every tenant runs in the shared process</td>");
            expect(nodeHtml).toContain("Paid tenants in the shared process");
            expect(nodeHtml).toContain('<li><a href="/ops/tenants/renoxium"><code>renoxium</code></a></li>');
            expect(tenantHtml).toContain("<td>paid (process own)</td>");
            expect(tenantHtml).toContain("<td>the shared process<span class=\"problem\"> The tier promises its own process, but the node runs this tenant in the shared process.</span></td>");
          } else {
            expect(nodeHtml).toContain("<td>on: tenants of the paid tier run in their own process</td>");
            expect(nodeHtml).not.toContain("Paid tenants in the shared process");
            expect(tenantHtml).toContain("<td>its own process</td>");
            expect(tenantHtml).not.toContain("The tier promises its own process");
          }
          expect(nodeHtml + tenantHtml).not.toContain(OPERATOR_TOKEN);
        } finally {
          await dev.stop();
        }
      }
    },
    180_000,
  );
});
