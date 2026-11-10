//! Issue #670: `GET /nodes/{node}/tenants/{tenant}/files?database=` on the
//! node listener streams the stored files of a database as a gzip ustar with
//! its SHA-256 and counts in headers (`deploy-api.md` 0.8 section 15).
//!
//! The objects are written through the store (`DirStore` under
//! `<data_dir>/files`) and the `renox__files` rows with SQL: the shape is the
//! platform's own table (`renox-data` migration 0003), so no isolate is
//! needed.
#![cfg(target_os = "linux")]

use std::io::Read;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use renox_cell::control::files_export::{
    FilesExportError, collect_file_keys, write_files_tar_capped,
};
use renox_cell::control::node_listener::{CallbackToken, NodeListener};
use renox_cell::{Worker, WorkerConfig};
use sha2::Digest;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

static N: AtomicU64 = AtomicU64::new(0);
const TOKEN: &str = "renox_cb_abcdefghijklmnopqrstuvwxyz234567";
const TENANT: &str = "t_files";

fn scratch(name: &str) -> PathBuf {
    let dir = PathBuf::from(format!(
        "/tmp/rnx-files-{}-{name}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn config(root: &Path) -> WorkerConfig {
    std::fs::create_dir_all(root.join("artifacts")).unwrap();
    std::fs::write(
        root.join("routes.json"),
        r#"{ "version": 0, "entries": [] }"#,
    )
    .unwrap();
    let text = "listen = \"127.0.0.1:0\"\ndata_dir = \"data\"\nartifacts_dir = \"artifacts\"\nroutes_file = \"routes.json\"\nmeters_dir = \"meters\"\nlogs_dir = \"logs\"\nmeter_flush_ms = 50\n[process]\nrun_dir = \"run\"\n";
    let path = root.join("worker.toml");
    std::fs::write(&path, text).unwrap();
    WorkerConfig::load(&path).unwrap()
}

/// A worker, the tenant's database with `names` registered in `renox__files`
/// (objects stored for all of them), and the listener.
async fn setup(root: &Path, names: &[(&str, &[u8])]) -> (Worker, SocketAddr) {
    let worker = Worker::start(config(root)).await.unwrap();
    let data = root.join("data").join(TENANT);
    std::fs::create_dir_all(&data).unwrap();
    let db =
        renox_data::TenantDb::open(data.join("app.db"), renox_data::DbOptions::default()).unwrap();
    let store = worker.manager.file_store();
    for (i, (key, bytes)) in names.iter().enumerate() {
        store
            .put(
                format!("tenants/{TENANT}/files/{key}"),
                bytes::Bytes::copy_from_slice(bytes),
                "text/plain".into(),
            )
            .await
            .unwrap();
        db.execute(
            "insert into renox__files (key, module, bytes, content_type, sha256, public, created_at) values (?, 'app', ?, 'text/plain', 'x', 0, ?)",
            &[
                renox_data::Value::Text((*key).into()),
                renox_data::Value::Integer(bytes.len() as i64),
                renox_data::Value::Integer(1_700_000_000_000 + i as i64 * 1000),
            ],
        )
        .unwrap();
    }
    let _ = db.close();
    let token = Arc::new(CallbackToken::default());
    token.set(Some(TOKEN.into()));
    let listener = Arc::new(NodeListener {
        node_id: "node-local".into(),
        token,
        replication: None,
        manager: worker.manager.clone(),
        microvm_hook: None,
    });
    let (addr, _task) = listener
        .serve("127.0.0.1:0".parse().unwrap())
        .await
        .unwrap();
    (worker, addr)
}

struct Answer {
    status: u16,
    head: String,
    body: Vec<u8>,
}

impl Answer {
    fn header(&self, name: &str) -> Option<String> {
        self.head.lines().find_map(|l| {
            let (k, v) = l.split_once(':')?;
            k.eq_ignore_ascii_case(name).then(|| v.trim().to_string())
        })
    }
}

async fn get(addr: SocketAddr, path: &str, auth: Option<&str>) -> Answer {
    let mut s = tokio::net::TcpStream::connect(addr).await.unwrap();
    let auth = auth.map_or(String::new(), |a| format!("Authorization: {a}\r\n"));
    s.write_all(
        format!("GET {path} HTTP/1.1\r\nHost: node\r\n{auth}Connection: close\r\n\r\n").as_bytes(),
    )
    .await
    .unwrap();
    let mut buf = Vec::new();
    s.read_to_end(&mut buf).await.unwrap();
    let split = buf.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
    let head = String::from_utf8_lossy(&buf[..split]).to_string();
    let status = head.split(' ').nth(1).unwrap().parse().unwrap();
    Answer {
        status,
        head,
        body: buf[split + 4..].to_vec(),
    }
}

fn bearer() -> String {
    format!("Bearer {TOKEN}")
}

fn entries(body: &[u8]) -> Vec<(String, Vec<u8>)> {
    let mut gz = Vec::new();
    flate2::read::GzDecoder::new(body)
        .read_to_end(&mut gz)
        .unwrap();
    let mut out = Vec::new();
    for e in tar::Archive::new(&gz[..]).entries().unwrap() {
        let mut e = e.unwrap();
        assert_eq!(e.header().mode().unwrap(), 0o644);
        let name = e.path().unwrap().to_string_lossy().to_string();
        let mut bytes = Vec::new();
        e.read_to_end(&mut bytes).unwrap();
        out.push((name, bytes));
    }
    out
}

fn tenant_dir_has_no_temp(root: &Path) {
    let left: Vec<_> = std::fs::read_dir(root.join("data").join(TENANT))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
        .filter(|n| n.starts_with(".files-"))
        .collect();
    assert!(left.is_empty(), "temporary files left: {left:?}");
}

fn url() -> String {
    format!("/nodes/node-local/tenants/{TENANT}/files?database={TENANT}")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn three_files_come_back_sorted_with_the_hash_of_the_body() {
    let root = scratch("three");
    let (worker, addr) = setup(
        &root,
        &[
            ("app/b.txt", b"bee"),
            ("blog/a/c.txt", b"cee"),
            ("app/a.txt", b"ay"),
        ],
    )
    .await;
    let r = get(addr, &url(), Some(&bearer())).await;
    assert_eq!(r.status, 200, "{}", r.head);
    assert_eq!(
        r.header("content-type").as_deref(),
        Some("application/x-tar+gzip")
    );
    assert_eq!(r.header("x-renox-files").as_deref(), Some("3"));
    assert_eq!(r.header("x-renox-files-missing").as_deref(), Some("0"));
    assert_eq!(
        r.header("content-length")
            .unwrap()
            .parse::<usize>()
            .unwrap(),
        r.body.len()
    );
    let actual: String = sha2::Sha256::digest(&r.body)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    assert_eq!(r.header("x-renox-sha256").unwrap(), actual);
    let got = entries(&r.body);
    let p = |k: &str| format!("tenants/{TENANT}/files/{k}");
    assert_eq!(
        got,
        vec![
            (p("app/a.txt"), b"ay".to_vec()),
            (p("app/b.txt"), b"bee".to_vec()),
            (p("blog/a/c.txt"), b"cee".to_vec()),
        ]
    );
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    tenant_dir_has_no_temp(&root);
    worker.shutdown().await;
    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_tenant_without_files_gets_an_empty_tar() {
    let root = scratch("empty");
    let (worker, addr) = setup(&root, &[]).await;
    let r = get(addr, &url(), Some(&bearer())).await;
    assert_eq!(r.status, 200, "{}", r.head);
    assert_eq!(r.header("x-renox-files").as_deref(), Some("0"));
    assert!(entries(&r.body).is_empty());
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    tenant_dir_has_no_temp(&root);
    worker.shutdown().await;
    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_row_without_its_object_is_skipped_and_counted() {
    let root = scratch("missing");
    let (worker, addr) = setup(&root, &[("app/a.txt", b"ay"), ("app/b.txt", b"bee")]).await;
    std::fs::remove_file(root.join(format!("data/files/tenants/{TENANT}/files/app/a.txt")))
        .unwrap();
    let r = get(addr, &url(), Some(&bearer())).await;
    assert_eq!(r.status, 200, "{}", r.head);
    assert_eq!(r.header("x-renox-files").as_deref(), Some("1"));
    assert_eq!(r.header("x-renox-files-missing").as_deref(), Some("1"));
    assert_eq!(
        entries(&r.body),
        vec![(format!("tenants/{TENANT}/files/app/b.txt"), b"bee".to_vec())]
    );
    worker.shutdown().await;
    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn authentication_node_database_and_moving_are_checked() {
    let root = scratch("errors");
    let (worker, addr) = setup(&root, &[("app/a.txt", b"ay")]).await;
    assert_eq!(get(addr, &url(), None).await.status, 401);
    assert_eq!(
        get(addr, &url(), Some("Bearer renox_cb_wrong"))
            .await
            .status,
        401
    );
    let other = format!("/nodes/other-node/tenants/{TENANT}/files?database={TENANT}");
    assert_eq!(get(addr, &other, Some(&bearer())).await.status, 404);
    let foreign = format!("/nodes/node-local/tenants/{TENANT}/files?database=t_other");
    assert_eq!(get(addr, &foreign, Some(&bearer())).await.status, 400);
    let none = format!("/nodes/node-local/tenants/{TENANT}/files");
    assert_eq!(get(addr, &none, Some(&bearer())).await.status, 400);

    assert!(worker.manager.start_moving(TENANT));
    let r = get(addr, &url(), Some(&bearer())).await;
    assert_eq!(r.status, 503);
    assert!(String::from_utf8_lossy(&r.body).contains("RENOX_TENANT_MOVING"));
    worker.manager.stop_moving(TENANT);
    assert_eq!(get(addr, &url(), Some(&bearer())).await.status, 200);
    worker.shutdown().await;
    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_size_guard_stops_and_the_helper_reads_keys() {
    let root = scratch("limit");
    let noise: Vec<u8> = (0..4096u32)
        .map(|i| (i.wrapping_mul(2654435761) >> 13) as u8)
        .collect();
    let (worker, _addr) = setup(&root, &[("app/a.txt", &noise), ("app/b.txt", b"b")]).await;
    let db = root.join("data").join(TENANT).join("app.db");
    let keys = tokio::task::spawn_blocking(move || collect_file_keys(&db))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        keys.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>(),
        ["app/a.txt", "app/b.txt"]
    );
    let store = worker.manager.file_store();
    let out = root.join("out.tar.gz");
    let r = tokio::task::spawn_blocking(move || {
        write_files_tar_capped(store.as_ref(), TENANT, &keys, &out, 16)
    })
    .await
    .unwrap();
    assert!(matches!(r, Err(FilesExportError::TooLarge)));
    worker.shutdown().await;
    let _ = std::fs::remove_dir_all(&root);
}
