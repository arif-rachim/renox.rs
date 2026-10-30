// The operator console page (#259, docs/19-platform-wireframes.md section 5)
// against the real control API (in process): 403 unless the dashboard
// enables the console; the three actions with the operator's token, which is
// sent to the API once and never kept; the API's refusal of a token without
// ops:write. With RENOX_WORKER_PATH, the page is rendered by the worker.
//
// docs/24-threat-model.md section E, "Operator console abuse".
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { contentHash } from "@renox/artifact-validate";

import { helloArtifact, upload } from "../../api/tests/artifacts.ts";
import { assertScoped, createApp_, OPERATOR_TOKEN, registeredNode, tenant } from "../../api/tests/helpers.ts";
import { currentToken } from "../lib/session.ts";
import { load, actions } from "../pages/ops/tenants/[tenant].ts";
import { actions as signinActions } from "../pages/signin.ts";
import { actionCtx, dash, devWithData, loaderCtx, SECRETS, statements, type Dash } from "./helpers.ts";

setDefaultTimeout(30_000);
afterEach(assertScoped);

const T = { tenant: "t_hello" };
const REASON = "ticket OPS-118: upgraded by invoice";
const worker = process.env.RENOX_WORKER_PATH;
const statementsOf = (d: Dash) => statements(d.sqlite);
type Data = Record<string, any>;
const data = (v: unknown): Data => {
  expect(v).not.toBeInstanceOf(Response);
  return v as Data;
};

async function setup(enabled = true): Promise<Dash> {
  const d = await dash({ secrets: enabled ? { ...SECRETS, OPS_CONSOLE: "operators" } : SECRETS });
  const owner = await tenant(d.h, "t_hello");
  await createApp_(d.h, owner, "hello");
  const files = helloArtifact();
  expect((await upload(d.h, owner, "hello", files)).status).toBe(201);
  await registeredNode(d.h, "node-1");
  expect((await d.h.request("POST", "/v1/apps/hello/activate", { token: owner, json: { hash: contentHash(files) } })).status).toBe(200);
  expect(await signinActions.default(actionCtx(d, "/signin", "default", { token: owner, next: "/apps" }))).toBeInstanceOf(Response);
  return d;
}

describe("operator console (section 5)", () => {
  test("403 unless the dashboard enables the console, for the page and every action", async () => {
    const d = await setup(false);
    const page = await load(loaderCtx(d, "/ops/tenants/t_hello", { params: T }));
    expect(page).toBeInstanceOf(Response);
    expect((page as Response).status).toBe(403);
    for (const name of ["tier", "node", "microvm"] as const) {
      const r = await actions[name](actionCtx(d, "/ops/tenants/t_hello", name, { tier: "paid", node_id: "node-1", reason: REASON, token: OPERATOR_TOKEN }, { params: T }));
      expect((r as Response).status).toBe(403);
    }
    expect(d.calls.sent.filter((c) => c.url.includes("/v1/ops/"))).toEqual([]);
  });

  test("with the console on: the page renders; a tier change with the operator token reaches the API once and the token is not kept", async () => {
    const d = await setup();
    const page = data(await load(loaderCtx(d, "/ops/tenants/t_hello", { params: T })));
    expect(page).toMatchObject({ tenant: "t_hello", state: null, reason_min: 10 });
    const r = data(await actions.tier(actionCtx(d, "/ops/tenants/t_hello", "tier", { tier: "paid", reason: REASON, token: OPERATOR_TOKEN }, { params: T })));
    expect(r.action_problem).toBeNull();
    expect(r.state).toMatchObject({ tier: "paid", process: "own", node: "node-1" });
    expect(r.state.notice).toContain("process own");
    const sent = d.calls.sent.filter((c) => c.url.includes("/v1/ops/"));
    expect(sent.map((c) => [c.method, new URL(c.url).pathname, c.authorization])).toEqual([["POST", "/v1/ops/tenants/t_hello/tier", `Bearer ${OPERATOR_TOKEN}`]]);
    expect(JSON.stringify(r)).not.toContain(OPERATOR_TOKEN);
    // The dashboard's own sign-in is still the tenant token, not the operator's.
    expect(await currentToken(statementsOf(d), d.secrets, d.sessionId, Date.now())).not.toBe(OPERATOR_TOKEN);
    const micro = data(await actions.microvm(actionCtx(d, "/ops/tenants/t_hello", "microvm", { reason: REASON, token: OPERATOR_TOKEN }, { params: T })));
    // node-1 has no listener (an F3 registration): the API answers 503.
    expect(micro.action_problem).toMatchObject({ code: "RENOX_BACKUP_UNAVAILABLE", status: 503 });
  });

  test("bad input is refused before the API; a token without ops:write is the API's 401 or 403, and the sign-in stays", async () => {
    const d = await setup();
    const before = d.calls.sent.length;
    for (const [name, fields] of [
      ["tier", { tier: "paid", reason: REASON, token: "renox_pat_" + "a".repeat(32) }],
      ["tier", { tier: "paid", reason: "short", token: OPERATOR_TOKEN }],
      ["tier", { tier: "gold", reason: REASON, token: OPERATOR_TOKEN }],
      ["node", { node_id: "Bad Node", reason: REASON, token: OPERATOR_TOKEN }],
    ] as const) {
      expect(data(await actions[name](actionCtx(d, "/ops/tenants/t_hello", name, fields, { params: T }))).form_error).not.toBeNull();
    }
    expect(d.calls.sent.length).toBe(before);
    const forged = data(await actions.tier(actionCtx(d, "/ops/tenants/t_hello", "tier", { tier: "paid", reason: REASON, token: "renox_op_" + "b".repeat(32) }, { params: T })));
    expect(forged.action_problem).toMatchObject({ status: 401, signed_out: false });
    expect(await currentToken(statementsOf(d), d.secrets, d.sessionId, Date.now())).not.toBeNull();
  });

  test("status panel (#296): getOpsTenant with the operator token, shown and not kept; refused input never reaches the API", async () => {
    const d = await setup();
    const before = d.calls.sent.length;
    const bad = data(await actions.status(actionCtx(d, "/ops/tenants/t_hello", "status", { token: "renox_pat_" + "a".repeat(32) }, { params: T })));
    expect(bad.form_error).not.toBeNull();
    expect(d.calls.sent.length).toBe(before);

    expect(data(await actions.tier(actionCtx(d, "/ops/tenants/t_hello", "tier", { tier: "paid", reason: REASON, token: OPERATOR_TOKEN }, { params: T }))).state).not.toBeNull();
    const r = data(await actions.status(actionCtx(d, "/ops/tenants/t_hello", "status", { token: OPERATOR_TOKEN }, { params: T })));
    expect(r.action_problem).toBeNull();
    expect(r.status).toMatchObject({ tier: "paid", process: "own", state: "active", node: "node-1", pinned: "—", moving: "no", microvm: "—", replication: [] });
    expect(r.status.actions).toHaveLength(1);
    expect(r.status.actions[0]).toMatchObject({ action: "setTenantTier", result: "changed", reason: REASON, operator: "operator" });
    const reads = d.calls.sent.filter((c) => c.method === "GET" && c.url.includes("/v1/ops/"));
    expect(reads.map((c) => [new URL(c.url).pathname, c.authorization])).toEqual([["/v1/ops/tenants/t_hello", `Bearer ${OPERATOR_TOKEN}`]]);
    expect(JSON.stringify(r)).not.toContain(OPERATOR_TOKEN);
    // The API's refusal of a token it does not know.
    const forged = data(await actions.status(actionCtx(d, "/ops/tenants/t_hello", "status", { token: "renox_op_" + "c".repeat(32) }, { params: T })));
    expect(forged.action_problem).toMatchObject({ status: 401, signed_out: false });
  });

  test.skipIf(!worker)(
    "rendered by the worker: the status panel and the three actions with a reason and a token field each",
    async () => {
      const d = await setup();
      const page = data(await load(loaderCtx(d, "/ops/tenants/t_hello", { params: T })));
      expect(data(await actions.tier(actionCtx(d, "/ops/tenants/t_hello", "tier", { tier: "paid", reason: REASON, token: OPERATOR_TOKEN }, { params: T }))).state).not.toBeNull();
      const status = data(await actions.status(actionCtx(d, "/ops/tenants/t_hello", "status", { token: OPERATOR_TOKEN }, { params: T }))).status;
      // The status panel with a replication row as a node reports it (#296).
      status.replication = [{ database: "t_hello", state: "replicating", replica: "s3 (me-central-1)", lag: "0.4 s", last_sync: "3s ago", reported: "5s ago", stale: true }];
      const dev = await devWithData({ "pages/ops/tenants/[tenant].ts": { ...page, status } });
      try {
        const res = await fetch(`${dev.base}/ops/tenants/t_hello`);
        expect(res.status).toBe(200);
        const html = (await res.text()).replaceAll(' dir="auto"', "");
        for (const b of ["Show status", "Change tier", "Move to node", "Move to microVM"]) expect(html).toContain(`<button type="submit">${b}</button>`);
        expect(html.match(/name="token"/gu)?.length).toBe(4);
        expect(html.match(/name="reason"/gu)?.length).toBe(3);
        expect(html).toContain("<td>paid (process own)</td>");
        expect(html).toContain("<td><code>t_hello</code></td><td>replicating</td><td>s3 (me-central-1)</td><td>0.4 s</td>");
        expect(html).toContain("(stale)");
        expect(html).toContain("<td>setTenantTier</td><td>changed</td>");
        expect(html).not.toContain("No operator action on this tenant yet.");
        expect(html).not.toContain(OPERATOR_TOKEN);
      } finally {
        await dev.stop();
      }
    },
    120_000,
  );
});
