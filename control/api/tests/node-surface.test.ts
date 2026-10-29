// The node-facing surface off the public edge (ADR D23 follow-up, #218;
// docs/24-threat-model.md B, "Tenant code reaches the control plane's
// node-facing endpoints"): main.ts serves the public surface and the node
// surface on two listeners. A node path on the public surface is 404 before
// any handler or auth middleware runs; the node surface serves it with a node
// token and nothing else.

import { afterEach, describe, expect, test } from "bun:test";
import type { Hono } from "hono";
import { createApp, isNodePath, type RouteModule, type Surface } from "../src/app.ts";
import type { Env } from "../src/context.ts";
import { assertScoped, harness, type Harness, nodeToken, tenant } from "./helpers.ts";

afterEach(assertScoped);

const REGISTER = { type: "node_register", schema_version: 0, node_id: "node-surface-1", worker_version: "0.1.0", region: "me-central-1", max_cells: 100 };

/** Handlers that record that they ran, on a node path of each prefix and on a public path. */
function spy(): { ran: string[]; module: RouteModule } {
  const ran: string[] = [];
  const module: RouteModule = (app) => {
    for (const path of ["/v1/nodes/spy", "/v1/ingest/spy", "/v1/spy"]) {
      app.get(path, (c) => {
        ran.push(path);
        return c.json({ ok: true });
      });
    }
  };
  return { ran, module };
}

function send(app: Hono<Env>, method: string, path: string, token?: string, json?: unknown): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  if (json !== undefined) headers["content-type"] = "application/json";
  const body = json === undefined ? undefined : JSON.stringify(json);
  return Promise.resolve(app.request(path, { method, headers, body }, { requestIP: () => ({ address: "192.0.2.10" }) }));
}

async function surfaces(): Promise<{ h: Harness; ran: string[]; app: Record<Surface, Hono<Env>> }> {
  const { ran, module } = spy();
  const h = await harness();
  const app = {
    public: createApp(h.deps, [module], "public"),
    node: createApp(h.deps, [module], "node"),
    combined: createApp(h.deps, [module], "combined"),
  };
  return { h, ran, app };
}

async function expectNotFound(res: Response): Promise<void> {
  expect(res.status).toBe(404);
  expect(((await res.json()) as { error: { code: string } }).error.code).toBe("RENOX_NOT_FOUND");
}

describe("node-facing paths on the public surface", () => {
  test("/v1/nodes/… and /v1/ingest/… are 404 with no handler run; the node surface runs them", async () => {
    const { ran, app } = await surfaces();
    for (const path of ["/v1/nodes/spy", "/v1/ingest/spy"]) await expectNotFound(await send(app.public, "GET", path));
    expect(ran).toEqual([]);
    for (const path of ["/v1/nodes/spy", "/v1/ingest/spy"]) expect((await send(app.node, "GET", path)).status).toBe(200);
    expect(ran).toEqual(["/v1/nodes/spy", "/v1/ingest/spy"]);
  });

  test("every registered node route is 404 on the public surface, even with a valid node token", async () => {
    const { h, app } = await surfaces();
    const token = await nodeToken(h, "node-surface-1");
    const nodeRoutes = app.combined.routes.filter((r) => r.method !== "ALL" && isNodePath(r.path) && !r.path.endsWith("/spy"));
    // registerWorkers, registerNodeArtifacts, registerPrepareResults, registerIngest, registerLogIngest, certificates, secret bundles.
    expect(nodeRoutes.length).toBeGreaterThanOrEqual(9);
    for (const r of nodeRoutes) {
      const path = r.path.replace(/:[a-z_]+/gu, "x");
      await expectNotFound(await send(app.public, r.method, path, token, r.method === "GET" ? undefined : {}));
    }
    // No handler wrote anything: no node row, no audit row.
    expect(await h.db.query("select node_id from workers")).toEqual([]);
    expect(await h.db.query("select id from audit")).toEqual([]);
  });

  test("other spellings of a node path are 404 on the public surface too", async () => {
    const { h, ran, app } = await surfaces();
    const token = await nodeToken(h, "node-surface-1");
    for (const path of ["/V1/NODES/register", "//v1/nodes/register", "/v1//nodes/register", "/v1/nodes/%72egister", "/v1/nodes", "/v1/ingest"]) {
      await expectNotFound(await send(app.public, "POST", path, token, REGISTER));
    }
    for (const path of ["/v1/Ingest/spy", "/v1/nodes/spy?x=1", "/v1/nodes/%73py"]) await expectNotFound(await send(app.public, "GET", path, token));
    expect(ran).toEqual([]);
    expect(await h.db.query("select node_id from workers")).toEqual([]);
  });

  test("POST /v1/nodes/register works on the node surface with a node token, and not without one", async () => {
    const { h, app } = await surfaces();
    const token = await nodeToken(h, "node-surface-1");
    await expectNotFound(await send(app.public, "POST", "/v1/nodes/register", token, REGISTER));
    expect((await send(app.node, "POST", "/v1/nodes/register", undefined, REGISTER)).status).toBe(401);
    const tenantToken = await tenant(h, "t_surface");
    expect((await send(app.node, "POST", "/v1/nodes/register", tenantToken, REGISTER)).status).toBe(401);
    const res = await send(app.node, "POST", "/v1/nodes/register", token, REGISTER);
    expect(res.status).toBe(200);
    expect(await h.db.query("select node_id from workers")).toEqual([{ node_id: "node-surface-1" }]);
  });

  test("POST /v1/ingest/meters is 404 on the public surface and reaches the handler on the node surface", async () => {
    const { h, app } = await surfaces();
    const token = await nodeToken(h, "node-surface-1");
    await expectNotFound(await send(app.public, "POST", "/v1/ingest/meters", token, { type: "meter_batch" }));
    // The handler runs and validates the body (400), instead of the surface answering 404.
    expect((await send(app.node, "POST", "/v1/ingest/meters", token, { type: "meter_batch" })).status).toBe(400);
  });
});

describe("the node surface serves nothing else", () => {
  test("tenant, account and operator paths are 404 on the node surface; /v1/healthz answers on both", async () => {
    const { h, ran, app } = await surfaces();
    const token = await tenant(h, "t_surface");
    await expectNotFound(await send(app.node, "GET", "/v1/spy"));
    await expectNotFound(await send(app.node, "POST", "/v1/apps", token, { name: "hello" }));
    await expectNotFound(await send(app.node, "POST", "/v1/account/login", undefined, { email: "a@example.com", password: "x" }));
    await expectNotFound(await send(app.node, "POST", "/mcp", token, {}));
    expect(ran).toEqual([]);
    expect(await h.db.query("select name from apps")).toEqual([]);
    expect((await send(app.public, "GET", "/v1/spy")).status).toBe(200);
    expect((await send(app.public, "POST", "/v1/apps", token, { name: "hello" })).status).toBe(201);
    for (const surface of ["public", "node"] as const) expect((await send(app[surface], "GET", "/v1/healthz")).status).toBe(200);
  });
});

describe("main.ts", () => {
  test("serves the two surfaces on two listeners", async () => {
    const free = () => {
      const s = Bun.serve({ port: 0, fetch: () => new Response() });
      const port = s.port as number;
      s.stop(true);
      return port;
    };
    const [port, nodePort] = [free(), free()];
    const proc = Bun.spawn(["bun", `${import.meta.dir}/../src/main.ts`], {
      env: { ...process.env, CONTROL_DATABASE_URL: "pglite:memory", CONTROL_LISTEN_PORT: String(port), CONTROL_NODE_LISTEN_HOST: "127.0.0.1", CONTROL_NODE_LISTEN_PORT: String(nodePort) },
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      const deadline = Date.now() + 30_000;
      for (;;) {
        const up = await fetch(`http://127.0.0.1:${nodePort}/v1/healthz`).then((r) => r.ok, () => false);
        if (up) break;
        if (Date.now() > deadline) throw new Error("main.ts did not start");
        await Bun.sleep(100);
      }
      const register = (p: number) => fetch(`http://127.0.0.1:${p}/v1/nodes/register`, { method: "POST", headers: { authorization: "Bearer renox_node_x", "content-type": "application/json" }, body: JSON.stringify(REGISTER) });
      // Public listener: not routed at all. Node listener: the node-token check answers.
      expect((await register(port)).status).toBe(404);
      expect((await register(nodePort)).status).toBe(401);
      expect((await fetch(`http://127.0.0.1:${nodePort}/v1/apps`)).status).toBe(404);
      expect((await fetch(`http://127.0.0.1:${port}/v1/apps`)).status).toBe(401);
    } finally {
      proc.kill();
      await proc.exited;
    }
  }, 40_000);
});
