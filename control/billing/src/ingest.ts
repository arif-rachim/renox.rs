// Meter ingestion (docs/contracts/meter.md section 4, deploy-api.md section
// 11): one batch envelope in, raw rows out, de-duplicated on request_id. The
// insert is one statement, so a batch is persisted whole or not at all.

import type { Queryable } from "./db.ts";

/** One invocation record (meter-record.schema.json `$defs/record`); the API validated it already. */
export interface MeterRecord {
  request_id: string;
  tenant_id: string;
  deployment_hash: string;
  route: string;
  started_at: number;
  cpu_ms: number;
  wall_ms: number;
  peak_heap_bytes: number;
  ingress_bytes: number;
  egress_bytes: number;
  fetch_sent_bytes: number;
  fetch_received_bytes: number;
  fetch_blocked: number;
  db_ms: number;
  db_rows: number;
  render_fuel: number;
  render_ms?: number;
  logs_dropped: number;
  http_status: number;
  status: "ok" | "error" | "timeout" | "cpu_limit" | "oom" | "blocked_fetch" | "busy" | "render_limit" | "forbidden";
  // Optional fields of meter.md 0.2 to 0.4 (F5 to F7), read by the unit-cost report.
  kind?: "request" | "event" | "tool" | "job" | "image";
  authz_evals?: number;
  realtime_conn_seconds?: number;
  realtime_messages?: number;
  storage_bytes?: number;
  image_variants?: number;
  ai_tokens_in?: number;
  ai_tokens_out?: number;
  render_pdf_ms?: number;
}

export interface MeterBatch {
  schema_version: 0;
  cell_id: string;
  node_id: string;
  records: MeterRecord[];
}

export interface IngestResult {
  accepted: number;
  duplicates: number;
}

/**
 * A record names a (tenant, deployment) pair the control plane never stored.
 * A node only runs deployments from the route table, so this is a bug or a
 * node billing a tenant it does not serve; the batch is refused whole.
 */
export class UnknownDeployment extends Error {
  constructor(readonly indexes: number[]) {
    super(`records name unknown deployments: ${indexes.join(", ")}`);
  }
}

/** Persists `batch` from `nodeId`; records whose request_id is already stored count as duplicates. */
export async function ingestBatch(db: Queryable, nodeId: string, batch: MeterBatch, receivedAt: number): Promise<IngestResult> {
  const pairs = new Map<string, { tenant: string; hash: string }>();
  for (const r of batch.records) pairs.set(`${r.tenant_id} ${r.deployment_hash}`, { tenant: r.tenant_id, hash: r.deployment_hash });
  const known = new Set(
    (
      await db.query<{ tenant_id: string; hash: string }>(
        "select distinct tenant_id, hash from deployments where (tenant_id, hash) in (select * from unnest($1::text[], $2::text[]))",
        [[...pairs.values()].map((p) => p.tenant), [...pairs.values()].map((p) => p.hash)],
      )
    ).map((r) => `${r.tenant_id} ${r.hash}`),
  );
  const unknown = batch.records.flatMap((r, i) => (known.has(`${r.tenant_id} ${r.deployment_hash}`) ? [] : [i]));
  if (unknown.length > 0) throw new UnknownDeployment(unknown);

  // A request_id repeated inside one batch is a duplicate too (rule M1 of validate.ts).
  const seen = new Set<string>();
  const unique = batch.records.filter((r) => !seen.has(r.request_id) && seen.add(r.request_id) !== undefined);
  const rows = await db.query<{ request_id: string }>(
    `insert into meters_raw (request_id, tenant_id, deployment_hash, node_id, started_at, record, received_at)
     select r->>'request_id', r->>'tenant_id', r->>'deployment_hash', $1, (r->>'started_at')::bigint, r, $2
     from jsonb_array_elements($3::text::jsonb) as r
     on conflict (request_id) do nothing
     returning request_id`,
    [nodeId, receivedAt, JSON.stringify(unique)],
  );
  return { accepted: rows.length, duplicates: batch.records.length - rows.length };
}
