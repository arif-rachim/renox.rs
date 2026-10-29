// Node endpoints (deploy-api.md sections 7-8): register, heartbeat, the
// control-message stream (SSE), and the route snapshot.

import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { nodeAuth, nodeId } from "../auth/middleware.ts";
import { operation } from "../audit.ts";
import { checkMessage } from "../contract.ts";
import { readBody, JSON_LIMIT } from "../http.ts";
import type { Deps, Env } from "../context.ts";
import { routeService } from "../routes/service.ts";
import { currentVersion, lockRoutes, snapshot } from "../routes/table.ts";
import { reassign } from "./health.ts";
import { dropMovedTenants, sealCallbackToken } from "./failover.ts";
import { base32 } from "../ids.ts";
import { randomBytes } from "node:crypto";
import { findWorker, HEARTBEAT_INTERVAL_MS, RESYNC_INTERVAL_MS, UNHEALTHY_AFTER_MS } from "./repo.ts";
import { ApiError, conflict, invalid } from "../errors.ts";
import type { Context } from "hono";

/** Keep-alive comment interval on the stream (deploy-api.md section 7). */
export const KEEPALIVE_MS = 15_000;

async function message<T>(c: Context<Env>, def: string): Promise<T> {
  if (!/^application\/json(;|$)/u.test(c.req.header("content-type") ?? "")) throw invalid("content-type", "must be application/json");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readBody(c, JSON_LIMIT)));
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw invalid("body", "not valid UTF-8 JSON");
  }
  return checkMessage<T>(def, value);
}

export function registerWorkers(app: Hono<Env>, deps: Deps): void {
  const { db } = deps;
  const service = routeService(deps);

  app.post("/v1/nodes/register", operation(deps, "registerNode"), nodeAuth(deps), async (c) => {
    const node = nodeId(c);
    const body = await message<{ node_id: string; worker_version: string; region: string; max_cells: number; listen_url?: string }>(c, "node_register");
    if (body.node_id !== node) throw new ApiError("RENOX_TOKEN_SCOPE");
    const now = deps.now();
    // 0.3 (section 15): a node with a listener gets a fresh callback token,
    // stored wrapped under the master key, returned once.
    const callback = body.listen_url === undefined ? null : `renox_cb_${base32(randomBytes(20))}`;
    const sealed = callback === null ? null : await sealCallbackToken(deps, node, callback);
    if (callback !== null && sealed === null) deps.log.warn("node listener announced but CONTROL_MASTER_KEY is unset: no callback token issued", { node_id: node });
    const moved = await db.transaction(async (tx) => {
      await lockRoutes(tx);
      const before = await findWorker(tx, node);
      await tx.query(
        `insert into workers (node_id, worker_version, region, max_cells, registered_at, last_heartbeat_at, healthy)
         values ($1, $2, $3, $4, $5, $5, true)
         on conflict (node_id) do update set worker_version = excluded.worker_version, region = excluded.region,
           max_cells = excluded.max_cells, registered_at = excluded.registered_at, last_heartbeat_at = excluded.last_heartbeat_at, healthy = true`,
        [node, body.worker_version, body.region, body.max_cells, now],
      );
      await tx.query("update workers set listen_url = $1, callback_token_wrapped = $2, callback_token_nonce = $3 where node_id = $4", [
        sealed === null ? null : (body.listen_url as string),
        sealed?.wrapped ?? null,
        sealed?.nonce ?? null,
        node,
      ]);
      return before?.healthy === true ? 0 : reassign(tx, now);
    });
    if (moved > 0) await service.publisher.publish();
    // FO4: tenants moved off this node while it was gone are dropped there.
    void dropMovedTenants(deps, node).catch((e: unknown) => deps.log.warn("drop of moved tenants failed", { node_id: node, error: String(e) }));
    return c.json({
      type: "node_registered",
      schema_version: 0,
      node_id: node,
      heartbeat_interval_ms: HEARTBEAT_INTERVAL_MS,
      unhealthy_after_ms: UNHEALTHY_AFTER_MS,
      resync_interval_ms: RESYNC_INTERVAL_MS,
      route_version: await currentVersion(db),
      ...(callback !== null && sealed !== null ? { callback_token: callback } : {}),
    });
  });

  app.post("/v1/nodes/:node_id/heartbeat", operation(deps, "heartbeat"), nodeAuth(deps), async (c) => {
    const node = nodeId(c);
    const body = await message<{ node_id: string; route_version: number; cells: number }>(c, "heartbeat");
    if (body.node_id !== node) throw new ApiError("RENOX_TOKEN_SCOPE");
    const now = deps.now();
    const moved = await db.transaction(async (tx) => {
      await lockRoutes(tx);
      const before = await findWorker(tx, node);
      if (before === null) throw conflict("node_id", "the node is not registered");
      await tx.query("update workers set last_heartbeat_at = $1, route_version = $2, cells = $3, healthy = true where node_id = $4", [
        now,
        body.route_version,
        body.cells,
        node,
      ]);
      return before.healthy ? 0 : reassign(tx, now);
    });
    if (moved > 0) await service.publisher.publish();
    void dropMovedTenants(deps, node).catch((e: unknown) => deps.log.warn("drop of moved tenants failed", { node_id: node, error: String(e) }));
    return c.json({ type: "heartbeat_ack", schema_version: 0, route_version: await currentVersion(db) });
  });

  app.get("/v1/nodes/:node_id/stream", operation(deps, "nodeStream"), nodeAuth(deps), (c) => {
    const node = nodeId(c);
    return streamSSE(c, async (stream) => {
      const send = (m: unknown): void => void stream.writeSSE({ event: "message", data: JSON.stringify(m) }).catch(() => {});
      const unsubscribe = service.hub.subscribe(node, send);
      const version = await currentVersion(db);
      service.publisher.anchor(version);
      await stream.writeSSE({ event: "message", data: JSON.stringify({ type: "resync", schema_version: 0, version }) });
      const keepalive = setInterval(() => void stream.write(": keep-alive\n\n").catch(() => {}), KEEPALIVE_MS);
      await new Promise<void>((resolve) => stream.onAbort(resolve));
      clearInterval(keepalive);
      unsubscribe();
    });
  });

  app.get("/v1/nodes/:node_id/routes", operation(deps, "routeSnapshot"), nodeAuth(deps), async (c) => {
    const snap = await snapshot(db);
    const etag = `"${snap.version}"`;
    if (c.req.header("if-none-match") === etag) return c.body(null, 304, { etag });
    return c.json(snap, 200, { etag });
  });
}

