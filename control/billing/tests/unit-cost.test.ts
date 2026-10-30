// The unit-cost report (#56): arithmetic on a hand-computed input.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRecords, report, unitCost } from "../src/unit-cost.ts";
import { batch, record } from "./helpers.ts";

describe("unitCost", () => {
  test("cost per CPU-ms and per request from the meter.md section 7 dimensions", () => {
    const records = [
      record({ cpu_ms: 1, render_ms: 1, egress_bytes: 1000, fetch_sent_bytes: 0 }),
      record({ cpu_ms: 4, egress_bytes: 2000, fetch_sent_bytes: 1000 }),
      record({ cpu_ms: 0, egress_bytes: 0, status: "busy" }),
    ];
    // 2 vCPU x 30 days x 50 % = 2 * 2_592_000_000 * 0.5 = 2_592_000_000 sellable CPU-ms for $259.2.
    const inputs = { nodeUsdPerMonth: 259.2, vcpus: 2, utilization: 0.5, egressUsdPerGb: 0.1, throughput: 1000 };
    const c = unitCost([...records, records[0] as never], inputs);
    expect(c).toMatchObject({ records: 3, charged: 2, busy: 1, cpuMsMean: 3, cpuMsP50: 4, egressBytesMean: 2000 });
    expect(c.usdPerCpuMs).toBeCloseTo(1e-7, 15);
    expect(c.usdPerRequestCpu).toBeCloseTo(3e-7, 15);
    expect(c.usdPerRequestEgress).toBeCloseTo(2e-7, 15);
    expect(c.usdPerMillionRequests).toBeCloseTo(0.5, 9);
    expect(c.requestsPerNodeMonth).toBe(864_000_000);
    // $259.2 / (1000 req/s x 2_592_000 s) x 1e6 = $0.1
    expect(c.usdPerMillionAtThroughput).toBeCloseTo(0.1, 9);
    expect(report("fixture", c, inputs)).toContain("| Cost per 1M requests | $0.50 |");
  });

  test("the F5 to F7 fields (#325): kinds, authz, realtime, storage level, images, AI tokens priced, PDF time in the billed CPU", () => {
    const records = [
      record({ cpu_ms: 1, kind: "request", authz_evals: 2, storage_bytes: 5000, render_pdf_ms: 3 }),
      record({ cpu_ms: 1, kind: "request", authz_evals: 1, ai_tokens_in: 600, ai_tokens_out: 400, storage_bytes: 9000 }),
      record({ cpu_ms: 0, realtime_conn_seconds: 30.5, realtime_messages: 12 }),
      record({ cpu_ms: 2, kind: "image", image_variants: 3 }),
      record({ cpu_ms: 0, kind: "job" }),
    ];
    const inputs = { nodeUsdPerMonth: 259.2, vcpus: 2, utilization: 0.5, egressUsdPerGb: 0.1, throughput: null, aiUsdPerMillionTokens: 15 };
    const c = unitCost(records, inputs);
    expect(c.kinds).toEqual({ image: 1, job: 1, request: 3 });
    const by = Object.fromEntries(c.extended.map((e) => [e.field, e]));
    expect(by.authz_evals).toEqual({ field: "authz_evals", total: 3, records: 2 });
    expect(by.realtime_conn_seconds?.total).toBe(30.5);
    expect(by.storage_bytes).toEqual({ field: "storage_bytes", total: 9000, records: 2 });
    expect(by.image_variants?.total).toBe(3);
    expect(by.ai_tokens_in?.total).toBe(600);
    // (1000 tokens / 5 invocations) x $15 per million = $0.003.
    expect(c.usdPerRequestAi).toBeCloseTo(0.003, 12);
    // Billed CPU: (1 + 3) + 1 + 0 + 2 + 0 = 7 over 5.
    expect(c.cpuMsMean).toBeCloseTo(1.4, 12);
    const md = report("fixture", c, inputs);
    expect(md).toContain("Invocations by kind: image 1, job 1, request 3.");
    expect(md).toContain("| `storage_bytes` | 9000 | (level, max) | 2 |");
    expect(md).toContain("| AI tokens per invocation | $0.00300 |");
    expect(report("fixture", unitCost(records, { ...inputs, aiUsdPerMillionTokens: null }), inputs)).toContain("not priced (--ai-usd-mtok)");
  });

  test("reads file-sink batches from directories", () => {
    const dir = mkdtempSync(join(tmpdir(), "unit-cost-"));
    mkdirSync(join(dir, "cell"));
    writeFileSync(join(dir, "cell", "2026-11-01.ndjson"), `${JSON.stringify(batch([record(), record()]))}\n${JSON.stringify(batch([record()]))}\n`);
    writeFileSync(join(dir, "cell", "notes.txt"), "ignored");
    expect(readRecords([dir])).toHaveLength(3);
  });
});
