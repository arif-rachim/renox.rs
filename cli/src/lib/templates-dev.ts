// The dev-only browser side of `renox dev` (#43; docs/12-developer-experience.md,
// "Dev loop" step 4): an SSE channel, the error overlay, and the fragment
// swap after a template edit. The `renox dev` proxy serves the script at
// DEV_CLIENT_PATH and injects its <script> into HTML responses, so nothing
// of it is ever in an artifact or a production response (#93).
//
// Events on DEV_EVENTS_PATH (text/event-stream):
//   reload     {}                       code, routes, or config changed: reload
//   templates  { targets: string[] }    only templates changed: re-fetch the
//                                       page, swap the fragment targets that
//                                       differ; reload if anything else differs
//   error      { problems: Problem[] }  the build failed: show the overlay
//   ok         {}                       a build succeeded: hide the overlay

export const DEV_EVENTS_PATH = "/__renox/dev/events";
export const DEV_CLIENT_PATH = "/__renox/dev/client.js";

/** The browser script. Plain ES2020, no dependencies. */
export const DEV_CLIENT_JS = `(() => {
  const es = new EventSource(${JSON.stringify(DEV_EVENTS_PATH)});
  let overlay = null;
  const hide = () => { if (overlay) { overlay.remove(); overlay = null; } };
  const show = (problems) => {
    hide();
    overlay = document.createElement("renox-dev-overlay");
    const root = overlay.attachShadow({ mode: "open" });
    const box = document.createElement("div");
    box.setAttribute("style", "position:fixed;inset:0;z-index:2147483647;background:rgba(20,20,20,.92);color:#f5f5f5;font:14px/1.5 ui-monospace,monospace;padding:24px;overflow:auto");
    const h = document.createElement("h2");
    h.textContent = "renox dev: build failed";
    h.setAttribute("style", "color:#ff6b6b;margin:0 0 12px");
    box.append(h);
    for (const p of problems) {
      const pre = document.createElement("pre");
      pre.setAttribute("style", "white-space:pre-wrap;margin:0 0 12px");
      const where = p.file ? p.file + (p.line ? ":" + p.line + (p.column ? ":" + p.column : "") : "") + "  " : "";
      pre.textContent = where + p.message + (p.hint ? "\\nhint: " + p.hint : "");
      box.append(pre);
    }
    root.append(box);
    document.documentElement.append(overlay);
  };
  const swap = async (targets) => {
    const res = await fetch(location.href, { headers: { accept: "text/html" } });
    if (!res.ok) return location.reload();
    const next = new DOMParser().parseFromString(await res.text(), "text/html");
    const strip = (doc) => {
      const body = doc.body.cloneNode(true);
      for (const id of targets) { const el = body.querySelector("#" + CSS.escape(id)); if (el) el.replaceChildren(); }
      for (const el of body.querySelectorAll("script, renox-dev-overlay")) el.remove();
      return body.innerHTML;
    };
    if (strip(document) !== strip(next) || document.title !== next.title) return location.reload();
    for (const id of targets) {
      const now = document.getElementById(id);
      const then = next.getElementById(id);
      if (now && then && now.outerHTML !== then.outerHTML) now.replaceWith(document.importNode(then, true));
    }
    document.dispatchEvent(new CustomEvent("renox:dev-swapped", { detail: { targets } }));
  };
  es.addEventListener("reload", () => location.reload());
  es.addEventListener("templates", (e) => { hide(); swap(JSON.parse(e.data).targets).catch(() => location.reload()); });
  es.addEventListener("error", (e) => { if (e.data) show(JSON.parse(e.data).problems); });
  es.addEventListener("ok", hide);
})();
`;

/**
 * Adds the dev client's <script> to an HTML document: before </body>, else
 * at the end. Carries the response's CSP nonce, if any, so the strict CSP
 * (#47) allows it.
 */
export function injectDevClient(html: string, csp: string | null): string {
  const nonce = csp ? /'nonce-([A-Za-z0-9+/=_-]+)'/u.exec(csp)?.[1] : undefined;
  const tag = `<script src="${DEV_CLIENT_PATH}"${nonce ? ` nonce="${nonce}"` : ""} defer></script>`;
  const i = html.lastIndexOf("</body>");
  return i >= 0 ? `${html.slice(0, i)}${tag}${html.slice(i)}` : `${html}${tag}`;
}

/** One server-sent event. */
export const sse = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/**
 * What a rebuild means for the browser: `templates` with the fragment
 * targets of the changed pages when only page templates changed, `reload`
 * otherwise (code, routes, a layout or partial that many pages share).
 */
export function changeEvent(
  before: { hash: string; templates: Record<string, { kind: string; source: string; fragments?: Record<string, { target: string | null }> }> },
  after: { hash: string; templates: typeof before.templates },
  codeChanged: boolean,
): { event: "reload" } | { event: "templates"; targets: string[] } | null {
  if (before.hash === after.hash) return null;
  if (codeChanged) return { event: "reload" };
  const ids = new Set([...Object.keys(before.templates), ...Object.keys(after.templates)]);
  const changed = [...ids].filter((id) => before.templates[id]?.source !== after.templates[id]?.source);
  if (changed.length === 0) return { event: "reload" };
  const targets = new Set<string>();
  for (const id of changed) {
    const t = after.templates[id];
    if (!t || t.kind !== "page" || before.templates[id]?.kind !== "page") return { event: "reload" };
    for (const f of Object.values(t.fragments ?? {})) if (f.target) targets.add(f.target);
  }
  return targets.size ? { event: "templates", targets: [...targets].sort() } : { event: "reload" };
}
