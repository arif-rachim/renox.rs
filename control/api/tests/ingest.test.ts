// POST /v1/ingest/meters and GET /v1/apps/{app}/usage (#56; deploy-api.md
// section 11, meter.md sections 4-5), and POST /v1/ingest/logs (#199).

import { afterEach, describe, expect, test } from "bun:test";
import { contentHash } from "@renox/artifact-validate";
import { hourOf, rollup } from "@renox/billing";
import spec from "../../../docs/contracts/schemas/deploy-api.yaml";
import { LOG_LINES_PER_MINUTE, logIngest, SAMPLE_EVERY } from "../src/ingest/logs.ts";
import { helloArtifact, named, upload } from "./artifacts.ts";
import { assertScoped, auditRows, createApp_, type Harness, harness, nodeToken, scopedToken, tenant } from "./helpers.ts";

afterEach(assertScoped);

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

type Example = { value: unknown; "x-expect"?: string };
type LogsOp = {
  requestBody: { content: { "application/json": { examples: Record<string, Example>; "x-renox-invalid-examples": Record<string, Example> } } };
  responses: Record<string, { content?: { "application/json": { examples: Record<string, Example> } } }>;
};
const logsOp = (spec as { paths: Record<string, { post: LogsOp }> }).paths["/v1/ingest/logs"]?.post as LogsOp;

let lineSeq = 0;
const line = (hash: string, over: Record<string, unknown> = {}) => {
  lineSeq += 1;
  return {
    ts: 1_793_318_400_200 + lineSeq,
    tenant_id: "t_hello",
    deployment_hash: hash,
    request_id: "01JBQ3Z7M8K5V6W9X2Y4A1B3C5",
    module: "functions/api/hello",
    level: "info",
    message: `line ${lineSeq}`,
    fields: null,
    source: "server",
    ...over,
  };
};
const logBatch = (lines: unknown[], node = "node-1") => ({ type: "log_batch", schema_version: 0, node_id: node, lines });
const ingestLogs = (h: Harness, token: string, body: unknown) => h.request("POST", "/v1/ingest/logs", { token, json: body });

describe("POST /v1/ingest/logs", () => {
  test("every request example → its 202 response example; the line is stored for the app", async () => {
    const { h } = await setup();
    const node = await nodeToken(h, "node-dxb-01");
    const responses = logsOp.responses["202"]?.content?.["application/json"].examples ?? {};
    for (const [name, ex] of Object.entries(logsOp.requestBody.content["application/json"].examples)) {
      const res = await ingestLogs(h, node, ex.value);
      expect(res.status, name).toBe(202);
      expect(await res.json()).toEqual(responses[name]?.value as object);
    }
    const stored = await logIngest(h.deps).store.read("t_hello", "hello");
    expect(stored.map((l) => [l.message, l.node_id, l.app])).toEqual([["hello", "node-dxb-01", "hello"]]);
    expect((await auditRows(h)).filter((r) => r.action === "ingestLogs").map((r) => [r.actor, r.status])).toEqual([["node:node-dxb-01", 202]]);
  });

  test("every invalid request example → 400 RENOX_VALIDATION", async () => {
    const { h } = await setup();
    const node = await nodeToken(h, "node-dxb-01");
    for (const [name, ex] of Object.entries(logsOp.requestBody.content["application/json"]["x-renox-invalid-examples"])) {
      const res = await ingestLogs(h, node, ex.value);
      expect(res.status, name).toBe(400);
    }
  });

  test("lines are de-duplicated on (ts, request_id, message) within one batch", async () => {
    const { h, node, hash } = await setup();
    const a = line(hash);
    const res = await ingestLogs(h, node, logBatch([a, { ...a, level: "warn" }, line(hash)]));
    expect(await res.json()).toEqual({ accepted: 2, duplicates: 1 });
  });

  test("node_id must be the token's node (403); a tenant token cannot ingest (401); another tenant's deployment → 400", async () => {
    const { h, token, node, hash } = await setup();
    expect((await ingestLogs(h, node, logBatch([line(hash)], "node-2"))).status).toBe(403);
    expect((await ingestLogs(h, token, logBatch([line(hash)]))).status).toBe(401);
    const other = await tenant(h, "t_other");
    await createApp_(h, other, "other");
    const files = named("other");
    expect((await upload(h, other, "other", files)).status).toBe(201);
    const res = await ingestLogs(h, node, logBatch([line(hash), line(contentHash(files))]));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { details: { field: string }[] } }).error.details.map((d) => d.field)).toEqual(["lines.1.deployment_hash"]);
    expect(await logIngest(h.deps).store.read("t_hello", "hello")).toEqual([]);
  });

  /** docs/23-failure-modes.md section 4, "Outbox or logs grow unbounded" (per-tenant log volume limit): over the cap lines are sampled and counted, never 5xx. */
  test("over the per-minute cap: one line in SAMPLE_EVERY is kept, the rest counted as dropped, always 202", async () => {
    const { h, node, hash } = await setup();
    const cap = LOG_LINES_PER_MINUTE.free;
    let accepted = 0;
    for (let i = 0; i < cap / 1000 + 2; i++) {
      const res = await ingestLogs(h, node, logBatch(Array.from({ length: 1000 }, () => line(hash))));
      expect(res.status).toBe(202);
      accepted += ((await res.json()) as { accepted: number }).accepted;
    }
    const over = 2000;
    expect(accepted).toBe(cap + over / SAMPLE_EVERY);
    expect(logIngest(h.deps).cap.dropped.get("t_hello")).toBe(over - over / SAMPLE_EVERY);
    // The next minute starts a new window.
    h.clock.now += 60_000;
    expect(await (await ingestLogs(h, node, logBatch([line(hash)]))).json()).toEqual({ accepted: 1, duplicates: 0 });
  });

  test("a paid tenant's cap is 10,000 lines per minute", async () => {
    const { h, node, hash } = await setup();
    await h.db.query("update tenants set tier = 'paid' where id = 't_hello'");
    let accepted = 0;
    for (let i = 0; i < 3; i++) accepted += ((await (await ingestLogs(h, node, logBatch(Array.from({ length: 1000 }, () => line(hash))))).json()) as { accepted: number }).accepted;
    expect(accepted).toBe(3000);
    expect(LOG_LINES_PER_MINUTE.paid).toBe(10_000);
  });
});
