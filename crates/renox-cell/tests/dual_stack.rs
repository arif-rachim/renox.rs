//! Issue #404: the worker's public listeners are dual-stack. `listen =
//! "[::]:<port>"` binds one IPv6 socket with `IPV6_V6ONLY` off: IPv4 and
//! IPv6 clients are both served, and the per-IP limits see an IPv4 client
//! (which arrives as `::ffff:a.b.c.d`) as its IPv4 address
//! (`renox-gateway` `rate_limit.rs` and `limits.rs` unit tests prove the
//! mapping; this proves the socket and the limit end to end). On a host
//! without IPv6 the listener falls back to `0.0.0.0`.

#[path = "support/control_stack.rs"]
mod stack;

use std::net::SocketAddr;
use std::time::Duration;

use renox_cell::{Worker, WorkerConfig};
use stack::{HELLO_HASH, hello_dir, http};

fn ipv6_available() -> bool {
    std::net::TcpListener::bind("[::1]:0").is_ok()
}

fn copy_dir(from: &std::path::Path, to: &std::path::Path) {
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_unspecified_ipv6_listener_serves_both_families_and_limits_ipv4_clients_by_address() {
    let root = std::env::temp_dir().join(format!("renox-cell-dual-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    copy_dir(&hello_dir(), &root.join("artifacts").join(HELLO_HASH));
    let routes = serde_json::json!({ "version": 0, "entries": [
        { "hostname": "hello.test", "tenant_id": "t_hello", "deployment_hash": HELLO_HASH, "status": "active", "updated_at": 1 }
    ]});
    std::fs::write(root.join("routes.json"), routes.to_string()).unwrap();
    // One request per 100 s per client, burst 2: the third request of one
    // client is limited.
    let text = r#"
listen = "[::]:0"
data_dir = "data"
artifacts_dir = "artifacts"
routes_file = "routes.json"
meters_dir = "meters"
logs_dir = "logs"
[gateway]
rate_limit_per_ip = 0.01
rate_limit_burst = 2
"#;
    let worker = Worker::start(WorkerConfig::parse(text, &root).unwrap())
        .await
        .unwrap();
    let port = worker.addr.port();
    let v4 = SocketAddr::from(([127, 0, 0, 1], port));
    if ipv6_available() {
        assert!(worker.addr.is_ipv6(), "{}", worker.addr);
        let v6: SocketAddr = format!("[::1]:{port}").parse().unwrap();
        let r = http(v6, "GET", "/api/hello", "hello.test", &[], b"")
            .await
            .unwrap();
        assert_eq!(r.status, 200, "IPv6 client");
    } else {
        eprintln!(
            "no IPv6 on this host: the listener fell back to IPv4 ({})",
            worker.addr
        );
        assert!(worker.addr.is_ipv4());
    }
    // The IPv4 client, through the same socket.
    for _ in 0..2 {
        let r = http(v4, "GET", "/api/hello", "hello.test", &[], b"")
            .await
            .unwrap();
        assert_eq!(r.status, 200, "IPv4 client: {}", r.text());
    }
    let r = http(v4, "GET", "/api/hello", "hello.test", &[], b"")
        .await
        .unwrap();
    assert_eq!(r.status, 429, "the IPv4 client's own budget is spent");
    if ipv6_available() {
        // ::1 is another client: its budget is its own.
        let v6: SocketAddr = format!("[::1]:{port}").parse().unwrap();
        let r = http(v6, "GET", "/api/hello", "hello.test", &[], b"")
            .await
            .unwrap();
        assert_eq!(r.status, 200);
    }
    tokio::time::sleep(Duration::from_millis(10)).await;
    worker.shutdown().await;
    let _ = std::fs::remove_dir_all(&root);
}
