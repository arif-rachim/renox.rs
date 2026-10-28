// POST /v1/nodes/{node_id}/prepare-results (prepareResult, deploy-api.md
// section 6 steps 3-7): the owning node's answer to a `prepare` message.
//
// The broker sends `prepare` to one node over its stream and waits for the
// answer, at most `deadline_ms`. The answer settles the activation once: a
// result after the deadline, or a second result, gets 409 and is discarded,
// and the node then discards its prepared cell (step 7). Pending activations
// live in the API process that sent `prepare`; F3 runs one API instance.

import type { Context, Hono } from "hono";
import { operation } from "../audit.ts";
import { nodeAuth, nodeId } from "../auth/middleware.ts";
import { checkMessage } from "../contract.ts";
import type { Deps, Env } from "../context.ts";
import { ApiError, conflict, invalid, notFound } from "../errors.ts";
import { JSON_LIMIT, readBody } from "../http.ts";
import { ulid } from "../ids.ts";
import { routeService, type PrepareResult } from "../routes/service.ts";

/** deploy-api.md section 6 step 3. */
export const PREPARE_DEADLINE_MS = 60_000;

/** How many settled activation ids are remembered, so a late answer gets 409 instead of 404. */
const SETTLED_KEPT = 1024;

export interface PrepareMessage {
  type: "prepare";
  schema_version: 0;
  activation_id: string;
  tenant_id: string;
  app: string;
  deployment_hash: string;
  tier: "free" | "paid";
  secrets_version: number;
  probe: { path: string; timeout_ms: number } | null;
  deadline_ms: number;
}

export interface PrepareResultMessage {
  type: "prepare_result";
  schema_version: 0;
  activation_id: string;
  node_id: string;
  ok: boolean;
  migrations_applied?: string[];
  error?: { stage: string; reason: string; module?: string; file?: string; sqlite_error?: string; http_status?: number };
}

interface Pending {
  nodeId: string;
  resolve: (r: PrepareResultMessage | null) => void;
}

export class PrepareBroker {
  private readonly pending = new Map<string, Pending>();
  private readonly settled = new Set<string>();

  constructor(private readonly deps: Deps) {}

  /** A new activation id (`act_` + ULID, `$defs/activation_id`). */
  newId(): string {
    return `act_${ulid(this.deps.now())}`;
  }

  /**
   * Sends `message` to `node` and waits for its prepare_result. The node's
   * answer, or a failure with stage `timeout` when none arrives within
   * `deadline_ms` or the node has no stream on this API instance.
   */
  async request(node: string, message: PrepareMessage): Promise<PrepareResult & { migrationsApplied?: string[] }> {
    const id = message.activation_id;
    const answer = new Promise<PrepareResultMessage | null>((resolve) => this.pending.set(id, { nodeId: node, resolve }));
    const sent = routeService(this.deps).hub.sendTo(node, message);
    const timer = setTimeout(() => this.settle(id, null), sent ? message.deadline_ms : 0);
    const r = await answer;
    clearTimeout(timer);
    if (r === null) {
      return { ok: false, error: { stage: "timeout", reason: sent ? `no answer within ${message.deadline_ms} ms` : "the node has no open stream" } };
    }
    if (r.ok) return { ok: true, migrationsApplied: r.migrations_applied ?? [] };
    return { ok: false, error: { ...(r.error as { stage: string; reason: string }) } };
  }

  /** Whether `id` waits for an answer from `node`; "other" when it waits for another node. */
  waiting(id: string, node: string): "yes" | "other" | "settled" | "unknown" {
    const p = this.pending.get(id);
    if (p !== undefined) return p.nodeId === node ? "yes" : "other";
    return this.settled.has(id) ? "settled" : "unknown";
  }

  /** Resolves the activation `id` once; later calls do nothing. */
  settle(id: string, result: PrepareResultMessage | null): void {
    const p = this.pending.get(id);
    if (p === undefined) return;
    this.pending.delete(id);
    this.settled.add(id);
    if (this.settled.size > SETTLED_KEPT) this.settled.delete(this.settled.values().next().value as string);
    p.resolve(result);
  }
}

const brokers = new WeakMap<Deps, PrepareBroker>();

export function prepareBroker(deps: Deps): PrepareBroker {
  let b = brokers.get(deps);
  if (b === undefined) {
    b = new PrepareBroker(deps);
    brokers.set(deps, b);
  }
  return b;
}

async function resultBody(c: Context<Env>): Promise<PrepareResultMessage> {
  if (!/^application\/json(;|$)/u.test(c.req.header("content-type") ?? "")) throw invalid("content-type", "must be application/json");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readBody(c, JSON_LIMIT)));
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw invalid("body", "not valid UTF-8 JSON");
  }
  return checkMessage<PrepareResultMessage>("prepare_result", value);
}

export function registerPrepareResults(app: Hono<Env>, deps: Deps): void {
  const broker = prepareBroker(deps);

  app.post("/v1/nodes/:node_id/prepare-results", operation(deps, "prepareResult"), nodeAuth(deps), async (c) => {
    const node = nodeId(c);
    const body = await resultBody(c);
    if (body.node_id !== node) throw new ApiError("RENOX_TOKEN_SCOPE");
    c.set("auditTarget", { activation_id: body.activation_id });
    switch (broker.waiting(body.activation_id, node)) {
      case "other":
        // Another node's activation: refused, and the activation keeps waiting for its own node.
        throw new ApiError("RENOX_TOKEN_SCOPE");
      case "settled":
        throw conflict("activation_id", "the activation is no longer waiting for a result");
      case "unknown":
        throw notFound();
      case "yes":
        broker.settle(body.activation_id, body);
        return c.body(null, 204);
    }
  });
}
