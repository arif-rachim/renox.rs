# renox-gateway

The data plane's front door (P3, `docs/03-architecture.md` Gateway row): hostname → tenant → deployment routing, static files from `public/`, per-IP rate limiting, and the default security headers. Leaf crate: no dependency on other `renox-*` crates, no V8 (`cargo tree -p renox-gateway | grep v8` is empty). There is no binary; `renox-worker` (`crates/renox-cell`, #29) calls `Gateway::serve`.

## Request path

1. A ULID request id is assigned.
2. **Rate limit**: token bucket per client IP (IPv6 by /64). Over the limit → `429` with `Retry-After` and an empty body (no error code: under a flood the gateway spends no bytes on a body; `docs/contracts/errors.md` "Open" 2). The cell is not called and nothing is metered.
3. **Host**: the URI authority (HTTP/2 `:authority`) or the single `Host` header, with the port and a trailing dot removed and lower-cased. Missing, repeated, or not a DNS hostname (IP literals included) → `400`.
4. **Route table** lookup (`docs/contracts/artifact.md` section 5). No entry, or only `draining` entries → `404 Not found`; no cell is touched.
5. **Static files**: a `GET`/`HEAD` whose percent-decoded path is a key of the deployment's `public/manifest.json` is served from `<artifact_root>/<deployment_hash>/public/` with `ETag` = the manifest's `sha256`, the manifest's `Content-Type`, and `Cache-Control: public, max-age=31536000, immutable` when the file name carries a content hash (`app.3f2a9c1b.js`, `logo-5d41402abc4b2a76.png`), `public, max-age=0, must-revalidate` otherwise. `If-None-Match` → `304`. The request path is never joined onto the filesystem: only manifest keys are, and those are checked against the artifact path rules. Static hits are counted (`Gateway::stats`) and not metered to the tenant quota.
6. **Body limit** (see "Input limits"), then everything else goes to the `CellDispatcher`.
7. Every response, whatever produced it, gets the default security headers (below) and `x-renox-request-id`.

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
    pub client_ip: IpAddr,        // TCP peer; IPv4-mapped IPv6 shown as IPv4
}
```

The cell implements `dispatch` (an `async fn` in the impl is fine). The gateway never knows about isolates. The request it passes has:

- the original method, URI, and body;
- hop-by-hop headers removed (`Connection` and the headers it names, `Keep-Alive`, `Proxy-*`, `TE`, `Trailer`, `Upgrade`);
- every client-sent `x-renox-*` header removed, then `x-renox-request-id` and `x-renox-client-ip` set, so tenant code can trust those two (`docs/contracts/ops.md` section 6).

`deadline` is the one clock for the request (`docs/03-architecture.md`, "Deadlines"): the cell, ops, queries, and fetches all derive their timeouts from it.

## Route table

`RouteTable` maps hostname → entries (`docs/contracts/artifact.md` section 5): at most one `active` entry and any number of `draining` ones per hostname.

- `lookup(host) -> Option<RouteEntry>` returns the active entry.
- `upsert(entry)` inserts or replaces `(hostname, deployment_hash)`; upserting an active entry turns the previous active entry of that hostname into `draining` (deployment switch).
- `remove(hostname)` drops all entries; `remove_deployment(hostname, hash)` drops one.
- `from_json` / `reload_from_json` read the F1 route table file. The file is validated as a whole (V13: schema shape, patterns, one active entry per hostname, unique `(hostname, deployment_hash)`); on failure the previous table stays in use. The worker calls `reload_from_json` on `SIGHUP`.

**Lock-free reads.** The map lives in an `ArcSwap`. A lookup is `ArcSwap::load` (an atomic pointer load, no lock, no reference-count contention between readers) plus one hash-map read. Writers clone the map, change the clone, and publish it with `ArcSwap::rcu` (compare-and-swap, retried on a concurrent write). A request sees either the table before or after a write, never a partial one, and writers never block readers.

## Default security headers

Set on every response, overwriting any value from tenant code (configuration moves to `renox.toml [security.headers]` in F2, #47; it is never done by handler code):

| Header | Value |
| --- | --- |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `X-Frame-Options` | `DENY` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` |
| `Cross-Origin-Opener-Policy` | `same-origin` |

CSP and CSRF are F2 (#47).

## TLS

`CertStore::load(&TlsConfig { cert_dir })` reads `cert_dir/<hostname>/fullchain.pem` + `privkey.pem`; a directory `_wildcard.<domain>` serves `*.<domain>` (one label: `x.wild.test`, not `wild.test` or `a.b.wild.test`). `Gateway::serve_tls(listener, certs, dispatcher)` terminates TLS with `rustls` (ring provider): TLS 1.3 preferred, 1.2 minimum, ALPN `h2` then `http/1.1`, handshake timeout 10 s.

- The certificate is chosen by SNI: exact name first, then the wildcard of the parent domain. No SNI, or an SNI with no certificate, fails the handshake; there is no default certificate, so a client never sees another tenant's certificate.
- `certs.reload()` re-reads the directory and swaps the map (`ArcSwap`): new handshakes see the new set, established connections are untouched. An entry that fails to load is reported in `LoadReport::failed` (directory name and reason, never key material) and the name keeps its previous certificate.
- Responses on TLS connections get `Strict-Transport-Security: max-age=31536000; includeSubDomains`. Plain-HTTP responses never carry it (the header is removed if tenant code set it).

Certificates are issued and pushed by the control plane from F3 (ACME, #59); keys never enter a tenant cell.

## Input limits

`GatewayLimits` (`src/limits.rs`) stops hostile input before dispatch, so it never reaches a tenant isolate (`docs/23-failure-modes.md` section 2). Defaults, configured from the worker config:

| Field | Default | Mechanism | Over the limit |
| --- | --- | --- | --- |
| `max_header_bytes` | 16 KiB | HTTP/1.1: hyper read buffer for the request head (hyper's floor is 8 KiB). HTTP/2: `SETTINGS_MAX_HEADER_LIST_SIZE` | 431, connection closed |
| `max_headers` | 100 | hyper parser (HTTP/1.1; on HTTP/2 the header list size bounds the count) | 431, connection closed |
| `max_body_bytes_default` | 1 MiB | Checked after routing, before dispatch: a declared `Content-Length` over the limit is refused before any body byte is read; a body of unknown length (chunked) is read at most up to the limit | 413 `RENOX_BODY_TOO_LARGE` (`errors.md` body: JSON, or the default HTML page when `Accept` prefers HTML) |
| `max_body_bytes_webhook` | 5 MiB | Same, for webhook routes. F1 manifests have only function routes, so it is not used yet | 413 |
| `header_read_timeout` | 10 s | hyper's HTTP/1.1 head timer (also between keep-alive requests); the TLS handshake gets the same budget | connection closed |
| `idle_timeout` | 60 s | `IdleTimeout` around the socket: no byte read or written for this long while waiting on the socket | connection closed |
| `max_connections_per_ip` | 100 | `ConnectionLimiter` at accept (IPv6 by /64) | plain HTTP: fixed `503` + `Retry-After: 1`, closed; TLS: closed before the handshake |

The protocol is chosen up front instead of sniffed: plain HTTP is HTTP/1.1 only (no h2c, no cleartext upgrade), TLS uses HTTP/2 when ALPN negotiated `h2`. A sniffing step would read the first bytes before the head timer starts. Per-app overrides are supported by `body_limit(kind, override)`, which takes `min(override, platform)`, but nothing passes an override yet: the manifest's `limits` object (`docs/contracts/artifact.md` section 3) has no body field, and adding one is a contract change.

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

## Tests

`cargo test -p renox-gateway`. `tests/gateway.rs` drives the router in memory with `tower::ServiceExt::oneshot` and a fake dispatcher that records calls; `tests/limits.rs` uses raw TCP clients against `Gateway::serve`; `tests/tls.rs` generates certificates with `rcgen` and connects with a `rustls` client.
