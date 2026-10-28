// Billing v0 (#56): de-duplication, the hourly rollup against a hand-computed
// fixture, usage reads, and the tier quota signal.

import { describe, expect, test } from "bun:test";
import { appUsageHours, HOUR_MS, ingestBatch, overQuota, quotaOf, rollup, runOnce, scheduledWindow, TIER_QUOTAS, total, UnknownDeployment } from "../src/index.ts";
import { batch, HASH_A, HASH_B, HASH_C, record, seed, testDb } from "./helpers.ts";

/** 2026-11-01T00:00:00Z, the start of a UTC hour and of a month. */
const H0 = Date.UTC(2026, 10, 1);
const RECEIVED = H0 + 5 * HOUR_MS;

describe("ingestBatch", () => {
  test("a duplicate batch does not double count (meter.md section 4)", async () => {
    const db = await testDb();
    await seed(db);
    const b = batch([record({ started_at: H0 }), record({ started_at: H0 + 1 }), record({ started_at: H0 + 2 })]);
    expect(await ingestBatch(db, "node-1", b, RECEIVED)).toEqual({ accepted: 3, duplicates: 0 });
    expect(await ingestBatch(db, "node-1", b, RECEIVED)).toEqual({ accepted: 0, duplicates: 3 });
    // A replay that overlaps: one known record, one new.
    const again = batch([b.records[0] as never, record({ started_at: H0 + 3 })]);
    expect(await ingestBatch(db, "node-1", again, RECEIVED)).toEqual({ accepted: 1, duplicates: 1 });
    await rollup(db, { from: H0, to: H0 + HOUR_MS });
    const hours = await appUsageHours(db, "t_one", "one", H0, H0 + HOUR_MS);
    expect(hours).toHaveLength(1);
    expect(hours[0]?.requests).toBe(4);
    expect(hours[0]?.cpu_ms).toBe(4);
  });

  test("a request_id repeated inside one batch counts once", async () => {
    const db = await testDb();
    await seed(db);
    const r = record({ started_at: H0 });
    expect(await ingestBatch(db, "node-1", batch([r, { ...r }]), RECEIVED)).toEqual({ accepted: 1, duplicates: 1 });
  });

  test("the same request_id from another node is a duplicate, whatever the batch", async () => {
    const db = await testDb();
    await seed(db);
    const r = record({ started_at: H0 });
    await ingestBatch(db, "node-1", batch([r]), RECEIVED);
    expect(await ingestBatch(db, "node-2", batch([r], "node-2"), RECEIVED)).toEqual({ accepted: 0, duplicates: 1 });
  });

  test("a record for a deployment the tenant does not own refuses the whole batch", async () => {
    const db = await testDb();
    await seed(db);
    // HASH_C belongs to t_two: a node cannot bill it to t_one.
    const b = batch([record({ started_at: H0 }), record({ started_at: H0, deployment_hash: HASH_C })]);
    const err = await ingestBatch(db, "node-1", b, RECEIVED).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnknownDeployment);
    expect((err as UnknownDeployment).indexes).toEqual([1]);
    expect(await db.query("select 1 from meters_raw")).toHaveLength(0);
  });
});

describe("rollup", () => {
  /**
   * The fixture: nine records over two hours, two deployments of t_one and
   * one of t_two. Expected rows computed by hand from meter.md section 7.
   */
  const fixture = () => [
    // t_one / A, hour 0
    record({ started_at: H0 + 10, cpu_ms: 1.25, wall_ms: 3.5, egress_bytes: 1000, fetch_sent_bytes: 200, db_ms: 0.5, db_rows: 3, render_fuel: 120, render_ms: 0.25 }),
    record({ started_at: H0 + 20, cpu_ms: 2.5, wall_ms: 4, egress_bytes: 500, db_ms: 1.25, db_rows: 1, render_fuel: 80 }),
    record({ started_at: H0 + HOUR_MS - 1, cpu_ms: 0.125, wall_ms: 0.5, egress_bytes: 10, status: "error", http_status: 500 }),
    // busy: not a charged request, no CPU
    record({ started_at: H0 + 30, cpu_ms: 0, wall_ms: 50, egress_bytes: 90, status: "busy", http_status: 503 }),
    // t_one / B, hour 0
    record({ started_at: H0 + 40, deployment_hash: HASH_B, cpu_ms: 10, wall_ms: 12, egress_bytes: 2000, render_ms: 1.5, render_fuel: 900 }),
    // t_one / A, hour 1
    record({ started_at: H0 + HOUR_MS, cpu_ms: 3, wall_ms: 3, egress_bytes: 300, fetch_sent_bytes: 50 }),
    record({ started_at: H0 + HOUR_MS + 5, cpu_ms: 7, wall_ms: 9, egress_bytes: 700, db_ms: 2, db_rows: 10, status: "timeout", http_status: 504 }),
    // t_two / C, hour 1
    record({ started_at: H0 + HOUR_MS + 7, tenant_id: "t_two", deployment_hash: HASH_C, cpu_ms: 4, wall_ms: 5, egress_bytes: 40 }),
    record({ started_at: H0 + HOUR_MS + 8, tenant_id: "t_two", deployment_hash: HASH_C, cpu_ms: 6, wall_ms: 5, egress_bytes: 60, render_ms: 2 }),
  ];

  const expected = [
    { tenant_id: "t_one", deployment_hash: HASH_A, hour_start: H0, requests: 3, cpu_ms: 4.125, wall_ms: 58, egress_bytes: 1600, fetch_sent_bytes: 200, db_ms: 1.75, db_rows: 4, render_fuel: 200 },
    { tenant_id: "t_one", deployment_hash: HASH_A, hour_start: H0 + HOUR_MS, requests: 2, cpu_ms: 10, wall_ms: 12, egress_bytes: 1000, fetch_sent_bytes: 50, db_ms: 2, db_rows: 10, render_fuel: 0 },
    { tenant_id: "t_one", deployment_hash: HASH_B, hour_start: H0, requests: 1, cpu_ms: 11.5, wall_ms: 12, egress_bytes: 2000, fetch_sent_bytes: 0, db_ms: 0, db_rows: 0, render_fuel: 900 },
    { tenant_id: "t_two", deployment_hash: HASH_C, hour_start: H0 + HOUR_MS, requests: 2, cpu_ms: 12, wall_ms: 10, egress_bytes: 100, fetch_sent_bytes: 0, db_ms: 0, db_rows: 0, render_fuel: 0 },
  ];

  const hourly = async (db: Awaited<ReturnType<typeof testDb>>) =>
    (await db.query("select * from meters_hourly order by tenant_id, deployment_hash, hour_start")).map((r) =>
      Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "bigint" || (typeof v === "string" && /^[0-9.]+$/u.test(v) && k !== "deployment_hash") ? Number(v) : v])),
    );

  test("matches the hand-computed fixture", async () => {
    const db = await testDb();
    await seed(db);
    await ingestBatch(db, "node-1", batch(fixture()), RECEIVED);
    expect(await rollup(db, { from: H0, to: H0 + 2 * HOUR_MS })).toBe(4);
    expect(await hourly(db)).toEqual(expected);
  });

  test("is idempotent, and a late record is counted by the next run over its hour", async () => {
    const db = await testDb();
    await seed(db);
    const records = fixture();
    const late = records.pop() as ReturnType<typeof record>;
    await ingestBatch(db, "node-1", batch(records), RECEIVED);
    await rollup(db, { from: H0, to: H0 + 2 * HOUR_MS });
    await rollup(db, { from: H0, to: H0 + 2 * HOUR_MS });
    const before = (await hourly(db)).find((r) => r.tenant_id === "t_two");
    expect(before?.requests).toBe(1);
    await ingestBatch(db, "node-1", batch([late]), RECEIVED + HOUR_MS);
    await rollup(db, scheduledWindow(H0 + 3 * HOUR_MS));
    expect(await hourly(db)).toEqual(expected);
  });

  test("leaves hours outside the window alone", async () => {
    const db = await testDb();
    await seed(db);
    await ingestBatch(db, "node-1", batch(fixture()), RECEIVED);
    expect(await rollup(db, { from: H0 + HOUR_MS, to: H0 + 2 * HOUR_MS })).toBe(2);
    expect((await hourly(db)).map((r) => r.hour_start)).toEqual([H0 + HOUR_MS, H0 + HOUR_MS]);
  });

  test("app usage joins deployments to their app and sums per hour", async () => {
    const db = await testDb();
    await seed(db);
    await ingestBatch(db, "node-1", batch(fixture()), RECEIVED);
    await rollup(db, { from: H0, to: H0 + 2 * HOUR_MS });
    const hours = await appUsageHours(db, "t_one", "one", H0, H0 + 24 * HOUR_MS);
    expect(hours).toEqual([
      { hour_start: H0, requests: 4, cpu_ms: 15.625, wall_ms: 70, egress_bytes: 3600, fetch_sent_bytes: 200, db_ms: 1.75, db_rows: 4, render_fuel: 1100 },
      { hour_start: H0 + HOUR_MS, requests: 2, cpu_ms: 10, wall_ms: 12, egress_bytes: 1000, fetch_sent_bytes: 50, db_ms: 2, db_rows: 10, render_fuel: 0 },
    ]);
    expect(total(hours)).toEqual({ requests: 6, cpu_ms: 25.625, wall_ms: 82, egress_bytes: 4600, fetch_sent_bytes: 250, db_ms: 3.75, db_rows: 14, render_fuel: 1100 });
    // Another tenant's app is never summed into this one, and vice versa.
    expect(await appUsageHours(db, "t_two", "one", H0, H0 + 24 * HOUR_MS)).toEqual([]);
  });
});

describe("quota signal", () => {
  test("marks a tenant over its tier's monthly quota, and only that dimension", async () => {
    const db = await testDb();
    await seed(db);
    const quotas = { free: { requests: 5, cpu_ms: 1_000, egress_bytes: 1_000_000 }, paid: TIER_QUOTAS.paid };
    await ingestBatch(db, "node-1", batch(Array.from({ length: 6 }, (_, i) => record({ started_at: H0 + i }))), RECEIVED);
    await ingestBatch(db, "node-1", batch([record({ tenant_id: "t_two", deployment_hash: HASH_C, started_at: H0 })]), RECEIVED);
    await rollup(db, { from: H0, to: H0 + HOUR_MS });
    const over = await overQuota(db, H0 + 2 * HOUR_MS, quotas);
    expect(over.map((s) => [s.tenant_id, s.tier, s.over])).toEqual([["t_one", "free", ["requests"]]]);
    expect(over[0]?.used).toEqual({ requests: 6, cpu_ms: 6, egress_bytes: 600 });
    const one = await quotaOf(db, "t_two", H0 + 2 * HOUR_MS, quotas);
    expect(one).toMatchObject({ tier: "paid", over: [], period_start: H0, period_end: Date.UTC(2026, 11, 1) });
    // Next month starts from zero.
    expect(await overQuota(db, Date.UTC(2026, 11, 2), quotas)).toEqual([]);
  });

  test("billed egress counts fetch_sent_bytes (meter.md section 7)", async () => {
    const db = await testDb();
    await seed(db);
    await ingestBatch(db, "node-1", batch([record({ started_at: H0, egress_bytes: 10, fetch_sent_bytes: 5 })]), RECEIVED);
    await rollup(db, { from: H0, to: H0 + HOUR_MS });
    expect((await quotaOf(db, "t_one", H0)).used.egress_bytes).toBe(15);
  });

  test("the job logs one warning per tenant over quota and nothing else", async () => {
    const db = await testDb();
    await seed(db);
    const n = TIER_QUOTAS.free.requests;
    expect(n).toBeGreaterThan(1000);
    // Push t_one over the free CPU quota with a few expensive records.
    await ingestBatch(db, "node-1", batch([record({ started_at: H0, cpu_ms: TIER_QUOTAS.free.cpu_ms + 1 })]), RECEIVED);
    const lines: [string, string, Record<string, unknown> | undefined][] = [];
    const log = { info: (m: string, f?: Record<string, unknown>) => lines.push(["info", m, f]), warn: (m: string, f?: Record<string, unknown>) => lines.push(["warn", m, f]) };
    expect(await runOnce(db, H0 + 30 * 60_000, log)).toEqual({ rows: 1, over: 1 });
    expect(lines.filter((l) => l[0] === "warn").map((l) => [l[1], l[2]?.tenant_id, l[2]?.over])).toEqual([["tenant over quota", "t_one", ["cpu_ms"]]]);
  });
});
