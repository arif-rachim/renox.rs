// Browser events under `renox dev` (#127; docs/contracts/client-events.md
// section 9, "Dev mode"). The page's client script (sdk/client) posts its
// batches to /__renox/events on the dev proxy's origin; the proxy handles
// them here instead of the worker, because in dev the developer wants every
// event (the production gateway drops `js.console.error` and samples):
//
// - one terminal line per event, in the shape of the server lines:
//   `[browser] js.error pages/products/[id].html:42:7 TypeError: … (01JB…)`;
// - one line in .renox/logs/browser.ndjson, read by the MCP `dev_errors`
//   tool (cli/src/mcp/tools.ts).
//
// Browser CSP reports (`?kind=csp`) go on to the worker, whose gateway
// normalises them into tenant log lines with `source: "client"`; the
// terminal tail prints those with clientLine() too. The proxy also marks
// every page as dev (`<meta name="renox-dev">`), which turns on the script's
// `console.error` capture, and adds the overlay's Browser tab.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { DOCS } from "../mcp/docs.ts";

export const CLIENT_EVENTS_PATH = "/__renox/events";
/** At most this much body is read (the production limit, rule CE1). */
const MAX_BODY = 32 * 1024;

export interface BrowserEvent {
  kind: string;
  ts?: number;
  url?: string;
  request_id?: string | null;
  code?: string | null;
  detail?: Record<string, unknown>;
}

/** A page route of the current build: its path pattern and template id. */
export interface PageRoute {
  kind: string;
  path: string;
  template?: string;
}

/** The template file a page path is rendered from (`/products/42` → `pages/products/[id].html`), or null. */
export function templateFor(path: string, routes: PageRoute[]): string | null {
  const seg = path.split("?")[0]?.split("/").filter(Boolean) ?? [];
  for (const r of routes) {
    if (r.kind !== "page" || !r.template) continue;
    const pat = r.path.split("/").filter(Boolean);
    const rest = pat.findIndex((p) => p.startsWith("*"));
    const ok = rest >= 0 ? seg.length >= rest && pat.slice(0, rest).every((p, i) => p.startsWith(":") || p === seg[i]) : pat.length === seg.length && pat.every((p, i) => p.startsWith(":") || p === seg[i]);
    if (ok) return `${r.template}.html`;
  }
  return null;
}

const short = (s: unknown, n = 200): string => {
  const t = String(s ?? "").replace(/\s+/gu, " ");
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** Where an event happened, as precise as the event allows. */
function where(e: BrowserEvent, routes: PageRoute[]): string {
  const d = e.detail ?? {};
  const page = (e.url ?? "").split("?")[0] ?? "";
  if (e.kind === "js.error") {
    const src = String(d.source ?? "");
    // An inline script's errors point at the page: name its template.
    const file = src === page ? (templateFor(page, routes) ?? src) : src;
    return d.line != null ? `${file}:${d.line}${d.column != null ? `:${d.column}` : ""}` : file;
  }
  if (e.kind.startsWith("htmx.")) return [d.request_url, d.target].filter(Boolean).join(" → ");
  if (e.kind === "csp.violation") return `${d.effective_directive ?? ""} blocked ${d.blocked_uri || "(empty)"}`;
  return templateFor(page, routes) ?? page;
}

/** What went wrong, in a few words. */
function what(e: BrowserEvent): string {
  const d = e.detail ?? {};
  if (e.kind === "htmx.responseError") return `${d.status}${d.code ? ` ${d.code}` : ""}`;
  if (e.kind === "csp.violation") return d.source_file ? `in ${d.source_file}${d.line ? `:${d.line}` : ""}` : "";
  return short(d.message ?? "");
}

/** The terminal line of one browser event. */
export function browserLine(e: BrowserEvent, routes: PageRoute[] = []): string {
  const id = e.request_id ? ` (${e.request_id})` : "";
  const msg = what(e);
  const hint = e.code ? hintFor(e.code) : null;
  return `[browser] ${e.kind} ${where(e, routes)}${msg ? ` ${msg}` : ""}${id}${hint ? `\n    hint: ${short(hint, 240)}` : ""}`;
}

/** A tenant log line written by the gateway for a browser event (`source: "client"`), as a terminal line; null for other lines. */
export function clientLine(line: { request_id?: string | null; fields?: Record<string, unknown> }, routes: PageRoute[] = []): string | null {
  const f = line.fields ?? {};
  if (f.source !== "client" || typeof f.kind !== "string") return null;
  return browserLine({ kind: f.kind, url: String(f.url ?? ""), request_id: line.request_id ?? null, code: (f.code as string | null) ?? null, detail: (f.detail as Record<string, unknown>) ?? {} }, routes);
}

let hints: Map<string, string> | null = null;

/** The "What to do" column of the error catalogue (docs/contracts/errors.md) for a RENOX_* code. */
export function hintFor(code: string): string | null {
  if (!hints) {
    hints = new Map();
    for (const row of (DOCS["contracts/errors.md"] ?? "").split("\n")) {
      const cells = row.split(" | ");
      const m = /^\| `(RENOX_[A-Z0-9_]+)`$/u.exec(cells[0] ?? "");
      if (m && cells[6]) hints.set(m[1] as string, cells[6].trim());
    }
  }
  return hints.get(code) ?? null;
}

/** Every hint, for the overlay's Browser tab. */
export function allHints(): Record<string, string> {
  hintFor("");
  return Object.fromEntries(hints ?? []);
}

/** The events of a batch body, or null when it is not one. */
export function parseBatch(text: string): BrowserEvent[] | null {
  try {
    const b = JSON.parse(text) as { v?: unknown; events?: unknown };
    if (b.v !== 0 || !Array.isArray(b.events) || b.events.length > 20) return null;
    const events = b.events.filter((e): e is BrowserEvent => typeof e === "object" && e !== null && typeof (e as BrowserEvent).kind === "string");
    return events.length === b.events.length ? events : null;
  } catch {
    return null;
  }
}

/**
 * Handles a batch posted to the dev proxy: terminal lines and
 * .renox/logs/browser.ndjson. Always 204, like the production endpoint.
 */
export async function handleBatch(req: Request, opts: { browserLog: string; routes: () => PageRoute[]; log: (l: string) => void }): Promise<Response> {
  const text = await req.text();
  const events = text.length <= MAX_BODY ? parseBatch(text) : null;
  if (events) {
    mkdirSync(dirname(opts.browserLog), { recursive: true });
    const now = new Date().toISOString();
    for (const e of events) {
      opts.log(browserLine(e, opts.routes()));
      const level = e.kind.startsWith("realtime.") || (e.kind === "csp.violation" && e.detail?.disposition === "report") ? "warn" : "error";
      appendFileSync(
        opts.browserLog,
        `${JSON.stringify({ ts: now, level, request_id: e.request_id ?? null, message: `${e.kind}: ${short(what(e) || where(e, []), 500)}`, fields: { source: "client", kind: e.kind, url: e.url ?? null, client_ts: e.ts ?? null, code: e.code ?? null, detail: e.detail ?? {} } })}\n`,
      );
    }
  }
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}

/** Marks a page as dev for the client script: a meta tag first in <head>, before the script reads it. */
export function injectDevMeta(html: string, extra = ""): string {
  const m = /<head(\s[^>]*)?>/iu.exec(html);
  const tag = `<meta name="renox-dev" content="1">${extra}`;
  return m ? `${html.slice(0, m.index + m[0].length)}${tag}${html.slice(m.index + m[0].length)}` : html;
}
