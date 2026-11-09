//! Issue #295: one trace per request through the worker, the metrics
//! families, and redaction (V8-linked). An in-memory exporter stands in for
//! the OTLP collector.
//!
//! Proves `docs/24-threat-model.md` "Secrets in logs, spans or metrics": a
//! request with a secret in a header and in the query leaves no trace of it
//! in any exported span attribute or in `/metrics`.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use opentelemetry::trace::SpanId;
use opentelemetry_sdk::trace::{InMemorySpanExporter, SdkTracerProvider, SpanData};
use renox_cell::{Worker, WorkerConfig};
use renox_template::{Compiler, TemplateProject};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tracing_subscriber::layer::SubscriberExt;

static N: AtomicU64 = AtomicU64::new(0);
const SECRET: &str = "sk_live_TelemetrySecret_93a1f";

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "renox-cell-telemetry-{}-{name}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// One global subscriber for the test binary (spans are created on the
/// gateway's, the cell's and the isolate's threads).
fn exporter() -> &'static (InMemorySpanExporter, SdkTracerProvider) {
    static E: OnceLock<(InMemorySpanExporter, SdkTracerProvider)> = OnceLock::new();
    E.get_or_init(|| {
        let exporter = InMemorySpanExporter::default();
        let provider = SdkTracerProvider::builder()
            .with_simple_exporter(exporter.clone())
            .with_sampler(renox_cell::telemetry::sampler(1.0))
            .build();
        let subscriber = tracing_subscriber::registry()
            .with(renox_cell::telemetry::layer(&provider))
            .with(tracing_subscriber::EnvFilter::new("info"));
        tracing::subscriber::set_global_default(subscriber).unwrap();
        (exporter, provider)
    })
}

const PAGE_JS: &str = r#"
export async function load(ctx) {
  ctx.log.info("loading items");
  const rows = await ctx.db.query("select name from app__items where name != ?", [ctx.url.searchParams.get("token") ?? ""]);
  return { title: "Items", items: rows.map((r) => r.name) };
}
"#;

const FN_JS: &str = r#"
export async function POST(ctx) {
  await ctx.db.execute("insert into app__items (name) values (?)", [ctx.headers.get("x-api-key") ?? ""]);
  return new Response("ok");
}
"#;

fn write_artifact(artifacts: &Path) -> String {
    let mut project = TemplateProject::new();
    project.insert(
        "pages/items.html",
        "<!DOCTYPE html><html><head></head><body><h1>{{ title }}</h1><ul><li r-for=\"i in items\">{{ i }}</li></ul></body></html>",
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
    for (id, js) in [("pages/items", PAGE_JS), ("functions/items", FN_JS)] {
        let p = tmp.join("code").join(format!("{id}.js"));
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, js).unwrap();
    }
    let sql = "create table app__items (name text);\n";
    std::fs::create_dir_all(tmp.join("migrations/app")).unwrap();
    std::fs::write(tmp.join("migrations/app/001_init.sql"), sql).unwrap();
    use sha2::Digest;
    let digest: String = sha2::Sha256::digest(sql.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    std::fs::write(
        tmp.join("migrations/checksums.json"),
        serde_json::json!({ "version": 0, "files": { "app/001_init.sql": digest } }).to_string(),
    )
    .unwrap();
    let manifest = serde_json::json!({
        "artifact": { "version": 1 },
        "app": { "name": "telemetry", "timezone": "UTC" },
        "code": { "format": "esm-dir", "entry": { "pages/items": "pages/items.js", "functions/items": "functions/items.js" } },
        "routes": [
            { "kind": "page", "path": "/items", "module": "pages/items", "load": true, "template": "pages/items" },
            { "kind": "function", "method": "POST", "path": "/api/items", "module": "functions/items", "export": "POST" }
        ],
        "templates": compiled.manifest_entries(),
        "permissions": { "network": [], "secrets": [] },
    });
    std::fs::write(
        tmp.join("manifest.json"),
        serde_json::to_vec_pretty(&manifest).unwrap(),
    )
    .unwrap();
    let hash = renox_runtime::manifest::content_hash(&tmp).unwrap();
    std::fs::rename(&tmp, artifacts.join(&hash)).unwrap();
    hash
}

async fn start() -> (Worker, PathBuf) {
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
"#;
    std::fs::write(root.join("worker.toml"), text).unwrap();
    let config = WorkerConfig::parse(text, &root).unwrap();
    std::fs::create_dir_all(&config.artifacts_dir).unwrap();
    let hash = write_artifact(&config.artifacts_dir);
    let routes = serde_json::json!({ "version": 0, "entries": [
        { "hostname": "t.test", "tenant_id": "t_tel", "deployment_hash": hash, "status": "active", "updated_at": 1 }
    ]});
    std::fs::write(&config.routes_file, routes.to_string()).unwrap();
    let logs = config.logs_dir.clone();
    (Worker::start(config).await.unwrap(), logs)
}

/// Every tenant log line written under `dir` so far.
fn log_lines(dir: &Path) -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for e in std::fs::read_dir(&d).into_iter().flatten().flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else if let Ok(text) = std::fs::read_to_string(&p) {
                out.extend(text.lines().filter_map(|l| serde_json::from_str(l).ok()));
            }
        }
    }
    out
}

async fn send(addr: std::net::SocketAddr, head: &str) -> String {
    let mut s = tokio::net::TcpStream::connect(addr).await.unwrap();
    s.write_all(head.as_bytes()).await.unwrap();
    let mut out = Vec::new();
    tokio::time::timeout(Duration::from_secs(10), s.read_to_end(&mut out))
        .await
        .unwrap()
        .unwrap();
    String::from_utf8_lossy(&out).into_owned()
}

fn by_name<'a>(spans: &'a [SpanData], name: &str) -> Vec<&'a SpanData> {
    spans.iter().filter(|s| s.name == name).collect()
}

fn attr(s: &SpanData, key: &str) -> Option<String> {
    s.attributes
        .iter()
        .find(|kv| kv.key.as_str() == key)
        .map(|kv| kv.value.to_string())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn one_page_request_is_one_trace_and_no_secret_reaches_spans_or_metrics() {
    let (exporter, provider) = exporter();
    let (worker, logs) = start().await;
    let post = send(
        worker.addr,
        &format!("POST /api/items?token={SECRET} HTTP/1.1\r\nHost: t.test\r\nx-api-key: {SECRET}\r\nCookie: s={SECRET}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"),
    )
    .await;
    assert!(post.starts_with("HTTP/1.1 200"), "{post}");
    let page = send(
        worker.addr,
        &format!("GET /items?token={SECRET} HTTP/1.1\r\nHost: t.test\r\nAccept: text/html\r\nx-api-key: {SECRET}\r\nConnection: close\r\n\r\n"),
    )
    .await;
    assert!(page.starts_with("HTTP/1.1 200"), "{page}");
    let _ = provider.force_flush();
    tokio::time::sleep(Duration::from_millis(200)).await;
    let spans = exporter.get_finished_spans().unwrap();

    // The page request: gateway.request is the root, cell.request its
    // child, cell.loader and template.render children of cell.request.
    let page_root = by_name(&spans, "gateway.request")
        .into_iter()
        .find(|s| {
            spans.iter().any(|c| {
                c.parent_span_id == s.span_context.span_id()
                    && c.name == "cell.request"
                    && spans.iter().any(|g| {
                        g.parent_span_id == c.span_context.span_id() && g.name == "cell.loader"
                    })
            })
        })
        .expect("a gateway.request with the page's cell.request");
    assert_eq!(
        page_root.parent_span_id,
        SpanId::INVALID,
        "gateway.request is the root"
    );
    assert_eq!(attr(page_root, "tenant_id").as_deref(), Some("t_tel"));
    assert_eq!(attr(page_root, "status").as_deref(), Some("200"));
    let trace = page_root.span_context.trace_id();
    let cell = spans
        .iter()
        .find(|s| s.name == "cell.request" && s.parent_span_id == page_root.span_context.span_id())
        .unwrap();
    let children: Vec<&str> = spans
        .iter()
        .filter(|s| s.parent_span_id == cell.span_context.span_id())
        .map(|s| s.name.as_ref())
        .collect();
    assert!(children.contains(&"cell.loader"), "{children:?}");
    assert!(children.contains(&"template.render"), "{children:?}");
    assert!(
        spans
            .iter()
            .filter(|s| s.span_context.trace_id() == trace)
            .count()
            >= 4
    );
    // The trace id was recorded on the root for the log lines.
    assert_eq!(attr(page_root, "trace_id"), Some(trace.to_string()));
    // The function request: cell.function under cell.request.
    assert!(!by_name(&spans, "cell.function").is_empty());
    // Statements: the verb and the tables, never the SQL or a parameter.
    let queries = by_name(&spans, "db.query");
    assert!(
        queries
            .iter()
            .any(|q| attr(q, "kind").as_deref() == Some("insert")
                && attr(q, "tables").as_deref() == Some("app__items")),
        "{queries:?}"
    );
    assert!(
        queries
            .iter()
            .any(|q| attr(q, "kind").as_deref() == Some("select"))
    );
    // #295: a statement on the DB thread is a child of its request's
    // handler span, in the request's trace (no longer a trace of its own).
    let loader = spans
        .iter()
        .find(|s| s.name == "cell.loader" && s.span_context.trace_id() == trace)
        .expect("the page's cell.loader");
    assert!(
        queries
            .iter()
            .any(|q| q.parent_span_id == loader.span_context.span_id()
                && q.span_context.trace_id() == trace
                && attr(q, "kind").as_deref() == Some("select")),
        "the page's select is a child of cell.loader: {queries:?}"
    );

    // Redaction: the secret is in no span name or attribute.
    for s in &spans {
        assert!(!s.name.contains(SECRET), "{}", s.name);
        for kv in &s.attributes {
            let v = kv.value.to_string();
            assert!(
                !v.contains(SECRET) && !v.contains("token="),
                "{} = {v} on {}",
                kv.key,
                s.name
            );
        }
    }

    // Metrics: the families the Grafana panels and alert rules read.
    let text = worker.manager.metrics_text(Some((0.4, 0)), vec![]).await;
    for family in [
        "renox_worker_requests_total{tenant_id=\"t_tel\",status_class=\"2xx\"} 2",
        "renox_worker_request_duration_seconds_count{tenant_id=\"t_tel\"} 2",
        "renox_worker_cpu_seconds_total{tenant_id=\"t_tel\"}",
        "renox_worker_cold_starts_total{tenant_id=\"t_tel\"} 1",
        "renox_worker_cold_start_duration_seconds_count 1",
        "renox_worker_cells 1",
        "renox_worker_outbox_pending{tenant_id=\"t_tel\"} 0",
        "renox_worker_outbox_oldest_age_seconds{tenant_id=\"t_tel\"} 0",
        "renox_worker_dead_letters_total{tenant_id=\"t_tel\"} 0",
        "renox_worker_authz_decisions_total{tenant_id=\"t_tel\",decision=\"all\"}",
        "renox_worker_disk_level 0",
        // The families #295 had pending (telemetry::counters).
        "renox_worker_sandbox_denials_total{kind=\"seccomp\"} 0",
        "# TYPE renox_worker_replication_lag_seconds gauge",
        "# TYPE renox_worker_process_restarts_total counter",
        "renox_worker_db_unavailable 0",
        "renox_worker_log_lines_sampled_out_total",
        // #297.
        "renox_worker_job_runs_total",
    ] {
        assert!(text.contains(family), "missing {family} in\n{text}");
    }
    assert!(!text.contains(SECRET));
    // #295: the tenant's own log line names the request's trace.
    let mut line = None;
    for _ in 0..50 {
        line = log_lines(&logs)
            .into_iter()
            .find(|l| l.to_string().contains("loading items"));
        if line.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let line = line.expect("the loader's log line");
    assert!(
        line.to_string().contains(&trace.to_string()),
        "the line carries trace_id {trace}: {line}"
    );
    worker.shutdown().await;
}

// ---------------------------------------------------------------- #659

const SEC_FN_JS: &str = r#"
export async function GET({ url, db }) {
  const op = url.searchParams.get("op");
  try {
    if (op === "fetch") await fetch("http://127.0.0.1:9/");
    if (op === "attach") await db.execute("attach database ? as other", ["/tmp/renox-other.db"]);
  } catch (e) {
    return Response.json({ code: e.code });
  }
  return Response.json({ code: null });
}
export function POST() { return Response.json({ ok: true }); }
"#;

const SEC_PAGE_JS: &str = r#"
export function load() { return new Response("page"); }
export const actions = { async add() { return { ok: 1 }; } };
"#;

fn write_security_artifact(artifacts: &Path) -> String {
    let tmp = scratch("sec-artifact-src");
    for (id, js) in [("functions/api/sec", SEC_FN_JS), ("pages/sec", SEC_PAGE_JS)] {
        let p = tmp.join("code").join(format!("{id}.js"));
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, js).unwrap();
    }
    let sql = "create table app__x (id integer primary key);\n";
    std::fs::create_dir_all(tmp.join("migrations/app")).unwrap();
    std::fs::write(tmp.join("migrations/app/001_init.sql"), sql).unwrap();
    use sha2::Digest;
    let digest: String = sha2::Sha256::digest(sql.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    std::fs::write(
        tmp.join("migrations/checksums.json"),
        serde_json::json!({ "version": 0, "files": { "app/001_init.sql": digest } }).to_string(),
    )
    .unwrap();
    let manifest = serde_json::json!({
        "artifact": { "version": 1 },
        "app": { "name": "security", "timezone": "UTC" },
        "code": { "format": "esm-dir", "entry": { "functions/api/sec": "functions/api/sec.js", "pages/sec": "pages/sec.js" } },
        "routes": [
            { "kind": "function", "method": "GET", "path": "/api/sec", "module": "functions/api/sec", "export": "GET" },
            { "kind": "function", "method": "POST", "path": "/api/sec", "module": "functions/api/sec", "export": "POST" },
            { "kind": "page", "path": "/sec", "module": "pages/sec", "load": true, "actions": ["add"] }
        ],
        "permissions": { "network": [], "secrets": [] },
        "security": { "ratelimit": [
            { "method": "POST", "path": "/api/sec", "requests": 1, "window_s": 60, "key": "ip" }
        ] }
    });
    std::fs::write(
        tmp.join("manifest.json"),
        serde_json::to_vec_pretty(&manifest).unwrap(),
    )
    .unwrap();
    let hash = renox_runtime::manifest::content_hash(&tmp).unwrap();
    std::fs::rename(&tmp, artifacts.join(&hash)).unwrap();
    hash
}

async fn sec_get(addr: std::net::SocketAddr, path: &str) -> String {
    let head = format!("GET {path} HTTP/1.1\r\nHost: sec.test\r\nConnection: close\r\n\r\n");
    send(addr, &head).await
}

async fn sec_post(addr: std::net::SocketAddr, path: &str) -> String {
    let head = format!(
        "POST {path} HTTP/1.1\r\nHost: sec.test\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: 5\r\nConnection: close\r\n\r\nsku=a"
    );
    send(addr, &head).await
}

const SECURITY_LINES: [&str; 5] = [
    "renox_security_events_total{tenant_id=\"t_sec\",kind=\"fetch_denied\"} 1\n",
    "renox_security_events_total{tenant_id=\"t_sec\",kind=\"db_auth_refused\"} 1\n",
    "renox_security_events_total{tenant_id=\"t_sec\",kind=\"csrf_failed\"} 1\n",
    "renox_security_events_total{tenant_id=\"t_sec\",kind=\"rate_limited\"} 1\n",
    "renox_security_events_total{tenant_id=\"t_sec\",kind=\"login_failed\"} 1\n",
];

/// #659: each of the five security events adds one to
/// `renox_security_events_total{tenant_id, kind}` (docs/24 "Security
/// events not visible to operators"): a blocked fetch, a statement the
/// SQLite authorizer refuses (`RENOX_DB_AUTH`), a CSRF failure, a per-route
/// 429, and auth's `auth.login_failed` event.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn security_events_are_counted_per_kind() {
    let root = scratch("security");
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
    std::fs::create_dir_all(&config.artifacts_dir).unwrap();
    let hash = write_security_artifact(&config.artifacts_dir);
    let routes = serde_json::json!({ "version": 0, "entries": [
        { "hostname": "sec.test", "tenant_id": "t_sec", "deployment_hash": hash, "status": "active", "updated_at": 1 }
    ]});
    std::fs::write(&config.routes_file, routes.to_string()).unwrap();
    // A failed sign-in the auth module emitted before this worker started:
    // the new cell's outbox delivers it, and the cell counts it.
    {
        let dir = config.data_dir.join("t_sec");
        std::fs::create_dir_all(&dir).unwrap();
        let db = renox_data::TenantDb::open(dir.join("app.db"), renox_data::DbOptions::default())
            .unwrap();
        renox_data::outbox::emit_autocommit(
            &db,
            &renox_data::outbox::OutboxEvent {
                id: "01JBQ3Z7MA0000000000000659".into(),
                name: "auth.login_failed".into(),
                payload: r#"{"reason":"password","ip_hash":"0123456789abcdef"}"#.into(),
                module: "auth".into(),
                created_at: 1,
            },
        )
        .unwrap();
        db.close().unwrap();
    }
    let worker = Worker::start(config).await.unwrap();
    let addr = worker.addr;

    let r = sec_get(addr, "/api/sec?op=fetch").await;
    assert!(r.contains("RENOX_FETCH_BLOCKED"), "{r}");
    let r = sec_get(addr, "/api/sec?op=attach").await;
    assert!(r.contains("RENOX_DB_AUTH"), "{r}");
    let r = sec_post(addr, "/sec?/add").await;
    assert!(r.starts_with("HTTP/1.1 403"), "{r}");
    let r = sec_post(addr, "/api/sec").await;
    assert!(r.starts_with("HTTP/1.1 200"), "{r}");
    let r = sec_post(addr, "/api/sec").await;
    assert!(r.starts_with("HTTP/1.1 429"), "{r}");

    // The request records are written after the response; poll `/metrics`.
    let mut text = String::new();
    for _ in 0..50 {
        text = worker.manager.metrics_text(None, vec![]).await;
        if SECURITY_LINES.iter().all(|l| text.contains(l)) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    for line in SECURITY_LINES {
        assert!(text.contains(line), "missing {line} in\n{text}");
    }
    assert!(text.contains("# TYPE renox_security_events_total counter"));
    assert!(text.contains("renox_gateway_rate_limited_total "));
    worker.shutdown().await;
}
