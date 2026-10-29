//! Issue #259: `POST /nodes/{node}/tenants/{tenant}/move` on the node
//! listener runs `[process] microvm_hook` with the tenant id and the
//! absolute path of its file, and the tenant answers 503
//! `RENOX_TENANT_MOVING` while the hook runs.
//!
//! `docs/24-threat-model.md` section E, "Operator console abuse": the move
//! needs the callback token, a reason and an operator.
#![cfg(target_os = "linux")]

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use renox_cell::{Worker, WorkerConfig};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

static N: AtomicU64 = AtomicU64::new(0);

fn scratch(name: &str) -> PathBuf {
    let dir = PathBuf::from(format!(
        "/tmp/rnx-move-{}-{name}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// An artifact whose function writes a row and answers the row count.
fn db_artifact(artifacts: &Path) -> String {
    let src = scratch("artifact");
    let migration = "create table app__hits (id integer primary key, at integer not null);\n";
    let sums = serde_json::json!({ "version": 0, "files": { "app/001_hits.sql": renox_data::checksum(migration) } });
    let manifest = serde_json::json!({
        "artifact": { "version": 0 },
        "app": { "name": "replicated", "timezone": "UTC" },
        "code": { "format": "esm-dir", "entry": { "functions/api/hits": "functions/api/hits.js" } },
        "routes": [{ "kind": "function", "method": "GET", "path": "/api/hits", "module": "functions/api/hits", "export": "GET" }],
        "permissions": { "network": [], "secrets": [] }
    });
    let code = r#"
        export async function GET({ url, db }) {
            if (url.searchParams.get("write") !== "0") {
                await db.execute("insert into app__hits (at) values (?)", [Date.now()]);
            }
            const n = (await db.queryOne("select count(*) as n from app__hits")).n;
            return Response.json({ n });
        }
    "#;
    let files = [
        ("manifest.json", manifest.to_string()),
        ("code/functions/api/hits.js", code.to_string()),
        ("migrations/app/001_hits.sql", migration.to_string()),
        ("migrations/checksums.json", sums.to_string()),
    ];
    for (rel, content) in &files {
        let p = src.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, content).unwrap();
    }
    let hash = renox_runtime::manifest::content_hash(&src).unwrap();
    for (rel, _) in &files {
        let to = artifacts.join(&hash).join(rel);
        std::fs::create_dir_all(to.parent().unwrap()).unwrap();
        std::fs::copy(src.join(rel), to).unwrap();
    }
    hash
}

fn worker_config(root: &Path, replication: bool) -> WorkerConfig {
    std::fs::create_dir_all(root.join("artifacts")).unwrap();
    let hash = db_artifact(&root.join("artifacts"));
    let routes = serde_json::json!({ "version": 0, "entries": [
        { "hostname": "repl.test", "tenant_id": "t_repl", "deployment_hash": hash, "status": "active", "updated_at": 1 }
    ]});
    std::fs::write(root.join("routes.json"), routes.to_string()).unwrap();
    let section = if replication {
        "[replication]\nenabled = true\nreplica = \"file\"\npath = \"replica\"\nsync_interval_ms = 200\nstop_grace_ms = 1500\nsnapshot_interval_secs = 3600\n"
    } else {
        ""
    };
    let text = format!(
        "listen = \"127.0.0.1:0\"\ndata_dir = \"data\"\nartifacts_dir = \"artifacts\"\nroutes_file = \"routes.json\"\nmeters_dir = \"meters\"\nlogs_dir = \"logs\"\nmeter_flush_ms = 50\n[process]\nrun_dir = \"run\"\n{section}"
    );
    let path = root.join("worker.toml");
    std::fs::write(&path, text).unwrap();
    WorkerConfig::load(&path).unwrap()
}

async fn http(
    addr: SocketAddr,
    method: &str,
    host: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: &str,
) -> (u16, String) {
    let mut s = tokio::net::TcpStream::connect(addr).await.unwrap();
    let mut req = format!(
        "{method} {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\nContent-Length: {}\r\n",
        body.len()
    );
    for (k, v) in headers {
        req.push_str(&format!("{k}: {v}\r\n"));
    }
    req.push_str("\r\n");
    req.push_str(body);
    s.write_all(req.as_bytes()).await.unwrap();
    let mut buf = Vec::new();
    s.read_to_end(&mut buf).await.unwrap();
    let text = String::from_utf8_lossy(&buf).to_string();
    let status = text
        .split(' ')
        .nth(1)
        .and_then(|c| c.parse().ok())
        .unwrap_or(0);
    let body = text
        .split_once("\r\n\r\n")
        .map(|(_, b)| b.to_string())
        .unwrap_or_default();
    (status, body)
}

/// Writes the hook's exit code whole (the hook polls for the file).
fn release(root: &Path, code: &str) {
    std::fs::write(root.join("release.tmp"), format!("{code}\n")).unwrap();
    std::fs::rename(root.join("release.tmp"), root.join("release")).unwrap();
}

const TOKEN: &str = "renox_cb_abcdefghijklmnopqrstuvwxyz234567";

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_hook_runs_with_the_tenant_and_its_file_and_the_tenant_answers_503_while_moving() {
    let root = scratch("hook");
    let worker = Worker::start(worker_config(&root, false)).await.unwrap();
    let get = |addr| async move { http(addr, "GET", "repl.test", "/api/hits", &[], "").await };
    assert_eq!(
        get(worker.addr).await.0,
        200,
        "the tenant serves before the move"
    );

    // The hook records its arguments, then waits for `release` and exits with
    // its content. Builtins only: the hook inherits the worker's seccomp
    // filter (CI runs this under `RENOX_TEST_SANDBOX=enforce`), which has no
    // fork, so no `sleep` and no `$(…)`.
    let hook = root.join("hook.sh");
    std::fs::write(
        &hook,
        format!(
            "#!/bin/sh\nprintf '%s\\n%s\\n' \"$1\" \"$2\" > '{0}/hook.args'\nwhile [ ! -e '{0}/release' ]; do :; done\nread code < '{0}/release'\nexit \"$code\"\n",
            root.display()
        ),
    )
    .unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();

    let token = Arc::new(renox_cell::control::node_listener::CallbackToken::default());
    token.set(Some(TOKEN.into()));
    let listener = Arc::new(renox_cell::control::node_listener::NodeListener {
        node_id: "node-local".into(),
        token,
        replication: None,
        manager: worker.manager.clone(),
        microvm_hook: Some(hook.clone()),
    });
    let (addr, _task) = listener
        .serve("127.0.0.1:0".parse().unwrap())
        .await
        .unwrap();
    let auth = (
        "authorization",
        "Bearer renox_cb_abcdefghijklmnopqrstuvwxyz234567",
    );
    let body = serde_json::json!({ "type": "move_request", "schema_version": 0, "tenant_id": "t_repl", "target": "microvm", "reason": "abuse report 2026-118: isolate", "operator": "operator" }).to_string();
    let path = "/nodes/node-local/tenants/t_repl/move";

    // No callback token, or a short reason: refused, nothing runs.
    assert_eq!(http(addr, "POST", "node", path, &[], &body).await.0, 401);
    let short = body.replace("abuse report 2026-118: isolate", "short");
    assert_eq!(
        http(addr, "POST", "node", path, &[auth], &short).await.0,
        400
    );
    assert!(!root.join("hook.args").exists());

    let moving =
        tokio::spawn(async move { http(addr, "POST", "node", path, &[auth], &body).await });
    let args = root.join("hook.args");
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while !args.exists() || std::fs::read_to_string(&args).unwrap().lines().count() < 2 {
        assert!(std::time::Instant::now() < deadline, "the hook did not run");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let got = std::fs::read_to_string(&args).unwrap();
    let file = std::path::absolute(root.join("data/t_repl/app.db")).unwrap();
    assert_eq!(
        got,
        format!("t_repl\n{}\n", file.display()),
        "the tenant id and the absolute file path"
    );

    // While the hook runs: the tenant answers 503 RENOX_TENANT_MOVING, and a second move is refused.
    let (status, text) = get(worker.addr).await;
    assert_eq!(status, 503);
    assert!(text.contains("RENOX_TENANT_MOVING"), "{text}");
    let again = serde_json::json!({ "type": "move_request", "schema_version": 0, "tenant_id": "t_repl", "target": "microvm", "reason": "a second operator, same tenant", "operator": "operator" }).to_string();
    let (status, text) = http(addr, "POST", "node", path, &[auth], &again).await;
    assert_eq!(status, 503);
    assert!(text.contains("RENOX_TENANT_MOVING"));

    // The stub's code (75): failed, and the tenant serves here again.
    release(&root, "75");
    let (status, answer) = moving.await.unwrap();
    assert_eq!(status, 200, "{answer}");
    let r: serde_json::Value = serde_json::from_str(&answer).unwrap();
    assert_eq!(r["type"], "move_result");
    assert_eq!(r["state"], "failed");
    assert_eq!(r["hook_exit_code"], 75);
    assert_eq!(get(worker.addr).await.0, 200, "the tenant serves again");

    // Exit 0: moved; the tenant stays refused here.
    release(&root, "0");
    let ok = serde_json::json!({ "type": "move_request", "schema_version": 0, "tenant_id": "t_repl", "target": "microvm", "reason": "abuse report 2026-118: isolate", "operator": "acct_01JBQ40000000000OP" }).to_string();
    let (status, answer) = http(addr, "POST", "node", path, &[auth], &ok).await;
    assert_eq!(status, 200, "{answer}");
    let r: serde_json::Value = serde_json::from_str(&answer).unwrap();
    assert_eq!(
        (r["state"].as_str(), r["hook_exit_code"].as_i64()),
        (Some("moved"), Some(0))
    );
    assert_eq!(get(worker.addr).await.0, 503);

    worker.shutdown().await;
    let _ = std::fs::remove_dir_all(&root);
}
