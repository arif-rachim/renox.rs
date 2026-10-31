//! Test helpers shared by the gateway integration tests.
#![allow(dead_code)]

use std::net::SocketAddr;
use std::path::Path;
use std::sync::{Arc, Mutex};

use axum::body::Body;
use axum::http::{Request, Response, StatusCode};
use renox_gateway::{CellDispatcher, RequestCtx, RouteEntry, RouteStatus};

pub const HASH_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
pub const HASH_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

/// A dispatcher that records every call and answers 200 with the tenant id.
#[derive(Default)]
pub struct FakeDispatcher {
    pub calls: Mutex<Vec<(RequestCtx, Request<()>)>>,
}

impl FakeDispatcher {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn count(&self) -> usize {
        self.calls.lock().unwrap().len()
    }

    pub fn last(&self) -> (RequestCtx, Request<()>) {
        let calls = self.calls.lock().unwrap();
        let (ctx, req) = calls.last().expect("dispatcher was called");
        let mut copy = Request::builder()
            .method(req.method())
            .uri(req.uri())
            .body(())
            .unwrap();
        *copy.headers_mut() = req.headers().clone();
        (ctx.clone(), copy)
    }
}

impl CellDispatcher for FakeDispatcher {
    async fn dispatch(&self, ctx: RequestCtx, req: Request<Body>) -> Response<Body> {
        let (parts, body) = req.into_parts();
        // Drain the body like a cell would, so body limits are exercised.
        let body_len = axum::body::to_bytes(body, usize::MAX)
            .await
            .map(|b| b.len())
            .unwrap_or(0);
        let tenant = ctx.tenant_id.clone();
        self.calls
            .lock()
            .unwrap()
            .push((ctx, Request::from_parts(parts, ())));
        Response::builder()
            .status(StatusCode::OK)
            .header("x-frame-options", "ALLOWALL")
            .header("x-body-len", body_len)
            .body(Body::from(format!("tenant={tenant}")))
            .unwrap()
    }
}

pub fn entry(host: &str, tenant: &str, hash: &str, status: RouteStatus) -> RouteEntry {
    RouteEntry {
        hostname: host.to_owned(),
        tenant_id: tenant.to_owned(),
        deployment_hash: hash.to_owned(),
        status,
        updated_at: 1_793_318_400_000,
        display_name: None,
        version: None,
    }
}

/// The `sha256` written into test public manifests. The gateway uses it as
/// an opaque `ETag` and does not rehash files (the cell verifies artifacts).
pub const STATIC_SHA256: &str = "5d41402abc4b2a76b9719d911017c592ae0f3e8a2d5c0b7f6e8d9c1a2b3c4d5e";

/// Writes `public/<path>` files and a matching `public/manifest.json` under
/// `root/<hash>/`.
pub fn write_public(root: &Path, hash: &str, files: &[(&str, &[u8], &str)]) {
    let public = root.join(hash).join("public");
    let mut entries = serde_json::Map::new();
    for (path, bytes, content_type) in files {
        let file = public.join(path);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, bytes).unwrap();
        entries.insert(
            format!("/{path}"),
            serde_json::json!({
                "sha256": STATIC_SHA256,
                "size": bytes.len(),
                "content_type": content_type,
            }),
        );
    }
    std::fs::create_dir_all(&public).unwrap();
    let manifest = serde_json::json!({ "version": 0, "files": entries });
    std::fs::write(public.join("manifest.json"), manifest.to_string()).unwrap();
}

pub fn request(host: &str, path: &str) -> Request<Body> {
    request_from(host, path, "192.0.2.10:50000".parse().unwrap())
}

pub fn request_from(host: &str, path: &str, peer: SocketAddr) -> Request<Body> {
    let mut req = Request::builder()
        .uri(path)
        .header("host", host)
        .body(Body::empty())
        .unwrap();
    req.extensions_mut()
        .insert(axum::extract::ConnectInfo(peer));
    req
}
