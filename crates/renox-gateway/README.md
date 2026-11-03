# renox-gateway

The data plane's front door (P3, `docs/03-architecture.md` Gateway row): hostname → tenant → deployment routing, static files from `public/`, per-IP rate limiting, protocol hardening, and the default security headers. Leaf crate: no dependency on other `renox-*` crates, no V8 (`cargo tree -p renox-gateway | grep v8` is empty). There is no binary; `renox-worker` (`crates/renox-cell`, #29) calls `Gateway::serve`.

## Request path

Below the HTTP parser, the **protocol guard** (see "Protocol limits") refuses an HTTP/1 request with ambiguous framing, an h2c upgrade or the HTTP/2 preface before hyper parses it. Then, per request:

1. A ULID request id is assigned (`src/request_id.rs`). It is on every response, including the fixed `503` at the connection cap and the guard's `400` and `431`, which are written below hyper.
2. **Rate limit**: token bucket per client IP (IPv6 by /64). Over the limit → `429` with `Retry-After` and an empty body (no error code: under a flood the gateway spends no bytes on a body; `docs/contracts/errors.md` "Open" 2). The cell is not called and nothing is metered.
3. **Host**: the URI authority (absolute-form) or the single `Host` header, with the port and a trailing dot removed and lower-cased. Missing, repeated, not a DNS hostname (IP literals included), or an authority and a `Host` header naming different hosts → `400`.
4. **Route table** lookup (`docs/contracts/artifact.md` section 5). No entry, or only `draining` entries → `404 Not found`; no cell is touched.
5. **Deployment security** (#47, `src/security/`): `<hash>/manifest.json` is read once per hash for `artifact.version`, the `security` object, and `client.events`. **Platform paths** under `/__renox/` are answered next, before preflights and static files, and never reach the cell (see "Client events"). A CORS preflight (`OPTIONS` with `Access-Control-Request-Method`) is answered here: `204` with the `Access-Control-*` headers for a listed origin, method, and headers, else `403` with none; it never reaches the cell.
6. **Static files**: a `GET`/`HEAD` whose percent-decoded path is a key of the deployment's public index (`public.json` in artifact version 1, `public/manifest.json` in version 0) is served from `<artifact_root>/<deployment_hash>/public/` with `ETag` = the manifest's `sha256`, the manifest's `Content-Type`, and `Cache-Control: public, max-age=31536000, immutable` when the file name carries a content hash (`app.3f2a9c1b.js`, `logo-5d41402abc4b2a76.png`), `public, max-age=0, must-revalidate` otherwise. `If-None-Match` → `304`. The request path is never joined onto the filesystem: only manifest keys are, and those are checked against the artifact path rules. Static hits are counted (`Gateway::stats`) and not metered to the tenant quota.
7. **Body limit** (see "Input limits"), then everything else goes to the `CellDispatcher`, with a fresh CSP nonce in `RequestCtx.csp_nonce`. Per-route rate-limit buckets need route matching and are enforced by the cell (`crates/renox-cell/src/ratelimit.rs`).
9. Every response, whatever produced it, gets the protection headers (below) and `x-renox-request-id`; responses to a listed CORS origin get `Access-Control-Allow-Origin` (and `-Credentials`), and every `Access-Control-*` header tenant code set is removed.

## `CellDispatcher` and `RequestCtx`

```rust
pub trait CellDispatcher: Send + Sync + 'static {
    fn dispatch(&self, ctx: RequestCtx, req: Request<Body>)
        -> impl Future<Output = Response<Body>> + Send;
}

pub struct RequestCtx {
    pub tenant_id: String,        // from the route table entry, never from request input
    pub deployment_hash: String,  // the active deployment of the hostname
    pub request_id: String,       // ULID, also in x-renox-request-id
    pub deadline: Instant,        // accept time + wall-clock limit (30 s default)
    pub client_ip: IpAddr,        // the client (see "Client address"); IPv4-mapped IPv6 shown as IPv4
    pub csp_nonce: String,        // this request's CSP nonce (#47): the renderer's and the header's
}
```

The cell implements `dispatch` (an `async fn` in the impl is fine). The gateway never knows about isolates. The request it passes has:

- the original method, URI, and body;
- hop-by-hop headers removed (`Connection` and the headers it names, `Keep-Alive`, `Proxy-*`, `TE`, `Trailer`, `Upgrade`);
- the forwarding headers removed (`CF-Connecting-IP`, `CF-Connecting-IPv6`, `True-Client-IP`, `X-Real-IP`, `X-Forwarded-For`, `-Proto`, `-Host`, `-Port`, `Forwarded`, and the configured client-IP header), from every peer;
- every client-sent `x-renox-*` header removed except `x-renox-csrf` (the page CSRF token, which the cell checks and removes before tenant code, #41), then `x-renox-request-id` and `x-renox-client-ip` set, so tenant code can trust those two (`docs/contracts/ops.md` section 6).

`deadline` is the one clock for the request (`docs/03-architecture.md`, "Deadlines"): the cell, ops, queries, and fetches all derive their timeouts from it.

## Client address

`src/client_ip.rs` (#414, ADR D25). Behind Cloudflare every request reaches the worker from `cloudflared`, so the socket peer is the edge. `GatewayConfig.client_ip` (`ClientIpConfig`) says which peers may name the client in `header` (default `CF-Connecting-IP`):

- a TCP peer inside `trusted_proxies` (CIDR list, empty by default; `Gateway::serve`);
- a unix-socket peer whose uid, read with `SO_PEERCRED` at accept, is in `trusted_socket_uids` (`Gateway::serve_unix`; the production layout, where `cloudflared` reaches `unix:/run/renox-edge/worker.sock` as `renox-tunnel`).

From a trusted peer, a header with exactly one address names the client (v4-mapped IPv6 as IPv4); missing, repeated, comma-separated or malformed falls back to the peer. Any other peer keeps its socket address whatever it sends; an untrusted unix peer counts as `127.0.0.1`. The derived address feeds the token bucket, client events, `RequestCtx.client_ip`, `x-renox-client-ip` and the `ClientAddr` request extension (which also says whether a trusted proxy sent `X-Forwarded-Proto: https`). The forwarding headers are removed before dispatch from every peer. Connection caps run before any header is read: a trusted peer gets `limits.max_connections_per_trusted_peer` (10,000), every other peer `max_connections_per_ip`. Empty lists trust nobody, on purpose: `renox dev` connects from loopback and copies the browser's headers. Proof: `tests/client_ip.rs` (`docs/24-threat-model.md` A, "Forged client-IP header", "Local process forges the client-IP header").

## Route table

`RouteTable` maps hostname → entries (`docs/contracts/artifact.md` section 5): at most one `active` entry and any number of `draining` ones per hostname.

- `lookup(host) -> Option<RouteEntry>` returns the active entry.
- `upsert(entry)` inserts or replaces `(hostname, deployment_hash)`; upserting an active entry turns the previous active entry of that hostname into `draining` (deployment switch).
- `remove(hostname)` drops all entries; `remove_deployment(hostname, hash)` drops one.
- `from_json` / `reload_from_json` read the F1 route table file. The file is validated as a whole (V13: schema shape, patterns, one active entry per hostname, unique `(hostname, deployment_hash)`); on failure the previous table stays in use. The worker calls `reload_from_json` on `SIGHUP`.

**Lock-free reads.** The map lives in an `ArcSwap`. A lookup is `ArcSwap::load` (an atomic pointer load, no lock, no reference-count contention between readers) plus one hash-map read. Writers clone the map, change the clone, and publish it with `ArcSwap::rcu` (compare-and-swap, retried on a concurrent write). A request sees either the table before or after a write, never a partial one, and writers never block readers.

## Security headers, CSP, CORS (#47)

`src/security/` (`docs/04-isolation-security.md`, "Web-layer protections"; `docs/contracts/artifact.md` section 3, "Security"). Set on every response, overwriting any value from tenant code; configured only through `renox.toml [security]` → `manifest.security`, never by handler code. A request that reached no deployment (unknown host, bad request, rate limited) gets the defaults.

| Header | Default | Configured by |
| --- | --- | --- |
| `Content-Security-Policy` | `default-src 'self'; script-src 'self' 'nonce-<n>'; style-src 'self' 'nonce-<n>'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; report-uri /__renox/events?kind=csp; report-to renox-csp`, plus `upgrade-insecure-requests` on TLS | `csp.script_src`, `style_src` (appended), `img_src`, `connect_src`, `frame_src`, `font_src` (a directive `'self' <sources>` when listed); `csp.report_only` sends `Content-Security-Policy-Report-Only` instead |
| `Reporting-Endpoints` | `renox-csp="/__renox/events?kind=csp"` (the `report-to` group, `client-events.md` section 6) | — |
| `X-Content-Type-Options` | `nosniff` | — |
| `X-Frame-Options` | `DENY` | — (per-page `frame` export is artifact Open 6) |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | `headers.referrer_policy` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` | `headers.permissions_allow`: those features become `(self)` |
| `Cross-Origin-Opener-Policy` | `same-origin` | — |
| `Strict-Transport-Security` | Only when the trusted edge says the visitor used HTTPS (see "No TLS, no HTTP/2") | — |

**Nonce.** 128 random bits (base64), fresh per request, in `RequestCtx.csp_nonce`. The cell hands it to the renderer, which puts it on every `<script>` and `<style>` the compiler emitted (`renox-template`), so the page's tags and the header carry the same value. `upgrade-insecure-requests` is left out on plain HTTP, where it would break the `renox dev` listener on `localhost`.

**CORS.** Closed by default: no `Access-Control-*` header for any origin. `cors.origins` lists origins (never `*`); `methods` (default `GET, HEAD, POST`), `headers`, `credentials`, `max_age_s` (600) shape the preflight answer. Same-origin requests need no CORS headers. With `credentials` the session cookie may be `SameSite=None` (`renox-cell`).

**Cookies (#207).** A tenant response's `Set-Cookie` may not reach another tenant's host (`src/security/cookies.rs`; `docs/24-threat-model.md` C, "Cookie tossing between tenants"). A `Domain=` attribute is kept only when it names the request host itself (a leading dot and case are ignored), so on a custom domain the tenant may scope a cookie to that hostname. Any other `Domain=` (the platform domain's apex `renoxium.app`, `.renoxium.app`, a parent of a custom domain, another tenant's host) is removed and the cookie becomes host-only; the response is rewritten, never refused. Each header is rewritten on its own; a malformed one (no `name=`, a name that is not a token, control characters) is dropped. The gateway logs one `warn` per deployment and cookie name with the name and the removed domain, never the value. This holds until `renoxium.app` is on the Public Suffix List (`ops/psl/README.md`) and stays for custom domains after that. Applies to function and page responses; static files carry no cookies.

`renox check --security` prints the same set per route (`cli/src/check/security.ts`); both test suites assert the same default CSP string.

## No TLS, no HTTP/2 (ADR D25, #418)

The gateway serves plain HTTP/1.1 only. TLS, certificates (Cloudflare for SaaS for custom domains), HTTP/2 and its flood defences end at Cloudflare's edge, which reaches the worker through `cloudflared` on a unix socket (`Gateway::serve_unix`, see "Client address"). There is no certificate store, no SNI and no `RENOX_HOST_MISMATCH` any more. Behind the edge:

- **HTTPS as the visitor saw it** comes from the trusted proxy's `X-Forwarded-Proto: https` (`ClientAddr.forwarded_https`). Then the response gets `Strict-Transport-Security: max-age=31536000; includeSubDomains` and CSP `upgrade-insecure-requests`, and `/__renox/events` expects an `https://` `Origin`. From any other peer the header is ignored and removed, so a `renox dev` listener or a forged header never turns them on.
- **Cloudflare's limits** bind every app: a response that sends no byte for about 100 s is cut by the edge (524), so the platform's streams send a `: keep-alive` comment every 15 s (realtime SSE, `crates/renox-realtime`; log follow and the node stream, `control/api`), and a tenant's own streamed responses must write within that time; a request body above 100 MB (Free and Pro plans) is refused at the edge, above the worker's own body limits (`max_body_bytes_*`, 1 MiB and 5 MiB); `cloudflared` does not buffer `text/event-stream` or chunked responses as long as `disableChunkedEncoding` stays off (`ops/cloudflared/config.yml.example`).

## Input limits

`GatewayLimits` (`src/limits.rs`) stops hostile input before dispatch, so it never reaches a tenant isolate (`docs/23-failure-modes.md` section 2). Defaults, configured from the worker config:

| Field | Default | Mechanism | Over the limit |
| --- | --- | --- | --- |
| `max_header_bytes` | 16 KiB | The protocol guard counts head bytes (hyper's read buffer has the same size; its floor is 8 KiB) | 431 with `x-renox-request-id`, connection closed |
| `max_headers` | 100 | The protocol guard counts header lines (hyper's parser has the same limit) | 431 with `x-renox-request-id`, connection closed |
| `max_body_bytes_default` | 1 MiB | Checked after routing, before dispatch: a declared `Content-Length` over the limit is refused before any body byte is read; a body of unknown length (chunked) is read at most up to the limit | 413 `RENOX_BODY_TOO_LARGE` (`errors.md` body: JSON, or the default HTML page when `Accept` prefers HTML) |
| `max_body_bytes_webhook` | 5 MiB | Same, for webhook routes. F1 manifests have only function routes, so it is not used yet | 413 |
| `header_read_timeout` | 10 s | hyper's HTTP/1.1 head timer (also between keep-alive requests) | connection closed |
| `idle_timeout` | 60 s | `IdleTimeout` around the socket: no byte read or written for this long while waiting on the socket | connection closed |
| `max_connections_per_ip` | 100 | `ConnectionLimiter` at accept (IPv6 by /64) | fixed `503` + `Retry-After: 1`, closed |
| `max_connections_per_trusted_peer` | 10,000 | A second `ConnectionLimiter` for trusted proxies (see "Client address") | fixed `503`, closed |

Per-app overrides are supported by `body_limit(kind, override)`, which takes `min(override, platform)`, but nothing passes an override yet: the manifest's `limits` object (`docs/contracts/artifact.md` section 3) has no body field, and adding one is a contract change.

## Protocol limits

`src/protocol.rs` (#107; `docs/24-threat-model.md` section C). The gateway is the only HTTP parser between the internet and a cell, so a request that two parsers could read differently is refused here, before routing, and never reaches the `CellDispatcher`.

**HTTP/1.x guard.** `Http1Guard` wraps every connection and checks the raw bytes before hyper sees them. hyper alone accepts several of these cases: it drops `Content-Length` when `Transfer-Encoding` is also present, merges equal duplicate lengths, and accepts bare LF. The guard follows the body framing (`Content-Length` or `chunked`) to find each next request head on a keep-alive connection. It refuses:

| Refused | Why |
| --- | --- |
| `Transfer-Encoding` together with `Content-Length` (CL.TE, TE.CL) | Classic smuggling: the two parsers disagree on the body length |
| More than one `Content-Length` (even equal), or one that is not plain digits | RFC 9112 section 6.3 |
| `Transfer-Encoding` other than exactly `chunked`, repeated, or on HTTP/1.0 | `chunked, identity` and friends |
| Bare LF or bare CR as a line ending, anywhere in a head or chunk framing | Lenient parsers split lines differently |
| Obsolete line folding (a header line starting with SP or HT) | RFC 9112 section 5.2 |
| Whitespace between a header name and `:`, a name that is not a token, a control character (NUL included) in a value | RFC 9112 section 5.1 |
| A request line that is not `token SP target SP HTTP/1.0` or `HTTP/1.1` (one space each, visible ASCII target); this includes the h2c prior-knowledge preface `PRI * HTTP/2.0` | Invalid characters in the request line |
| `CONNECT` | The gateway is an origin, not a proxy |
| `Upgrade: h2c` or an `HTTP2-Settings` header | No cleartext HTTP/2 or upgrade |
| A chunk size that is not 1–16 hex digits (optional `;ext`), or chunk data not followed by CRLF | Chunk framing |

A refused first request on a connection gets a fixed `400 Bad Request` with `connection: close`. A violation later on the connection closes it without a response, because a response to an earlier request may still be in flight. A head longer than the header limit is left to hyper, which answers `431`.

**Static assets.** `StaticFiles` keys a static response by `(deployment_hash, path)`. The deployment hash is the content hash of the artifact, chosen by the hostname's route entry, so the key implies the tenant and hostname. No request header other than `If-None-Match` (which only turns a 200 into a 304) changes the response. The gateway never sets `Vary`. `public/manifest.json` has no precompressed variants, so there is no `Accept-Encoding` negotiation until a contract adds variants.

Every knob, its default, and where it is set. The knobs come from `GatewayConfig.limits` (see "Input limits"); the worker uses the defaults (the HTTP/2 flood budgets of #166 and #260 left with HTTP/2, #418).

| Knob | Default | Config key | Mechanism |
| --- | --- | --- | --- |
| HTTP/1 head read timeout | 10 s | `limits.header_read_timeout` | hyper `http1::Builder::header_read_timeout` |
| HTTP/1 read buffer (head size) | 16 KiB | `limits.max_header_bytes` | hyper `max_buf_size`; also the guard's line buffer |
| HTTP/1 header count | 100 | `limits.max_headers` | hyper `max_headers` |
| HTTP/1 half-close | off | fixed | hyper `half_close(false)`: a client `FIN` ends the connection |
| HTTP/1 pipeline flush aggregation | off | fixed | hyper `pipeline_flush(false)` |
| HTTP/1 multiple spaces in the request line | refused | fixed | hyper `allow_multiple_spaces_in_request_line_delimiters(false)`, and the guard |
| HTTP/1 invalid header lines | refused | fixed | hyper `ignore_invalid_headers(false)`, and the guard |
| HTTP/1 framing rules (table above) | on | fixed | `Http1Guard` |
| h2c / cleartext upgrade | refused | fixed | plain listener is HTTP/1 only; `Upgrade: h2c` refused by the guard; `Upgrade` stripped before dispatch |

`Gateway::stats()` counts `protocol_refused` (connections closed by the guard).

## WebSocket upgrades (#281)

Upgrades are enabled on HTTP/1.1 (`serve_connection(..).with_upgrades()`); `cloudflared` carries WebSocket upgrades through the tunnel as HTTP/1.1 `Upgrade` requests (tests/upgrade.rs drives one over a plain HTTP/1.1 front). `src/upgrade.rs`:

- A request with `Connection: upgrade` and `Upgrade: websocket` is checked before dispatch: `GET` over HTTP/1.1 (else 405 `Allow: GET`), `Sec-WebSocket-Version: 13` (else 426 with `Sec-WebSocket-Version: 13`), a `Sec-WebSocket-Key` of 16 base64 bytes (else 400). A refused handshake never reaches the cell.
- An accepted handshake reaches the cell like any request (hop-by-hop headers removed) with a `WsUpgrade` in its extensions. The cell decides: route kind `ws`, the principal and `guard`, the connection caps (`Origin` is #118). It answers `WsUpgrade::accept()` (101 with `Sec-WebSocket-Accept`) and takes the connection with `WsUpgrade::upgraded()`, or answers anything else and the connection stays HTTP/1.
- SSE needs nothing here: it is a streamed `200 text/event-stream` response.
- **Guard handover (#167).** The HTTP/1 protocol guard parses every byte of a connection as HTTP/1 framing. When the gateway answers 101, it sets the connection's `UpgradeSwitch` before hyper writes the response, and the guard passes everything after it through: frames reach the cell. Only a 101 sets it; a request carrying `Upgrade: websocket` that is answered with anything else stays under the guard, and its next head is checked as before. A client that sends frames before it has read the 101 gets them parsed as HTTP/1 and refused, as RFC 6455 requires clients to wait.

Tests: `tests/upgrade.rs`.

## Client events (#126)

`docs/contracts/client-events.md`. The gateway serves two platform paths for every app:

- `/__renox/client.js` (`src/client_script.rs`): the platform client script, embedded from `assets/renox-client.js` (built from `sdk/client/` by #127 and committed, so a Rust build needs no Bun). `ETag` is its SHA-256; pages reference it as `/__renox/client.js?v=<first 16 hex>`, so it is served `immutable`.
- `/__renox/events` (`src/client_events.rs`): browser events and CSP reports. `POST` only (else 405 `Allow: POST`), always `204` with `Cache-Control: no-store`. Checks in order: `client.events = false` → `disabled`; an `Origin` other than the request's own scheme and host → `invalid`; 60 requests per minute per client IP per tenant → `ip_rate`; body over 32 KB (declared or read, never read past) → `body_size`; more than 20 events → `batch_size`; the batch against `client-event.schema.json`, rule CE2, and `js.console.error` (dev only) → `invalid`; per tenant, the daily cap (144,000 kept events, free tier) → `daily_cap`, and over 1,000 events a minute one in ten kept → `sampled`. With `?kind=csp`, an `application/csp-report` or `application/reports+json` body is normalised to `csp.violation` events (URLs reduced, `ua` from `User-Agent`, `original-policy` and other extra members dropped) and validated as events.

Accepted events go to the `ClientEventSink` the worker attaches (`Gateway::set_client_event_sink`; `renox-cell` writes them to the tenant log through the runtime's redacting sink) as one line each with `source: "client"`, `kind`, `client_ts`, `url`, `ua`, `session_fingerprint`, `code`, `extra`, `detail`, the event's `request_id`, and the event's `deployment` when the host routes to it. Drops are counted in `Gateway::stats().client_events` and written to the tenant log as `RENOX_CLIENT_EVENTS_DROPPED` (`reason`, `dropped`), at most once a minute per tenant. The client IP is never logged.

The CSP carries `report-uri /__renox/events?kind=csp; report-to renox-csp`, and every response `Reporting-Endpoints: renox-csp="/__renox/events?kind=csp"`.

## Compression

`src/compress.rs` (#159). Dynamic responses only: the cell calls `compress::negotiate(&request_headers)` and `compress::apply(response, encoding)` **before** it writes the meter record, so `egress_bytes` is the body bytes sent on the wire (`docs/contracts/meter.md`). Static files from `public/` are not compressed (#107 forbids a `Vary` from request headers on static assets until a contract adds precompressed variants).

- **What:** `text/*`, `application/json`, and `application/*+json` bodies of at least 1 KB (`MIN_BYTES`), with brotli (quality 4) or gzip, whichever `Accept-Encoding` ranks higher (`br` on a tie; `x-gzip` and `*` count; `q=0` refuses). A body that would not get smaller is sent as is.
- **`Vary`:** every response of those types gets `Vary: Accept-Encoding`, compressed or not (merged into an existing `Vary`, never next to `Vary: *`). A strong `ETag` becomes weak on a compressed body.
- **Never compressed:** a response carrying the `compress::NoCompress` extension, the cell's BREACH mark for responses that reflect a secret (a CSRF token, #111) next to request input (`docs/24-threat-model.md`, "End user"). It is a response extension, not a header, so tenant code can neither set nor see it. Also left alone: a response that already has `Content-Encoding`, `Cache-Control: no-transform`, `Content-Range`, 204, 206, and 304.
- **Tests:** `tests/compress.rs` (negotiation, `Vary`, the uncompressed path, `NoCompress`); `crates/renox-cell/tests/compress.rs` (through the worker, egress = wire bytes).

## Configuration

`GatewayConfig`:

| Field | Default | Meaning |
| --- | --- | --- |
| `artifact_root` | — | Directory holding artifact directories named by their hash |
| `wall_clock_limit` | 30 s | Used for `RequestCtx::deadline` (free tier; the route table carries no tier in F1) |
| `rate_limit.requests_per_second` | 100 | Sustained rate per client IP |
| `rate_limit.burst` | 200 | Bucket size |
| `rate_limit.max_tracked_clients` | 100,000 | When reached, fully refilled buckets are dropped |
| `limits` | see "Input limits" | Header, body, timeout, and connection limits |
| `client_events` | see "Client events" | `/__renox/events` limits (`ClientEventLimits`) |
| `client_ip` | trusts nobody | Which peers may name the client (`ClientIpConfig`: `trusted_proxies`, `trusted_socket_uids`, `header`); see "Client address" |
| `security_txt` | `None` | The platform's `/.well-known/security.txt` (RFC 9116, #121), answered before route lookup on its hosts only. `well_known::Settings::build` makes it from `worker.toml` `[gateway.security_txt]` (#364): `hosts` (default `renoxium.app`, the platform domain's apex), `contacts` (default `mailto:security@renoxium.com`), `canonical` (default `https://<first host>/.well-known/security.txt`), `policy`; a file RFC 9116 refuses is an error. The worker sets it in controlled mode |

## Tests

`cargo test -p renox-gateway`. `tests/gateway.rs` drives the router in memory with `tower::ServiceExt::oneshot` and a fake dispatcher that records calls; `tests/limits.rs` uses raw TCP clients against `Gateway::serve`; `tests/protocol.rs` sends hand-written bytes (smuggling, h2c, the HTTP/2 preface); `tests/client_ip.rs` drives TCP and unix-socket peers with forged forwarding headers; `tests/client_events.rs` posts the contract's examples to `/__renox/events` and checks the request id on every response kind.
