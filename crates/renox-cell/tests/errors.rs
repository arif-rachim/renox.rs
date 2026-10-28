//! #93: error pages of page routes end to end through the worker
//! (`docs/contracts/errors.md` section 1; `docs/23-failure-modes.md` rule 2
//! and section 6). Each of `cpu_limit`, `oom`, `timeout`, the render limit,
//! `internal`, and 404 on an HTML route renders an HTML page:
//!
//! - tenant `shop`: the error and 404 templates and the layout of
//!   `examples/shop/pages/`;
//! - tenant `evil`: the attacks of `examples/evil` as page loaders (the
//!   B13 template `pages/nested.html` with its loader, and loaders doing
//!   what `functions/api/loop|alloc|hang` do), with an error template that
//!   asks for every value an error page must never get. The page shows the
//!   four fields only (`errors.md` section 1), checked by grepping each
//!   body for the causes, limits, and figures the log has.
//! - without an error template: the platform default page.
//!
//! No page carries the dev overlay (`renox dev` injects it in its proxy).

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use renox_cell::{Worker, WorkerConfig};
use renox_template::{Compiler, TemplateProject};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

static N: AtomicU64 = AtomicU64::new(0);

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "renox-cell-errors-{}-{name}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn read(rel: &str) -> String {
    std::fs::read_to_string(repo().join(rel)).unwrap()
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

/// `functions/api/loop.ts`: never yields.
const LOOP_JS: &str = "export function load() { for (;;) {} }";
/// `functions/api/alloc.ts`: grows a module-level array until the heap is full.
const ALLOC_JS: &str = "const keep = [];\nexport function load() { for (;;) keep.push(new Array(1 << 20).fill(keep.length)); }";
/// `functions/api/hang.ts`: never resolves, uses no CPU.
const HANG_JS: &str = "export function load() { return new Promise(() => {}); }";
const THROWS_JS: &str =
    "export function load() { throw new Error(\"database is down at 10.0.0.7\"); }";

/// The pages both tenants have, by error kind.
const PAGES: [(&str, &str); 5] = [
    ("loop", LOOP_JS),
    ("alloc", ALLOC_JS),
    ("hang", HANG_JS),
    ("throws", THROWS_JS),
    ("nested", ""),
];

/// An error template that asks for everything the log knows.
const HOSTILE_ERROR: &str = "<!doctype html><html><head><title>e</title></head><body>\
<p id=\"fields\">{{ status }}|{{ code }}|{{ request_id }}|{{ message }}</p>\
<p id=\"extra\">[{{ cause_message }}{{ stack }}{{ limit }}{{ limit_ms }}{{ template }}{{ cpu_ms }}{{ peak_heap_bytes }}{{ route }}{{ reason }}{{ phase }}{{ render_fuel }}{{ fields }}{{ error }}{{ request }}{{ ctx }}{{ env }}{{ secrets }}]</p>\
</body></html>";

/// Writes an artifact; `templates` are `(path, source)` pairs of the
/// template project besides the pages.
fn write_artifact(artifacts: &Path, templates: &[(&str, String)]) -> String {
    let mut project = TemplateProject::new();
    for (path, src) in templates {
        project.insert(path.to_string(), src.clone());
    }
    for (name, _) in PAGES {
        let src = if name == "nested" {
            read("examples/evil/pages/nested.html")
        } else {
            "<p>{{ x }}</p>".to_string()
        };
        project.insert(format!("pages/{name}.html"), src);
    }
    let compiled = Compiler::default()
        .compile(&project)
        .unwrap_or_else(|d| panic!("{d:?}"));
    let tmp = scratch("artifact-src");
    for (rel, src) in compiled.files() {
        let p = tmp.join("templates").join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, src).unwrap();
    }
    let nested = read("examples/evil/pages/nested.ts");
    let mut entry = serde_json::Map::new();
    let mut routes = Vec::new();
    for (name, js) in PAGES {
        let js = if name == "nested" {
            nested.as_str()
        } else {
            js
        };
        let id = format!("pages/{name}");
        let p = tmp.join("code").join(format!("{id}.js"));
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, js).unwrap();
        entry.insert(id.clone(), format!("{id}.js").into());
        routes.push(serde_json::json!({
            "kind": "page", "path": format!("/{name}"), "module": id, "load": true, "template": id
        }));
    }
    let manifest = serde_json::json!({
        "artifact": { "version": 1 },
        "app": { "name": "errors", "timezone": "Asia/Dubai" },
        "code": { "format": "esm-dir", "entry": entry },
        "routes": routes,
        "templates": compiled.manifest_entries(),
        "permissions": { "network": [], "secrets": [] }
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

struct Reply {
    status: u16,
    head: String,
    body: String,
}

async fn get(addr: SocketAddr, host: &str, path: &str) -> Reply {
    let mut s = tokio::net::TcpStream::connect(addr).await.unwrap();
    let req = format!(
        "GET {path} HTTP/1.1\r\nHost: {host}\r\nAccept: text/html,application/xhtml+xml,*/*;q=0.8\r\nConnection: close\r\n\r\n"
    );
    s.write_all(req.as_bytes()).await.unwrap();
    let mut buf = Vec::new();
    s.read_to_end(&mut buf).await.unwrap();
    let text = String::from_utf8_lossy(&buf).to_string();
    let (head, body) = text.split_once("\r\n\r\n").unwrap_or((&text, ""));
    Reply {
        status: head
            .split(' ')
            .nth(1)
            .and_then(|c| c.parse().ok())
            .unwrap_or(0),
        head: head.to_ascii_lowercase(),
        body: body.to_string(),
    }
}

/// `(path, status, code)` of every error kind.
const CASES: [(&str, u16, Option<&str>); 6] = [
    ("/loop", 503, Some("RENOX_CPU_LIMIT")),
    ("/alloc", 503, Some("RENOX_OOM")),
    ("/hang", 504, Some("RENOX_DEADLINE")),
    ("/nested", 500, Some("RENOX_RENDER_LIMIT")),
    ("/throws", 500, Some("RENOX_INTERNAL")),
    ("/nowhere", 404, None),
];

/// What no error page may show (`errors.md` section 1): causes, limit
/// names, template ids, and the dev overlay.
const NEVER: [&str; 9] = [
    "database is down",
    "10.0.0.7",
    "pages/nested",
    "pages/throws",
    "load_result",
    "\"limit\"",
    "fuel",
    "__renox/dev",
    "renox-dev-overlay",
];

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_error_kind_renders_its_page() {
    let root = scratch("worker");
    std::fs::create_dir_all(root.join("artifacts")).unwrap();
    // Small limits so the attacks end quickly; the mechanism is the tier's.
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
cpu_ms = 200
wall_ms = 1500
heap_mb = 32
"#;
    let config = WorkerConfig::parse(text, &root).unwrap();
    let shop = write_artifact(
        &config.artifacts_dir,
        &[
            ("pages/_error.html", read("examples/shop/pages/_error.html")),
            ("pages/_404.html", read("examples/shop/pages/_404.html")),
            (
                "pages/_layouts/main.html",
                read("examples/shop/pages/_layouts/main.html"),
            ),
        ],
    );
    let evil = write_artifact(
        &config.artifacts_dir,
        &[("pages/_error.html", HOSTILE_ERROR.to_string())],
    );
    let bare = write_artifact(&config.artifacts_dir, &[]);
    let routes = serde_json::json!({ "version": 0, "entries": [
        { "hostname": "shop.test", "tenant_id": "t_shop", "deployment_hash": shop, "status": "active", "updated_at": 1 },
        { "hostname": "evil.test", "tenant_id": "t_evil", "deployment_hash": evil, "status": "active", "updated_at": 1 },
        { "hostname": "bare.test", "tenant_id": "t_bare", "deployment_hash": bare, "status": "active", "updated_at": 1 }
    ]});
    std::fs::write(&config.routes_file, routes.to_string()).unwrap();
    let worker = Worker::start(config.clone()).await.unwrap();
    let addr = worker.addr;

    for (path, status, code) in CASES {
        // shop: its own _error / _404 templates inside its layout.
        let r = get(addr, "shop.test", path).await;
        assert_eq!(r.status, status, "shop {path}: {}", r.body);
        assert!(r.head.contains("content-type: text/html"), "{path}");
        let id = r
            .head
            .lines()
            .find_map(|l| l.strip_prefix("x-renox-request-id: "))
            .unwrap()
            .to_ascii_uppercase();
        assert!(r.body.contains("site-header"), "shop layout on {path}");
        assert!(r.body.contains(&id), "request id on {path}");
        match code {
            Some(code) => {
                assert!(r.body.contains(&format!("Something went wrong ({status})")));
                assert!(r.body.contains(code), "{path}: {}", r.body);
                assert!(r.body.contains(&format!(
                    "<meta name=\"renox-error-code\" content=\"{code}\">"
                )));
            }
            None => assert!(r.body.contains("Page not found"), "{}", r.body),
        }

        // evil: the hostile template gets the four fields, nothing else.
        let e = get(addr, "evil.test", path).await;
        assert_eq!(e.status, status, "evil {path}: {}", e.body);
        let id = e
            .head
            .lines()
            .find_map(|l| l.strip_prefix("x-renox-request-id: "))
            .unwrap()
            .to_ascii_uppercase();
        assert!(
            e.body.contains(&format!(
                "<p id=\"fields\" dir=\"auto\">{status}|{}|{id}|",
                code.unwrap_or("")
            )),
            "{path}: {}",
            e.body
        );
        assert!(
            e.body.contains("<p id=\"extra\" dir=\"auto\">[]</p>"),
            "{path}: {}",
            e.body
        );

        // bare: no template at all, the platform default page.
        let b = get(addr, "bare.test", path).await;
        assert_eq!(b.status, status, "bare {path}: {}", b.body);
        assert!(b.body.contains(&format!("<h1>{status}</h1>")), "{}", b.body);

        for body in [&r.body, &e.body, &b.body] {
            for never in NEVER {
                assert!(!body.contains(never), "{path}: `{never}` in {body}");
            }
        }
    }

    // The causes are in the tenant log, not in the pages.
    let logs = std::fs::read_to_string(config.logs_dir.join("tenant.ndjson")).unwrap();
    assert!(logs.contains("database is down"), "{logs}");
    assert!(logs.contains("RENOX_RENDER_LIMIT"));

    worker.shutdown().await;
    let _ = std::fs::remove_dir_all(&root);
}
