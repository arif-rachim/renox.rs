// Activation failure semantics (#96; docs/contracts/deploy-api.md section 6;
// docs/23-failure-modes.md section 3, "Migration fails half-way", "New
// deployment fails its first request", "Rollback to a hash whose migrations
// are older"): the control plane sends `prepare` to the owning node and moves
// the pointer only on its success. The node is played by the test through
// its stream and POST /v1/nodes/{node_id}/prepare-results.

import { afterEach, describe, expect, test } from "bun:test";
import { contentHash } from "@renox/artifact-validate";
import { checkMessage } from "../src/contract.ts";
import { probePath } from "../src/deployments/activate.ts";
import type { PrepareMessage } from "../src/nodes/prepare_results.ts";
import type { RouteSnapshot } from "../src/routes/table.ts";
import { helloArtifact, upload } from "./artifacts.ts";
import { assertScoped, auditRows, createApp_, harness, registeredNode, sseReader, tenant, type Harness } from "./helpers.ts";

afterEach(assertScoped);

const enc = new TextEncoder();
const variant = (n: number) => helloArtifact((_m, f) => f.set("code/n.json", enc.encode(String(n))));

async function setup(withStream = true): Promise<{ h: Harness; token: string; node: string; a: string; b: string; stream: ReturnType<typeof sseReader> }> {
  const h = await harness([], { prepare: "node" });
  const token = await tenant(h, "t_hello");
  await createApp_(h, token, "hello");
  const node = await registeredNode(h, "node-1");
  const a = contentHash(variant(1));
  const b = contentHash(variant(2));
  expect((await upload(h, token, "hello", variant(1))).status).toBe(201);
  expect((await upload(h, token, "hello", variant(2))).status).toBe(201);
  if (!withStream) return { h, token, node, a, b, stream: undefined as unknown as ReturnType<typeof sseReader> };
  const stream = sseReader(await h.request("GET", "/v1/nodes/node-1/stream", { token: node }));
  await stream.next(); // resync
  return { h, token, node, a, b, stream };
}

/** Starts an activation, reads the `prepare` the node receives, answers it, and returns the activation's response. */
async function activateAnswering(
  s: { h: Harness; token: string; node: string; stream: ReturnType<typeof sseReader> },
  hash: string,
  answer: (p: PrepareMessage) => Record<string, unknown>,
): Promise<{ res: Response; prepare: PrepareMessage }> {
  const pending = s.h.request("POST", "/v1/apps/hello/activate", { token: s.token, json: { hash } });
  let prepare: PrepareMessage | undefined;
  for (;;) {
    const ev = await s.stream.next(5000);
    if ((ev.data as { type: string }).type === "prepare") {
      prepare = checkMessage<PrepareMessage>("prepare", ev.data);
      break;
    }
  }
  const body = { type: "prepare_result", schema_version: 0, activation_id: prepare.activation_id, node_id: "node-1", ...answer(prepare) };
  const posted = await s.h.request("POST", "/v1/nodes/node-1/prepare-results", { token: s.node, json: body });
  expect(posted.status).toBe(204);
  return { res: await pending, prepare };
}

const stateOf = async (h: Harness, token: string, hash: string) =>
  (await (await h.request("GET", `/v1/apps/hello/deployments/${hash}`, { token })).json()) as { state: string; last_error: Record<string, unknown> | null };
const activeHash = async (h: Harness, node: string) =>
  ((await (await h.request("GET", "/v1/nodes/node-1/routes", { token: node })).json()) as RouteSnapshot).entries.find((e) => e.status === "active")?.deployment_hash;

describe("probe path (deploy-api.md section 6, Probe)", () => {
  test("/ when a GET route matches it; else the first parameterless GET route; else null", () => {
    const m = (routes: unknown[]) => ({ routes });
    expect(probePath(m([{ kind: "function", method: "POST", path: "/" }, { kind: "page", path: "/" }]))).toBe("/");
    expect(probePath(m([{ kind: "function", method: "GET", path: "/api/:id" }, { kind: "function", method: "GET", path: "/api/hello" }]))).toBe("/api/hello");
    expect(probePath(m([{ kind: "function", method: "GET", path: "/files/*rest" }, { kind: "function", method: "POST", path: "/x" }]))).toBeNull();
    expect(probePath(null)).toBeNull();
  });
});

describe("activation through the node's prepare", () => {
  test("success: the node receives prepare (probe, secrets version, deadline) and the pointer switches", async () => {
    const s = await setup();
    const { res, prepare } = await activateAnswering(s, s.a, () => ({ ok: true, migrations_applied: [] }));
    expect(res.status).toBe(200);
    expect(prepare).toMatchObject({ tenant_id: "t_hello", app: "hello", deployment_hash: s.a, tier: "free", secrets_version: 0, probe: { path: "/api/hello", timeout_ms: 10_000 }, deadline_ms: 60_000 });
    expect(await activeHash(s.h, s.node)).toBe(s.a);
    await s.stream.close();
  });

  /** docs/23-failure-modes.md section 3, "Migration fails half-way". */
  test("a failing migration file: 422, state validated with last_error { module, file, sqlite_error }, old hash still active", async () => {
    const s = await setup();
    expect((await activateAnswering(s, s.a, () => ({ ok: true }))).res.status).toBe(200);
    const error = { stage: "migrate", reason: "migration app/002_price.sql failed", module: "app", file: "app/002_price.sql", sqlite_error: "near \"COLUM\": syntax error" };
    const { res } = await activateAnswering(s, s.b, () => ({ ok: false, migrations_applied: ["app/001_items.sql"], error }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string; deployment: string; details: unknown[] } };
    expect(body.error.code).toBe("RENOX_ACTIVATION_FAILED");
    expect(body.error.deployment).toBe(s.b);
    expect(body.error.details).toEqual([error]);
    const d = await stateOf(s.h, s.token, s.b);
    expect(d.state).toBe("validated");
    expect(d.last_error).toEqual(error);
    expect((await stateOf(s.h, s.token, s.a)).state).toBe("active");
    expect(await activeHash(s.h, s.node)).toBe(s.a);
    await s.stream.close();
  });

  /** docs/23-failure-modes.md section 3, "New deployment fails its first request". */
  test("the probe answers 500: activation fails, the old deployment stays active, the failure is audited", async () => {
    const s = await setup();
    expect((await activateAnswering(s, s.a, () => ({ ok: true }))).res.status).toBe(200);
    const { res } = await activateAnswering(s, s.b, () => ({ ok: false, error: { stage: "probe", reason: "the probe answered 500", http_status: 500 } }));
    expect(res.status).toBe(422);
    expect((await stateOf(s.h, s.token, s.b)).last_error).toMatchObject({ stage: "probe", http_status: 500 });
    expect(await activeHash(s.h, s.node)).toBe(s.a);
    const audit = await auditRows(s.h);
    expect(audit.filter((r) => r.action === "deploymentState").map((r) => (r.target as { from: string; to: string; hash: string }))).toContainEqual(
      expect.objectContaining({ hash: s.b, from: "activating", to: "validated" }),
    );
    expect(audit.filter((r) => r.action === "activateDeployment").map((r) => r.status)).toEqual([200, 422]);
    // A fixed re-upload is not needed to try again: the deployment is validated, not rejected.
    expect((await activateAnswering(s, s.b, () => ({ ok: true }))).res.status).toBe(200);
    expect(await activeHash(s.h, s.node)).toBe(s.b);
    await s.stream.close();
  });

  test("no answer from the node (no stream): stage timeout, nothing switches", async () => {
    const s = await setup(false);
    const res = await s.h.request("POST", "/v1/apps/hello/activate", { token: s.token, json: { hash: s.a } });
    expect(res.status).toBe(422);
    expect((await stateOf(s.h, s.token, s.a)).last_error).toMatchObject({ stage: "timeout" });
    expect(await activeHash(s.h, s.node)).toBeUndefined();
  });

  /** docs/23-failure-modes.md section 3, "Rollback to a hash whose migrations are older": a pointer switch, no prepare. */
  test("rollback after a newer deployment is a pointer switch without prepare", async () => {
    const s = await setup();
    expect((await activateAnswering(s, s.a, () => ({ ok: true }))).res.status).toBe(200);
    expect((await activateAnswering(s, s.b, () => ({ ok: true, migrations_applied: ["app/002_add_price.sql"] }))).res.status).toBe(200);
    const res = await s.h.request("POST", "/v1/apps/hello/rollback", { token: s.token, json: {} });
    expect(res.status).toBe(200);
    expect(await activeHash(s.h, s.node)).toBe(s.a);
    // The next event on the stream is the route delta, not a prepare.
    expect(((await s.stream.next()).data as { type: string }).type).toBe("route_delta");
    await s.stream.close();
  });
});
