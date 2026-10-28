//! Issue #159: dynamic responses are compressed by `Accept-Encoding`
//! before the meter record, so `egress_bytes` counts the bytes sent
//! (`docs/contracts/meter.md`: body bytes, headers excluded). V8-linked.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use renox_cell::{Worker, WorkerConfig};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

static N: AtomicU64 = AtomicU64::new(0);

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "renox-cell-compress-{}-{name}-{}",
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

/// An artifact with `GET /api/list` (about 8 KB of JSON), `GET /api/small`
/// (a few bytes of JSON) and `GET /api/png` (8 KB, `image/png`).
fn artifact(artifacts: &Path) -> String {
    let manifest = serde_json::json!({
        "artifact": { "version": 0 },
        "app": { "name": "compress", "timezone": "UTC" },
        "code": { "format": "esm-dir", "entry": {
            "functions/api/list": "functions/api/list.js",
            "functions/api/small": "functions/api/small.js",
            "functions/api/png": "functions/api/png.js"
        } },
        "routes": [
            { "kind": "function", "method": "GET", "path": "/api/list", "module": "functions/api/list", "export": "GET" },
            { "kind": "function", "method": "GET", "path": "/api/small", "module": "functions/api/small", "export": "GET" },
            { "kind": "function", "method": "GET", "path": "/api/png", "module": "functions/api/png", "export": "GET" }
        ],
        "permissions": { "network": [], "secrets": [] }
    });
    let list = r#"
        export function GET() {
            const items = [];
            for (let i = 0; i < 200; i++) items.push({ id: i, name: `product ${i}`, price: i * 3 });
            return Response.json(items);
        }
    "#;
    let small = r#"export function GET() { return Response.json({ ok: true }); }"#;
    let png = r#"
        export function GET() {
            return new Response(new Uint8Array(8192).fill(7), { headers: { "content-type": "image/png" } });
        }
    "#;
    let tmp = scratch("artifact-src");
    for (rel, content) in [
        ("manifest.json", manifest.to_string()),
        ("code/functions/api/list.js", list.to_string()),
        ("code/functions/api/small.js", small.to_string()),
        ("code/functions/api/png.js", png.to_string()),
    ] {
        let p = tmp.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, content).unwrap();
    }
    let hash = renox_runtime::manifest::content_hash(&tmp).unwrap();
    copy_dir(&tmp, &artifacts.join(&hash));
    hash
}

struct Reply {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Reply {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

/// One HTTP/1.1 request with `extra` request headers; the raw reply.
async fn http(addr: SocketAddr, path: &str, extra: &str) -> Reply {
    let mut s = tokio::net::TcpStream::connect(addr).await.unwrap();
    let req = format!("GET {path} HTTP/1.1\r\nHost: c.test\r\n{extra}Connection: close\r\n\r\n");
    s.write_all(req.as_bytes()).await.unwrap();
    let mut buf = Vec::new();
    s.read_to_end(&mut buf).await.unwrap();
    let split = buf.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
    let head = String::from_utf8_lossy(&buf[..split]).to_string();
    let body = buf[split + 4..].to_vec();
    let mut lines = head.split("\r\n");
    let status = lines
        .next()
        .and_then(|l| l.split(' ').nth(1))
        .and_then(|c| c.parse().ok())
        .unwrap_or(0);
    let headers = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_string(), v.trim().to_string()))
        .collect();
    Reply {
        status,
        headers,
        body,
    }
}

/// The meter record of one request id, once it is flushed.
async fn record(meters: &Path, request_id: &str) -> serde_json::Value {
    let start = Instant::now();
    loop {
        if let Ok(entries) = std::fs::read_dir(meters) {
            for e in entries.flatten() {
                let text = std::fs::read_to_string(e.path()).unwrap_or_default();
                for line in text.lines() {
                    let Ok(batch) = serde_json::from_str::<serde_json::Value>(line) else {
                        continue;
                    };
                    for r in batch["records"].as_array().into_iter().flatten() {
                        if r["request_id"] == request_id {
                            return r.clone();
                        }
                    }
                }
            }
        }
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "no meter record for {request_id}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// Negotiation, `Vary`, the uncompressed path, and `egress_bytes` = the
/// body bytes on the wire, through the worker.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn responses_are_compressed_and_egress_counts_wire_bytes() {
    let root = scratch("worker");
    let text = r#"
listen = "127.0.0.1:0"
data_dir = "data"
artifacts_dir = "artifacts"
routes_file = "routes.json"
meters_dir = "meters"
logs_dir = "logs"
idle_timeout_secs = 30
meter_flush_ms = 50
"#;
    std::fs::write(root.join("worker.toml"), text).unwrap();
    let config = WorkerConfig::parse(text, &root).unwrap();
    std::fs::create_dir_all(&config.artifacts_dir).unwrap();
    let hash = artifact(&config.artifacts_dir);
    let routes = serde_json::json!({ "version": 0, "entries": [
        { "hostname": "c.test", "tenant_id": "t_c", "deployment_hash": hash, "status": "active", "updated_at": 1 }
    ]});
    std::fs::write(&config.routes_file, routes.to_string()).unwrap();
    let worker = Worker::start(config.clone()).await.unwrap();

    // Uncompressed reference.
    let plain = http(worker.addr, "/api/list", "").await;
    assert_eq!(plain.status, 200);
    assert!(plain.header("content-encoding").is_none());
    assert_eq!(plain.header("vary"), Some("accept-encoding"));
    assert!(plain.body.len() > 4096, "{}", plain.body.len());

    for (accept, coding) in [
        ("gzip, deflate, br", "br"),
        ("gzip", "gzip"),
        ("br;q=0.1, gzip;q=0.9", "gzip"),
    ] {
        let r = http(
            worker.addr,
            "/api/list",
            &format!("Accept-Encoding: {accept}\r\n"),
        )
        .await;
        assert_eq!(r.status, 200);
        assert_eq!(r.header("content-encoding"), Some(coding), "{accept}");
        assert_eq!(r.header("vary"), Some("accept-encoding"));
        assert!(r.body.len() < plain.body.len() / 2, "{accept}");
        assert_eq!(
            r.header("content-length"),
            Some(r.body.len().to_string().as_str())
        );
        let id = r.header("x-renox-request-id").unwrap().to_string();
        let rec = record(&config.meters_dir, &id).await;
        assert_eq!(
            rec["egress_bytes"].as_u64().unwrap(),
            r.body.len() as u64,
            "{accept}: egress_bytes must be the compressed body"
        );
    }

    // The uncompressed path: egress is the plain body.
    let id = plain.header("x-renox-request-id").unwrap().to_string();
    let rec = record(&config.meters_dir, &id).await;
    assert_eq!(
        rec["egress_bytes"].as_u64().unwrap(),
        plain.body.len() as u64
    );

    // Small JSON: Vary, not compressed. Not a compressed type: neither.
    let small = http(worker.addr, "/api/small", "Accept-Encoding: br\r\n").await;
    assert!(small.header("content-encoding").is_none());
    assert_eq!(small.header("vary"), Some("accept-encoding"));
    let png = http(worker.addr, "/api/png", "Accept-Encoding: br, gzip\r\n").await;
    assert!(png.header("content-encoding").is_none());
    assert!(png.header("vary").is_none());
    assert_eq!(png.body.len(), 8192);
    let id = png.header("x-renox-request-id").unwrap().to_string();
    assert_eq!(record(&config.meters_dir, &id).await["egress_bytes"], 8192);

    worker.shutdown().await;
    let _ = std::fs::remove_dir_all(&root);
}
