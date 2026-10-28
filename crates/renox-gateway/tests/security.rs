//! #47: web-layer protections at the gateway (`docs/04-isolation-security.md`,
//! "Web-layer protections"; `docs/contracts/artifact.md` section 3,
//! "Security"; `docs/24-threat-model.md`, "XSS" and "CSRF" rows for CSP and
//! CORS): the default header table, the per-request CSP nonce handed to the
//! cell, the deployment's `security` object, CORS preflights, and the
//! version 1 public index.

mod common;

use std::sync::Arc;

use axum::http::{Method, Request, StatusCode};
use common::*;
use renox_gateway::{Gateway, GatewayConfig, RouteStatus, RouteTable, SECURITY_HEADERS};
use tower::ServiceExt;

fn gateway(root: &std::path::Path) -> Gateway {
    let table = RouteTable::new();
    table
        .upsert(entry("a.test", "t_a", HASH_A, RouteStatus::Active))
        .unwrap();
    table
        .upsert(entry("b.test", "t_b", HASH_B, RouteStatus::Active))
        .unwrap();
    Gateway::new(GatewayConfig::new(root), Arc::new(table))
}

fn write_manifest(root: &std::path::Path, hash: &str, manifest: serde_json::Value) {
    std::fs::create_dir_all(root.join(hash)).unwrap();
    std::fs::write(root.join(hash).join("manifest.json"), manifest.to_string()).unwrap();
}

/// Default response headers match the table; the CSP carries the nonce the
/// cell got in `RequestCtx.csp_nonce`, a fresh one per request; tenant
/// values for these headers are replaced.
#[tokio::test]
async fn default_headers_and_the_request_nonce() {
    let dir = tempfile::tempdir().unwrap();
    let gw = gateway(dir.path());
    let cell = FakeDispatcher::new();
    let app = gw.router(cell.clone());
    let resp = app.clone().oneshot(request("a.test", "/fn")).await.unwrap();
    for (name, value) in SECURITY_HEADERS {
        assert_eq!(resp.headers()[name], value, "{name}");
    }
    let (ctx, _) = cell.last();
    assert_eq!(ctx.csp_nonce.len(), 24);
    let csp = resp.headers()["content-security-policy"]
        .to_str()
        .unwrap()
        .to_string();
    assert_eq!(
        csp,
        format!(
            "default-src 'self'; script-src 'self' 'nonce-{n}'; style-src 'self' 'nonce-{n}'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; report-uri /__renox/events?kind=csp",
            n = ctx.csp_nonce
        )
    );
    let _ = app.clone().oneshot(request("a.test", "/fn")).await.unwrap();
    assert_ne!(
        cell.last().0.csp_nonce,
        ctx.csp_nonce,
        "one nonce per request"
    );
    // No CORS header for a cross-origin request: closed by default.
    let mut req = request("a.test", "/fn");
    req.headers_mut()
        .insert("origin", "https://partner.example".parse().unwrap());
    let resp = app.oneshot(req).await.unwrap();
    assert!(resp.headers().get("access-control-allow-origin").is_none());
}

fn preflight(origin: &str, method: &str) -> Request<axum::body::Body> {
    let mut req = request("b.test", "/api/orders");
    *req.method_mut() = Method::OPTIONS;
    req.headers_mut().insert("origin", origin.parse().unwrap());
    req.headers_mut()
        .insert("access-control-request-method", method.parse().unwrap());
    req
}

/// A version 1 deployment's `security`: configured CSP sources, CORS for a
/// listed origin (preflight answered at the gateway, never reaching the
/// cell), an unlisted one refused, and `public.json` as the public index.
#[tokio::test]
async fn deployment_security_cors_and_public_json() {
    let dir = tempfile::tempdir().unwrap();
    write_manifest(
        dir.path(),
        HASH_B,
        serde_json::json!({
            "artifact": { "version": 1 },
            "security": {
                "csp": { "script_src": ["https://js.stripe.com"] },
                "cors": { "origins": ["https://partner.example"], "methods": ["GET", "POST"], "credentials": true },
                "headers": { "referrer_policy": "no-referrer" }
            }
        }),
    );
    // Version 1: the index is public.json at the root; public/manifest.json
    // is an ordinary file.
    std::fs::create_dir_all(dir.path().join(HASH_B).join("public")).unwrap();
    std::fs::write(dir.path().join(HASH_B).join("public/robots.txt"), "ok").unwrap();
    std::fs::write(dir.path().join(HASH_B).join("public/manifest.json"), "{}").unwrap();
    std::fs::write(
        dir.path().join(HASH_B).join("public.json"),
        serde_json::json!({ "version": 0, "files": {
            "/robots.txt": { "sha256": STATIC_SHA256, "size": 2, "content_type": "text/plain" },
            "/manifest.json": { "sha256": STATIC_SHA256, "size": 2, "content_type": "application/manifest+json" }
        }})
        .to_string(),
    )
    .unwrap();
    let gw = gateway(dir.path());
    let cell = FakeDispatcher::new();
    let app = gw.router(cell.clone());

    let ok = app
        .clone()
        .oneshot(preflight("https://partner.example", "POST"))
        .await
        .unwrap();
    assert_eq!(ok.status(), StatusCode::NO_CONTENT);
    assert_eq!(
        ok.headers()["access-control-allow-origin"],
        "https://partner.example"
    );
    assert_eq!(ok.headers()["access-control-allow-methods"], "GET, POST");
    assert_eq!(ok.headers()["access-control-allow-credentials"], "true");
    assert_eq!(ok.headers()["access-control-max-age"], "600");
    let bad = app
        .clone()
        .oneshot(preflight("https://evil.example", "POST"))
        .await
        .unwrap();
    assert_eq!(bad.status(), StatusCode::FORBIDDEN);
    assert!(bad.headers().get("access-control-allow-origin").is_none());
    let bad = app
        .clone()
        .oneshot(preflight("https://partner.example", "DELETE"))
        .await
        .unwrap();
    assert_eq!(bad.status(), StatusCode::FORBIDDEN);
    assert_eq!(cell.count(), 0, "preflights never reach the cell");

    let mut req = request("b.test", "/api/orders");
    req.headers_mut()
        .insert("origin", "https://partner.example".parse().unwrap());
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(
        resp.headers()["access-control-allow-origin"],
        "https://partner.example"
    );
    assert_eq!(resp.headers()["referrer-policy"], "no-referrer");
    let csp = resp.headers()["content-security-policy"].to_str().unwrap();
    assert!(csp.contains("script-src 'self' 'nonce-"), "{csp}");
    assert!(csp.contains("' https://js.stripe.com; style-src"), "{csp}");

    let robots = app
        .clone()
        .oneshot(request("b.test", "/robots.txt"))
        .await
        .unwrap();
    assert_eq!(robots.status(), StatusCode::OK);
    assert!(robots.headers().contains_key("content-security-policy"));
    let web_manifest = app
        .oneshot(request("b.test", "/manifest.json"))
        .await
        .unwrap();
    assert_eq!(web_manifest.status(), StatusCode::OK);
    assert_eq!(
        web_manifest.headers()["content-type"],
        "application/manifest+json"
    );
}

/// `csp.report_only`: the policy is sent as Report-Only, never both.
#[tokio::test]
async fn report_only_mode() {
    let dir = tempfile::tempdir().unwrap();
    write_manifest(
        dir.path(),
        HASH_A,
        serde_json::json!({ "artifact": { "version": 1 }, "security": { "csp": { "report_only": true } } }),
    );
    let app = gateway(dir.path()).router(FakeDispatcher::new());
    let resp = app.oneshot(request("a.test", "/x")).await.unwrap();
    assert!(resp.headers().get("content-security-policy").is_none());
    assert!(
        resp.headers()["content-security-policy-report-only"]
            .to_str()
            .unwrap()
            .contains("report-uri /__renox/events?kind=csp")
    );
}
