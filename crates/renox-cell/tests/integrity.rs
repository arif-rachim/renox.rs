//! Issue #103: data integrity and recovery, end to end through a worker.
//!
//! - `a_corrupt_file_answers_503_then_is_restored`: `docs/23-failure-modes.md`
//!   "SQLite file corrupted, WAL unreadable" (corrupt file → 503
//!   `RENOX_DB_UNAVAILABLE`, automatic restore, then 200; quarantine kept).
//!   Needs `litestream` on `PATH` (skipped with the reason otherwise).
//! - `each_disk_watermark_behaves_as_documented`: "Disk full on node" (a
//!   loop device filled to each watermark). Needs root, `losetup` (through
//!   `mount -o loop`) and `mkfs.ext4`; skipped with the reason otherwise.
#![cfg(target_os = "linux")]

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use renox_cell::disk::Level;
use renox_cell::replication::State;
use renox_cell::{Worker, WorkerConfig};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

static N: AtomicU64 = AtomicU64::new(0);

fn logs() {
    let _ = tracing_subscriber::fmt()
        .with_test_writer()
        .with_env_filter("renox_cell=info")
        .try_init();
}

fn scratch(name: &str) -> PathBuf {
    let dir = PathBuf::from(format!(
        "/tmp/rnx-integrity-{}-{name}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn have(cmd: &str, arg: &str) -> bool {
    std::process::Command::new(cmd)
        .arg(arg)
        .output()
        .is_ok_and(|o| o.status.success())
}

/// An artifact whose function writes a row on POST and answers the count.
fn db_artifact(artifacts: &Path) -> String {
    let src = scratch("artifact");
    let migration = "create table app__hits (id integer primary key, at integer not null);\n";
    let sums = serde_json::json!({ "version": 0, "files": { "app/001_hits.sql": renox_data::checksum(migration) } });
    let manifest = serde_json::json!({
        "artifact": { "version": 0 },
        "app": { "name": "integrity", "timezone": "UTC" },
        "code": { "format": "esm-dir", "entry": { "functions/api/hits": "functions/api/hits.js" } },
        "routes": [
            { "kind": "function", "method": "GET", "path": "/api/hits", "module": "functions/api/hits", "export": "GET" },
            { "kind": "function", "method": "POST", "path": "/api/hits", "module": "functions/api/hits", "export": "POST" }
        ],
        "permissions": { "network": [], "secrets": [] }
    });
    let code = r#"
        export async function GET({ db }) {
            const n = (await db.queryOne("select count(*) as n from app__hits")).n;
            return Response.json({ n });
        }
        export async function POST({ db }) {
            await db.execute("insert into app__hits (at) values (?)", [Date.now()]);
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

/// A local worker under `root` with two tenants (`a.test` → `t_a`,
/// `b.test` → `t_b`) on the same artifact, its data directory at `data`.
fn worker_config(root: &Path, data: &Path, replication: bool) -> WorkerConfig {
    std::fs::create_dir_all(root.join("artifacts")).unwrap();
    let hash = db_artifact(&root.join("artifacts"));
    let routes = serde_json::json!({ "version": 0, "entries": [
        { "hostname": "a.test", "tenant_id": "t_a", "deployment_hash": hash, "status": "active", "updated_at": 1 },
        { "hostname": "b.test", "tenant_id": "t_b", "deployment_hash": hash, "status": "active", "updated_at": 1 }
    ]});
    std::fs::write(root.join("routes.json"), routes.to_string()).unwrap();
    let section = if replication {
        "[replication]\nenabled = true\nreplica = \"file\"\npath = \"replica\"\nsync_interval_ms = 200\nstop_grace_ms = 1500\nsnapshot_interval_secs = 3600\n"
    } else {
        ""
    };
    let text = format!(
        "listen = \"127.0.0.1:0\"\ndata_dir = \"{}\"\nartifacts_dir = \"artifacts\"\nroutes_file = \"routes.json\"\nmeters_dir = \"meters\"\nlogs_dir = \"logs\"\nmeter_flush_ms = 50\n[process]\nrun_dir = \"run\"\n{section}",
        data.display()
    );
    let path = root.join("worker.toml");
    std::fs::write(&path, text).unwrap();
    WorkerConfig::load(&path).unwrap()
}

async fn http(addr: SocketAddr, method: &str, host: &str, path: &str) -> (u16, String, String) {
    let mut s = tokio::net::TcpStream::connect(addr).await.unwrap();
    let req = format!(
        "{method} {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"
    );
    s.write_all(req.as_bytes()).await.unwrap();
    let mut buf = Vec::new();
    s.read_to_end(&mut buf).await.unwrap();
    let text = String::from_utf8_lossy(&buf).to_string();
    let status = text
        .split(' ')
        .nth(1)
        .and_then(|c| c.parse().ok())
        .unwrap_or(0);
    let (head, body) = text.split_once("\r\n\r\n").unwrap_or((&text, ""));
    (status, head.to_string(), body.to_string())
}

async fn eventually(what: &str, within: Duration, mut f: impl FnMut() -> bool) {
    let start = Instant::now();
    while !f() {
        assert!(start.elapsed() < within, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

async fn evict(worker: &Worker, tenant: &str) {
    worker
        .manager
        .set_idle_timeout_for_tests(Some(Duration::ZERO));
    eventually("eviction", Duration::from_secs(10), || {
        worker.manager.cell_count() == 0 && !worker.manager.db_open(tenant)
    })
    .await;
    worker.manager.set_idle_timeout_for_tests(None);
}

fn count(body: &str) -> u64 {
    serde_json::from_str::<serde_json::Value>(body).unwrap()["n"]
        .as_u64()
        .unwrap()
}

/// `docs/23-failure-modes.md` "SQLite file corrupted, WAL unreadable": a
/// tenant file overwritten on disk → the next request answers 503
/// `RENOX_DB_UNAVAILABLE` with `Retry-After`, the restore from the replica
/// completes on its own, the following request is 200 with the replicated
/// rows, and the damaged file is kept as `app.db.corrupt-<ts>`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_corrupt_file_answers_503_then_is_restored() {
    logs();
    if !have("litestream", "version") {
        eprintln!(
            "skipped: litestream is not on PATH (ops/scripts/fetch-litestream.sh installs the pinned release)"
        );
        return;
    }
    let root = scratch("corrupt");
    let worker = Worker::start(worker_config(&root, &root.join("data"), true))
        .await
        .unwrap();
    let repl = worker.replication.clone().expect("[replication] enabled");

    for want in 1..=3 {
        let (status, _, body) = http(worker.addr, "POST", "a.test", "/api/hits").await;
        assert_eq!((status, count(&body)), (200, want), "{body}");
    }
    eventually("frames shipped", Duration::from_secs(15), || {
        repl.state("t_a") == State::Replicating
            && repl.status("t_a", "t_a")["last_sync_at"].is_u64()
    })
    .await;
    tokio::time::sleep(Duration::from_millis(800)).await;
    evict(&worker, "t_a").await;
    eventually("the sidecar stops", Duration::from_secs(10), || {
        repl.state("t_a") == State::Stopped
    })
    .await;

    // Overwrite bytes of the file on disk. The WAL goes too: a WAL left
    // behind (the eviction's checkpoint can meet Litestream's read lock)
    // would still carry page 1 and hide the damage from SQLite.
    let file = root.join("data/t_a/app.db");
    for suffix in ["-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", file.display()));
    }
    std::fs::write(&file, vec![0xAB; 8192]).unwrap();

    let (status, head, body) = http(worker.addr, "GET", "a.test", "/api/hits").await;
    assert_eq!(status, 503, "{head}\n{body}");
    assert!(body.contains("RENOX_DB_UNAVAILABLE"), "{body}");
    assert!(
        head.to_ascii_lowercase().contains("retry-after: 30"),
        "{head}"
    );
    assert!(
        !body.contains(root.to_str().unwrap()),
        "no file path in the response"
    );

    // Another tenant on the node is not affected.
    let (status, _, body) = http(worker.addr, "POST", "b.test", "/api/hits").await;
    assert_eq!((status, count(&body)), (200, 1), "{body}");

    eventually("the automatic restore", Duration::from_secs(30), || {
        repl.recovered() == 1 && repl.unavailable("t_a").is_none()
    })
    .await;
    let (status, _, body) = http(worker.addr, "GET", "a.test", "/api/hits").await;
    assert_eq!((status, count(&body)), (200, 3), "{body}");

    let quarantined: Vec<String> = std::fs::read_dir(root.join("data/t_a"))
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| n.starts_with("app.db.corrupt-"))
        .collect();
    assert_eq!(quarantined.len(), 1, "{quarantined:?}");
    assert_eq!(
        std::fs::read(root.join("data/t_a").join(&quarantined[0])).unwrap(),
        vec![0xAB; 8192],
        "the damaged bytes are kept for forensics"
    );

    worker.shutdown().await;
    let _ = std::fs::remove_dir_all(&root);
}

/// A loop-mounted ext4 file system, unmounted on drop.
struct Loop {
    image: PathBuf,
    mount: PathBuf,
}

impl Loop {
    fn new(root: &Path, mib: u64) -> Option<Loop> {
        let image = root.join("disk.img");
        let mount = root.join("mnt");
        std::fs::create_dir_all(&mount).ok()?;
        let ok = |c: &mut std::process::Command| c.output().is_ok_and(|o| o.status.success());
        let made = ok(std::process::Command::new("truncate")
            .arg("-s")
            .arg(format!("{mib}M"))
            .arg(&image))
            && ok(std::process::Command::new("mkfs.ext4")
                .args(["-q", "-m", "0"])
                .arg(&image))
            && ok(std::process::Command::new("mount")
                .args(["-o", "loop"])
                .arg(&image)
                .arg(&mount));
        made.then_some(Loop { image, mount })
    }

    /// Writes a filler file so usage reaches `pct` percent.
    fn fill_to(&self, pct: f64) {
        let filler = self.mount.join("filler");
        let _ = std::fs::remove_file(&filler);
        let u = renox_cell::disk::usage(&self.mount).unwrap();
        let used = u.total - u.available;
        let want = (u.total as f64 * pct / 100.0) as u64;
        let bytes = want.saturating_sub(used);
        let f = std::fs::File::create(&filler).unwrap();
        // Real blocks, not a sparse file.
        use std::io::Write;
        let mut w = std::io::BufWriter::new(f);
        let chunk = vec![0u8; 1 << 16];
        let mut left = bytes;
        while left > 0 {
            let n = left.min(chunk.len() as u64) as usize;
            w.write_all(&chunk[..n]).unwrap();
            left -= n as u64;
        }
        w.into_inner().unwrap().sync_all().unwrap();
    }

    fn used_pct(&self) -> f64 {
        renox_cell::disk::usage(&self.mount).unwrap().used_pct()
    }
}

impl Drop for Loop {
    fn drop(&mut self) {
        // Lazy: the worker's last file handles may close after the test.
        let _ = std::process::Command::new("umount")
            .arg("-l")
            .arg(&self.mount)
            .status();
        let _ = std::fs::remove_file(&self.image);
    }
}

/// `docs/23-failure-modes.md` "Disk full on node", on a loop device filled
/// to each watermark (`crate::disk` table):
/// - 80 %: everything is served; the level is `warn` and a pruning sweep ran;
/// - 90 %: a tenant whose file is not open gets 503 `RENOX_UNAVAILABLE`
///   (no new cell); a warm tenant reads and writes;
/// - 95 %: a write (POST) gets 503 `RENOX_UNAVAILABLE`, a read is 200;
/// - freed: writes and new cells work again.
///
/// The worker runs in local mode, which only reports levels, so the test
/// turns enforcement on as a controlled node has it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn each_disk_watermark_behaves_as_documented() {
    logs();
    let root = scratch("disk");
    let is_root = std::process::Command::new("id")
        .arg("-u")
        .output()
        .is_ok_and(|o| String::from_utf8_lossy(&o.stdout).trim() == "0");
    let disk = if is_root && have("mkfs.ext4", "-V") {
        Loop::new(&root, 64)
    } else {
        None
    };
    let Some(disk) = disk else {
        eprintln!("skipped: needs root, mkfs.ext4 and loop mounts (CI: the loop-device job)");
        let _ = std::fs::remove_dir_all(&root);
        return;
    };
    let data = disk.mount.join("data");
    let worker = Worker::start(worker_config(&root, &data, false))
        .await
        .unwrap();
    // Local mode reports levels only; a controlled node enforces them.
    worker.disk.set_enforcing(true);
    let post = |host: &'static str| http(worker.addr, "POST", host, "/api/hits");
    let get = |host: &'static str| http(worker.addr, "GET", host, "/api/hits");

    assert_eq!(worker.disk.poll(), Level::Ok);
    assert_eq!(post("a.test").await.0, 200);

    disk.fill_to(82.0);
    assert_eq!(worker.disk.poll(), Level::Warn, "{}%", disk.used_pct());
    assert_eq!(post("a.test").await.0, 200);
    assert!(
        worker.pruning.counters()["sweeps"].as_u64().unwrap() >= 1,
        "pressure runs a sweep: {}",
        worker.pruning.counters()
    );

    disk.fill_to(92.0);
    assert_eq!(
        worker.disk.poll(),
        Level::StopScheduling,
        "{}%",
        disk.used_pct()
    );
    let (status, _, body) = get("b.test").await;
    assert_eq!(status, 503, "no new cell: {body}");
    assert!(body.contains("RENOX_UNAVAILABLE"), "{body}");
    assert!(!data.join("t_b/app.db").exists(), "no file was created");
    assert_eq!(get("a.test").await.0, 200, "a warm tenant reads");
    assert_eq!(post("a.test").await.0, 200, "and writes");

    disk.fill_to(96.0);
    assert_eq!(
        worker.disk.poll(),
        Level::RefuseWrites,
        "{}%",
        disk.used_pct()
    );
    let (status, head, body) = post("a.test").await;
    assert_eq!(status, 503, "{body}");
    assert!(body.contains("RENOX_UNAVAILABLE"), "{body}");
    assert!(
        head.to_ascii_lowercase().contains("retry-after: 30"),
        "{head}"
    );
    let (status, _, body) = get("a.test").await;
    assert_eq!((status, count(&body)), (200, 3), "reads continue");

    disk.fill_to(0.0);
    assert_eq!(worker.disk.poll(), Level::Ok);
    assert_eq!(post("a.test").await.0, 200);
    assert_eq!(post("b.test").await.0, 200);
    assert_eq!(worker.disk.changes(), 4);

    worker.shutdown().await;
    drop(disk);
    let _ = std::fs::remove_dir_all(&root);
}
