//! Issue #460 (deploy API 0.6.2 section 7): a controlled worker reports on
//! every heartbeat whether its process supervisor runs, and with `[process]`
//! off which of its tenants ask for `process = "own"` (a paid tier) and run
//! in the shared process instead (#403).
//!
//! Proves `docs/24-threat-model.md` "Isolate escape (V8 bug)" (paid tier:
//! one process per tenant) is visible to the operator when it is not given:
//! the control plane gets `{ enabled: false, own_ignored: [<tenant>] }`, never
//! silence. Each heartbeat is validated against
//! `docs/contracts/schemas/control-messages.schema.json`.
//!
//! Issue #825 (deploy API 0.12 sections 8 to 10): a route delta that changes
//! only an active entry's `module_config` reaches a warm tenant, in the
//! shared process and in a child of its own: the next request is served by
//! a cell built from the new entry, without a new deployment.
#![cfg(target_os = "linux")]

#[path = "support/fake_control.rs"]
mod fake;

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use renox_cell::{Worker, WorkerConfig};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const HASH: &str = "802957869194e4c16e462dfcb50bfa6b3e435fca606b96a1223e2b7e21271d7a";

static N: AtomicU64 = AtomicU64::new(0);

fn scratch(name: &str) -> PathBuf {
    // Short: a supervisor's Unix sockets live under it (108-byte limit).
    let dir = PathBuf::from(format!(
        "/tmp/rnx-pi-{}-{name}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn schema() -> jsonschema::Validator {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../docs/contracts/schemas/control-messages.schema.json");
    let schema: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    jsonschema::validator_for(&schema).unwrap()
}

fn node_token(root: &Path) -> PathBuf {
    let path = root.join("node.token");
    // `renox_node_` + 32 base32 characters (control/http.rs). A fixed test
    // value: the fake control plane accepts any token.
    std::fs::write(&path, format!("renox_node_{}", "a".repeat(32))).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    path
}

async fn worker(root: &Path, control: &fake::FakeControl, process: bool) -> Worker {
    let token = node_token(root);
    let process_section = if process {
        format!(
            "[process]\nenabled = true\nrun_dir = \"run\"\nworker_bin = \"{}\"\n",
            env!("CARGO_BIN_EXE_renox-worker")
        )
    } else {
        String::new()
    };
    let text = format!(
        "mode = \"controlled\"\nlisten = \"127.0.0.1:0\"\nnode_id = \"node-pi-1\"\ndata_dir = \"data\"\nartifacts_dir = \"artifacts\"\nmeters_dir = \"meters\"\nlogs_dir = \"logs\"\nfetch_blocked_addresses = [\"203.0.113.250\"]\n[control]\nurl = \"{}\"\nnode_token_file = \"{}\"\n[sandbox]\nallow_unsandboxed = true\n{process_section}",
        control.url(),
        token.display()
    );
    let path = root.join("worker.toml");
    std::fs::write(&path, text).unwrap();
    Worker::start(WorkerConfig::load(&path).unwrap())
        .await
        .unwrap()
}

/// The fake control plane's table: a paid tenant asking for its own process
/// and a free one, both on this node, and a paid one on another node.
fn table(control: &fake::FakeControl) {
    let mut own = fake::entry("paid.renox.test", "t_paid", "shop", HASH, "node-pi-1", 1);
    own["process"] = json!("own");
    let free = fake::entry("free.renox.test", "t_free", "hello", HASH, "node-pi-1", 2);
    let mut other = fake::entry("else.renox.test", "t_else", "shop", HASH, "node-pi-2", 3);
    other["process"] = json!("own");
    let mut st = control.state.lock().unwrap();
    st.route_version = 3;
    st.entries = vec![own, free, other];
}

/// The first heartbeat sent after the route table was applied.
async fn heartbeat_after_snapshot(control: &fake::FakeControl, worker: &Worker) -> Value {
    let start = Instant::now();
    loop {
        let applied = worker.controller.as_ref().unwrap().routes.version() == 3;
        if applied
            && let Some(h) = control
                .state
                .lock()
                .unwrap()
                .heartbeats
                .iter()
                .rev()
                .find(|h| h["route_version"] == 3)
                .cloned()
        {
            return h;
        }
        assert!(
            start.elapsed() < Duration::from_secs(20),
            "no heartbeat at route version 3: {:?}",
            control.state.lock().unwrap().heartbeats
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn with_process_off_the_heartbeat_names_the_paid_tenant() {
    let root = scratch("off");
    let control = fake::FakeControl::start().await;
    table(&control);
    let worker = worker(&root, &control, false).await;
    let beat = heartbeat_after_snapshot(&control, &worker).await;
    assert_eq!(
        beat["process_isolation"],
        json!({ "enabled": false, "own_ignored": ["t_paid"] }),
        "{beat}"
    );
    let errors: Vec<String> = schema().iter_errors(&beat).map(|e| e.to_string()).collect();
    assert!(errors.is_empty(), "{beat}: {errors:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn with_process_on_the_heartbeat_ignores_nobody() {
    let root = scratch("on");
    let control = fake::FakeControl::start().await;
    table(&control);
    let worker = worker(&root, &control, true).await;
    assert!(worker.supervisor.is_some(), "[process] enabled");
    let beat = heartbeat_after_snapshot(&control, &worker).await;
    assert_eq!(
        beat["process_isolation"],
        json!({ "enabled": true, "own_ignored": [] }),
        "{beat}"
    );
    let errors: Vec<String> = schema().iter_errors(&beat).map(|e| e.to_string()).collect();
    assert!(errors.is_empty(), "{beat}: {errors:?}");
}

/// The app: its `email` module's `ctx.config`, and its own `APP_KEY` secret
/// when the manifest declares it.
const APP: &str = r#"
import { email } from "renox:modules";
export async function GET(ctx) {
  return Response.json({ config: await email.info(), secret: ctx.secrets.APP_KEY ?? null });
}
"#;

const EMAIL: &str = r#"
export async function info(ctx) { return ctx.config; }
"#;

/// An artifact with the `email` module (`app_url = ""` in its resolved
/// config) under `root/artifacts`, declaring `secrets`; its hash.
fn artifact(root: &Path, secrets: &[&str]) -> String {
    let tmp = root.join("artifact-src");
    let perms =
        json!({ "tables": "email__*", "network": [], "secrets": [], "slots": [], "hooks": [] });
    let manifest = json!({
        "artifact": { "version": 1 },
        "app": { "name": "shop", "timezone": "Asia/Dubai" },
        "code": { "format": "esm-dir", "entry": {
            "functions/f": "functions/f.js",
            "modules/email/services": "modules/email/services.js",
        } },
        "routes": [
            { "kind": "function", "method": "GET", "path": "/", "module": "functions/f", "export": "GET" },
        ],
        "permissions": { "network": [], "secrets": secrets },
        "modules": [{
            "name": "email", "version": "1.0.0", "hash": "0".repeat(64), "source": "path:modules/email",
            "mount": "/email", "isolation": "shared", "dependencies": [],
            "config": { "app_url": "", "greeting": "hi" },
            "permissions": perms, "approved": perms,
            "exports": { "services": ["info"] },
        }],
    });
    for (p, src) in [
        (
            "manifest.json",
            serde_json::to_string_pretty(&manifest).unwrap(),
        ),
        ("code/functions/f.js", APP.to_string()),
        ("code/modules/email/services.js", EMAIL.to_string()),
    ] {
        let path = tmp.join(p);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, src).unwrap();
    }
    let hash = renox_cell::artifact::canonical_hash(&tmp).unwrap();
    std::fs::create_dir_all(root.join("artifacts")).unwrap();
    std::fs::rename(&tmp, root.join("artifacts").join(&hash)).unwrap();
    hash
}

/// `GET /` on `host`, retried until it answers 200 (a child starting, a
/// cell being created); the JSON body.
async fn get_json(addr: SocketAddr, host: &str) -> Value {
    let start = Instant::now();
    loop {
        let mut s = tokio::net::TcpStream::connect(addr).await.unwrap();
        let req = format!("GET / HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n");
        s.write_all(req.as_bytes()).await.unwrap();
        let mut buf = Vec::new();
        s.read_to_end(&mut buf).await.unwrap();
        let text = String::from_utf8_lossy(&buf).to_string();
        let (head, body) = text.split_once("\r\n\r\n").unwrap_or((&text, ""));
        if head.split(' ').nth(1) == Some("200") {
            return serde_json::from_str(body).unwrap_or_else(|e| panic!("{e}: {body}"));
        }
        assert!(
            start.elapsed() < Duration::from_secs(30),
            "GET / on {host}: {text}"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn eventually(what: &str, mut f: impl FnMut() -> bool) {
    let start = Instant::now();
    while !f() {
        assert!(
            start.elapsed() < Duration::from_secs(20),
            "timed out waiting for {what}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

const HOST: &str = "warm.renox.test";

/// A warm tenant on this node, in the shared process or in its own (`own`).
struct Warm {
    root: PathBuf,
    control: fake::FakeControl,
    worker: Worker,
    hash: String,
    own: bool,
}

impl Warm {
    /// Starts the worker with one entry (version 1, edited by `first`) as
    /// the table, once the artifact declaring `secrets` is on disk.
    async fn start(
        name: &str,
        own: bool,
        secrets: &[&str],
        first: impl FnOnce(&mut Value),
    ) -> Warm {
        let root = scratch(name);
        let control = fake::FakeControl::start().await;
        let hash = artifact(&root, secrets);
        let mut e = fake::entry(HOST, "t_warm", "shop", &hash, "node-pi-1", 1);
        if own {
            e["process"] = json!("own");
        }
        first(&mut e);
        {
            let mut st = control.state.lock().unwrap();
            st.route_version = 1;
            st.entries = vec![e];
        }
        let worker = worker(&root, &control, own).await;
        // Not about the disk watermark: a full CI or dev disk must not
        // turn the first request away (`disk.rs`, `stop_scheduling`).
        worker.disk.set_enforcing(false);
        let w = Warm {
            root,
            control,
            worker,
            hash,
            own,
        };
        let routes = w.worker.controller.as_ref().unwrap().routes.clone();
        eventually("route version 1", || routes.version() == 1).await;
        // Deltas go out on the stream: wait until the worker reads it.
        eventually("the stream", || {
            w.control.requests().iter().any(|r| r.ends_with("/stream"))
        })
        .await;
        w
    }

    /// The deployment's entry at `version`, edited by `edit`.
    fn entry(&self, version: u64, edit: impl FnOnce(&mut Value)) -> Value {
        let mut e = fake::entry(HOST, "t_warm", "shop", &self.hash, "node-pi-1", version);
        if self.own {
            e["process"] = json!("own");
        }
        edit(&mut e);
        e
    }

    async fn get(&self) -> Value {
        get_json(self.worker.addr, HOST).await
    }

    /// Publishes `entry` as version `version` of the table, sends it as a
    /// delta on the stream, and waits until the worker applied it.
    async fn change(&self, entry: Value, version: u64) {
        {
            let mut st = self.control.state.lock().unwrap();
            st.route_version = version;
            st.entries = vec![entry.clone()];
        }
        self.control.send(json!({
            "type": "route_delta", "schema_version": 0, "prev_version": version - 1,
            "version": version, "upserts": [entry], "removals": [],
        }));
        let routes = self.worker.controller.as_ref().unwrap().routes.clone();
        eventually("the delta", || routes.version() == version).await;
    }

    fn child_pid(&self) -> Option<u32> {
        self.worker.supervisor.as_ref()?.child("t_warm")?.pid
    }

    /// Stops the tenant's child, if any: an orphan would hold the test
    /// harness's output open until its idle timeout.
    async fn stop(self) {
        if let Some(sv) = &self.worker.supervisor {
            sv.shutdown().await;
        }
    }
}

impl Drop for Warm {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

async fn module_config_change_reaches_a_warm_tenant(own: bool) {
    let app_url = |url: &str| json!({ "email": { "app_url": url } });
    let w = Warm::start(if own { "mc-own" } else { "mc-shared" }, own, &[], |e| {
        e["module_config"] = app_url("https://warm.renox.test")
    })
    .await;
    let v = w.get().await;
    assert_eq!(v["config"]["app_url"], "https://warm.renox.test", "{v}");
    assert_eq!(v["config"]["greeting"], "hi", "{v}");
    let pid = w.child_pid();
    assert_eq!(pid.is_some(), own, "served by a child only when own");
    let created = w.worker.manager.cells_created();
    // A custom domain: the platform computes a new app_url; same deployment.
    w.change(
        w.entry(2, |e| e["module_config"] = app_url("https://shop.example")),
        2,
    )
    .await;
    let v = w.get().await;
    assert_eq!(v["config"]["app_url"], "https://shop.example", "{v}");
    assert_eq!(v["config"]["greeting"], "hi", "{v}");
    if own {
        // The child took the new entry in place: not restarted.
        assert_eq!(w.child_pid(), pid);
    } else {
        assert_eq!(w.worker.manager.cells_created(), created + 1);
    }
    // No module_config any more: the artifact's own value ("") again.
    w.change(w.entry(3, |_| {}), 3).await;
    let v = w.get().await;
    assert_eq!(v["config"]["app_url"], "", "{v}");
    w.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_module_config_change_reaches_a_warm_shared_tenant() {
    module_config_change_reaches_a_warm_tenant(false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_module_config_change_reaches_a_warm_tenant_in_its_own_process() {
    module_config_change_reaches_a_warm_tenant(true).await;
}
