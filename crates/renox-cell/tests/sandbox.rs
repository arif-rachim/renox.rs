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
//!
//! Issue #392: a controlled worker under `mode = "enforce"` activates a
//! deployment through the control plane: the artifact is downloaded into
//! an `artifacts_dir` outside `data_dir` (the `ops/worker.toml.example`
//! layout), prepared and served.
#![cfg(target_os = "linux")]

#[path = "support/fake_control.rs"]
mod fake;
#[path = "support/control_stack.rs"]
mod stack;

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

/// #392 (docs/23-failure-modes.md section 3, "Artifact fetch fails"): under
/// Landlock `enforce`, `prepare` downloads the artifact into an
/// `artifacts_dir` outside `data_dir`, and the route that follows is served.
/// Before the fix every activation failed with `stage=fetch` and "permission
/// denied".
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_controlled_worker_activates_through_the_control_plane_under_enforce() {
    if no_seccomp() {
        return;
    }
    let root = scratch("controlled");
    let control = fake::FakeControl::start().await;
    control
        .state
        .lock()
        .unwrap()
        .artifacts
        .insert(stack::HELLO_HASH.into(), stack::tar_of(&stack::hello_dir()));
    let token_file = root.join("node.token");
    std::fs::write(&token_file, stack::token("renox_node_")).unwrap();
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&token_file, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    // artifacts_dir beside data_dir, not inside it: the layout of
    // ops/worker.toml.example and bootstrap-node.sh.
    let text = format!(
        "mode = \"controlled\"\nlisten = \"127.0.0.1:{port}\"\nnode_id = \"node-sbx-1\"\ndata_dir = \"var/data\"\nartifacts_dir = \"var/artifacts\"\nmeters_dir = \"var/meters\"\nlogs_dir = \"var/logs\"\nfetch_blocked_addresses = [\"203.0.113.250\"]\n[control]\nurl = \"{}\"\nnode_token_file = \"{}\"\n[sandbox]\nenabled = true\nmode = \"enforce\"\n",
        control.url(),
        token_file.display()
    );
    std::fs::write(root.join("worker.toml"), text).unwrap();
    // The worker's temp dir is read-write under Landlock; `root` sits in the
    // test's temp dir, so the worker gets one of its own, beside `var/`.
    // Otherwise every directory of this test would be writable through it.
    std::fs::create_dir_all(root.join("tmp")).unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_renox-worker"))
        .env_remove("RENOX_TEST_SANDBOX")
        .env("TMPDIR", root.join("tmp"))
        .arg("--config")
        .arg(root.join("worker.toml"))
        .stderr(std::fs::File::create(root.join("worker.log")).unwrap())
        .spawn()
        .unwrap();
    let log = || std::fs::read_to_string(root.join("worker.log")).unwrap_or_default();
    let start = Instant::now();
    while control.state.lock().unwrap().registrations.is_empty()
        || !control.requests().iter().any(|r| r.ends_with("/stream"))
    {
        if let Some(status) = child.try_wait().unwrap() {
            panic!("the sandboxed worker exited ({status}):\n{}", log());
        }
        assert!(
            start.elapsed() < Duration::from_secs(30),
            "the worker did not connect:\n{}",
            log()
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    // deploy-api.md section 6 step 4: prepare on the owning node.
    control.send(serde_json::json!({
        "type": "prepare", "schema_version": 0, "activation_id": "act_0000000000000000000000000a",
        "tenant_id": "t_sandboxed", "app": "hello", "deployment_hash": stack::HELLO_HASH,
        "tier": "free", "secrets_version": 0,
        "probe": { "path": "/api/hello", "timeout_ms": 10000 }, "deadline_ms": 60000,
    }));
    let start = Instant::now();
    let result = loop {
        if let Some(r) = control
            .state
            .lock()
            .unwrap()
            .prepare_results
            .first()
            .cloned()
        {
            break r;
        }
        assert!(
            start.elapsed() < Duration::from_secs(60),
            "no prepare_result:\n{}",
            log()
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    assert_eq!(result["ok"], true, "{result}\n{}", log());
    assert!(root.join("var/artifacts").join(stack::HELLO_HASH).is_dir());
    // Step 5: the route follows; the prepared cell serves it.
    {
        let mut st = control.state.lock().unwrap();
        st.route_version = 1;
        st.entries = vec![fake::entry(
            "hello.sandboxed.test",
            "t_sandboxed",
            "hello",
            stack::HELLO_HASH,
            "node-sbx-1",
            1,
        )];
    }
    control.send(serde_json::json!({ "type": "resync", "schema_version": 0, "route_version": 1 }));
    let addr: SocketAddr = format!("127.0.0.1:{port}").parse().unwrap();
    let start = Instant::now();
    loop {
        let (status, _) = http(addr, "hello.sandboxed.test", "/api/hello").await;
        if status == 200 {
            break;
        }
        assert!(
            start.elapsed() < Duration::from_secs(10),
            "status {status}:\n{}",
            log()
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(
        child.try_wait().unwrap().is_none(),
        "the worker must still run"
    );
    assert!(log().contains("seccomp allowlist applied"), "{}", log());
    let _ = child.kill();
    let _ = child.wait();
    let _ = std::fs::remove_dir_all(&root);
}
