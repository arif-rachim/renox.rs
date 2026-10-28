// What the dev error overlay shows for one request (#93): read from what the
// worker already wrote under .renox/: the tenant log lines carrying the
// request id (code, the limit hit, cpu/heap figures, the template of a render
// error, the cause) and the request's meter record (cpu_ms, peak heap, wall
// time). Dev only: production error pages carry the four fields of
// errors.md section 1 and nothing else.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface ErrorDetails {
  request_id: string;
  /** RENOX_* code from the log line; null when the log has none (a plain 404). */
  code: string | null;
  /** The log line's message ("request CPU limit reached; isolate recycled", ...). */
  message: string | null;
  /** The limit that was hit: "cpu", "heap", "wall", or a render limit (fuel, iterations, output, depth, time). */
  limit: string | null;
  /** The limit's value: ms for cpu and wall, bytes for heap. */
  limit_value: number | null;
  route: string | null;
  cpu_ms: number | null;
  peak_heap_bytes: number | null;
  wall_ms: number | null;
  /** Render errors: the template id and, when the cause names one, the line in the compiled template. */
  template: string | null;
  line: number | null;
  /** The redacted cause from the tenant log (render failures, internal errors). */
  cause: string | null;
  render_fuel: number | null;
}

type Line = { level?: string; request_id?: string | null; message?: string; fields?: Record<string, unknown> };
type Record_ = { request_id?: string; route?: string; cpu_ms?: number; peak_heap_bytes?: number; wall_ms?: number; render_fuel?: number };

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

function jsonLines(text: string): unknown[] {
  const out: unknown[] = [];
  for (const l of text.split("\n")) {
    if (!l) continue;
    try {
      out.push(JSON.parse(l));
    } catch {
      // A line being written; the next poll sees it whole.
    }
  }
  return out;
}

/** The tenant log lines of one request, oldest first. */
export function logLines(logFile: string, requestId: string): Line[] {
  if (!existsSync(logFile)) return [];
  return (jsonLines(readFileSync(logFile, "utf8")) as Line[]).filter((l) => l.request_id === requestId);
}

/** The meter record of one request, if it was flushed (meter batches are ndjson of `{ records: [...] }`). */
export function meterRecord(metersDir: string, requestId: string): Record_ | null {
  if (!existsSync(metersDir)) return null;
  for (const name of readdirSync(metersDir)) {
    if (!name.endsWith(".ndjson")) continue;
    for (const batch of jsonLines(readFileSync(join(metersDir, name), "utf8")) as { records?: Record_[] }[]) {
      const r = batch.records?.find((x) => x.request_id === requestId);
      if (r) return r;
    }
  }
  return null;
}

/** `(in pages/x:12)`: the template line minijinja names in a render error. */
const TEMPLATE_LINE = /\(in ([^\s:()]+):(\d+)\)/u;

/** Folds the log lines and the meter record of one request into what the overlay shows. */
export function errorDetails(requestId: string, lines: Line[], record: Record_ | null): ErrorDetails {
  // The line that carries the platform code wins; a page error may log two
  // (the failure, then the error page's own render).
  const main = lines.find((l) => typeof l.fields?.code === "string") ?? lines.at(-1);
  const f = main?.fields ?? {};
  const code = str(f.code);
  let limit = str(f.limit);
  let limitValue: number | null = null;
  if (code === "RENOX_CPU_LIMIT") [limit, limitValue] = ["cpu", num(f.limit_ms)];
  else if (code === "RENOX_OOM") [limit, limitValue] = ["heap", num(f.limit_bytes)];
  else if (code === "RENOX_DEADLINE") [limit, limitValue] = ["wall", num(f.limit_ms)];
  const cause = str(f.cause_message);
  const at = cause ? TEMPLATE_LINE.exec(cause) : null;
  return {
    request_id: requestId,
    code,
    message: str(main?.message),
    limit,
    limit_value: limitValue,
    route: str(f.route) ?? str(record?.route),
    cpu_ms: num(f.cpu_ms) ?? num(record?.cpu_ms),
    peak_heap_bytes: num(f.peak_heap_bytes) ?? num(record?.peak_heap_bytes),
    wall_ms: num(f.wall_ms) ?? num(record?.wall_ms),
    template: str(f.template) ?? (at ? (at[1] as string) : null),
    line: at ? Number(at[2]) : null,
    cause,
    render_fuel: num(f.render_fuel) ?? num(record?.render_fuel),
  };
}

/**
 * The details of `requestId` from `.renox/`: waits up to `waitMs` for the
 * meter record (the dev worker flushes meters every second), then answers
 * with whatever is there.
 */
export async function collectErrorDetails(stateDir: string, requestId: string, waitMs = 1500): Promise<ErrorDetails> {
  const logFile = join(stateDir, "logs", "tenant.ndjson");
  const meters = join(stateDir, "meters");
  const until = Date.now() + waitMs;
  let record = meterRecord(meters, requestId);
  while (!record && Date.now() < until) {
    await Bun.sleep(50);
    record = meterRecord(meters, requestId);
  }
  return errorDetails(requestId, logLines(logFile, requestId), record);
}
