//! Issue #253: the worker's seccomp allowlist and Landlock rules
//! (`src/sandbox/`), with the real `renox-worker` binary as a child process.
//!
//! Proves `docs/24-threat-model.md` row "Isolate escape (V8 bug)": with the
//! profile applied, code running in the worker process cannot read
//! `/etc/passwd` or connect to the cloud metadata address (169.254.169.254)
//! even without going through the `fetch` op, while the artifacts and data
//! dirs keep working and a tenant with a database is served end to end.
//!
//! Skipped, with the reason, on a kernel without seccomp
//! (`/proc/sys/kernel/seccomp` absent) or without Landlock.
#![cfg(target_os = "linux")]

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use tokio::io::{AsyncReadExt, AsyncWriteExt};

static N: AtomicU64 = AtomicU64::new(0);

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "renox-cell-sandbox-{}-{name}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn no_seccomp() -> bool {
    if !Path::new("/proc/sys/kernel/seccomp").exists() {
        eprintln!("skipped: /proc/sys/kernel/seccomp is absent, this kernel has no seccomp");
        return true;
    }
    false
}

fn config(root: &Path, listen: &str, mode: &str) -> PathBuf {
    let text = format!(
        "listen = \"{listen}\"\ndata_dir = \"data\"\nartifacts_dir = \"artifacts\"\nroutes_file = \"routes.json\"\nmeters_dir = \"meters\"\nlogs_dir = \"logs\"\nmeter_flush_ms = 50\n[sandbox]\nenabled = true\nmode = \"{mode}\"\n"
    );
    let path = root.join("worker.toml");
    std::fs::write(&path, text).unwrap();
    path
}

/// The self-test table: `<verdict> <probe> <outcome>`.
fn selftest(root: &Path) -> (bool, String) {
    let out = Command::new(env!("CARGO_BIN_EXE_renox-worker"))
        .env_remove("RENOX_TEST_SANDBOX")
        .arg("--sandbox-selftest")
        .arg("--config")
        .arg(config(root, "127.0.0.1:0", "enforce"))
        .stderr(Stdio::null())
        .output()
        .unwrap();
    (
        out.status.success(),
        String::from_utf8_lossy(&out.stdout).to_string(),
    )
}

fn line<'a>(table: &'a str, probe: &str) -> &'a str {
    table
        .lines()
        .find(|l| l.contains(probe))
        .unwrap_or_else(|| panic!("no line for {probe} in\n{table}"))
}

/// `docs/24-threat-model.md` "Isolate escape (V8 bug)": `/etc/passwd` and
/// the metadata IP are refused with EACCES/EPERM after the profile applies;
/// the artifacts and data dirs still work.
#[test]
fn selftest_refuses_passwd_and_metadata_and_keeps_the_worker_dirs() {
    if no_seccomp() {
        return;
    }
    let root = scratch("selftest");
    let (ok, table) = selftest(&root);
    let header = table.lines().next().unwrap_or_default();
    if header.contains("landlock fs unsupported") {
        eprintln!("skipped: this kernel has no Landlock ({header})");
        return;
    }
    assert!(
        line(&table, "/etc/passwd").contains("refused (E"),
        "{table}"
    );
    assert!(line(&table, "(artifacts)").contains("allowed"), "{table}");
    assert!(line(&table, "(data)").contains("allowed"), "{table}");
    if header.contains("landlock net unsupported") {
        eprintln!("metadata probe not asserted: Landlock ABI < 4 has no network rules ({header})");
    } else {
        assert!(
            line(&table, "169.254.169.254").contains("refused (E"),
            "{table}"
        );
        assert!(ok, "the self-test must pass:\n{table}");
    }
    let _ = std::fs::remove_dir_all(&root);
}

/// One HTTP/1.1 request; returns (status, body).
async fn http(addr: SocketAddr, host: &str, path: &str) -> (u16, String) {
    let mut s = tokio::net::TcpStream::connect(addr).await.unwrap();
    let req = format!("GET {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n");
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

/// An artifact whose function migrates, writes and reads its database.
fn db_artifact(artifacts: &Path) -> String {
    let src = scratch("artifact");
    let migration = "create table app__hits (id integer primary key, at integer not null);\n";
    let sums = serde_json::json!({ "version": 0, "files": { "app/001_hits.sql": renox_data::checksum(migration) } });
    let manifest = serde_json::json!({
        "artifact": { "version": 0 },
        "app": { "name": "sandboxed", "timezone": "UTC" },
        "code": { "format": "esm-dir", "entry": { "functions/api/hits": "functions/api/hits.js" } },
        "routes": [{ "kind": "function", "method": "GET", "path": "/api/hits", "module": "functions/api/hits", "export": "GET" }],
        "permissions": { "network": [], "secrets": [] }
    });
    let code = r#"
        export async function GET({ db, log }) {
            await db.execute("insert into app__hits (at) values (?)", [Date.now()]);
            const n = (await db.queryOne("select count(*) as n from app__hits")).n;
            log.info("hit", { n });
            return Response.json({ n });
        }
    "#;
    for (rel, content) in [
        ("manifest.json", manifest.to_string()),
        ("code/functions/api/hits.js", code.to_string()),
        ("migrations/app/001_hits.sql", migration.to_string()),
        ("migrations/checksums.json", sums.to_string()),
    ] {
        let p = src.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, content).unwrap();
    }
    let hash = renox_runtime::manifest::content_hash(&src).unwrap();
    let dest = artifacts.join(&hash);
    for rel in [
        "manifest.json",
        "code/functions/api/hits.js",
        "migrations/app/001_hits.sql",
        "migrations/checksums.json",
    ] {
        std::fs::create_dir_all(dest.join(rel).parent().unwrap()).unwrap();
        std::fs::copy(src.join(rel), dest.join(rel)).unwrap();
    }
    let _ = std::fs::remove_dir_all(&src);
    hash
}

/// The whole request path (artifact load, isolate, migration, SQLite
/// writes, meters, tenant log) runs under `mode = "enforce"`: a syscall
/// outside the allowlist would kill the process and the second request
/// would fail.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_tenant_with_a_database_is_served_under_enforce() {
    if no_seccomp() {
        return;
    }
    let root = scratch("worker");
    std::fs::create_dir_all(root.join("artifacts")).unwrap();
    let hash = db_artifact(&root.join("artifacts"));
    let routes = serde_json::json!({ "version": 0, "entries": [
        { "hostname": "sandboxed.test", "tenant_id": "t_sandboxed", "deployment_hash": hash, "status": "active", "updated_at": 1 }
    ]});
    std::fs::write(root.join("routes.json"), routes.to_string()).unwrap();
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let mut child = Command::new(env!("CARGO_BIN_EXE_renox-worker"))
        .env_remove("RENOX_TEST_SANDBOX")
        .arg("--config")
        .arg(config(&root, &format!("127.0.0.1:{port}"), "enforce"))
        .stderr(std::fs::File::create(root.join("worker.log")).unwrap())
        .spawn()
        .unwrap();
    let addr: SocketAddr = format!("127.0.0.1:{port}").parse().unwrap();
    let start = Instant::now();
    while tokio::net::TcpStream::connect(addr).await.is_err() {
        if let Some(status) = child.try_wait().unwrap() {
            panic!(
                "the sandboxed worker exited ({status}):\n{}",
                std::fs::read_to_string(root.join("worker.log")).unwrap_or_default()
            );
        }
        assert!(
            start.elapsed() < Duration::from_secs(30),
            "worker did not start"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    for n in 1..=3 {
        let (status, body) = http(addr, "sandboxed.test", "/api/hits").await;
        assert_eq!(
            (status, body.as_str()),
            (200, format!("{{\"n\":{n}}}").as_str()),
            "{}",
            std::fs::read_to_string(root.join("worker.log")).unwrap_or_default()
        );
    }
    assert_eq!(http(addr, "unknown.test", "/api/hits").await.0, 404);
    assert!(
        child.try_wait().unwrap().is_none(),
        "the worker must still run"
    );
    let log = std::fs::read_to_string(root.join("worker.log")).unwrap_or_default();
    assert!(log.contains("seccomp allowlist applied"), "{log}");
    let _ = child.kill();
    let _ = child.wait();
    assert!(root.join("data/t_sandboxed/app.db").exists());
    let _ = std::fs::remove_dir_all(&root);
}
