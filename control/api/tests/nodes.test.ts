// Node-facing endpoints of #199: fetchArtifact and prepareResult
// (docs/contracts/deploy-api.md sections 6-7). The request and response
// examples of docs/contracts/schemas/deploy-api.yaml are the fixtures.

import { afterEach, describe, expect, test } from "bun:test";
import { contentHash, extractTar } from "@renox/artifact-validate";
import spec from "../../../docs/contracts/schemas/deploy-api.yaml";
import { checkMessage } from "../src/contract.ts";
import { prepareBroker, type PrepareMessage } from "../src/nodes/prepare_results.ts";
import { ownerOf } from "../src/workers/assign.ts";
import { helloArtifact, upload } from "./artifacts.ts";
import { assertScoped, auditRows, createApp_, harness, registeredNode, sseReader, tenant, type Harness } from "./helpers.ts";

afterEach(assertScoped);

type Example = { value: unknown; "x-expect"?: string };
type Op = {
  requestBody?: { content: Record<string, { examples?: Record<string, Example>; "x-renox-invalid-examples"?: Record<string, Example> }> };
  responses: Record<string, { content?: Record<string, { examples?: Record<string, Example> }>; headers?: Record<string, { example?: string }> }>;
};
const paths = (spec as { paths: Record<string, Record<string, Op>> }).paths;
const prepareOp = paths["/v1/nodes/{node_id}/prepare-results"]?.post as Op;
const artifactOp = paths["/v1/nodes/{node_id}/artifacts/{hash}"]?.get as Op;
const examples = (op: Op) => op.requestBody?.content["application/json"]?.examples ?? {};
const invalidExamples = (op: Op) => op.requestBody?.content["application/json"]?.["x-renox-invalid-examples"] ?? {};

/** The contract examples use node-dxb-01 and t_hello with the examples/hello artifact. */
const NODE = "node-dxb-01";

async function setup(nodes: string[] = [NODE]): Promise<{ h: Harness; token: string; hash: string; nodes: Record<string, string> }> {
  const h = await harness();
  const token = await tenant(h, "t_hello");
  await createApp_(h, token, "hello");
  const files = helloArtifact();
  expect((await upload(h, token, "hello", files)).status).toBe(201);
  const tokens: Record<string, string> = {};
  for (const n of nodes) tokens[n] = await registeredNode(h, n);
  return { h, token, hash: contentHash(files), nodes: tokens };
}

/** Moves the deployment to `state` directly (activation itself is #96's subject). */
const setState = (h: Harness, hash: string, state: string) => h.db.query("update deployments set state = $1 where hash = $2", [state, hash]);

const prepare = (id: string, hash: string): PrepareMessage => ({
  type: "prepare",
  schema_version: 0,
  activation_id: id,
  tenant_id: "t_hello",
  app: "hello",
  deployment_hash: hash,
  tier: "free",
  secrets_version: 0,
  probe: { path: "/", timeout_ms: 10_000 },
  deadline_ms: 60_000,
});

describe("GET /v1/nodes/{node_id}/artifacts/{hash}", () => {
  test("200 with the stored tar and its hash as ETag for the owning node; If-None-Match → 304", async () => {
    const { h, hash, nodes } = await setup();
    await setState(h, hash, "activating");
    const res = await h.request("GET", `/v1/nodes/${NODE}/artifacts/${hash}`, { token: nodes[NODE] });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-tar");
    expect(res.headers.get("etag")).toBe(`"${hash}"`);
    const tree = await extractTar(new Uint8Array(await res.arrayBuffer()), { gzip: false });
    expect(contentHash(tree)).toBe(hash);
    const again = await h.request("GET", `/v1/nodes/${NODE}/artifacts/${hash}`, { token: nodes[NODE], headers: { "if-none-match": `"${hash}"` } });
    expect(again.status).toBe(304);
  });

  test("307 to a presigned URL when the store can presign (the contract's 307 example)", async () => {
    const { h, hash, nodes } = await setup();
    await setState(h, hash, "active");
    const presigned = artifactOp.responses["307"]?.headers?.Location?.example as string;
    const store = h.store as { presign: (key: string, seconds: number) => string | null };
    const asked: [string, number][] = [];
    store.presign = (key, seconds) => {
      asked.push([key, seconds]);
      return presigned;
    };
    const res = await h.request("GET", `/v1/nodes/${NODE}/artifacts/${hash}`, { token: nodes[NODE] });
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(presigned);
    expect(asked).toEqual([[`artifacts/${hash}.tar`, 300]]);
  });

  /** docs/24-threat-model.md E, "Tenant-scoping bug in the control-plane API (IDOR)", for node tokens: a node reads only the artifacts of tenants it serves. */
  test("a node that is not assigned the tenant gets 403; a hash no fetchable deployment has → 404", async () => {
    const other = ownerOf("t_hello", ["node-a", "node-b"]) === "node-a" ? "node-b" : "node-a";
    const owner = other === "node-a" ? "node-b" : "node-a";
    const { h, hash, nodes } = await setup([owner, other]);
    await setState(h, hash, "active");
    expect((await h.request("GET", `/v1/nodes/${other}/artifacts/${hash}`, { token: nodes[other] })).status).toBe(403);
    expect((await h.request("GET", `/v1/nodes/${owner}/artifacts/${hash}`, { token: nodes[owner] })).status).toBe(200);
    // Another node's path with this node's token.
    expect((await h.request("GET", `/v1/nodes/${owner}/artifacts/${hash}`, { token: nodes[other] })).status).toBe(403);
    // validated (never activated): no node needs it yet.
    await setState(h, hash, "validated");
    expect((await h.request("GET", `/v1/nodes/${owner}/artifacts/${hash}`, { token: nodes[owner] })).status).toBe(404);
    expect((await h.request("GET", `/v1/nodes/${owner}/artifacts/${"0".repeat(64)}`, { token: nodes[owner] })).status).toBe(404);
    expect((await h.request("GET", `/v1/nodes/${owner}/artifacts/${hash}`, { token: "renox_pat_" + "a".repeat(32) })).status).toBe(401);
  });

  test("a route entry naming the node makes the artifact fetchable (draining after a reassignment)", async () => {
    const { h, hash, nodes } = await setup([NODE, "node-z"]);
    await setState(h, hash, "superseded");
    const nonOwner = ownerOf("t_hello", [NODE, "node-z"]) === NODE ? "node-z" : NODE;
    await h.db.query(
      `insert into route_entries (hostname, deployment_hash, tenant_id, app, status, updated_at, version, tier, node_id, secrets_version)
       values ('hello.renox.app', $1, 't_hello', 'hello', 'draining', 0, 1, 'free', $2, 0)`,
      [hash, nonOwner],
    );
    expect((await h.request("GET", `/v1/nodes/${nonOwner}/artifacts/${hash}`, { token: nodes[nonOwner] })).status).toBe(200);
  });
});

describe("POST /v1/nodes/{node_id}/prepare-results", () => {
  test("every request example: the waiting activation receives the node's answer; 204", async () => {
    const { h, hash, nodes } = await setup();
    const broker = prepareBroker(h.deps);
    const stream = sseReader(await h.request("GET", `/v1/nodes/${NODE}/stream`, { token: nodes[NODE] }));
    await stream.next(); // resync
    for (const [name, ex] of Object.entries(examples(prepareOp))) {
      const body = ex.value as { activation_id: string; ok: boolean };
      const waiting = broker.request(NODE, prepare(body.activation_id, hash));
      const sent = await stream.next();
      expect(checkMessage<PrepareMessage>("prepare", sent.data).activation_id).toBe(body.activation_id);
      const res = await h.request("POST", `/v1/nodes/${NODE}/prepare-results`, { token: nodes[NODE], json: body });
      expect(res.status, name).toBe(204);
      expect(await waiting).toEqual(body.ok ? { ok: true, migrationsApplied: [] } : expect.objectContaining({ ok: false }));
    }
    await stream.close();
    expect((await auditRows(h)).filter((r) => r.action === "prepareResult").map((r) => r.status)).toEqual([204]);
  });

  test("a failure carries the activation error (migrate: module, file, SQLite message)", async () => {
    const { h, hash, nodes } = await setup();
    const stream = sseReader(await h.request("GET", `/v1/nodes/${NODE}/stream`, { token: nodes[NODE] }));
    await stream.next();
    const waiting = prepareBroker(h.deps).request(NODE, prepare("act_01JBQ40000000000AC", hash));
    await stream.next();
    const error = { stage: "migrate", reason: "migration failed", module: "app", file: "app/002_add_price.sql", sqlite_error: "near \"COLUM\": syntax error" };
    const res = await h.request("POST", `/v1/nodes/${NODE}/prepare-results`, {
      token: nodes[NODE],
      json: { type: "prepare_result", schema_version: 0, activation_id: "act_01JBQ40000000000AC", node_id: NODE, ok: false, error },
    });
    expect(res.status).toBe(204);
    expect(await waiting).toEqual({ ok: false, error });
    await stream.close();
  });

  test("every invalid request example → 400 RENOX_VALIDATION", async () => {
    const { h, nodes } = await setup();
    for (const [name, ex] of Object.entries(invalidExamples(prepareOp))) {
      const res = await h.request("POST", `/v1/nodes/${NODE}/prepare-results`, { token: nodes[NODE], json: ex.value });
      expect(res.status, name).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("RENOX_VALIDATION");
    }
  });

  /** docs/24-threat-model.md E, "Tenant-scoping bug in the control-plane API (IDOR)", for node tokens: a node cannot answer for another node. */
  test("a node cannot post results for another node: body or path naming another node → 403, and the activation keeps waiting", async () => {
    const { h, hash, nodes } = await setup([NODE, "node-other"]);
    const broker = prepareBroker(h.deps);
    const stream = sseReader(await h.request("GET", `/v1/nodes/${NODE}/stream`, { token: nodes[NODE] }));
    await stream.next();
    const id = "act_01JBQ40000000000AD";
    const waiting = broker.request(NODE, prepare(id, hash));
    await stream.next();
    const body = { type: "prepare_result", schema_version: 0, activation_id: id, ok: true, migrations_applied: [] };
    // Path and token of node-other, body naming NODE.
    expect((await h.request("POST", "/v1/nodes/node-other/prepare-results", { token: nodes["node-other"], json: { ...body, node_id: NODE } })).status).toBe(403);
    // node-other's token on NODE's path.
    expect((await h.request("POST", `/v1/nodes/${NODE}/prepare-results`, { token: nodes["node-other"], json: { ...body, node_id: NODE } })).status).toBe(403);
    // node-other answering, in its own name, an activation sent to NODE.
    expect((await h.request("POST", "/v1/nodes/node-other/prepare-results", { token: nodes["node-other"], json: { ...body, node_id: "node-other" } })).status).toBe(403);
    expect(broker.waiting(id, NODE)).toBe("yes");
    expect((await h.request("POST", `/v1/nodes/${NODE}/prepare-results`, { token: nodes[NODE], json: { ...body, node_id: NODE } })).status).toBe(204);
    expect((await waiting).ok).toBe(true);
    await stream.close();
  });

  test("a late or repeated result → 409; an unknown activation → 404", async () => {
    const { h, hash, nodes } = await setup();
    const broker = prepareBroker(h.deps);
    const id = "act_01JBQ40000000000AE";
    // Not connected: the activation fails at once with stage timeout.
    expect(await broker.request(NODE, prepare(id, hash))).toEqual({ ok: false, error: { stage: "timeout", reason: "the node has no open stream" } });
    const body = { type: "prepare_result", schema_version: 0, activation_id: id, node_id: NODE, ok: true };
    const late = await h.request("POST", `/v1/nodes/${NODE}/prepare-results`, { token: nodes[NODE], json: body });
    expect(late.status).toBe(409);
    expect(((await late.json()) as { error: { code: string } }).error.code).toBe("RENOX_CONFLICT");
    const unknown = await h.request("POST", `/v1/nodes/${NODE}/prepare-results`, { token: nodes[NODE], json: { ...body, activation_id: "act_01JBQ4ZZZZZZZZZZZZZZ" } });
    expect(unknown.status).toBe(404);
  });

  test("no answer within deadline_ms → stage timeout", async () => {
    const { h, hash, nodes } = await setup();
    const stream = sseReader(await h.request("GET", `/v1/nodes/${NODE}/stream`, { token: nodes[NODE] }));
    await stream.next();
    const result = await prepareBroker(h.deps).request(NODE, { ...prepare("act_01JBQ40000000000AF", hash), deadline_ms: 20 });
    expect(result).toEqual({ ok: false, error: { stage: "timeout", reason: "no answer within 20 ms" } });
    await stream.close();
  });
});
