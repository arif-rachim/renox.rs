// One PGlite per test process with the control-plane schema (control/api owns
// the migrations, including meters_raw and meters_hourly), emptied per test.

import { readdirSync, readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import type { MeterRecord, Queryable } from "../src/index.ts";

const MIGRATIONS = new URL("../../api/migrations/", import.meta.url).pathname;

let shared: Promise<PGlite> | undefined;

export async function testDb(): Promise<Queryable> {
  shared ??= (async () => {
    const pg = new PGlite();
    await pg.waitReady;
    for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) await pg.exec(readFileSync(`${MIGRATIONS}${f}`, "utf8"));
    return pg;
  })();
  const pg = await shared;
  await pg.exec("truncate meters_raw, meters_hourly, deployments, apps, tenants cascade");
  return { query: async (sql, params = []) => (await pg.query(sql, [...params])).rows as never[] };
}

export const HASH_A = "a".repeat(64);
export const HASH_B = "b".repeat(64);
export const HASH_C = "c".repeat(64);

/** Tenants t_one (free, app `one`, deployments A and B) and t_two (paid, app `two`, deployment C). */
export async function seed(db: Queryable): Promise<void> {
  const at = 1_793_318_400_000;
  await db.query("insert into tenants (id, name, tier, created_at) values ('t_one', 'one', 'free', $1), ('t_two', 'two', 'paid', $1)", [at]);
  await db.query("insert into apps (name, tenant_id, created_at) values ('one', 't_one', $1), ('two', 't_two', $1)", [at]);
  for (const [tenant, app, hash] of [
    ["t_one", "one", HASH_A],
    ["t_one", "one", HASH_B],
    ["t_two", "two", HASH_C],
  ]) {
    await db.query("insert into deployments (tenant_id, app, hash, state, created_at, updated_at) values ($1, $2, $3, 'validated', $4, $4)", [tenant, app, hash, at]);
  }
}

let seq = 0;

/** A valid record; `request_id` is unique per call unless given. */
export function record(over: Partial<MeterRecord> = {}): MeterRecord {
  seq += 1;
  return {
    request_id: `01JBQ3Z7M8K5V6W9X2Y4A${String(seq).padStart(5, "0")}`,
    tenant_id: "t_one",
    deployment_hash: HASH_A,
    route: "GET /api/hello",
    started_at: 1_793_318_400_123,
    cpu_ms: 1,
    wall_ms: 2,
    peak_heap_bytes: 4_000_000,
    ingress_bytes: 0,
    egress_bytes: 100,
    fetch_sent_bytes: 0,
    fetch_received_bytes: 0,
    fetch_blocked: 0,
    db_ms: 0,
    db_rows: 0,
    render_fuel: 0,
    logs_dropped: 0,
    http_status: 200,
    status: "ok",
    ...over,
  };
}

export const batch = (records: MeterRecord[], node = "node-1") => ({ schema_version: 0 as const, cell_id: `t_one@${node}`, node_id: node, records });
