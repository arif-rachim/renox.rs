# Contract: client events

| | |
| --- | --- |
| Version | **0** (F2). Written into every batch as `v`. Adding an optional field or a new `kind` is minor; renaming or removing a field or a kind, or tightening a limit, is breaking |
| Producers | the platform client script `/__renox/client.js` (#127) running in end users' browsers; the browser itself for CSP reports |
| Consumer | `crates/renox-gateway` (P3), endpoint `/__renox/events` (#126), which validates, limits, normalises, and writes to the tenant log sink. Downstream: `renox dev` overlay "Browser" tab and terminal, the MCP `dev_errors` tool, the dashboard (#128) |
| Machine-readable | [`schemas/client-event.json`](schemas/client-event.json): the batch envelope (root), one event (`$defs/event`), and the two raw CSP report bodies (`$defs/csp-report`, `$defs/csp-reports-json`) |
| Examples | [`examples/client-events/`](examples/client-events/): one valid batch per kind, valid CSP report bodies, invalid batches |
| Checker | `bun run docs/contracts/validate.ts` (schema plus rules CE1 and CE2 below) |
| Sources | `docs/12-developer-experience.md` "Client-side errors"; `docs/04-isolation-security.md` "Web-layer protections" and "Per-tenant limits" (logs); `docs/23-failure-modes.md` rows "Browser error", "Script blocked by CSP", "Client-event flood"; [`errors.md`](errors.md) |

Server-side errors are already logged with a request id (`ops.md` section 4, `errors.md` section 2). A JavaScript error in an Alpine component or an island, an htmx request that fails or finds no target, a script blocked by the strict CSP, or a realtime connection that cannot open happen only in the browser, and without this contract they are invisible to the tenant. This contract fixes what the browser reports, where it sends it, the correlation with server logs, the limits, and the privacy rules, so the gateway (#126), the client script (#127), and the dashboard (#128) build against the same thing.

Out of scope: session replay, performance and web-vitals events (a later contract), user identification of any kind.

## 1. Correlation: `x-renox-request-id`

- The gateway sets **`x-renox-request-id`** on **every** response it sends: pages, fragments, functions, static files, platform errors (413, 429, 404 for an unknown host, 503), and the `/__renox/events` endpoint itself. The value is the ULID of `RequestCtx.request_id`, the same id as in the meter record (`meter.md` section 2), the tenant log lines (`ops.md` section 4), and the error body (`errors.md` section 1). This is an existing guarantee of `crates/renox-gateway` (`REQUEST_ID_HEADER`), restated here; a client-sent `x-renox-request-id` is stripped before dispatch and never trusted.
- **Pages** additionally carry `<meta name="renox-request-id" content="<id>">` and `<meta name="renox-deployment" content="<hash>">` in `<head>` (emitted by the render path, #40/#41), because a script cannot read the headers of the document response.
- **Fragments** (htmx requests): the client script reads the header from the `XMLHttpRequest` that htmx exposes on its events (`event.detail.xhr.getResponseHeader("x-renox-request-id")`).
- An event carries the id of the page or fragment **that was on screen** when it happened (section 3, `request_id`), so the overlay and the dashboard can show the server log line and the browser error for the same request side by side.

The header name is lower-case on the wire (HTTP/2 requires it; HTTP/1.1 is case-insensitive). Earlier documents spelled it `Renox-Request-Id`; that is the same header.

## 2. Endpoint

| | |
| --- | --- |
| Path | `/__renox/events` on the **app's own origin** (every hostname of the tenant). No CORS headers are ever sent; a cross-origin page cannot read anything from it |
| Method | `POST`. Any other method: `405`, empty body, `Allow: POST` |
| Client batches | Body is the envelope of section 3 as JSON. `Content-Type` is `text/plain;charset=UTF-8` (what `navigator.sendBeacon(url, string)` sends, so no preflight) or `application/json` (a `fetch(..., { keepalive: true })` fallback) |
| CSP reports | Query `?kind=csp`. `Content-Type: application/csp-report` (the `report-uri` format, `$defs/csp-report`) or `application/reports+json` (the Reporting API format used by `report-to`, `$defs/csp-reports-json`). Normalised to `csp.violation` events (section 5) |
| Response | **`204 No Content`, always** for `POST`: when accepted, when dropped by a limit, when invalid, and when the tenant disabled events. Body empty; `Cache-Control: no-store`; `x-renox-request-id`. The response never reveals whether an event was kept, so it cannot be used to probe limits or configuration |
| Unknown host | Same as any other path: the gateway's 404 for an unknown host (no tenant to attribute the events to) |
| Isolate | The endpoint is served by the gateway and **never** dispatched to the cell or the isolate. No meter record (`meter.md` section 1: requests that never reach a cell are not metered); counted in gateway stats |
| Cookies, auth | `Cookie` and `Authorization` request headers are ignored: not parsed, not logged |
| Origin check | If the request carries `Origin` and it is not the request's own origin (`https://<Host>`), or `Sec-Fetch-Site` is `cross-site`, the body is dropped (still `204`). CSP reports are exempt from the `Origin` check, since browsers send them without one |

The tenant can switch the feature off with `[client] events = false` in `renox.toml`: the render path then does not include the client script, the CSP omits `report-uri` / `report-to`, and the endpoint drops every body (still `204`). How the flag reaches the gateway (a field of the artifact manifest) is an artifact contract change, see Open 1.

## 3. Batch envelope and common event fields

```json
{
  "v": 0,
  "events": [
    {
      "kind": "js.error",
      "ts": 1793318400123,
      "url": "/products?page=2",
      "request_id": "01JBQ3Z7MA0000000000000001",
      "deployment": "2b91fc0592294b5d6d0c56500b8c5b38af26ed6c9f75198c497c2f529cdbd8f6",
      "ua": "chrome",
      "session_fingerprint": "9f86d081884c7d65",
      "detail": { "message": "Cannot read properties of undefined (reading 'price')", "source": "/assets/cart-3f9a.js", "line": 12, "column": 7, "stack": [{ "file": "/assets/cart-3f9a.js", "line": 12, "column": 7, "function": "total" }] }
    }
  ]
}
```

Envelope:

| Field | Type | Meaning |
| --- | --- | --- |
| `v` | `0` | Contract version |
| `events` | array, 1–20 items | The events of one batch. The client script flushes when it holds 20 events, after 5 s, and on `pagehide` / `visibilitychange` to hidden |

Every event has these fields (all required, `extra` optional; no other top-level field is allowed):

| Field | Type | Meaning |
| --- | --- | --- |
| `kind` | enum, section 4 | What happened |
| `ts` | integer, Unix ms | Browser clock when it happened. Not trusted for ordering across clients; the gateway adds its own receive time to the log line |
| `url` | string, starts with `/`, no `#`, ≤ 2,048 | Path and query of the page (`location.pathname + location.search`). Never the fragment, scheme, or host |
| `request_id` | string `^[0-9A-Za-z_-]{8,64}$`, or `null` | The `x-renox-request-id` of the page or fragment on screen (section 1). `null` only for CSP reports, where the browser does not know it |
| `deployment` | 64 lower-case hex | The deployment hash of the page on screen (`<meta name="renox-deployment">`). For CSP reports the gateway fills in the hostname's active deployment |
| `ua` | enum `chrome`, `edge`, `firefox`, `safari`, `samsung`, `other` | Browser family only, no version or platform string. For CSP reports the gateway derives it from `User-Agent` and then discards the header |
| `session_fingerprint` | string `^[0-9a-f]{16}$`, or `null` | 64 random bits generated with `crypto.getRandomValues` once per page load, kept in memory only (never in a cookie or storage). Groups the events of one page view; it is not a user id and does not survive a reload. `null` for CSP reports |
| `detail` | object, per kind (section 4) | The kind-specific fields |
| `extra` | object, optional | Tenant-provided context via `renox.reportError(err, extra)` (#127): at most 16 keys matching `^[A-Za-z_][A-Za-z0-9_]{0,63}$`, values string (≤ 2,048), number, boolean, or `null`; at most **1,024 bytes** as compact JSON (rule CE2) |

Every string in an event is at most **2,048** code points; the client script truncates longer strings (keeping the start and appending `…`) before sending, and the gateway drops events that still exceed it. A stack is at most 50 frames (the innermost ones are kept).

Rules checked after the schema (`validate.ts`):

- **CE1**: the batch serialised as the client sends it (compact JSON, UTF-8) is at most **32,768 bytes**. The client splits larger batches; the gateway stops reading a body at 32 KB and drops it.
- **CE2**: `extra`, serialised as compact JSON, is at most 1,024 bytes.

## 4. Event kinds

Stack frames (`frame`) are `{ file, line, column, function }`: `file` is a path on the app's origin or a full URL for third-party scripts with query and fragment removed; `function` is the function name or `null`. Nothing else from the stack (no source text, no argument values) is kept.

| `kind` | Captured from | `detail` fields (required unless marked optional) |
| --- | --- | --- |
| `js.error` | `window.onerror` / `error` event on `window` | `message`, `source` (script file, query and fragment removed), `line`, `column`, `stack` (frames, optional when the browser gives none) |
| `js.unhandledrejection` | `unhandledrejection` event | `message` (the reason's `message`, or its `String()` truncated), `stack` (optional) |
| `js.console.error` | `console.error` calls, **dev only** (`renox dev`); the production script does not hook `console` | `message` (the arguments joined with a space, each `String()`-ed and truncated) |
| `htmx.responseError` | `htmx:responseError` | `status` (100–599), `code` (the `RENOX_*` code from the response body when it had one, else `null`, see section 7), `method`, `request_url` (path and query), `target` (CSS selector, optional) |
| `htmx.sendError` | `htmx:sendError` (network failure) | `method`, `request_url` |
| `htmx.timeout` | `htmx:timeout` | `method`, `request_url`, `timeout_ms` |
| `htmx.targetError` | `htmx:targetError` (no element matches `hx-target`) | `target` (the selector that matched nothing), `request_url` (optional) |
| `htmx.swapError` | `htmx:swapError` | `message`, `target` (optional), `request_url` (optional) |
| `csp.violation` | the browser's CSP report, normalised by the gateway (section 5), or `securitypolicyviolation` from the client script | `blocked_uri`, `violated_directive`, `effective_directive` (optional), `source_file` (optional), `line` (optional), `column` (optional), `disposition` (`enforce` / `report`) |
| `realtime.connectError` | the realtime client (`renox.realtime`, F5) failing to open | `transport` (`websocket` / `sse`), `channel_url` (path and query) |
| `realtime.closed` | an open realtime connection closing abnormally | `transport`, `channel_url`, `code` (1000–4999, WebSocket close code; `1006` for SSE errors), `reason` (≤ 123 bytes, the WebSocket limit), `was_clean` |

`target` is a CSS selector string as written in `hx-target` or computed by htmx, at most 256 code points. `request_url` and `channel_url` follow the same rule as `url`: path and query only, starting with `/`. A request to another origin is reported with the origin and path (`https://api.example.com/v1/x`), query removed.

The realtime kinds are defined now so the dashboard schema is stable; nothing produces them before the realtime client exists (F5, #70).

## 5. CSP reports

The CSP the gateway emits (#47) carries both reporting mechanisms, because browser support differs:

```
Content-Security-Policy: ...; report-uri /__renox/events?kind=csp; report-to renox-csp
Reporting-Endpoints: renox-csp="/__renox/events?kind=csp"
```

The endpoint accepts:

- `application/csp-report`: `{ "csp-report": { "document-uri", "blocked-uri", "violated-directive", "effective-directive", "source-file", "line-number", "column-number", "disposition", ... } }` (`$defs/csp-report`).
- `application/reports+json`: an array (1–20) of `{ "type": "csp-violation", "age", "url", "body": { "documentURL", "blockedURL", "effectiveDirective", "sourceFile", "lineNumber", "columnNumber", "disposition", ... } }` (`$defs/csp-reports-json`). Reports of another `type` are dropped.

Normalisation to a `csp.violation` event:

| Event field | From `csp-report` | From `reports+json` |
| --- | --- | --- |
| `ts` | receive time | receive time − `age` |
| `url` | path and query of `document-uri` | path and query of `url` / `body.documentURL` |
| `request_id`, `session_fingerprint` | `null` | `null` |
| `deployment` | active deployment of the hostname | same |
| `ua` | family from `User-Agent` | same |
| `detail.blocked_uri` | `blocked-uri`: keywords (`inline`, `eval`, `data`, `blob`, `self`) kept; URLs reduced to origin and path | `blockedURL`, same reduction |
| `detail.violated_directive` | `violated-directive` | `effectiveDirective` |
| `detail.effective_directive` | `effective-directive` | `effectiveDirective` |
| `detail.source_file`, `line`, `column` | `source-file` (query removed), `line-number`, `column-number` | `sourceFile`, `lineNumber`, `columnNumber` |
| `detail.disposition` | `disposition` (default `enforce`) | `disposition` |

Dropped and never logged: `original-policy` / `originalPolicy` (it is our own header), `referrer`, `script-sample` / `sample` (it can contain page content), `status-code`, `user_agent`.

## 6. Limits

All limits are enforced in Rust in the gateway (#126), before any parsing beyond what the limit needs. Over a limit, the body or event is **dropped and counted**, never queued, and the response is still `204`.

| Limit | Value | Over the limit |
| --- | --- | --- |
| Body size | 32,768 bytes (CE1); the gateway stops reading at that size | Body dropped |
| Events per batch | 20 (`reports+json`: 20 reports) | Body dropped |
| String length | 2,048 code points per string; 50 frames per stack; `extra` 1,024 bytes (CE2) | Event dropped (the rest of the batch is kept) |
| Requests per IP per tenant | 60 per minute (token bucket, burst 20) | Body dropped |
| Events per tenant | 1,000 per minute | Above it, 1 in 10 events is kept for the rest of the minute; kept lines carry `sample_rate: 10` |
| Events per tenant per day | 10 % of the tenant's daily log line allowance (`ops.md` section 4: 1,000 / 10,000 lines per minute × 1,440): **144,000 free / 1,440,000 paid** (proposed, Open 2) | Dropped until 00:00 UTC; one warning line per day; the dashboard shows the quota warning (#128) |

Client-event lines do not count against the per-minute `console` limit of `ops.md` section 4 (a browser error storm must not silence server logs); they have their own budget above. Each minute with drops writes one summary line `{ "source": "client", "code": "RENOX_CLIENT_EVENTS_DROPPED", "dropped": N, "reason": "body_size" | "batch_size" | "invalid" | "ip_rate" | "daily_cap" | "origin" | "disabled" }` to the tenant sink; `disabled` and `origin` are counted but not written in production.

## 7. Error codes in events

`htmx.responseError.detail.code` carries the `RENOX_*` code of the failing response when the response had one: the `error.code` of a platform JSON body (`errors.md` section 1), or the `<meta name="renox-error-code">` of the platform default or `_error.html` page (#93). It is `null` for tenant-built error responses. The dashboard links such events to the server error catalogue row and, through `request_id`, to the server log line.

## 8. Privacy

- The client script reads **no** cookies, form values, input contents, `localStorage`, `sessionStorage`, or IndexedDB, and attaches no user id. The gateway ignores the request's `Cookie` and `Authorization` headers and does not log the client IP into the tenant sink (it is used only for the per-IP bucket).
- `url` fields never contain the fragment. Third-party URLs lose their query too.
- Stack frames keep file, line, column, and function name only.
- Strings are truncated at 2,048 code points before they leave the browser.
- Secret redaction (`ops.md` section 3) applies to the log lines written from events, like to any other tenant log line.
- `[client] events = false` disables collection completely (section 2).

## 9. What the gateway writes to the tenant log sink

One line per kept event, with the standard fields (`ts` = gateway receive time, `tenant_id`, `deployment_hash` = the event's `deployment`, `request_id` = the event's `request_id`) plus `source: "client"`, `level: "error"` (`"warn"` for `csp.violation` with `disposition: report`), `kind`, `client_ts` (the event's `ts`), `url`, `ua`, `session_fingerprint`, `detail`, `extra`, and `sample_rate` when sampling. The line never contains the client IP, the `User-Agent` string, or a header value.

## 10. Errors

| Code | Where | Meaning |
| --- | --- | --- |
| `RENOX_CLIENT_EVENTS_DROPPED` | dev overlay and `renox dev` terminal only; the summary log line of section 6 | Some client events were dropped by a limit. Production pages never show it; the dashboard shows the count instead. Row in [`errors.md`](errors.md) |

## Open

1. **How `[client] events = false` reaches the gateway.** The gateway reads `<hash>/public/manifest.json` only. The flag needs a field in the artifact manifest (`artifact.md` v1, together with the `security` object of #47); until that contract bump the feature is on for every deployment.
2. **Daily cap.** 10 % of the daily log allowance is a proposal; #128 should confirm it against real event volumes in F3.
3. **Fingerprint grouping.** The dashboard groups events by a fingerprint (kind + normalised message + top frame); the exact normalisation belongs to #128 and does not change this wire format.
4. **`htmx.responseError.code` on HTML error pages** needs the `renox-error-code` meta tag from #93; until then it is `null` for page fragments and set only from JSON bodies.
