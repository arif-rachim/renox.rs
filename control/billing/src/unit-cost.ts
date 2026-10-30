// The unit-cost report (#56): cost per request and per CPU-ms from real meter
// records, for docs/01-business.md ("Unit economics") and the F7 pricing
// decision (docs/15-roadmap.md, open question "Pricing model").
//
//   bun control/billing/src/unit-cost.ts [options] <meters.ndjson | meters dir>...
//
// Inputs are file-sink batches (meter.md section 5: one envelope per line;
// directories are read recursively), so the report runs on a worker's
// <data_dir>/meters as well as on a dump of the ingestion table.
//
// Options (defaults are the hypotheses of docs/01-business.md):
//   --node-usd <n>        node cost per month, USD             (125: "$100-150/month")
//   --vcpus <n>           vCPUs per node                        (4: "8 GB / 4 vCPU")
//   --utilization <f>     sellable share of the node's CPU      (0.6)
//   --egress-usd-gb <n>   egress price per GB, USD              (0.09)
//   --throughput <n>      measured req/s of one node (B11), for the whole-node comparison
//   --ai-usd-mtok <n>     AI provider price per million tokens, USD (no default:
//                         unpriced when absent; docs/01-business.md has no number)
//   --tenant <id>         only this tenant's records
//   --label <text>        what the records are, for the report heading

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { MeterBatch, MeterRecord } from "./ingest.ts";

export interface CostInputs {
  nodeUsdPerMonth: number;
  vcpus: number;
  utilization: number;
  egressUsdPerGb: number;
  /** Measured requests per second of one node; null skips the comparison. */
  throughput: number | null;
  /** AI tokens, USD per million (in and out alike); null leaves them unpriced. */
  aiUsdPerMillionTokens?: number | null;
}

export const DEFAULTS: CostInputs = { nodeUsdPerMonth: 125, vcpus: 4, utilization: 0.6, egressUsdPerGb: 0.09, throughput: null };

const MONTH_MS = 30 * 24 * 3_600_000;
const GB = 1e9;

export interface UnitCost {
  records: number;
  charged: number;
  busy: number;
  /** Billed CPU per charged request (cpu_ms + render_ms), ms. */
  cpuMsMean: number;
  cpuMsP50: number;
  cpuMsP99: number;
  /** Billed egress per charged request (egress_bytes + fetch_sent_bytes). */
  egressBytesMean: number;
  usdPerCpuMs: number;
  usdPerRequestCpu: number;
  usdPerRequestEgress: number;
  usdPerMillionRequests: number;
  requestsPerNodeMonth: number;
  /** From --throughput: the node's cost spread over the requests it served flat out. */
  usdPerMillionAtThroughput: number | null;
  /** Records per `kind` (meter.md 0.2 to 0.4; absent is `request`). */
  kinds: Record<string, number>;
  /** The F5 to F7 fields: totals over the charged records, and how many records carried each. */
  extended: { field: ExtendedField; total: number; records: number }[];
  /** AI tokens per charged invocation in USD, when priced. */
  usdPerRequestAi: number | null;
}

/** The optional meter fields of F5 (authz, realtime), F6 and F7 (storage, images, AI, PDF). */
export const EXTENDED = ["authz_evals", "realtime_conn_seconds", "realtime_messages", "storage_bytes", "image_variants", "ai_tokens_in", "ai_tokens_out", "render_pdf_ms"] as const;
export type ExtendedField = (typeof EXTENDED)[number];

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] as number;
}

/** The unit costs of `records` under `inputs`. Records are de-duplicated on request_id first. */
export function unitCost(records: readonly MeterRecord[], inputs: CostInputs = DEFAULTS): UnitCost {
  const unique = [...new Map(records.map((r) => [r.request_id, r])).values()];
  const charged = unique.filter((r) => r.status !== "busy");
  // Billed CPU: the isolate's, the render pool's, and the PDF conversion's (meter.md 0.4: outside cpu_ms like render_ms).
  const cpu = charged.map((r) => r.cpu_ms + (r.render_ms ?? 0) + (r.render_pdf_ms ?? 0)).sort((a, b) => a - b);
  const n = Math.max(charged.length, 1);
  const cpuMsMean = cpu.reduce((a, b) => a + b, 0) / n;
  const egressBytesMean = charged.reduce((a, r) => a + r.egress_bytes + r.fetch_sent_bytes, 0) / n;
  const sellableCpuMs = inputs.vcpus * MONTH_MS * inputs.utilization;
  const usdPerCpuMs = inputs.nodeUsdPerMonth / sellableCpuMs;
  const usdPerRequestCpu = cpuMsMean * usdPerCpuMs;
  const usdPerRequestEgress = (egressBytesMean / GB) * inputs.egressUsdPerGb;
  const kinds: Record<string, number> = {};
  for (const r of unique) kinds[r.kind ?? "request"] = (kinds[r.kind ?? "request"] ?? 0) + 1;
  // storage_bytes is a level at the end of an invocation, not an amount: the report keeps its maximum.
  const extended = EXTENDED.map((field) => {
    const carried = charged.filter((r) => typeof r[field] === "number");
    const values = carried.map((r) => r[field] as number);
    return { field, total: field === "storage_bytes" ? Math.max(0, ...values) : values.reduce((a, b) => a + b, 0), records: carried.length };
  });
  const aiTokens = charged.reduce((a, r) => a + (r.ai_tokens_in ?? 0) + (r.ai_tokens_out ?? 0), 0);
  const price = inputs.aiUsdPerMillionTokens ?? null;
  return {
    records: unique.length,
    charged: charged.length,
    busy: unique.length - charged.length,
    cpuMsMean,
    cpuMsP50: quantile(cpu, 0.5),
    cpuMsP99: quantile(cpu, 0.99),
    egressBytesMean,
    usdPerCpuMs,
    usdPerRequestCpu,
    usdPerRequestEgress,
    usdPerMillionRequests: (usdPerRequestCpu + usdPerRequestEgress) * 1e6,
    requestsPerNodeMonth: cpuMsMean > 0 ? sellableCpuMs / cpuMsMean : Number.POSITIVE_INFINITY,
    usdPerMillionAtThroughput: inputs.throughput === null ? null : (inputs.nodeUsdPerMonth / (inputs.throughput * (MONTH_MS / 1000))) * 1e6,
    kinds,
    extended,
    usdPerRequestAi: price === null ? null : ((aiTokens / n) * price) / 1e6,
  };
}

/** Every record in the ndjson files under `paths` (files or directories). */
export function readRecords(paths: readonly string[]): MeterRecord[] {
  const out: MeterRecord[] = [];
  const visit = (p: string): void => {
    if (statSync(p).isDirectory()) {
      for (const name of readdirSync(p).sort()) visit(join(p, name));
      return;
    }
    if (!p.endsWith(".ndjson")) return;
    for (const line of readFileSync(p, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      const batch = JSON.parse(line) as MeterBatch;
      if (batch.schema_version !== 0) throw new Error(`${p}: unknown schema_version ${String(batch.schema_version)}`);
      out.push(...batch.records);
    }
  };
  for (const p of paths) visit(p);
  return out;
}

const usd = (v: number): string => (v >= 0.01 ? `$${v.toFixed(2)}` : `$${v.toPrecision(3)}`);

/** The report as Markdown. */
export function report(label: string, c: UnitCost, inputs: CostInputs): string {
  const lines = [
    `### ${label}`,
    "",
    `Records: ${c.records} (${c.charged} charged, ${c.busy} busy). Inputs: node ${usd(inputs.nodeUsdPerMonth)}/month, ${inputs.vcpus} vCPU, ${Math.round(inputs.utilization * 100)} % sellable CPU, egress ${usd(inputs.egressUsdPerGb)}/GB.`,
    "",
    "| Quantity | Value |",
    "| --- | --- |",
    `| Billed CPU per request (cpu_ms + render_ms + render_pdf_ms), mean / p50 / p99 | ${c.cpuMsMean.toFixed(3)} / ${c.cpuMsP50.toFixed(3)} / ${c.cpuMsP99.toFixed(3)} ms |`,
    `| Billed egress per request, mean | ${Math.round(c.egressBytesMean)} B |`,
    `| Cost per CPU-ms | ${usd(c.usdPerCpuMs)} |`,
    `| Cost per request (CPU + egress) | ${usd(c.usdPerRequestCpu + c.usdPerRequestEgress)} |`,
    `| Cost per 1M requests | ${usd(c.usdPerMillionRequests)} |`,
    `| Requests per node-month at that CPU | ${Number.isFinite(c.requestsPerNodeMonth) ? `${(c.requestsPerNodeMonth / 1e6).toFixed(0)} M` : "unbounded"} |`,
  ];
  if (c.usdPerMillionAtThroughput !== null) {
    lines.push(`| Cost per 1M requests at the measured ${inputs.throughput} req/s (whole node, flat out) | ${usd(c.usdPerMillionAtThroughput)} |`);
  }
  lines.push(`| AI tokens per invocation | ${c.usdPerRequestAi === null ? "not priced (--ai-usd-mtok)" : usd(c.usdPerRequestAi)} |`);
  lines.push("", `Invocations by kind: ${Object.entries(c.kinds).sort().map(([k, v]) => `${k} ${v}`).join(", ")}.`, "");
  lines.push("| F5 to F7 meter field | Total | Per charged invocation | Records carrying it |", "| --- | --- | --- | --- |");
  for (const e of c.extended) {
    const per = e.field === "storage_bytes" ? "(level, max)" : (e.total / Math.max(c.charged, 1)).toFixed(3);
    lines.push(`| \`${e.field}\` | ${Number.isInteger(e.total) ? e.total : e.total.toFixed(3)} | ${per} | ${e.records} |`);
  }
  return `${lines.join("\n")}\n`;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const inputs = { ...DEFAULTS };
  let label = "Meter records";
  let tenant: string | null = null;
  const paths: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    const value = (): number => {
      const v = Number(args[++i]);
      if (!Number.isFinite(v) || v <= 0) throw new Error(`${a} takes a positive number`);
      return v;
    };
    if (a === "--node-usd") inputs.nodeUsdPerMonth = value();
    else if (a === "--vcpus") inputs.vcpus = value();
    else if (a === "--utilization") inputs.utilization = Math.min(value(), 1);
    else if (a === "--egress-usd-gb") inputs.egressUsdPerGb = value();
    else if (a === "--throughput") inputs.throughput = value();
    else if (a === "--ai-usd-mtok") inputs.aiUsdPerMillionTokens = value();
    else if (a === "--label") label = args[++i] ?? label;
    else if (a === "--tenant") tenant = args[++i] ?? null;
    else paths.push(a);
  }
  if (paths.length === 0) {
    process.stderr.write("usage: unit-cost.ts [options] <meters.ndjson | dir>...\n");
    process.exit(2);
  }
  const records = readRecords(paths).filter((r) => tenant === null || r.tenant_id === tenant);
  if (records.length === 0) {
    process.stderr.write("no meter records found\n");
    process.exit(1);
  }
  process.stdout.write(report(label, unitCost(records, inputs), inputs));
}
