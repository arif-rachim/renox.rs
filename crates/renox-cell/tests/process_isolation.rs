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
#![cfg(target_os = "linux")]

#[path = "support/fake_control.rs"]
mod fake;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use renox_cell::{Worker, WorkerConfig};
use serde_json::{Value, json};

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
