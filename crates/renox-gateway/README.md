# renox-gateway

The data plane's front door (P3, `docs/03-architecture.md` Gateway row): hostname → tenant → deployment routing, static files from `public/`, per-IP rate limiting, and the default security headers. Leaf crate: no dependency on other `renox-*` crates, no V8 (`cargo tree -p renox-gateway | grep v8` is empty). There is no binary; `renox-worker` (`crates/renox-cell`, #29) calls `Gateway::serve`.

## Request path

1. A ULID request id is assigned.
2. **Rate limit**: token bucket per client IP (IPv6 by /64). Over the limit → `429` with `Retry-After` and an empty body (no error code: under a flood the gateway spends no bytes on a body; `docs/contracts/errors.md` "Open" 2). The cell is not called and nothing is metered.
3. **Host**: the URI authority (HTTP/2 `:authority`) or the single `Host` header, with the port and a trailing dot removed and lower-cased. Missing, repeated, or not a DNS hostname (IP literals included) → `400`.
4. **Route table** lookup (`docs/contracts/artifact.md` section 5). No entry, or only `draining` entries → `404 Not found`; no cell is touched.
5. **Static files**: a `GET`/`HEAD` whose percent-decoded path is a key of the deployment's `public/manifest.json` is served from `<artifact_root>/<deployment_hash>/public/` with `ETag` = the manifest's `sha256`, the manifest's `Content-Type`, and `Cache-Control: public, max-age=31536000, immutable` when the file name carries a content hash (`app.3f2a9c1b.js`, `logo-5d41402abc4b2a76.png`), `public, max-age=0, must-revalidate` otherwise. `If-None-Match` → `304`. The request path is never joined onto the filesystem: only manifest keys are, and those are checked against the artifact path rules. Static hits are counted (`Gateway::stats`) and not metered to the tenant quota.
6. Everything else goes to the `CellDispatcher`.
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

## Configuration

`GatewayConfig`:

| Field | Default | Meaning |
| --- | --- | --- |
| `artifact_root` | — | Directory holding artifact directories named by their hash |
| `wall_clock_limit` | 30 s | Used for `RequestCtx::deadline` (free tier; the route table carries no tier in F1) |
| `rate_limit.requests_per_second` | 100 | Sustained rate per client IP |
| `rate_limit.burst` | 200 | Bucket size |
| `rate_limit.max_tracked_clients` | 100,000 | When reached, fully refilled buckets are dropped |

## Tests

`cargo test -p renox-gateway`. `tests/gateway.rs` drives the router in memory with `tower::ServiceExt::oneshot` and a fake dispatcher that records calls.
