//! Issue #161: streamed responses end to end through the worker
//! (`docs/contracts/ops.md` 1.2.0, sections 6, 7, 10 and 14). V8-linked.
//!
//! A `ReadableStream` body leaves the isolate chunk by chunk after its head;
//! the response egress limit, the deadline and a CPU kill truncate it; the
//! meter record is written at the end of the stream; a page whose loader is
//! slower than the shell delay gets its shell first, and an error after the
//! shell is rendered inside the stream.

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
        "renox-cell-streaming-{}-{name}-{}",
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

/// `first`, then 600 ms later `second`, then the end.
const SLOW_STREAM_JS: &str = r#"
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export function GET() {
  let step = 0;
  const enc = new TextEncoder();
  return new Response(new ReadableStream({
    async pull(c) {
      step += 1;
      if (step === 1) c.enqueue(enc.encode("first;"));
      else if (step === 2) { await sleep(600); c.enqueue(enc.encode("second;")); }
      else c.close();
    },
  }), { headers: { "content-type": "text/plain", "content-length": "13" } });
}
"#;

/// 16 KB chunks without end: the response egress limit stops it.
const FLOOD_JS: &str = r#"
export function GET() {
  return new Response(new ReadableStream({
    pull(c) { c.enqueue(new Uint8Array(16384).fill(97)); },
  }), { headers: { "content-type": "application/octet-stream" } });
}
"#;

/// One chunk, then (after the head is out) an infinite loop: the CPU
/// watchdog. A loop in the first slice would end the request before its
/// head, with 503 (ops.md section 10).
const SPIN_JS: &str = r#"
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export function GET() {
  let step = 0;
  return new Response(new ReadableStream({
    async pull(c) {
      step += 1;
      if (step === 1) { c.enqueue(new TextEncoder().encode("start;")); return; }
      await sleep(100);
      for (;;) {}
    },
  }), { headers: { "content-type": "text/plain" } });
}
"#;

/// One chunk, then nothing: the deadline (1 s) truncates it.
const HANG_JS: &str = r#"
export function GET() {
  let step = 0;
  return new Response(new ReadableStream({
    pull(c) {
      step += 1;
      if (step === 1) c.enqueue(new TextEncoder().encode("hang;"));
      else return new Promise(() => {});
    },
  }), { headers: { "content-type": "text/plain" } });
}
"#;

/// A stream that errors after one chunk.
const FAILS_JS: &str = r#"
export function GET() {
  let step = 0;
  return new Response(new ReadableStream({
    pull(c) {
      step += 1;
      if (step === 1) c.enqueue(new TextEncoder().encode("ok;"));
      else c.error(new Error("upstream reset"));
    },
  }), { headers: { "content-type": "text/plain" } });
}
"#;

/// A static body: still sent in one piece, with its length.
const STATIC_JS: &str = r#"
export function GET() { return new Response("static body", { headers: { "content-type": "text/plain" } }); }
"#;

const SLOW_PAGE_JS: &str = r#"
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function load(ctx) {
  await sleep(700);
  return { title: "Slow", cart_count: 3, items: ["dates", "saffron"] };
}
"#;

const FAST_PAGE_JS: &str = r#"
export function load() { return { title: "Fast", cart_count: 1, items: ["tea"] }; }
"#;

const SLOW_THROWS_JS: &str = r#"
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function load() { await sleep(300); throw new Error("database is down"); }
"#;

const SLOW_REDIRECT_JS: &str = r#"
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function load() {
  await sleep(300);
  return new Response(null, { status: 303, headers: { location: "/" } });
}
"#;

const LAYOUT: &str = r#"<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <link rel="stylesheet" href="/static/app.css">
</head>
<body>
  <header class="site-header"><a href="/">Shop</a> <span id="cart">{{ cart_count }}</span></header>
  <main><slot /></main>
</body>
</html>"#;

const LIST_PAGE: &str = r#"<r-layout use="main"><h1>{{ title }}</h1><ul><li r-for="i in items">{{ i }}</li></ul></r-layout>"#;

fn write_artifact(artifacts: &Path) -> String {
    let mut project = TemplateProject::new();
    project.insert("pages/_layouts/main.html", LAYOUT);
    for page in ["slow", "fast", "slow-throws", "slow-redirect"] {
        project.insert(format!("pages/{page}.html"), LIST_PAGE);
    }
    project.insert(
        "pages/_error.html",
        "<!doctype html><html><head><title>Error</title></head><body><h1>Error {{ status }}</h1><p>{{ code }}</p><p>{{ request_id }}</p></body></html>",
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
    let functions = [
        ("functions/slow", SLOW_STREAM_JS),
        ("functions/flood", FLOOD_JS),
        ("functions/spin", SPIN_JS),
        ("functions/hang", HANG_JS),
        ("functions/fails", FAILS_JS),
        ("functions/static", STATIC_JS),
    ];
    let pages = [
        ("pages/slow", SLOW_PAGE_JS),
        ("pages/fast", FAST_PAGE_JS),
        ("pages/slow-throws", SLOW_THROWS_JS),
        ("pages/slow-redirect", SLOW_REDIRECT_JS),
    ];
    for (id, js) in functions.iter().chain(pages.iter()) {
        let p = tmp.join("code").join(format!("{id}.js"));
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, js).unwrap();
    }
    let entry: serde_json::Map<String, serde_json::Value> = functions
        .iter()
        .chain(pages.iter())
        .map(|(id, _)| (id.to_string(), format!("{id}.js").into()))
        .collect();
    let mut routes: Vec<serde_json::Value> = functions
        .iter()
        .map(|(id, _)| {
            serde_json::json!({
                "kind": "function", "method": "GET", "path": format!("/{}", &id["functions/".len()..]),
                "module": id, "export": "GET"
            })
        })
        .collect();
    for (id, _) in pages {
        routes.push(serde_json::json!({
            "kind": "page", "path": format!("/p/{}", &id["pages/".len()..]),
            "module": id, "load": true, "template": id
        }));
    }
    let manifest = serde_json::json!({
        "artifact": { "version": 1 },
        "app": { "name": "streaming", "timezone": "UTC" },
        "code": { "format": "esm-dir", "entry": entry },
        "routes": routes,
        "templates": compiled.manifest_entries(),
        "permissions": { "network": [], "secrets": [] },
        "limits": { "wall_ms": 1000 }
    });
    std::fs::write(
        tmp.join("manifest.json"),
        serde_json::to_vec_pretty(&manifest).unwrap(),
    )
    .unwrap();
    renox_cell::Manifest::parse(&tmp.join("manifest.json")).unwrap();
    let hash = renox_runtime::manifest::content_hash(&tmp).unwrap();
    copy_dir(&tmp, &artifacts.join(&hash));
    hash
}

/// A worker serving the artifact at `s.test`, response egress limit 64 KB.
async fn start() -> (Worker, WorkerConfig) {
    let root = scratch("worker");
    let text = r#"
listen = "127.0.0.1:0"
data_dir = "data"
artifacts_dir = "artifacts"
routes_file = "routes.json"
meters_dir = "meters"
logs_dir = "logs"
idle_timeout_secs = 60
meter_flush_ms = 50

[tiers.free]
egress_bytes = 65536
"#;
    std::fs::write(root.join("worker.toml"), text).unwrap();
    let config = WorkerConfig::parse(text, &root).unwrap();
    std::fs::create_dir_all(&config.artifacts_dir).unwrap();
    let hash = write_artifact(&config.artifacts_dir);
    let routes = serde_json::json!({ "version": 0, "entries": [
        { "hostname": "s.test", "tenant_id": "t_s", "deployment_hash": hash, "status": "active", "updated_at": 1 }
    ]});
    std::fs::write(&config.routes_file, routes.to_string()).unwrap();
    let worker = Worker::start(config.clone()).await.unwrap();
    (worker, config)
}

/// One HTTP/1.1 response read as it arrives: the head, and each body piece
/// with the time it arrived after the request was sent.
struct Timed {
    status: u16,
    head: String,
    /// Decoded body pieces (chunked transfer coding removed), with arrival.
    pieces: Vec<(Duration, Vec<u8>)>,
    /// The terminating zero-length chunk arrived: the body is complete.
    complete: bool,
}

impl Timed {
    fn header(&self, name: &str) -> Option<String> {
        self.head
            .lines()
            .filter_map(|l| l.split_once(':'))
            .find(|(k, _)| k.trim().eq_ignore_ascii_case(name))
            .map(|(_, v)| v.trim().to_string())
    }

    fn body(&self) -> Vec<u8> {
        self.pieces.iter().flat_map(|(_, b)| b.clone()).collect()
    }

    fn text(&self) -> String {
        String::from_utf8_lossy(&self.body()).to_string()
    }

    /// When the body first contained `needle`.
    fn arrival_of(&self, needle: &str) -> Option<Duration> {
        let mut seen = Vec::new();
        for (at, b) in &self.pieces {
            seen.extend_from_slice(b);
            if String::from_utf8_lossy(&seen).contains(needle) {
                return Some(*at);
            }
        }
        None
    }
}

async fn timed_get(addr: SocketAddr, path: &str, extra: &str) -> Timed {
    let mut s = tokio::net::TcpStream::connect(addr).await.unwrap();
    let req = format!("GET {path} HTTP/1.1\r\nHost: s.test\r\n{extra}Connection: close\r\n\r\n");
    let sent = Instant::now();
    s.write_all(req.as_bytes()).await.unwrap();
    let mut raw = Vec::new();
    let mut arrivals: Vec<(Duration, usize)> = Vec::new();
    let mut buf = [0u8; 65536];
    loop {
        match tokio::time::timeout(Duration::from_secs(10), s.read(&mut buf)).await {
            Ok(Ok(0)) | Ok(Err(_)) => break,
            Ok(Ok(n)) => {
                raw.extend_from_slice(&buf[..n]);
                arrivals.push((sent.elapsed(), raw.len()));
            }
            Err(_) => panic!("{path}: no end of response in 10 s"),
        }
    }
    let split = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .expect("a head");
    let head = String::from_utf8_lossy(&raw[..split]).to_string();
    let status = head
        .split(' ')
        .nth(1)
        .and_then(|c| c.parse().ok())
        .unwrap_or(0);
    let body_start = split + 4;
    // Arrival time of the byte at `pos` of `raw`.
    let at = |pos: usize| {
        arrivals
            .iter()
            .find(|(_, end)| *end > pos)
            .map(|(t, _)| *t)
            .unwrap_or_default()
    };
    let chunked = head
        .to_ascii_lowercase()
        .contains("transfer-encoding: chunked");
    let mut pieces = Vec::new();
    let mut complete = false;
    if chunked {
        let mut pos = body_start;
        while let Some(eol) = raw[pos..].windows(2).position(|w| w == b"\r\n") {
            let size_line = String::from_utf8_lossy(&raw[pos..pos + eol]).to_string();
            let Ok(size) = usize::from_str_radix(size_line.trim(), 16) else {
                break;
            };
            let data = pos + eol + 2;
            if size == 0 {
                complete = raw.len() >= data + 2;
                break;
            }
            if raw.len() < data + size {
                pieces.push((at(raw.len() - 1), raw[data..].to_vec()));
                break;
            }
            pieces.push((at(data + size - 1), raw[data..data + size].to_vec()));
            pos = data + size + 2;
        }
    } else if raw.len() > body_start {
        pieces.push((at(raw.len() - 1), raw[body_start..].to_vec()));
        complete = true;
    }
    Timed {
        status,
        head,
        pieces,
        complete,
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

/// The meter record of `request_id`, once it is flushed.
async fn record(meters: &Path, request_id: &str) -> serde_json::Value {
    let start = Instant::now();
    loop {
        if let Some(r) = records(meters)
            .into_iter()
            .find(|r| r["request_id"] == request_id)
        {
            return r;
        }
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "no meter record for {request_id}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// Tenant log lines of `request_id` (redacted, as written by the worker).
async fn tenant_log(logs: &Path, request_id: &str, needle: &str) -> Vec<serde_json::Value> {
    let start = Instant::now();
    loop {
        let text = std::fs::read_to_string(logs.join("tenant.ndjson")).unwrap_or_default();
        let lines: Vec<serde_json::Value> = text
            .lines()
            .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
            .filter(|l| l["request_id"] == request_id)
            .collect();
        if lines.iter().any(|l| l.to_string().contains(needle)) {
            return lines;
        }
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "no log line with {needle} for {request_id}: {lines:?}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

fn request_id(t: &Timed) -> String {
    t.header("x-renox-request-id").expect("x-renox-request-id")
}

/// `ops.md` section 6 ("Response body") and section 7 ("When"): the head
/// and the first chunk reach the client before the stream ends; the body
/// is chunked with the handler's `Content-Length` removed and ends cleanly;
/// the meter record is written at the end of the stream (its `wall_ms`
/// covers the 600 ms wait, `egress_bytes` the body). A static body still
/// goes in one piece with its length (the B6 path is unchanged).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn head_and_first_chunk_arrive_before_the_stream_ends() {
    let (worker, config) = start().await;
    let r = timed_get(worker.addr, "/slow", "").await;
    assert_eq!(r.status, 200, "{}", r.head);
    assert_eq!(r.text(), "first;second;");
    assert!(r.complete, "the body ends with the last chunk");
    assert_eq!(r.header("transfer-encoding").as_deref(), Some("chunked"));
    assert!(r.header("content-length").is_none(), "{}", r.head);
    let first = r.arrival_of("first;").unwrap();
    let second = r.arrival_of("second;").unwrap();
    // #306: this is the cell's first request, so `first` includes the cold
    // start (isolate, policy load, prelude), which a loaded runner stretches
    // past any fixed bound. What streaming means is the gap: the handler
    // waits 600 ms between the chunks, so a body held back until the end
    // would deliver both together; a streamed one delivers `first;` well
    // before `second;`. The lower bound on `second` only grows with load.
    assert!(
        second.saturating_sub(first) >= Duration::from_millis(300)
            && second >= Duration::from_millis(550),
        "first at {first:?}, second at {second:?}"
    );
    let rec = record(&config.meters_dir, &request_id(&r)).await;
    assert_eq!(rec["route"], "GET /slow");
    assert_eq!(rec["status"], "ok");
    assert_eq!(rec["http_status"], 200);
    assert_eq!(rec["egress_bytes"], 13);
    assert!(rec["wall_ms"].as_f64().unwrap() >= 550.0, "{rec}");

    // Compressed per chunk.
    let gz = timed_get(worker.addr, "/slow", "Accept-Encoding: gzip\r\n").await;
    assert_eq!(gz.header("content-encoding").as_deref(), Some("gzip"));
    assert!(gz.complete);
    // gzip magic; decoding per chunk is renox-gateway's tests/compress.rs.
    assert_eq!(&gz.body()[..2], &[0x1f, 0x8b]);
    assert!(gz.pieces.len() >= 2, "one piece per flushed chunk");
    let rec = record(&config.meters_dir, &request_id(&gz)).await;
    assert_eq!(
        rec["egress_bytes"],
        gz.body().len(),
        "egress after compression"
    );

    let s = timed_get(worker.addr, "/static", "").await;
    assert_eq!(s.status, 200);
    assert_eq!(s.text(), "static body");
    assert_eq!(s.header("content-length").as_deref(), Some("11"));
    worker.shutdown().await;
}

/// `ops.md` section 10 ("Response egress", "Mid-stream"): the chunk that
/// would pass the limit (64 KB here) is refused whole, the body is
/// truncated (no terminating chunk), the log carries `egress_limit`, and
/// the record says `error` with the bytes sent. Also a failed stream
/// (`stream_error`) and the deadline mid-stream (`timeout`).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn egress_limit_and_deadline_truncate_the_body() {
    let (worker, config) = start().await;
    let r = timed_get(worker.addr, "/flood", "").await;
    assert_eq!(r.status, 200);
    assert!(!r.complete, "a truncated body has no last chunk");
    assert_eq!(r.body().len(), 65536, "four 16 KB chunks fit in 64 KB");
    let id = request_id(&r);
    let lines = tenant_log(&config.logs_dir, &id, "egress_limit").await;
    let line = lines
        .iter()
        .find(|l| l.to_string().contains("egress_limit"))
        .unwrap();
    assert_eq!(line["fields"]["limit_bytes"], 65536, "{line}");
    assert_eq!(line["fields"]["sent_bytes"], 65536, "{line}");
    let rec = record(&config.meters_dir, &id).await;
    assert_eq!(rec["status"], "error");
    assert_eq!(rec["egress_bytes"], 65536);

    let f = timed_get(worker.addr, "/fails", "").await;
    assert_eq!(f.text(), "ok;");
    assert!(!f.complete);
    let id = request_id(&f);
    tenant_log(&config.logs_dir, &id, "upstream reset").await;
    assert_eq!(record(&config.meters_dir, &id).await["status"], "error");

    let h = timed_get(worker.addr, "/hang", "").await;
    assert_eq!(h.status, 200);
    assert_eq!(h.text(), "hang;");
    assert!(!h.complete, "the deadline truncates the body");
    let id = request_id(&h);
    tenant_log(&config.logs_dir, &id, "RENOX_DEADLINE").await;
    let rec = record(&config.meters_dir, &id).await;
    assert_eq!(rec["status"], "timeout");
    assert_eq!(rec["http_status"], 200);
    assert_eq!(rec["egress_bytes"], 5);
    worker.shutdown().await;
}

/// `ops.md` section 10 ("Mid-stream"; `docs/23-failure-modes.md`, "Infinite
/// loop in a handler"): a CPU kill after the head truncates the body, and
/// the record says `cpu_limit` with the bytes sent so far.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cpu_kill_mid_stream_records_cpu_limit() {
    let (worker, config) = start().await;
    let r = timed_get(worker.addr, "/spin", "").await;
    assert_eq!(r.status, 200, "the head was sent before the kill");
    assert_eq!(r.text(), "start;");
    assert!(!r.complete);
    let id = request_id(&r);
    let lines = tenant_log(&config.logs_dir, &id, "RENOX_CPU_LIMIT").await;
    let line = lines
        .iter()
        .find(|l| l.to_string().contains("RENOX_CPU_LIMIT"))
        .unwrap();
    assert_eq!(line["fields"]["phase"], "stream", "{line}");
    assert_eq!(line["fields"]["sent_bytes"], 6, "{line}");
    let rec = record(&config.meters_dir, &id).await;
    assert_eq!(rec["status"], "cpu_limit");
    assert_eq!(rec["http_status"], 200);
    assert_eq!(rec["egress_bytes"], 6);
    // The member was recycled; the deployment still serves.
    let s = timed_get(worker.addr, "/static", "").await;
    assert_eq!(s.text(), "static body");
    worker.shutdown().await;
}

/// `ops.md` section 14 ("Streaming the shell"): with a loader slower than
/// the shell delay, the shell (the layout up to its first data read, with
/// the shell tags) reaches the client before the loader finishes; the rest
/// follows and the document is the whole page, equal to what a fast loader
/// gets in one piece. A fast loader's page keeps its `Content-Length`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shell_bytes_arrive_before_a_slow_loader_finishes() {
    let (worker, config) = start().await;
    let r = timed_get(worker.addr, "/p/slow", "").await;
    assert_eq!(r.status, 200, "{}", r.head);
    assert_eq!(r.header("transfer-encoding").as_deref(), Some("chunked"));
    assert_eq!(
        r.header("content-type").as_deref(),
        Some("text/html; charset=utf-8")
    );
    let id = request_id(&r);
    let shell = r
        .arrival_of(&format!(
            "<meta name=\"renox-request-id\" content=\"{id}\">"
        ))
        .expect("the shell tags");
    let header = r.arrival_of("<header class=\"site-header\">").unwrap();
    let data = r.arrival_of("saffron</li>").unwrap();
    // #306: the loader sleeps 700 ms and the shell is flushed after the
    // 50 ms shell delay, so the shell (and the layout's header) arrive about
    // 650 ms before the loader's data; a page held back until the loader
    // finished would deliver them together. The cold start of this first
    // request is on both sides of the gap, so a loaded runner does not move
    // it; the lower bound on `data` only grows with load.
    assert!(
        data.saturating_sub(shell) >= Duration::from_millis(300)
            && data.saturating_sub(header) >= Duration::from_millis(300),
        "shell at {shell:?}, header at {header:?}, data at {data:?}"
    );
    assert!(data >= Duration::from_millis(650), "data at {data:?}");
    assert!(r.complete);
    let html = r.text();
    assert!(html.starts_with("<!DOCTYPE html>"), "{html}");
    assert!(
        html.contains("<span id=\"cart\" dir=\"auto\">3</span>"),
        "{html}"
    );
    assert!(html.trim_end().ends_with("</html>"), "{html}");
    assert_eq!(html.matches("<head>").count(), 1, "{html}");
    let rec = record(&config.meters_dir, &id).await;
    assert_eq!(rec["status"], "ok");
    assert_eq!(rec["route"], "GET /p/slow");
    assert_eq!(rec["egress_bytes"], html.len());
    assert!(rec["render_fuel"].as_u64().unwrap() > 0);
    assert!(rec["wall_ms"].as_f64().unwrap() >= 650.0, "{rec}");

    let fast = timed_get(worker.addr, "/p/fast", "").await;
    assert_eq!(fast.status, 200);
    assert_eq!(
        fast.header("content-length"),
        Some(fast.body().len().to_string())
    );
    let fast_id = request_id(&fast);
    // Same template: the streamed page is the buffered page.
    let normalise = |html: String, id: &str, title: &str, cart: &str, items: &str| {
        html.replace(id, "ID")
            .replace(title, "T")
            .replace(
                &format!("<span id=\"cart\" dir=\"auto\">{cart}</span>"),
                "CART",
            )
            .replace(items, "ITEMS")
    };
    let nonce = |html: &str| {
        html.split("nonce=\"")
            .nth(1)
            .and_then(|r| r.split('"').next())
            .unwrap_or("")
            .to_string()
    };
    let slow_html = normalise(
        html.clone(),
        &id,
        "Slow",
        "3",
        "<li dir=\"auto\">dates</li><li dir=\"auto\">saffron</li>",
    );
    let fast_html = normalise(
        fast.text(),
        &fast_id,
        "Fast",
        "1",
        "<li dir=\"auto\">tea</li>",
    );
    assert_eq!(
        slow_html.replace(&nonce(&slow_html), "N"),
        fast_html.replace(&nonce(&fast_html), "N")
    );
    worker.shutdown().await;
}

/// `ops.md` section 14 ("Errors after the shell"): the status is already
/// 200, so a loader that throws after the shell gets the `_error` page's
/// markup inside the stream (from its `<body>`), the log line carries
/// `streamed: true`, and the record keeps the buffered page's `status`.
/// A loader `Response` after the shell is `response_after_shell`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn loader_error_after_the_shell_is_rendered_inside_the_stream() {
    let (worker, config) = start().await;
    let r = timed_get(worker.addr, "/p/slow-throws", "").await;
    assert_eq!(r.status, 200, "{}", r.head);
    assert!(r.complete, "the error page ends the stream normally");
    let id = request_id(&r);
    let html = r.text();
    assert!(
        html.contains("<header class=\"site-header\">"),
        "the shell: {html}"
    );
    assert!(
        html.contains("<body><h1 dir=\"auto\">Error 500</h1><p dir=\"auto\">RENOX_INTERNAL</p>"),
        "the error page inside the stream: {html}"
    );
    assert!(html.contains(&id), "{html}");
    assert!(
        !html.contains("database is down"),
        "no tenant error text: {html}"
    );
    let lines = tenant_log(&config.logs_dir, &id, "streamed").await;
    assert!(
        lines
            .iter()
            .any(|l| l.to_string().contains("handler threw")),
        "{lines:?}"
    );
    let rec = record(&config.meters_dir, &id).await;
    assert_eq!(rec["status"], "error");
    assert_eq!(rec["http_status"], 200);

    let r = timed_get(worker.addr, "/p/slow-redirect", "").await;
    assert_eq!(r.status, 200);
    assert!(r.text().contains("Error 500</h1>"), "{}", r.text());
    let id = request_id(&r);
    tenant_log(&config.logs_dir, &id, "response_after_shell").await;
    assert_eq!(record(&config.meters_dir, &id).await["status"], "error");
    worker.shutdown().await;
}

/// `ops.md` section 7 ("When"): a client that goes away mid-stream still
/// gets a record (`ok`, the bytes sent), and the request ends at once
/// rather than at its deadline.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn client_gone_mid_stream_still_writes_the_record() {
    let (worker, config) = start().await;
    let mut s = tokio::net::TcpStream::connect(worker.addr).await.unwrap();
    s.write_all(b"GET /hang HTTP/1.1\r\nHost: s.test\r\nConnection: close\r\n\r\n")
        .await
        .unwrap();
    let mut buf = vec![0u8; 4096];
    let mut got = Vec::new();
    while !String::from_utf8_lossy(&got).contains("hang;") {
        let n = s.read(&mut buf).await.unwrap();
        assert!(n > 0);
        got.extend_from_slice(&buf[..n]);
    }
    let head = String::from_utf8_lossy(&got).to_string();
    let id = head
        .lines()
        .find_map(|l| l.strip_prefix("x-renox-request-id: "))
        .unwrap()
        .trim()
        .to_string();
    drop(s);
    let rec = record(&config.meters_dir, &id).await;
    assert_eq!(rec["route"], "GET /hang");
    assert_eq!(rec["status"], "ok");
    assert_eq!(rec["egress_bytes"], 5);
    assert!(
        rec["wall_ms"].as_f64().unwrap() < 900.0,
        "ended before the 1 s deadline: {rec}"
    );
    worker.shutdown().await;
}

/// #306: the first request of a cell against the second (warm), for the
/// streamed function and the streamed page. Not an assertion: run with
/// `cargo test -p renox-cell --test streaming first_request_cost -- --ignored --nocapture`
/// (and `RUST_LOG=renox_cell=debug` for the `cell ready` and `policy set
/// loaded` breakdown); the numbers are in docs/14-benchmarks.md, "F5 first
/// request".
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore]
async fn first_request_cost() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .with_test_writer()
        .try_init();
    for (path, needle) in [
        ("/slow", "first;"),
        ("/p/slow", "<header class=\"site-header\">"),
    ] {
        let (worker, _) = start().await;
        let cold = timed_get(worker.addr, path, "").await;
        let warm = timed_get(worker.addr, path, "").await;
        println!(
            "{path}: first byte of interest cold {:?}, warm {:?}",
            cold.arrival_of(needle).unwrap(),
            warm.arrival_of(needle).unwrap()
        );
        worker.shutdown().await;
    }
}
