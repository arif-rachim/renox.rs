//! Gateway routing, static files, rate limiting, and headers (#22), with
//! in-memory requests (`tower::ServiceExt::oneshot`) and a fake dispatcher
//! (`docs/12-developer-experience.md`, rule 4).

mod common;

use std::sync::Arc;

use axum::body::{Body, to_bytes};
use axum::http::{Method, StatusCode};
use common::*;
use renox_gateway::{
    CLIENT_IP_HEADER, Gateway, GatewayConfig, REQUEST_ID_HEADER, RateLimitConfig, RouteStatus,
    RouteTable, SECURITY_HEADERS,
};
use tower::ServiceExt;

fn gateway(root: &std::path::Path) -> Gateway {
    let routes = Arc::new(RouteTable::new());
    routes
        .upsert(entry("a.test", "t_a", HASH_A, RouteStatus::Active))
        .unwrap();
    routes
        .upsert(entry("b.test", "t_b", HASH_B, RouteStatus::Active))
        .unwrap();
    Gateway::new(GatewayConfig::new(root), routes)
}

async fn body_string(resp: axum::http::Response<Body>) -> String {
    String::from_utf8(to_bytes(resp.into_body(), 1 << 20).await.unwrap().to_vec()).unwrap()
}

#[tokio::test]
async fn routes_by_host() {
    let dir = tempfile::tempdir().unwrap();
    let gw = gateway(dir.path());
    let cell = FakeDispatcher::new();
    let app = gw.router(cell.clone());

    let resp = app
        .clone()
        .oneshot(request("A.Test:8080", "/api/hello"))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(body_string(resp).await, "tenant=t_a");
    let (ctx, req) = cell.last();
    assert_eq!(ctx.tenant_id, "t_a");
    assert_eq!(ctx.deployment_hash, HASH_A);
    assert_eq!(req.uri().path(), "/api/hello");

    let resp = app.oneshot(request("b.test", "/")).await.unwrap();
    assert_eq!(body_string(resp).await, "tenant=t_b");
    assert_eq!(cell.last().0.tenant_id, "t_b");
    assert_eq!(gw.stats().dispatched, 2);
}

/// `docs/23-failure-modes.md` section 2, "Unknown `Host`": 404, no cell touched.
#[tokio::test]
async fn unknown_host_is_404_and_no_cell_is_touched() {
    let dir = tempfile::tempdir().unwrap();
    let gw = gateway(dir.path());
    let cell = FakeDispatcher::new();
    let resp = gw
        .router(cell.clone())
        .oneshot(request("nope.test", "/"))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    assert_eq!(body_string(resp).await, "Not found");
    assert_eq!(cell.count(), 0);
    assert_eq!(gw.stats().unknown_host, 1);
}

/// `docs/23-failure-modes.md` section 2, "Malformed `Host`": 400, no cell touched.
#[tokio::test]
async fn malformed_or_missing_host_is_400() {
    let dir = tempfile::tempdir().unwrap();
    let gw = gateway(dir.path());
    let cell = FakeDispatcher::new();
    let app = gw.router(cell.clone());
    for host in ["a_b.test", "[::1]:80", "a.test:x", "a.test:80:80"] {
        let resp = app.clone().oneshot(request(host, "/")).await.unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST, "{host}");
    }
    let mut no_host = request("a.test", "/");
    no_host.headers_mut().remove("host");
    let resp = app.oneshot(no_host).await.unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    assert_eq!(cell.count(), 0);
}

/// A deployment switch leaves the old deployment `draining`: it stays in the
/// table, and new requests go to the active entry (`artifact.md` section 5).
#[tokio::test]
async fn draining_entry_stays_listed_and_active_one_routes() {
    let dir = tempfile::tempdir().unwrap();
    let routes = Arc::new(RouteTable::new());
    routes
        .upsert(entry("a.test", "t_a", HASH_A, RouteStatus::Active))
        .unwrap();
    // New deployment for the same host: the old one becomes draining.
    routes
        .upsert(entry("a.test", "t_a", HASH_B, RouteStatus::Active))
        .unwrap();
    let all = routes.entries("a.test");
    assert_eq!(all.len(), 2);
    assert_eq!(
        all.iter()
            .find(|e| e.deployment_hash == HASH_A)
            .unwrap()
            .status,
        RouteStatus::Draining
    );

    let gw = Gateway::new(GatewayConfig::new(dir.path()), routes.clone());
    let cell = FakeDispatcher::new();
    let resp = gw
        .router(cell.clone())
        .oneshot(request("a.test", "/"))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(cell.last().0.deployment_hash, HASH_B);

    // Once the draining deployment is gone, routing is unchanged.
    assert!(routes.remove_deployment("a.test", HASH_A));
    let resp = gw
        .router(cell.clone())
        .oneshot(request("a.test", "/"))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(cell.last().0.deployment_hash, HASH_B);
}

/// A hostname whose entries are all draining is answered like an unknown
/// host (`artifact.md` section 5).
#[tokio::test]
async fn host_with_only_draining_entries_is_404() {
    let dir = tempfile::tempdir().unwrap();
    let routes = Arc::new(RouteTable::new());
    routes
        .upsert(entry("a.test", "t_a", HASH_A, RouteStatus::Draining))
        .unwrap();
    let gw = Gateway::new(GatewayConfig::new(dir.path()), routes);
    let cell = FakeDispatcher::new();
    let resp = gw
        .router(cell.clone())
        .oneshot(request("a.test", "/"))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    assert_eq!(cell.count(), 0);
}

#[tokio::test]
async fn remove_hostname_makes_it_unknown() {
    let dir = tempfile::tempdir().unwrap();
    let gw = gateway(dir.path());
    assert!(gw.routes().remove("a.test"));
    let cell = FakeDispatcher::new();
    let resp = gw
        .router(cell.clone())
        .oneshot(request("a.test", "/"))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}

/// Static file from `public/manifest.json`, served without touching the cell.
#[tokio::test]
async fn static_file_served_with_etag() {
    let dir = tempfile::tempdir().unwrap();
    write_public(
        dir.path(),
        HASH_A,
        &[
            (
                "robots.txt",
                b"User-agent: *\nDisallow:\n",
                "text/plain; charset=utf-8",
            ),
            (
                "assets/app.3f2a9c1b.js",
                b"console.log(1)",
                "text/javascript",
            ),
        ],
    );
    let gw = gateway(dir.path());
    let cell = FakeDispatcher::new();
    let app = gw.router(cell.clone());

    let resp = app
        .clone()
        .oneshot(request("a.test", "/robots.txt"))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let etag = format!("\"{STATIC_SHA256}\"");
    assert_eq!(resp.headers()["etag"], etag.as_str());
    assert_eq!(resp.headers()["content-type"], "text/plain; charset=utf-8");
    assert_eq!(
        resp.headers()["cache-control"],
        "public, max-age=0, must-revalidate"
    );
    assert_eq!(body_string(resp).await, "User-agent: *\nDisallow:\n");

    // Hashed path: immutable.
    let resp = app
        .clone()
        .oneshot(request("a.test", "/assets/app.3f2a9c1b.js"))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(
        resp.headers()["cache-control"],
        "public, max-age=31536000, immutable"
    );
    assert_eq!(resp.headers()["content-type"], "text/javascript");

    // Revalidation.
    let mut cond = request("a.test", "/robots.txt");
    cond.headers_mut()
        .insert("if-none-match", etag.parse().unwrap());
    let resp = app.clone().oneshot(cond).await.unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_MODIFIED);

    // HEAD: headers, no body.
    let mut head = request("a.test", "/robots.txt");
    *head.method_mut() = Method::HEAD;
    let resp = app.clone().oneshot(head).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(resp.headers()["content-length"], "24");
    assert_eq!(body_string(resp).await, "");

    // Not in the manifest, a POST, or a traversal attempt: goes to the cell,
    // never to the filesystem.
    for (method, path) in [
        (Method::GET, "/missing.txt"),
        (Method::POST, "/robots.txt"),
        (Method::GET, "/assets/../robots.txt"),
        (Method::GET, "/%2e%2e/%2e%2e/etc/passwd"),
        (Method::GET, "/manifest.json"),
    ] {
        let mut req = request("a.test", path);
        *req.method_mut() = method;
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(body_string(resp).await, "tenant=t_a", "{path}");
    }
    assert_eq!(gw.stats().static_hits, 4);
    assert_eq!(cell.count(), 5);

    // Another tenant's host does not see tenant A's files.
    let resp = app.oneshot(request("b.test", "/robots.txt")).await.unwrap();
    assert_eq!(body_string(resp).await, "tenant=t_b");
}

/// `docs/23-failure-modes.md` section 2, "Request flood from one IP": token
/// bucket, 429 with `Retry-After`, the cell is not called.
#[tokio::test]
async fn rate_limited_after_the_burst() {
    let dir = tempfile::tempdir().unwrap();
    let mut config = GatewayConfig::new(dir.path());
    config.rate_limit = RateLimitConfig {
        requests_per_second: 1.0,
        burst: 5,
        ..RateLimitConfig::default()
    };
    let routes = Arc::new(RouteTable::new());
    routes
        .upsert(entry("a.test", "t_a", HASH_A, RouteStatus::Active))
        .unwrap();
    let gw = Gateway::new(config, routes);
    let cell = FakeDispatcher::new();
    let app = gw.router(cell.clone());
    let attacker = "198.51.100.7:4000".parse().unwrap();
    for _ in 0..5 {
        let resp = app
            .clone()
            .oneshot(request_from("a.test", "/", attacker))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }
    let resp = app
        .clone()
        .oneshot(request_from("a.test", "/", attacker))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(resp.headers()["retry-after"], "1");
    for (name, _) in SECURITY_HEADERS {
        assert!(resp.headers().contains_key(name));
    }
    assert_eq!(cell.count(), 5);
    assert_eq!(gw.stats().rate_limited, 1);

    // Other clients are unaffected.
    let resp = app
        .oneshot(request_from(
            "a.test",
            "/",
            "198.51.100.8:4000".parse().unwrap(),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
}

/// Default security headers on every response kind, overriding the tenant.
#[tokio::test]
async fn security_headers_on_every_response() {
    let dir = tempfile::tempdir().unwrap();
    write_public(dir.path(), HASH_A, &[("a.txt", b"a", "text/plain")]);
    let gw = gateway(dir.path());
    let app = gw.router(FakeDispatcher::new());
    for (host, path) in [
        ("a.test", "/fn"),
        ("a.test", "/a.txt"),
        ("nope.test", "/"),
        ("bad_host", "/"),
    ] {
        let resp = app.clone().oneshot(request(host, path)).await.unwrap();
        for (name, value) in SECURITY_HEADERS {
            assert_eq!(resp.headers()[name], value, "{host}{path} {name}");
        }
        // HSTS is only sent on TLS connections (#23).
        assert!(!resp.headers().contains_key("strict-transport-security"));
    }
}

/// `x-renox-request-id` is assigned by the gateway, sent to the cell, and
/// echoed on the response; client-sent `x-renox-*` and hop-by-hop headers
/// never reach the cell (`ops.md` section 6).
#[tokio::test]
async fn request_id_echoed_and_untrusted_headers_stripped() {
    let dir = tempfile::tempdir().unwrap();
    let gw = gateway(dir.path());
    let cell = FakeDispatcher::new();
    let app = gw.router(cell.clone());
    let mut req = request("a.test", "/");
    let h = req.headers_mut();
    h.insert(REQUEST_ID_HEADER, "spoofed".parse().unwrap());
    h.insert(CLIENT_IP_HEADER, "10.0.0.1".parse().unwrap());
    h.insert("x-renox-tenant", "t_b".parse().unwrap());
    h.insert("connection", "keep-alive, x-secret-hop".parse().unwrap());
    h.insert("x-secret-hop", "1".parse().unwrap());
    h.insert("te", "trailers".parse().unwrap());
    h.insert("accept", "text/plain".parse().unwrap());
    let started = std::time::Instant::now();
    let resp = app.clone().oneshot(req).await.unwrap();
    let finished = std::time::Instant::now();

    let id = resp.headers()[REQUEST_ID_HEADER]
        .to_str()
        .unwrap()
        .to_owned();
    assert_eq!(id.len(), 26, "ULID");
    assert!(ulid::Ulid::from_string(&id).is_ok());
    let (ctx, seen) = cell.last();
    assert_eq!(ctx.request_id, id);
    assert_eq!(seen.headers()[REQUEST_ID_HEADER], id.as_str());
    assert_eq!(seen.headers()[CLIENT_IP_HEADER], "192.0.2.10");
    assert_eq!(ctx.client_ip.to_string(), "192.0.2.10");
    assert_eq!(ctx.tenant_id, "t_a");
    for gone in ["x-renox-tenant", "connection", "x-secret-hop", "te"] {
        assert!(!seen.headers().contains_key(gone), "{gone}");
    }
    assert_eq!(seen.headers()["accept"], "text/plain");

    // Deadline = accept time + 30 s default.
    let limit = std::time::Duration::from_secs(30);
    assert!(ctx.deadline >= started + limit);
    assert!(ctx.deadline <= finished + limit);

    // Every response gets a fresh id, including errors.
    let resp = app.oneshot(request("nope.test", "/")).await.unwrap();
    let other = resp.headers()[REQUEST_ID_HEADER].to_str().unwrap();
    assert_ne!(other, id);
}

/// The route table file is validated as a whole (V13) and a bad reload
/// keeps the previous table.
#[tokio::test]
async fn route_table_file_reload() {
    let json = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../docs/contracts/examples/hello-artifact/route-table.json"
    ))
    .unwrap();
    let table = RouteTable::from_json(&json).unwrap();
    let hello = table
        .lookup("hello.renox.app")
        .expect("worked example routes");
    assert_eq!(hello.status, RouteStatus::Active);
    assert!(
        table
            .reload_from_json("{\"version\":1,\"entries\":[]}")
            .is_err()
    );
    assert!(table.lookup("hello.renox.app").is_some());
}

/// Serving over a real socket: `Gateway::serve` sets the client address.
#[tokio::test]
async fn serve_over_tcp() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let dir = tempfile::tempdir().unwrap();
    let gw = gateway(dir.path());
    let cell = FakeDispatcher::new();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = gw.clone();
    let dispatcher = cell.clone();
    tokio::spawn(async move { server.serve(listener, dispatcher).await });

    let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
    stream
        .write_all(b"GET /x HTTP/1.1\r\nHost: a.test\r\nConnection: close\r\n\r\n")
        .await
        .unwrap();
    let mut out = String::new();
    stream.read_to_string(&mut out).await.unwrap();
    assert!(out.starts_with("HTTP/1.1 200"), "{out}");
    assert!(out.ends_with("tenant=t_a"));
    assert_eq!(cell.last().0.client_ip.to_string(), "127.0.0.1");
}
