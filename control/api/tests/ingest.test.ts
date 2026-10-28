// POST /v1/ingest/meters and GET /v1/apps/{app}/usage (#56; deploy-api.md
// section 11, meter.md sections 4-5).

import { describe, expect, test } from "bun:test";
import { contentHash } from "@renox/artifact-validate";
import { hourOf, rollup } from "@renox/billing";
import { helloArtifact, named, upload } from "./artifacts.ts";
import { auditRows, createApp_, harness, nodeToken, scopedToken, tenant, type Harness } from "./helpers.ts";

let seq = 0;
const record = (hash: string, over: Record<string, unknown> = {}) => {
  seq += 1;
  return {
    request_id: `01JBQ3Z7M8K5V6W9X2Y4B${String(seq).padStart(5, "0")}`,
    tenant_id: "t_hello",
    deployment_hash: hash,
    route: "GET /api/hello",
    started_at: 1_793_318_400_123,
    cpu_ms: 0.834,
    wall_ms: 1.302,
    peak_heap_bytes: 4_216_480,
    ingress_bytes: 0,
    egress_bytes: 11,
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
};
const envelope = (records: unknown[], node = "node-1") => ({ schema_version: 0, cell_id: `t_hello@${node}`, node_id: node, records });

async function setup(): Promise<{ h: Harness; token: string; node: string; hash: string }> {
  const h = await harness();
  const token = await tenant(h, "t_hello");
  await createApp_(h, token, "hello");
  const files = helloArtifact();
  expect((await upload(h, token, "hello", files)).status).toBe(201);
  return { h, token, node: await nodeToken(h, "node-1"), hash: contentHash(files) };
}

const ingest = (h: Harness, token: string, body: unknown) => h.request("POST", "/v1/ingest/meters", { token, json: body });

describe("POST /v1/ingest/meters", () => {
  test("202 with accepted and duplicates; a replayed batch does not double count", async () => {
    const { h, node, hash } = await setup();
    const body = envelope([record(hash), record(hash)]);
    const first = await ingest(h, node, body);
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({ accepted: 2, duplicates: 0 });
    const replay = await ingest(h, node, body);
    expect(replay.status).toBe(202);
    expect(await replay.json()).toEqual({ accepted: 0, duplicates: 2 });
    expect(await h.db.query("select request_id from meters_raw")).toHaveLength(2);
    expect((await auditRows(h)).filter((r) => r.action === "ingestMeters").map((r) => [r.actor, r.status])).toEqual([
      ["node:node-1", 202],
      ["node:node-1", 202],
    ]);
  });

  test("node_id must be the token's node (403)", async () => {
    const { h, node, hash } = await setup();
    const res = await ingest(h, node, envelope([record(hash)], "node-2"));
    expect(res.status).toBe(403);
    expect(await h.db.query("select 1 from meters_raw")).toHaveLength(0);
  });

  test("a tenant token or no token cannot ingest (401)", async () => {
    const { h, token, hash } = await setup();
    expect((await ingest(h, token, envelope([record(hash)]))).status).toBe(401);
    expect((await h.request("POST", "/v1/ingest/meters", { json: envelope([record(hash)]) })).status).toBe(401);
  });

  test("an unknown schema_version or an invalid record is 400 and nothing is stored", async () => {
    const { h, node, hash } = await setup();
    expect((await ingest(h, node, { ...envelope([record(hash)]), schema_version: 1 })).status).toBe(400);
    expect((await ingest(h, node, envelope([]))).status).toBe(400);
    const bad = await ingest(h, node, envelope([record(hash), record(hash, { cpu_ms: -1 })]));
    expect(bad.status).toBe(400);
    expect(await h.db.query("select 1 from meters_raw")).toHaveLength(0);
  });

  test("records for another tenant's deployment are refused (400), the batch whole", async () => {
    const { h, node, hash } = await setup();
    const other = await tenant(h, "t_other");
    await createApp_(h, other, "other");
    const files = named("other");
    expect((await upload(h, other, "other", files)).status).toBe(201);
    const res = await ingest(h, node, envelope([record(hash), record(contentHash(files))]));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { details: { field: string }[] } };
    expect(body.error.details.map((d) => d.field)).toEqual(["records.1.deployment_hash"]);
    expect(await h.db.query("select 1 from meters_raw")).toHaveLength(0);
  });
});

describe("GET /v1/apps/{app}/usage", () => {
  test("returns the hourly rollup, its total, and the quota state", async () => {
    const { h, token, node, hash } = await setup();
    const hour = hourOf(h.clock.now);
    expect(
      (await ingest(h, node, envelope([record(hash, { started_at: hour + 1 }), record(hash, { started_at: hour + 2, cpu_ms: 1, render_ms: 0.5, egress_bytes: 100, status: "busy" })]))).status,
    ).toBe(202);
    await rollup(h.db, { from: hour, to: hour + 3_600_000 });
    const res = await h.request("GET", `/v1/apps/hello/usage?from=${hour}&to=${hour + 3_600_000}`, { token });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    const row = { requests: 1, cpu_ms: 2.334, wall_ms: 2.604, egress_bytes: 111, fetch_sent_bytes: 0, db_ms: 0, db_rows: 0, render_fuel: 0 };
    expect(body.hours).toEqual([{ hour_start: hour, ...row }]);
    expect(body.total).toEqual(row);
    expect(body.quota).toMatchObject({ tenant_id: "t_hello", tier: "free", over: [], used: { requests: 1, cpu_ms: 2.334, egress_bytes: 111 } });
  });

  test("defaults to the current month; needs apps:read; another tenant's app is 404", async () => {
    const { h, token } = await setup();
    const res = await h.request("GET", "/v1/apps/hello/usage", { token });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { from: number; to: number; hours: unknown[] };
    expect(new Date(body.from).getUTCDate()).toBe(1);
    expect(body.from).toBeLessThanOrEqual(h.clock.now);
    expect(body.to).toBeGreaterThan(h.clock.now);
    expect(body.hours).toEqual([]);
    const noScope = await scopedToken(h, "t_hello", ["deploy"]);
    expect((await h.request("GET", "/v1/apps/hello/usage", { token: noScope })).status).toBe(403);
    const other = await tenant(h, "t_other");
    expect((await h.request("GET", "/v1/apps/hello/usage", { token: other })).status).toBe(404);
  });

  test("rejects a bad range (400)", async () => {
    const { h, token } = await setup();
    for (const q of ["from=abc", "from=10&to=5", `from=0&to=${400 * 86_400_000}`]) {
      expect((await h.request("GET", `/v1/apps/hello/usage?${q}`, { token })).status).toBe(400);
    }
  });
});
