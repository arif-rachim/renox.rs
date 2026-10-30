// The dev error overlay (#93; docs/12-developer-experience.md, "Debugging"):
// when a page answers with an error under `renox dev`, the proxy adds a
// script that asks the proxy for the request's details (details.ts) and shows
// them over the page: the code, the limit hit, cpu_ms and heap, and the
// template and line of a render error.
//
// Only the `renox dev` proxy serves and injects it. Nothing here is in an
// artifact or in a worker response: production error pages carry the four
// fields of errors.md section 1 and nothing else (crates/renox-cell/tests/
// errors.rs and cli/tests/overlay.test.ts check both sides).

import type { ErrorDetails } from "./details.ts";

export const ERROR_OVERLAY_PATH = "/__renox/dev/error-overlay.js";
export const ERROR_DETAILS_PATH = "/__renox/dev/error";

/**
 * The overlay's title and rows for one error. Pure, so it is snapshot-tested
 * and also the code the browser runs: ERROR_OVERLAY_JS embeds its source.
 */
export function overlayRows(status: number, d: ErrorDetails): { title: string; rows: [string, string][] } {
  // Self-contained: the browser runs this function's source.
  const names: Record<string, string> = {
    cpu: "CPU time per request",
    heap: "V8 heap per isolate",
    wall: "wall-clock time per request",
    fuel: "render fuel",
    iterations: "render loop iterations",
    output: "render output size",
    depth: "template include depth",
    time: "render time",
  };
  const mb = (b: number): string => `${(b / (1024 * 1024)).toFixed(1)} MB`;
  const rows: [string, string][] = [];
  rows.push(["code", d.code ?? (status === 404 ? "404 (no route)" : String(status))]);
  if (d.message) rows.push(["what happened", d.message]);
  if (d.limit) {
    let value = "";
    if (d.limit_value !== null) value = d.limit === "heap" ? ` (${mb(d.limit_value)})` : ` (${d.limit_value} ms)`;
    rows.push(["limit hit", `${names[d.limit] ?? d.limit}${value}`]);
  }
  if (d.route) rows.push(["route", d.route]);
  if (d.cpu_ms !== null) rows.push(["cpu_ms", d.cpu_ms.toFixed(1)]);
  if (d.peak_heap_bytes !== null) rows.push(["heap", mb(d.peak_heap_bytes)]);
  if (d.wall_ms !== null) rows.push(["wall_ms", d.wall_ms.toFixed(1)]);
  if (d.template) rows.push(["template", d.line !== null ? `${d.template}:${d.line}` : d.template]);
  if (d.render_fuel !== null && d.code === "RENOX_RENDER_LIMIT") rows.push(["render_fuel", String(d.render_fuel)]);
  // #294: an authorization denial: what was asked, by whom, and the policy that decided (dev mode names it).
  if (d.code === "RENOX_FORBIDDEN") {
    if (d.action) rows.push(["action", d.action]);
    if (d.resource) rows.push(["resource", d.resource]);
    if (d.principal) rows.push(["principal", d.principal]);
    rows.push(["policy", d.policy ?? "no policy permits it (default deny)"]);
    if (d.reason) rows.push(["reason", d.reason]);
  }
  // #294: a db.scoped() refusal: the owned table and the statement shape.
  if (d.code === "RENOX_DB_SCOPE") {
    const shapes: Record<string, string> = {
      unscoped: "a statement on an owned table outside db.scoped()",
      unprovable: "a shape the scope cannot be proven for (a subquery, a CTE, a set operation, a RIGHT/FULL join, UPDATE … FROM, INSERT … SELECT, INSERT without a column list, an upsert)",
      owner_mismatch: "an INSERT with another owner than the scope",
      scope_missing: "a scope without the value the table needs",
    };
    if (d.table) rows.push(["table", d.module ? `${d.table} (module ${d.module})` : d.table]);
    if (d.reason) rows.push(["statement", `${d.reason}: ${shapes[d.reason] ?? d.reason}`]);
    if (d.principal) rows.push(["principal", d.principal]);
  }
  if (d.cause) rows.push(["cause", d.cause]);
  rows.push(["request id", d.request_id]);
  return { title: `renox dev: ${status} ${d.code ?? ""}`.trim(), rows };
}

/** The browser script. Plain ES2020, no dependencies, styles through the CSSOM (the strict CSP refuses inline styles). */
export const ERROR_OVERLAY_JS = `(() => {
  const me = document.currentScript;
  const id = me && me.dataset.requestId;
  const status = Number(me && me.dataset.status);
  if (!id) return;
  const overlayRows = ${overlayRows.toString()};
  fetch(${JSON.stringify(ERROR_DETAILS_PATH)} + "?id=" + encodeURIComponent(id))
    .then((r) => r.json())
    .then((d) => {
      const { title, rows } = overlayRows(status, d);
      const host = document.createElement("renox-dev-error");
      const root = host.attachShadow({ mode: "open" });
      const box = document.createElement("div");
      box.style.cssText = "position:fixed;inset:auto 16px 16px 16px;max-height:60vh;overflow:auto;z-index:2147483646;background:rgba(20,20,20,.95);color:#f5f5f5;font:13px/1.5 ui-monospace,monospace;padding:16px 20px;border-radius:8px;border-left:4px solid #ff6b6b";
      const h = document.createElement("h2");
      h.textContent = title;
      h.style.cssText = "color:#ff6b6b;margin:0 0 8px;font-size:15px";
      const close = document.createElement("button");
      close.textContent = "close";
      close.style.cssText = "float:right;background:none;color:#aaa;border:1px solid #555;border-radius:4px;cursor:pointer";
      close.addEventListener("click", () => host.remove());
      box.append(close, h);
      const table = document.createElement("table");
      for (const [k, v] of rows) {
        const tr = document.createElement("tr");
        const th = document.createElement("th");
        th.textContent = k;
        th.style.cssText = "text-align:left;color:#aaa;padding:2px 16px 2px 0;vertical-align:top;font-weight:normal";
        const td = document.createElement("td");
        td.textContent = v;
        td.style.cssText = "white-space:pre-wrap";
        tr.append(th, td);
        table.append(tr);
      }
      box.append(table);
      root.append(box);
      document.documentElement.append(host);
    })
    .catch(() => {});
})();
`;

/**
 * Adds the overlay's <script> to an HTML error page, before </body> (else at
 * the end), with the response's CSP nonce, request id, and status.
 */
export function injectErrorOverlay(html: string, requestId: string, status: number, csp: string | null): string {
  const nonce = csp ? /'nonce-([A-Za-z0-9+/=_-]+)'/u.exec(csp)?.[1] : undefined;
  const id = requestId.replace(/[^0-9A-Za-z_-]/gu, "");
  const tag = `<script src="${ERROR_OVERLAY_PATH}"${nonce ? ` nonce="${nonce}"` : ""} data-request-id="${id}" data-status="${status}"></script>`;
  const i = html.lastIndexOf("</body>");
  return i >= 0 ? `${html.slice(0, i)}${tag}${html.slice(i)}` : `${html}${tag}`;
}
