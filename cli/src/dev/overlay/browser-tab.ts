// The overlay's "Browser" tab (#127): under `renox dev`, every browser event
// the client script reports (the `renox:error` DOM event, sdk/client) is
// listed in a panel with its source file, line, column, stack, and request
// id. "Server log" fetches the server side of the same request id (the
// details the error overlay shows, details.ts) into the same panel, so
// browser and server errors of one request are on one screen. An event with
// a RENOX_* code shows the catalogue's hint (docs/contracts/errors.md).
//
// The proxy injects it first in <head>, before the client script, so it
// hears every event; it builds its panel once the body exists. Dev only, like
// overlay.ts.

import { ERROR_DETAILS_PATH, overlayRows } from "./overlay.ts";

export const BROWSER_TAB_PATH = "/__renox/dev/browser-tab.js";

/**
 * The rows of one browser event in the panel. Pure, snapshot-tested, and
 * embedded in the browser script like overlayRows.
 */
export function browserRows(e: { kind: string; url?: string; request_id?: string | null; code?: string | null; detail?: Record<string, unknown> }, hints: Record<string, string>): [string, string][] {
  const d = e.detail ?? {};
  const rows: [string, string][] = [["kind", e.kind]];
  const at = (f: unknown, l: unknown, c: unknown): string => (f ? `${f}${l != null ? `:${l}` : ""}${c != null ? `:${c}` : ""}` : "");
  if (d.message) rows.push(["message", String(d.message)]);
  if (d.source) rows.push(["source", at(d.source, d.line, d.column)]);
  if (Array.isArray(d.stack) && d.stack.length)
    rows.push(["stack", (d.stack as { file: string; line?: number; column?: number; function?: string }[]).map((s) => `${s.function ?? "(anonymous)"} ${at(s.file, s.line, s.column)}`).join("\n")]);
  if (d.status != null) rows.push(["status", String(d.status)]);
  if (d.request_url) rows.push(["request", String(d.request_url)]);
  if (d.target) rows.push(["target", String(d.target)]);
  if (d.blocked_uri !== undefined) rows.push(["blocked", `${d.effective_directive ?? ""} ${d.blocked_uri || "(empty)"}`]);
  if (d.source_file) rows.push(["in", at(d.source_file, d.line, d.column)]);
  const code = e.code ?? (typeof d.code === "string" ? d.code : null);
  if (code) {
    rows.push(["code", code]);
    if (hints[code]) rows.push(["hint", hints[code] as string]);
  }
  if (e.url) rows.push(["page", e.url]);
  rows.push(["request id", e.request_id ?? "(none)"]);
  return rows;
}

/** The browser script, with the catalogue hints inlined. Plain ES2020; styles through the CSSOM (strict CSP). */
export function browserTabJs(hints: Record<string, string>): string {
  return `(() => {
  const hints = ${JSON.stringify(hints)};
  const browserRows = ${browserRows.toString()};
  const overlayRows = ${overlayRows.toString()};
  const events = [];
  let panel = null, list = null, badge = null, open = false;
  const el = (tag, css, text) => { const n = document.createElement(tag); if (css) n.style.cssText = css; if (text != null) n.textContent = text; return n; };
  const table = (rows) => {
    const t = el("table", "border-collapse:collapse;margin:4px 0 8px");
    for (const [k, v] of rows) {
      const tr = el("tr");
      tr.append(el("th", "text-align:left;color:#aaa;padding:1px 12px 1px 0;vertical-align:top;font-weight:normal", k), el("td", "white-space:pre-wrap", v));
      t.append(tr);
    }
    return t;
  };
  const render = () => {
    if (!badge) return;
    badge.textContent = "Browser errors: " + events.length;
    badge.style.display = events.length ? "block" : "none";
    list.replaceChildren();
    list.style.display = open ? "block" : "none";
    for (const e of events) {
      const item = el("div", "border-top:1px solid #444;padding:6px 0");
      item.append(table(browserRows(e, hints)));
      if (e.request_id) {
        const btn = el("button", "background:none;color:#8cf;border:1px solid #555;border-radius:4px;cursor:pointer", "Server log for " + e.request_id);
        const server = el("div");
        btn.addEventListener("click", () => {
          fetch(${JSON.stringify(ERROR_DETAILS_PATH)} + "?id=" + encodeURIComponent(e.request_id)).then((r) => r.json()).then((d) => {
            const { title, rows } = overlayRows(e.detail && e.detail.status ? e.detail.status : 0, d);
            server.replaceChildren(el("div", "color:#ff6b6b;margin-top:4px", "Server: " + title), table(rows));
          }).catch(() => server.replaceChildren(el("div", "", "no server log for this request")));
        });
        item.append(btn, server);
      }
      list.append(item);
    }
  };
  const mount = () => {
    const host = document.createElement("renox-dev-browser");
    host.setAttribute("data-tab", "browser");
    const root = host.attachShadow({ mode: "open" });
    panel = el("div", "position:fixed;left:16px;bottom:16px;max-width:min(720px,90vw);max-height:70vh;overflow:auto;z-index:2147483645;background:rgba(20,20,20,.95);color:#f5f5f5;font:12px/1.5 ui-monospace,monospace;padding:8px 12px;border-radius:8px;border-left:4px solid #f0a020");
    badge = el("div", "cursor:pointer;color:#f0a020;display:none");
    badge.addEventListener("click", () => { open = !open; render(); });
    list = el("div");
    panel.append(badge, list);
    root.append(panel);
    document.documentElement.append(host);
    render();
  };
  document.addEventListener("renox:error", (ev) => { events.push(ev.detail); render(); });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount); else mount();
})();
`;
}
