# Contract: client events

| | |
| --- | --- |
| Version | **0** (F2, #125). Written into every batch as `v` |
| Producers | The platform client script `/__renox/client.js` (P10, #127) in the browser; the browser's own CSP reporting |
| Consumers | `crates/renox-gateway` (P3, #126): the `/__renox/events` endpoint, limits, normalisation, the tenant log line; the dev overlay and `renox dev` (P11, #127); the dashboard (P13, #128) |
| Machine-readable | [`schemas/client-event.schema.json`](schemas/client-event.schema.json): the batch envelope (root), one event (`$defs/event`), and the two raw CSP report bodies (`$defs/cspReport`, `$defs/reportsJson`) |
| Examples | [`examples/client-events/`](examples/client-events/): one valid batch per event kind, a 20-event batch, both CSP report bodies, and invalid examples |
| Checker | `bun run docs/contracts/validate.ts` (schema, rules CE1 and CE2, one valid example per kind) |
| Sources | `docs/12-developer-experience.md` ("Client-side errors"), `docs/04-isolation-security.md` ("Per-tenant limits", "Web-layer protections"), `docs/09-htmx-realtime.md`, `docs/23-failure-modes.md` ("Browser error", "Script blocked by CSP", "Client-event flood") |

Server errors alone leave a page that "does nothing" when the failure is in the browser: an exception in an Alpine component or an island, an htmx request that fails or finds no target, a script blocked by the strict CSP, a WebSocket that cannot connect. This contract fixes what the browser reports, where it sends it, how it is correlated with the server's request, the limits, and the privacy rules, so the gateway (#126), the client script (#127), and the dashboard (#128) agree.

Out of scope: session replay, performance and web vitals (a later contract), and any user identification.

## 1. Correlation: `x-renox-request-id`

- **Existing guarantee.** The gateway already sets `x-renox-request-id` on every response it sends: pages, fragments, functions, static files, and every error (`errors.md` section 1; `crates/renox-gateway`, `REQUEST_ID_HEADER`). This contract uses that header. `Renox-Request-Id` in earlier documents is the same header: HTTP header names are case-insensitive, and the gateway's spelling is the one written down.
- **Pages** also carry the id in the HTML, because a script cannot read the headers of the document it runs in. The cell renders, in `<head>`:

  ```html
  <meta name="renox-request-id" content="01JBQ3Z7MA0000000000000101">
  <meta name="renox-deployment" content="<artifact hash>">
  ```

- **Fragments** are fetched by htmx with `XMLHttpRequest` on the same origin, so the script reads `xhr.getResponseHeader("x-renox-request-id")` from htmx's event.
- An event carries the request id **of the page or fragment that was on screen** when it happened. For an htmx error it is the failed request's id. The dashboard and the overlay show the server's log lines for that request next to the browser event.

## 2. Endpoint: `/__renox/events`

| | |
| --- | --- |
| Path | `/__renox/events` on the app's own origin. The gateway answers every `/__renox/*` path itself before route matching; a tenant route under it is never reached (Open 3) |
| Method | `POST`. Any other method is 405 with `Allow: POST` |
| Sent by | `navigator.sendBeacon` from the client script (fire-and-forget, survives page unload), or the browser itself for CSP reports |
| Body | The batch envelope (section 3) as `application/json` or `text/plain;charset=UTF-8` (what `sendBeacon` sends for a string); or, with `?kind=csp`, a raw CSP report body (section 6) |
| Origin | Same origin only. No CORS headers are ever sent. A request with an `Origin` header that is not the request's own origin (scheme and host) is dropped (`reason: invalid`) |
| Response | **`204 No Content`, always**, also when the body is invalid, over a limit, or dropped, with `Cache-Control: no-store` and `x-renox-request-id`. The browser learns nothing about drops, so a flood gets no feedback to tune against |
| Tenant code | Never. The endpoint is handled entirely in the gateway: no cell, no isolate, no meter record (`meter.md` section 1). It is counted in gateway metrics |
| Disabled | With `[client] events = false` in `renox.toml`, the client script is not injected and the endpoint drops everything (`reason: disabled`), still answering 204 (Open 1: how the setting reaches the gateway) |

## 3. Batch envelope

```json
{ "v": 0, "events": [ { "kind": "js.error", "...": "..." } ] }
```

| Field | Type | Meaning |
| --- | --- | --- |
| `v` | integer, `0` | This contract's version. The gateway drops a batch with another version (`reason: invalid`) |
| `events` | array, 1–20 events | Events in the order the script collected them |

A batch is validated as a whole: if the envelope or **any** event is invalid, the whole batch is dropped (`reason: invalid`). The script never sends a batch it could not validate itself, so this only drops hand-made or tampered requests.

## 4. Common event fields

Every event has these fields. No other top-level field is allowed (`additionalProperties: false`), so a script bug cannot add data the privacy rules (section 8) did not approve.

| Field | Type | Meaning |
| --- | --- | --- |
| `kind` | enum (section 5) | What happened |
| `ts` | integer, Unix time in ms | Browser clock when it happened. Not trusted for ordering against server time; the gateway adds its own receive time to the log line |
| `url` | string, path and query, ≤ 2,048 | `location.pathname + location.search` of the page. Never the scheme, host, or fragment (`#...` often holds tokens) |
| `request_id` | string or `null` | Section 1. `null` when no id was available (a page served from the browser's cache without the meta tag) |
| `deployment` | 64 hex characters or `null` | From `<meta name="renox-deployment">`; lets the dashboard group events per deployment and spot a regression |
| `ua` | `chrome` \| `edge` \| `firefox` \| `safari` \| `samsung` \| `other` | Browser family only, never the full user-agent string or a version |
| `session_fingerprint` | string, 16–32 characters `[A-Za-z0-9_-]` | Random, generated per **page load** by the script (`crypto.getRandomValues`), kept in memory only. It groups events of one page view. It is **not** a user id and is not stored in a cookie or storage |
| `code` | `RENOX_*` code or `null`, optional | The platform error code of the failing response, when there was one (read from the JSON error body or the `<meta name="renox-error-code">` of an HTML error page, Open 4). Links the event to the server error catalogue (`errors.md`) |
| `extra` | object, optional | Tenant-provided context: up to 16 keys `^[A-Za-z_][A-Za-z0-9_]{0,31}$`, values `null`, boolean, number, or a string ≤ 256; at most **1 KB** of JSON (rule CE2). Set by the app through the script's API (#127) |
| `detail` | object | Per kind (section 5) |

## 5. Event kinds

Strings in `detail` are at most 2,048 code points unless the table says otherwise. A **resource URL** (a script file, a request URL, a blocked URI) is reduced by the script before sending: same-origin → path only; cross-origin → origin and path; never a query or a fragment.

| Kind | Captured from | `detail` |
| --- | --- | --- |
| `js.error` | `window` `error` event | `message`, `source` (resource URL), `line`, `column` (integers or `null`), `stack` (frames) |
| `js.unhandledrejection` | `window` `unhandledrejection` event | `message`, `stack` (frames; empty when the reason is not an `Error`) |
| `js.console.error` | `console.error` calls. **Dev only**: the script captures it only under `renox dev`, and the production gateway drops it (`reason: invalid`) | `message` |
| `htmx.responseError` | `htmx:responseError` | `status` (100–599), `code` (`RENOX_*` from the response body, or `null`), `target` (selector), `request_url` (resource URL) |
| `htmx.sendError` | `htmx:sendError` (network failure) | `target`, `request_url` |
| `htmx.timeout` | `htmx:timeout` | `target`, `request_url` |
| `htmx.targetError` | `htmx:targetError` (the `hx-target` matches nothing) | `target` |
| `htmx.swapError` | `htmx:swapError` | `target`, `message` |
| `csp.violation` | `securitypolicyviolation` DOM event, or a browser CSP report (section 6) | `blocked_uri` (resource URL, or a CSP keyword: `inline`, `eval`, `wasm-eval`, `data`, `blob`, `trusted-types-policy`, `trusted-types-sink`, or empty), `violated_directive`, `effective_directive`, `source_file` (resource URL or `null`), `line`, `column` (integers or `null`), `disposition` (`enforce` / `report`) |
| `realtime.connectError` | SSE `error` before open, WebSocket `error` before open (`docs/09-htmx-realtime.md`) | `transport` (`sse` / `ws`), `url` (resource URL) |
| `realtime.closed` | WebSocket `close` with a code other than 1000, SSE closed by the server | `transport`, `url`, `code` (1000–4999 or `null` for SSE), `reason` (≤ 123 bytes, the WebSocket limit) |

`target` is the selector or element id htmx reports, at most 256 characters. A **stack frame** is `{ file, line, column, function }`: `file` is a resource URL and the only required field; at most 50 frames per stack.

## 6. CSP reports

The CSP the gateway sends (`docs/04-isolation-security.md`, "Web-layer protections"; `artifact.md` section 3, "Security") points the browser's own reports at this endpoint:

```
Content-Security-Policy: ...; report-uri /__renox/events?kind=csp; report-to renox-csp
Reporting-Endpoints: renox-csp="/__renox/events?kind=csp"
```

With `?kind=csp` the endpoint accepts the two bodies browsers send and normalises each report to one `csp.violation` event:

| Content type | Body | Schema |
| --- | --- | --- |
| `application/csp-report` | `{ "csp-report": { "blocked-uri", "violated-directive", "effective-directive", "source-file", "line-number", "column-number", "disposition", ... } }` (`report-uri`, CSP Level 2) | `$defs/cspReport` |
| `application/reports+json` | An array of up to 20 reports `{ "type": "csp-violation", "body": { "blockedURL", "effectiveDirective", "sourceFile", "lineNumber", "columnNumber", "disposition", ... } }` (`report-to`, Reporting API). A report of any other type makes the body invalid | `$defs/reportsJson` |

Normalisation: the URLs are reduced as in section 5; `url` is the path and query of `document-uri` / `documentURL`; `request_id` and `deployment` are `null` (browser reports carry neither) and `ua` is derived by the gateway from `User-Agent`; `session_fingerprint` is a fresh random value per report. Fields the event does not have (`original-policy`, `script-sample`, `referrer`, `status-code`) are dropped: `script-sample` can contain page text.

## 7. Limits

Enforced in the gateway (#126), before anything is parsed beyond what the limit needs. Every drop is counted per tenant and reason, and written as `RENOX_CLIENT_EVENTS_DROPPED` (`errors.md`): one summary line per minute while drops happen, never one line per drop.

| Limit | Value | Reason on drop |
| --- | --- | --- |
| Request body | 32 KB (32,768 bytes) (rule CE1); the gateway stops reading at the limit | `body_size` |
| Events per batch | 20 | `batch_size` (the schema's `maxItems`) |
| Strings | 2,048 code points (the script truncates and appends `…`; a longer string makes the batch invalid) | `invalid` |
| `extra` | 1 KB of JSON (rule CE2) | `invalid` |
| Requests per IP per tenant | 60 per minute | `ip_rate` |
| Events per tenant | 1,000 per minute; above that, 1 in 10 is kept | `sampled` |
| Events per tenant per day | 10 % of the tenant's daily log allowance (`ops.md` section 4: 1,000 / 10,000 lines per minute → 144,000 free / 1,440,000 paid per day) *proposed* | `daily_cap` |
| Invalid body, wrong `Origin`, unknown `v`, `js.console.error` in production | — | `invalid` |
| `[client] events = false` | — | `disabled` |

The dashboard shows a warning when a tenant reaches 80 % of the daily cap (#128). Client events count toward the daily cap only, not toward the tenant's per-minute log rate limit (`ops.md` section 4), so a browser flood cannot push the server's own log lines out.

## 8. Privacy

- **Never collected:** cookies, form values, input contents, `localStorage`, `sessionStorage`, IndexedDB, the full user-agent string, IP-derived location, or any user identifier. The script reads none of them.
- **URLs:** the page `url` keeps path and query; every other URL is reduced to path (same origin) or origin and path (cross origin), with no query or fragment (section 5).
- **Stacks:** frames keep `file`, `line`, `column`, and `function` only. No source text, no local variables, no `script-sample`.
- **Strings** are truncated to 2,048 code points by the script.
- **The client IP** is used by the gateway for the per-IP limit and is not written to the tenant log sink.
- **Opt-out:** `[client] events = false` in `renox.toml` disables the script and the endpoint (section 2).
- Secret redaction applies to every string of an event before it is logged (`ops.md` section 3), like any other tenant log line.

## 9. What is written

Each accepted event becomes one line in the tenant's log sink (`ops.md` section 4) with the standard fields (`ts` = gateway receive time, `tenant_id`, `deployment_hash`, `request_id` = the event's `request_id`, `level`), plus `source: "client"`, `kind`, `client_ts` (the event's `ts`), `url`, `ua`, `session_fingerprint`, `code`, `extra`, and `detail`. `deployment_hash` is the event's `deployment` when it names a deployment of this tenant, else the active one.

- Level: `error` for `js.*` and `htmx.*` kinds and enforced `csp.violation`; `warn` for `realtime.*` and report-only `csp.violation`.
- The tenant cannot tell a real event from a forged one: anyone can post to the endpoint. Client events are diagnostics only. They are never used for billing, security decisions, or alerts that page an operator, and the dashboard escapes every field it shows.
- Dev mode: `renox dev` shows the same lines as `[browser] …` in the terminal and in the overlay's "Browser" tab (#127), and the MCP `dev_errors` tool returns them.

## Open

1. **How `[client] events = false` reaches the gateway.** The gateway reads the deployment's `manifest.json` once per hash (#47). The setting needs a manifest field (for example `client.events`), which is an `artifact.md` minor change (a new optional object with a default of `true`). It is not in artifact version 1 (#152); #126 adds it through a contract issue.
2. **The daily cap.** 10 % of the daily log allowance is a proposal; #128 confirms it with the dashboard's quota view.
3. **Reserved path.** `artifact.md` should reject a tenant route under `/__renox/` at build time (a V-rule) rather than leave it unreachable. Minor change in the next artifact contract issue.
4. **`renox-error-code` meta tag.** For `code` on events from HTML error pages, the platform error page and the tenant's `_error.html` would carry `<meta name="renox-error-code">`. Whether the cell injects it into the tenant's error template is decided by #93.
5. **Fingerprint normalisation for grouping** (stripping hashes from file names, numbers from messages) is the dashboard's (#128) and does not change the event.
