// Meter ingestion and the usage view (#56): POST /v1/ingest/meters, the HTTP
// sink of docs/contracts/meter.md section 5 (deploy-api.md section 11), and
// GET /v1/apps/{app}/usage, the hourly rollup of one app. The rollup itself
// runs in the billing job (control/billing).

import type { Context, Hono } from "hono";
import { appUsageHours, HOUR_MS, ingestBatch, monthOf, nextMonthOf, quotaOf, total, UnknownDeployment, type MeterBatch } from "@renox/billing";
import { operation } from "../audit.ts";
import { nodeAuth, nodeId, tenantAuth, tenantId } from "../auth/middleware.ts";
import { requireApp } from "../apps/repo.ts";
import { checkMeterBatch } from "../contract.ts";
import { ApiError, invalid } from "../errors.ts";
import { JSON_LIMIT, pathParam, readBody } from "../http.ts";
import type { Deps, Env } from "../context.ts";

/** The longest range one usage request may cover. */
export const MAX_USAGE_RANGE_MS = 366 * 24 * HOUR_MS;

async function batchBody(c: Context<Env>): Promise<MeterBatch> {
  if (!/^application\/json(;|$)/u.test(c.req.header("content-type") ?? "")) throw invalid("content-type", "must be application/json");
  const bytes = await readBody(c, JSON_LIMIT);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw invalid("body", "not valid UTF-8 JSON");
  }
  return checkMeterBatch<MeterBatch>(value);
}

function msParam(c: Context<Env>, name: string, fallback: number): number {
  const raw = c.req.query(name);
  if (raw === undefined) return fallback;
  if (!/^[0-9]{1,16}$/u.test(raw)) throw invalid(name, "must be Unix milliseconds");
  return Number(raw);
}

export function registerIngest(app: Hono<Env>, deps: Deps): void {
  const { db } = deps;

  app.post("/v1/ingest/meters", operation(deps, "ingestMeters"), nodeAuth(deps), async (c) => {
    const node = nodeId(c);
    const batch = await batchBody(c);
    if (batch.node_id !== node) throw new ApiError("RENOX_TOKEN_SCOPE");
    try {
      return c.json(await ingestBatch(db, node, batch, deps.now()), 202);
    } catch (e) {
      if (!(e instanceof UnknownDeployment)) throw e;
      throw new ApiError(
        "RENOX_VALIDATION",
        e.indexes.slice(0, 50).map((i) => ({ field: `records.${i}.deployment_hash`, reason: "not a deployment of this tenant" })),
      );
    }
  });

  app.get("/v1/apps/:app/usage", operation(deps, "getUsage"), tenantAuth(deps, "apps:read"), async (c) => {
    const tenant = tenantId(c);
    const name = (await requireApp(db, tenant, pathParam(c, "app", "AppName"))).name;
    const now = deps.now();
    const from = msParam(c, "from", monthOf(now));
    const to = msParam(c, "to", nextMonthOf(now));
    if (to <= from) throw invalid("to", "must be after from");
    if (to - from > MAX_USAGE_RANGE_MS) throw invalid("to", "the range is at most 366 days");
    const hours = await appUsageHours(db, tenant, name, from, to);
    const quota = await quotaOf(db, tenant, now);
    return c.json({ app: name, from, to, hours, total: total(hours), quota });
  });
}
