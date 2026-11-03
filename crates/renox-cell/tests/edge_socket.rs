//! #414, ADR D25: the worker behind `cloudflared` listens on a unix socket
//! (`listen = "unix:<path>"`). The socket is created mode 0600 (0660 with
//! `[gateway] socket_group`); a peer whose uid is in `trusted_socket_users`
//! names the client in `CF-Connecting-IP`, any other local peer does not.
//! Proven end to end through `Worker::start` with the per-IP token bucket:
//! burst 1, so a second request in the same bucket is 429.
//!
//! `docs/24-threat-model.md` A, "Local process forges the client-IP header".

#[path = "support/control_stack.rs"]
mod stack;

use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::Duration;

use renox_cell::{Worker, WorkerConfig};
use stack::{HELLO_HASH, hello_dir};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for e in std::fs::read_dir(from).unwrap() {
        let e = e.unwrap();
        if e.file_type().unwrap().is_dir() {
            copy_dir(&e.path(), &to.join(e.file_name()));
        } else {
            std::fs::copy(e.path(), to.join(e.file_name())).unwrap();
        }
    }
}

async fn start(name: &str, trusted_uid: u32) -> (Worker, PathBuf, PathBuf) {
    let root = std::env::temp_dir().join(format!("renox-cell-edge-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    copy_dir(&hello_dir(), &root.join("artifacts").join(HELLO_HASH));
    let routes = serde_json::json!({ "version": 0, "entries": [
        { "hostname": "hello.test", "tenant_id": "t_hello", "deployment_hash": HELLO_HASH, "status": "active", "updated_at": 1 }
    ]});
    std::fs::write(root.join("routes.json"), routes.to_string()).unwrap();
    std::fs::create_dir_all(root.join("run")).unwrap();
    // A stale socket file from a previous run is replaced.
    drop(std::os::unix::net::UnixListener::bind(root.join("run/worker.sock")).unwrap());
    let text = format!(
        r#"
listen = "unix:run/worker.sock"
data_dir = "data"
artifacts_dir = "artifacts"
routes_file = "routes.json"
meters_dir = "meters"
logs_dir = "logs"
[gateway]
rate_limit_per_ip = 0.01
rate_limit_burst = 1
trusted_socket_users = ["{trusted_uid}"]
"#
    );
    let worker = Worker::start(WorkerConfig::parse(&text, &root).unwrap())
        .await
        .unwrap();
    let sock = root.join("run/worker.sock");
    (worker, sock, root)
}

/// This process's uid: the owner of `/proc/self`.
fn own_uid() -> u32 {
    std::fs::metadata("/proc/self").unwrap().uid()
}

/// The status of one request through the socket, as `CF-Connecting-IP: ip`.
async fn status(sock: &Path, ip: &str) -> u16 {
    let mut s = UnixStream::connect(sock).await.unwrap();
    let req = format!(
        "GET /api/hello HTTP/1.1\r\nHost: hello.test\r\nCF-Connecting-IP: {ip}\r\nX-Forwarded-Proto: https\r\nConnection: close\r\n\r\n"
    );
    s.write_all(req.as_bytes()).await.unwrap();
    let mut out = Vec::new();
    tokio::time::timeout(Duration::from_secs(30), s.read_to_end(&mut out))
        .await
        .unwrap()
        .unwrap();
    let text = String::from_utf8_lossy(&out);
    text.get(9..12).and_then(|s| s.parse().ok()).unwrap_or(0)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_trusted_socket_user_names_the_client() {
    let (worker, sock, root) = start("trusted", own_uid()).await;
    let mode = std::fs::metadata(&sock).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600, "no socket_group: owner only");
    // Two visitors behind the edge: one bucket each.
    assert_eq!(status(&sock, "198.51.100.1").await, 200);
    assert_eq!(status(&sock, "198.51.100.2").await, 200);
    assert_eq!(status(&sock, "198.51.100.1").await, 429);
    worker.shutdown().await;
    let _ = std::fs::remove_dir_all(root);
}

/// A local process under another uid (here: the test, with a different uid
/// listed as trusted) cannot pick its bucket with `CF-Connecting-IP`: every
/// request counts as the one local peer.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_local_peer_of_another_uid_cannot_name_the_client() {
    let (worker, sock, root) = start("untrusted", own_uid().wrapping_add(1)).await;
    assert_eq!(status(&sock, "198.51.100.1").await, 200);
    assert_eq!(status(&sock, "198.51.100.2").await, 429);
    worker.shutdown().await;
    let _ = std::fs::remove_dir_all(root);
}
