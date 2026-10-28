//! Issue #40: page routes end to end through the worker (V8-linked). The
//! shop list page (the B6 medium page, `crates/renox-template/tests/fixtures/shop`)
//! with a loader: `load()` runs in the isolate, returns its data as JSON, and
//! the cell renders it off the isolate thread. Fragment selection by
//! `HX-Target`, the meter's `render_fuel`/`render_ms` with `cpu_ms`
//! excluding the render, the 404 and 500 pages, and the render limit.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use renox_cell::{Worker, WorkerConfig};
use renox_template::{Compiler, TemplateProject};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

static N: AtomicU64 = AtomicU64::new(0);

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "renox-cell-pages-{}-{name}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for e in std::fs::read_dir(from).unwrap() {
        let e = e.unwrap();
        let target = to.join(e.file_name());
        if e.file_type().unwrap().is_dir() {
            copy_dir(&e.path(), &target);
        } else {
            std::fs::copy(e.path(), target).unwrap();
        }
    }
}

fn template_fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../renox-template/tests/fixtures")
}

const PRODUCTS_JS: &str = r#"
export async function load(ctx) {
  ctx.log.info("products loader", { fragment: ctx.fragment });
  const products = [];
  for (let i = 0; i < 100; i++) {
    products.push({
      id: i, slug: `product-${i}`, name: `Medjool dates ${i}`, price: 19.5 + i,
      stock: i % 7, featured: i % 10 === 0, category: "dates", sku: `SKU-${i}`,
      rating: 4.5, created: new Date(Date.UTC(2026, 9, 28)), big: 10n,
    });
  }
  return {
    title: "Products", query: "", category: "dates", cart_count: 2,
    categories: [{ slug: "dates", name: "Dates" }, { slug: "spices", name: "Spices" }],
    products,
  };
}
"#;

const LOGOUT_JS: &str = r#"
export function load() {
  return new Response(null, { status: 303, headers: { location: "/" } });
}
"#;

const BROKEN_JS: &str = r#"
export function load() {
  return [1, 2, 3];
}
"#;

const THROWS_JS: &str = r#"
export function load() {
  throw new Error("database is down");
}
"#;

const EVIL_JS: &str = r#"
export function load() {
  const list = Array.from({ length: 10000 }, (_, i) => i);
  return { rows: list, cols: list };
}
"#;

/// Builds the version 1 artifact: templates compiled by `renox-template`
/// from the shop fixture, the B13 fixture, and a few small pages.
fn write_artifact(artifacts: &Path) -> String {
    let mut project = TemplateProject::new();
    for fixture in ["shop", "evil-nested-loops"] {
        let p = TemplateProject::from_dir(&template_fixtures().join(fixture)).unwrap();
        for (path, src) in p.files() {
            let path = if fixture == "evil-nested-loops" {
                "pages/evil.html".to_string()
            } else {
                path.to_string()
            };
            project.insert(path, src);
        }
    }
    project.insert(
        "pages/about.html",
        "<r-layout use=\"main\"><p>About {{ title ?? \"us\" }}</p></r-layout>",
    );
    project.insert("pages/broken.html", "<p>{{ x }}</p>");
    project.insert("pages/throws.html", "<p>{{ x }}</p>");
    project.insert(
        "pages/_error.html",
        "<!doctype html><html><body><h1>Error {{ status }}</h1><p>{{ code }}</p><p>{{ message }}</p><p>{{ request_id }}</p></body></html>",
    );
    project.insert(
        "pages/_404.html",
        "<r-layout use=\"main\"><h1>Nothing here</h1><p>{{ request_id }}</p></r-layout>",
    );
    let compiled = Compiler::default()
        .compile(&project)
        .unwrap_or_else(|d| panic!("{d:?}"));

    let tmp = scratch("artifact-src");
    for (rel, src) in compiled.files() {
        let p = tmp.join("templates").join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, src).unwrap();
    }
    let code = [
        ("pages/products/index", PRODUCTS_JS),
        ("pages/logout", LOGOUT_JS),
        ("pages/broken", BROKEN_JS),
        ("pages/throws", THROWS_JS),
        ("pages/evil", EVIL_JS),
    ];
    for (id, js) in code {
        let p = tmp.join("code").join(format!("{id}.js"));
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, js).unwrap();
    }
    let entry: serde_json::Map<String, serde_json::Value> = code
        .iter()
        .map(|(id, _)| (id.to_string(), format!("{id}.js").into()))
        .collect();
    let manifest = serde_json::json!({
        "artifact": { "version": 1 },
        "app": { "name": "shop", "timezone": "Asia/Dubai" },
        "code": { "format": "esm-dir", "entry": entry },
        "routes": [
            { "kind": "page", "path": "/products", "module": "pages/products/index", "load": true, "template": "pages/products/index" },
            { "kind": "page", "path": "/about", "template": "pages/about" },
            { "kind": "page", "path": "/logout", "module": "pages/logout", "load": true },
            { "kind": "page", "path": "/broken", "module": "pages/broken", "load": true, "template": "pages/broken" },
            { "kind": "page", "path": "/throws", "module": "pages/throws", "load": true, "template": "pages/throws" },
            { "kind": "page", "path": "/evil", "module": "pages/evil", "load": true, "template": "pages/evil" }
        ],
        "templates": compiled.manifest_entries(),
        "permissions": { "network": [], "secrets": [] }
    });
    std::fs::write(
        tmp.join("manifest.json"),
        serde_json::to_vec_pretty(&manifest).unwrap(),
    )
    .unwrap();
    // The worker validates the manifest against the contract schema.
    renox_cell::Manifest::parse(&tmp.join("manifest.json")).unwrap();
    let hash = renox_runtime::manifest::content_hash(&tmp).unwrap();
    copy_dir(&tmp, &artifacts.join(&hash));
    hash
}

struct Env {
    root: PathBuf,
    config: WorkerConfig,
}

fn env() -> Env {
    let root = scratch("worker");
    std::fs::create_dir_all(root.join("artifacts")).unwrap();
    let text = r#"
listen = "127.0.0.1:0"
data_dir = "data"
artifacts_dir = "artifacts"
routes_file = "routes.json"
meters_dir = "meters"
logs_dir = "logs"
idle_timeout_secs = 60
meter_flush_ms = 50
"#;
    std::fs::write(root.join("worker.toml"), text).unwrap();
    let config = WorkerConfig::parse(text, &root).unwrap();
    Env { root, config }
}

struct Reply {
    status: u16,
    head: String,
    body: String,
}

async fn http(addr: SocketAddr, method: &str, path: &str, headers: &[(&str, &str)]) -> Reply {
    let mut s = tokio::net::TcpStream::connect(addr).await.unwrap();
    let mut req = format!("{method} {path} HTTP/1.1\r\nHost: shop.test\r\nConnection: close\r\n");
    for (k, v) in headers {
        req.push_str(&format!("{k}: {v}\r\n"));
    }
    req.push_str("\r\n");
    s.write_all(req.as_bytes()).await.unwrap();
    let mut buf = Vec::new();
    s.read_to_end(&mut buf).await.unwrap();
    let text = String::from_utf8_lossy(&buf).to_string();
    let (head, body) = text.split_once("\r\n\r\n").unwrap_or((&text, ""));
    let status = head
        .split(' ')
        .nth(1)
        .and_then(|c| c.parse().ok())
        .unwrap_or(0);
    Reply {
        status,
        head: head.to_ascii_lowercase(),
        body: body.to_string(),
    }
}

fn records(meters: &Path) -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(meters) {
        for e in entries.flatten() {
            let text = std::fs::read_to_string(e.path()).unwrap_or_default();
            for line in text.lines() {
                if let Ok(batch) = serde_json::from_str::<serde_json::Value>(line) {
                    out.extend(batch["records"].as_array().cloned().unwrap_or_default());
                }
            }
        }
    }
    out
}

async fn record_for(meters: &Path, request_route: &str, n: usize) -> Vec<serde_json::Value> {
    let start = Instant::now();
    loop {
        let found: Vec<serde_json::Value> = records(meters)
            .into_iter()
            .filter(|r| r["route"] == request_route)
            .collect();
        if found.len() >= n {
            return found;
        }
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "{} of {n} meter records for {request_route}; all: {:?}",
            found.len(),
            records(meters)
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

const HTML: (&str, &str) = ("accept", "text/html,application/xhtml+xml,*/*;q=0.8");

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shop_pages_render_through_the_full_path() {
    let e = env();
    let hash = write_artifact(&e.config.artifacts_dir);
    let routes = serde_json::json!({ "version": 0, "entries": [
        { "hostname": "shop.test", "tenant_id": "t_shop", "deployment_hash": hash, "status": "active", "updated_at": 1 }
    ]});
    std::fs::write(&e.config.routes_file, routes.to_string()).unwrap();
    let worker = Worker::start(e.config.clone()).await.unwrap();
    let addr = worker.addr;

    // Full page: layout, 100 cards, money filter, page headers.
    let r = http(addr, "GET", "/products", &[HTML]).await;
    assert_eq!(r.status, 200, "{}", r.body);
    assert!(r.body.starts_with("<!DOCTYPE html>"), "{}", r.body);
    assert_eq!(r.body.matches("class=\"card").count(), 100);
    assert!(r.body.contains("Medjool dates 99"));
    assert!(r.head.contains("content-type: text/html; charset=utf-8"));
    assert!(r.head.contains("cache-control: no-store"));
    assert!(r.head.contains("vary: hx-request, hx-target"));
    // #47: the nonce on every emitted <script> is the CSP header's (the
    // helper lower-cases the head, so compare lower-cased).
    let nonce = r
        .body
        .split("nonce=\"")
        .nth(1)
        .and_then(|rest| rest.split('"').next())
        .expect("a nonce on the script tag");
    assert_eq!(nonce.len(), 24);
    assert!(
        r.head.contains(&format!(
            "script-src 'self' 'nonce-{}'",
            nonce.to_ascii_lowercase()
        )),
        "{}",
        r.head
    );
    assert_eq!(
        r.body.matches("<script").count(),
        r.body.matches(&format!("nonce=\"{nonce}\"")).count()
    );

    // Fragment request: only the block, and the loader was told which.
    let f = http(
        addr,
        "GET",
        "/products",
        &[("hx-request", "true"), ("hx-target", "product-list")],
    )
    .await;
    assert_eq!(f.status, 200, "{}", f.body);
    assert!(f.body.starts_with("<ul id=\"product-list\""), "{}", f.body);
    assert!(!f.body.contains("<html") && !f.body.contains("site-header"));
    assert_eq!(f.body.matches("class=\"card").count(), 100);
    // A fragment defined in the layout, selected from the page.
    let badge = http(
        addr,
        "GET",
        "/products",
        &[("hx-request", "true"), ("hx-target", "cart-count")],
    )
    .await;
    assert_eq!(badge.body, "<span id=\"cart-count\" dir=\"auto\">2</span>");
    // An unknown target renders the full page (rule 2).
    let full = http(
        addr,
        "GET",
        "/products",
        &[("hx-request", "true"), ("hx-target", "nope")],
    )
    .await;
    assert!(full.body.starts_with("<!DOCTYPE html>"));

    // HEAD: same headers, no body.
    let h = http(addr, "HEAD", "/products", &[]).await;
    assert_eq!(h.status, 200);
    assert!(h.body.is_empty());

    // .html-only page: no tenant code, data {}.
    let about = http(addr, "GET", "/about", &[]).await;
    assert_eq!(about.status, 200);
    assert!(about.body.contains("About us"), "{}", about.body);

    // .ts-only page: the Response passes through untouched.
    let logout = http(addr, "GET", "/logout", &[]).await;
    assert_eq!(logout.status, 303);
    assert!(logout.head.contains("location: /"));

    // 500: the loader returned an array (load_result) or threw; the tenant's
    // _error page with the four inputs.
    for path in ["/broken", "/throws"] {
        let b = http(addr, "GET", path, &[]).await;
        assert_eq!(b.status, 500, "{path}");
        assert!(b.body.contains(">Error 500</h1>"), "{path}: {}", b.body);
        assert!(b.body.contains("RENOX_INTERNAL"));
        assert!(!b.body.contains("database is down"), "no cause in the page");
    }

    // 404: HTML clients get _404; JSON clients keep the JSON body.
    let nf = http(addr, "GET", "/nowhere", &[HTML]).await;
    assert_eq!(nf.status, 404);
    assert!(nf.body.contains("<h1>Nothing here</h1>"), "{}", nf.body);
    let nf_json = http(addr, "GET", "/nowhere", &[("accept", "application/json")]).await;
    assert_eq!(nf_json.status, 404);
    assert!(nf_json.body.starts_with('{'), "{}", nf_json.body);

    // Render limit: B13 page (10k x 10k) -> 500 RENOX_RENDER_LIMIT, error page.
    let evil = http(addr, "GET", "/evil", &[]).await;
    assert_eq!(evil.status, 500);
    assert!(evil.body.contains("RENOX_RENDER_LIMIT"), "{}", evil.body);
    assert!(evil.body.contains("The page could not be rendered."));
    // The worker keeps serving.
    assert_eq!(http(addr, "GET", "/about", &[]).await.status, 200);

    // Meter: render_fuel and render_ms are present; cpu_ms is the loader only.
    let meters = e.config.meters_dir.clone();
    let recs = record_for(&meters, "GET /products", 5).await;
    let page = &recs[0];
    assert_eq!(page["status"], "ok");
    assert!(page["render_fuel"].as_u64().unwrap() > 0, "{page}");
    assert!(page["render_ms"].as_f64().unwrap() > 0.0, "{page}");
    let about_rec = &record_for(&meters, "GET /about", 1).await[0];
    assert!(about_rec["render_fuel"].as_u64().unwrap() > 0);
    assert_eq!(
        about_rec["cpu_ms"],
        serde_json::json!(0.0),
        "no tenant code ran"
    );
    let evil_rec = &record_for(&meters, "GET /evil", 1).await[0];
    assert_eq!(evil_rec["status"], "render_limit", "{evil_rec}");
    assert_eq!(evil_rec["http_status"], 500);
    let cpu = evil_rec["cpu_ms"].as_f64().unwrap();
    let render = evil_rec["render_ms"].as_f64().unwrap();
    assert!(
        cpu < render,
        "render time is not in cpu_ms: cpu {cpu} ms, render {render} ms"
    );
    let broken_rec = &record_for(&meters, "GET /broken", 1).await[0];
    assert_eq!(broken_rec["status"], "error");
    assert!(
        records(&meters)
            .iter()
            .all(|r| r["route"] != "GET /nowhere"),
        "404 by routing has no record"
    );

    // Tenant log: the loader saw ctx.fragment; the refusals are logged.
    let logs = std::fs::read_to_string(e.config.logs_dir.join("tenant.ndjson")).unwrap();
    assert!(logs.contains(r#""fragment":"product_list""#), "{logs}");
    assert!(logs.contains(r#""fragment":null"#));
    assert!(logs.contains(r#""reason":"load_result""#), "{logs}");
    assert!(
        logs.contains("RENOX_RENDER_LIMIT") && logs.contains(r#""limit":"fuel""#),
        "{logs}"
    );

    worker.shutdown().await;
    let _ = std::fs::remove_dir_all(&e.root);
}

/// #126: the shop page carries the request-id and deployment meta tags and
/// the nonce'd client script tag first in `<head>`; fragments carry none of
/// them; a browser event posted to `/__renox/events` lands in the tenant
/// log file with `source: "client"` (no cell, no meter record); the script
/// is served by the gateway.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shop_page_shell_and_client_events() {
    let e = env();
    let hash = write_artifact(&e.config.artifacts_dir);
    let routes = serde_json::json!({ "version": 0, "entries": [
        { "hostname": "shop.test", "tenant_id": "t_shop", "deployment_hash": hash, "status": "active", "updated_at": 1 }
    ]});
    std::fs::write(&e.config.routes_file, routes.to_string()).unwrap();
    let worker = Worker::start(e.config.clone()).await.unwrap();
    let addr = worker.addr;

    let r = http(addr, "GET", "/products", &[HTML]).await;
    assert_eq!(r.status, 200, "{}", r.body);
    let id = r
        .head
        .lines()
        .find_map(|l| l.strip_prefix("x-renox-request-id: "))
        .unwrap()
        .to_ascii_uppercase();
    let nonce = r
        .body
        .split("nonce=\"")
        .nth(1)
        .and_then(|rest| rest.split('"').next())
        .unwrap();
    let src = renox_gateway::client_script::script_src();
    let shell = format!(
        "<head><meta name=\"renox-request-id\" content=\"{id}\"><meta name=\"renox-deployment\" content=\"{hash}\"><script nonce=\"{nonce}\" src=\"{src}\"></script>"
    );
    assert!(
        r.body.contains(&shell),
        "{}",
        &r.body[..600.min(r.body.len())]
    );
    assert!(
        r.head
            .contains("reporting-endpoints: renox-csp=\"/__renox/events?kind=csp\""),
        "{}",
        r.head
    );
    assert!(r.head.contains("report-to renox-csp"));
    // The tenant's error page gets the tags too, with the error code.
    let b = http(addr, "GET", "/broken", &[]).await;
    assert!(
        b.body
            .contains("<meta name=\"renox-error-code\" content=\"RENOX_INTERNAL\">")
            || !b.body.contains("<head"),
        "{}",
        b.body
    );
    // Fragments: no shell.
    let f = http(
        addr,
        "GET",
        "/products",
        &[("hx-request", "true"), ("hx-target", "product-list")],
    )
    .await;
    assert!(!f.body.contains("renox-request-id"));

    // The script, from the gateway.
    let js = http(addr, "GET", &src, &[]).await;
    assert_eq!(js.status, 200);
    assert!(
        js.head
            .contains("cache-control: public, max-age=31536000, immutable")
    );

    // A browser event, logged with source=client within the batch.
    let event = serde_json::json!({ "v": 0, "events": [{
        "kind": "js.error", "ts": 1793318400123_u64, "url": "/products",
        "request_id": id, "deployment": hash, "ua": "chrome",
        "session_fingerprint": "k3J9xQ2mP0aLz7Vb",
        "detail": { "message": "TypeError: cart is undefined", "source": "/assets/app.js",
                    "line": 12, "column": 31, "stack": [] }
    }]})
    .to_string();
    let mut s = tokio::net::TcpStream::connect(addr).await.unwrap();
    let req = format!(
        "POST /__renox/events HTTP/1.1\r\nHost: shop.test\r\nConnection: close\r\nContent-Type: text/plain;charset=UTF-8\r\nContent-Length: {}\r\n\r\n{event}",
        event.len()
    );
    s.write_all(req.as_bytes()).await.unwrap();
    let mut buf = Vec::new();
    s.read_to_end(&mut buf).await.unwrap();
    assert!(String::from_utf8_lossy(&buf).starts_with("HTTP/1.1 204"));
    let logs = std::fs::read_to_string(e.config.logs_dir.join("tenant.ndjson")).unwrap();
    let line: serde_json::Value = logs
        .lines()
        .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
        .find(|l| l["fields"]["source"] == "client")
        .unwrap_or_else(|| panic!("no client line in {logs}"));
    assert_eq!(line["tenant_id"], "t_shop");
    assert_eq!(line["deployment_hash"], hash.as_str());
    assert_eq!(line["request_id"], id.as_str());
    assert_eq!(line["level"], "error");
    assert_eq!(line["fields"]["kind"], "js.error");
    assert_eq!(line["message"], "js.error: TypeError: cart is undefined");
    assert!(
        records(&e.config.meters_dir)
            .iter()
            .all(|r| !r["route"].as_str().unwrap_or("").contains("__renox")),
        "no meter record for the endpoint"
    );

    worker.shutdown().await;
    let _ = std::fs::remove_dir_all(&e.root);
}
