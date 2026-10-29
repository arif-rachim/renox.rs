// GET /apps/:app/logs: the app's log lines (docs/19-platform-wireframes.md,
// 3.5) with level, source, search and time-window filters. "Live" polls the
// `log_lines` fragment every 2 s (htmx); each poll is one non-follow
// `GET /v1/apps/{app}/logs?since=` (lib/api.ts), so no request outlives the
// tenant wall-clock limit. Messages are rendered escaped; they were redacted
// on the node. A server stack's frames (`fields.frames`, #261) are listed at
// their original TypeScript position, with the bundled one beside it.
import type { LoaderContext } from "renox";

import { apiBase, type LogLine } from "../../../lib/api.ts";
import { appParam, hashParam, notFound, problem, signedIn } from "../../../lib/guard.ts";
import { clock, shortHash } from "../../../lib/view.ts";

export const WINDOWS = { "15m": 15 * 60_000, "1h": 3_600_000, "24h": 86_400_000, "7d": 7 * 86_400_000 } as const;
export const LEVELS = ["debug", "info", "warn", "error"] as const;
/** Lines shown at most, newest first. */
export const MAX_LINES = 200;

type Window = keyof typeof WINDOWS;

const pick = <T extends string>(raw: string | null, allowed: readonly T[], fallback: T): T => (allowed.includes(raw as T) ? (raw as T) : fallback);

/** The filters of the URL, normalised: what the page renders and what the poll repeats. */
export function filters(url: URL) {
  const level = pick(url.searchParams.get("level"), ["all", ...LEVELS], "all");
  const source = pick(url.searchParams.get("source"), ["all", "server", "client"], "all");
  const window = pick(url.searchParams.get("window"), Object.keys(WINDOWS) as Window[], "1h");
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 100);
  const deployment = hashParam(url.searchParams.get("deployment"));
  const live = url.searchParams.get("live") === "1";
  return { level, source, window, q, deployment, live };
}

/** A frame of `fields.frames`: the original position first, the bundled one beside it (at most 50, as the API sends). */
export function frameRows(fields: Record<string, unknown> | null): { fn: string; at: string; bundled: string | null }[] {
  const raw = fields?.frames;
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 50).flatMap((f) => {
    const o = f as { file?: unknown; line?: unknown; column?: unknown; function?: unknown; original?: { file?: unknown; line?: unknown; column?: unknown } | null };
    if (typeof o.file !== "string" || typeof o.line !== "number" || typeof o.column !== "number") return [];
    const bundled = `${o.file}:${o.line}:${o.column}`;
    const orig = o.original;
    const mapped = orig !== null && orig !== undefined && typeof orig.file === "string" && typeof orig.line === "number" && typeof orig.column === "number";
    return [{ fn: typeof o.function === "string" ? o.function : "(anonymous)", at: mapped ? `${orig.file}:${orig.line}:${orig.column}` : bundled, bundled: mapped ? bundled : null }];
  });
}

/** Lines that pass the level (at least) and search filters, newest first. */
export function visible(lines: LogLine[], f: ReturnType<typeof filters>): LogLine[] {
  const min = f.level === "all" ? 0 : LEVELS.indexOf(f.level);
  const q = f.q.toLowerCase();
  return lines
    .filter((l) => LEVELS.indexOf(l.level) >= min && (q === "" || l.message.toLowerCase().includes(q) || (l.request_id ?? "").toLowerCase().includes(q)))
    .slice(-MAX_LINES)
    .reverse();
}

/** The fields as JSON, without the frames and the raw stack when the frames are listed. */
function fieldsText(fields: Record<string, unknown> | null): string {
  if (fields === null) return "";
  if (frameRows(fields).length === 0) return JSON.stringify(fields).slice(0, 2000);
  const { frames: _f, stack: _s, ...rest } = fields;
  return Object.keys(rest).length === 0 ? "" : JSON.stringify(rest).slice(0, 2000);
}

export async function load(ctx: LoaderContext) {
  const api = await signedIn(ctx);
  if (api instanceof Response) return api;
  const name = appParam(ctx.params.app);
  if (name === null) return notFound();
  const f = filters(ctx.url);
  const query = new URLSearchParams({ level: f.level, source: f.source, window: f.window, q: f.q, ...(f.deployment === null ? {} : { deployment: f.deployment }) });
  const base = {
    signed_in: true,
    api_host: new URL(apiBase(ctx.secrets)).host,
    app: name,
    section: "logs",
    filters: f,
    windows: Object.keys(WINDOWS),
    levels: ["all", ...LEVELS],
    poll_url: `/apps/${name}/logs?${query}&live=1`,
    live_url: `/apps/${name}/logs?${query}&live=1`,
    pause_url: `/apps/${name}/logs?${query}`,
  };
  const r = await api.logs(name, {
    since: Date.now() - WINDOWS[f.window],
    source: f.source,
    ...(f.deployment === null ? {} : { deployment: f.deployment }),
  });
  if (!r.ok) return { ...base, problem: await problem(ctx, r), lines: [] };
  return {
    ...base,
    problem: null,
    lines: visible(r.value, f).map((l) => ({
      when: clock(l.ts),
      level: l.level.toUpperCase(),
      level_class: l.level,
      source: l.source,
      request_id: l.request_id ?? "—",
      deployment: shortHash(l.deployment_hash),
      module: l.module,
      message: l.message,
      fields: fieldsText(l.fields),
      frames: frameRows(l.fields),
      // A browser error links to its group (the control plane adds `fields.fingerprint` at ingestion).
      group_url: l.source === "client" && typeof l.fields?.fingerprint === "string" && /^[0-9a-f]{16}$/u.test(l.fields.fingerprint) ? `/apps/${name}/client-errors?fp=${l.fields.fingerprint}` : null,
    })),
  };
}
