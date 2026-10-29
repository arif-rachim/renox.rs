//! The control plane for worker tests in controlled mode (#55, #96, #97,
//! #98): `control/api` run with Bun against the Postgres of
//! `RENOX_TEST_PG` (a disposable database: its `public` schema is dropped)
//! and, when `RENOX_TEST_S3` names an S3 endpoint (MinIO from
//! `control/docker-compose.yml`, or any S3-compatible server with the
//! `renox-artifacts` bucket), that object store; otherwise the API keeps
//! artifacts in memory and serves the tar itself.
//!
//! Without `RENOX_TEST_PG`, or without `bun` on the `PATH`, [`Stack::start`]
//! returns `None` and the test prints why and passes: CI's rust job has
//! neither service (the issue notes on #55).

#![allow(dead_code)]

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, Command};

pub const HELLO_HASH: &str = "802957869194e4c16e462dfcb50bfa6b3e435fca606b96a1223e2b7e21271d7a";

pub fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// The contract's hello artifact directory.
pub fn hello_dir() -> PathBuf {
    repo()
        .join("docs/contracts/examples/hello-artifact")
        .join(HELLO_HASH)
}

/// A token value like the API issues: `<prefix>` + 32 base32 characters.
pub fn token(prefix: &str) -> String {
    let mut bytes = [0u8; 20];
    getrandom::fill(&mut bytes).unwrap();
    let alphabet = b"abcdefghijklmnopqrstuvwxyz234567";
    let mut out = String::from(prefix);
    let mut acc: u64 = 0;
    let mut bits = 0;
    for b in bytes {
        acc = (acc << 8) | u64::from(b);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(alphabet[((acc >> bits) & 31) as usize] as char);
        }
    }
    out
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// A raw HTTP/1.1 exchange (`Connection: close`).
pub struct Reply {
    pub status: u16,
    pub head: String,
    pub body: Vec<u8>,
}

impl Reply {
    pub fn json(&self) -> serde_json::Value {
        serde_json::from_slice(&self.body).unwrap_or(serde_json::Value::Null)
    }
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

pub async fn http(
    addr: SocketAddr,
    method: &str,
    path: &str,
    host: &str,
    headers: &[(&str, String)],
    body: &[u8],
) -> std::io::Result<Reply> {
    let mut s = tokio::time::timeout(Duration::from_secs(5), tokio::net::TcpStream::connect(addr))
        .await
        .map_err(|_| std::io::Error::other("connect timed out"))??;
    let mut req = format!(
        "{method} {path} HTTP/1.1\r\nhost: {host}\r\nconnection: close\r\ncontent-length: {}\r\n",
        body.len()
    );
    for (k, v) in headers {
        req.push_str(&format!("{k}: {v}\r\n"));
    }
    req.push_str("\r\n");
    s.write_all(req.as_bytes()).await?;
    s.write_all(body).await?;
    let mut raw = Vec::new();
    tokio::time::timeout(Duration::from_secs(30), s.read_to_end(&mut raw))
        .await
        .map_err(|_| std::io::Error::other("read timed out"))??;
    let split = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or_else(|| std::io::Error::other("no response head"))?;
    let head = String::from_utf8_lossy(&raw[..split]).into_owned();
    let status = head
        .split(' ')
        .nth(1)
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| std::io::Error::other("no status"))?;
    let mut body = raw[split + 4..].to_vec();
    if head
        .to_ascii_lowercase()
        .contains("transfer-encoding: chunked")
    {
        body = dechunk(&body);
    }
    Ok(Reply { status, head, body })
}

fn dechunk(mut b: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    while let Some(i) = b.windows(2).position(|w| w == b"\r\n") {
        let size = usize::from_str_radix(std::str::from_utf8(&b[..i]).unwrap_or("0").trim(), 16)
            .unwrap_or(0);
        if size == 0 {
            break;
        }
        out.extend_from_slice(&b[i + 2..i + 2 + size]);
        b = &b[i + 2 + size + 2..];
    }
    out
}

/// A ustar archive of the regular files under `dir`, paths relative to it.
pub fn tar_of(dir: &Path) -> Vec<u8> {
    fn walk(base: &Path, dir: &Path, out: &mut Vec<(String, Vec<u8>)>) {
        let mut entries: Vec<_> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap())
            .collect();
        entries.sort_by_key(|e| e.file_name());
        for e in entries {
            let p = e.path();
            if p.is_dir() {
                walk(base, &p, out);
            } else {
                let rel = p
                    .strip_prefix(base)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/");
                out.push((rel, std::fs::read(&p).unwrap()));
            }
        }
    }
    let mut files = Vec::new();
    walk(dir, dir, &mut files);
    let mut tar = Vec::new();
    for (path, data) in files {
        let mut h = [0u8; 512];
        h[..path.len()].copy_from_slice(path.as_bytes());
        h[100..107].copy_from_slice(b"0000644");
        h[108..115].copy_from_slice(b"0000000");
        h[116..123].copy_from_slice(b"0000000");
        h[124..135].copy_from_slice(format!("{:011o}", data.len()).as_bytes());
        h[136..147].copy_from_slice(b"00000000000");
        h[148..156].copy_from_slice(b"        ");
        h[156] = b'0';
        h[257..263].copy_from_slice(b"ustar\0");
        h[263..265].copy_from_slice(b"00");
        let sum: u32 = h.iter().map(|&b| u32::from(b)).sum();
        h[148..155].copy_from_slice(format!("{sum:06o}\0").as_bytes());
        tar.extend_from_slice(&h);
        tar.extend_from_slice(&data);
        tar.resize(tar.len().div_ceil(512) * 512, 0);
    }
    tar.resize(tar.len() + 1024, 0);
    tar
}

/// A TCP forwarder that can be stopped and started again on the same port:
/// "object storage unreachable" for degraded-mode tests (#98).
pub struct TcpProxy {
    pub addr: SocketAddr,
    target: SocketAddr,
    task: Option<tokio::task::JoinHandle<()>>,
}

impl TcpProxy {
    pub async fn start(target: SocketAddr) -> TcpProxy {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        let mut p = TcpProxy {
            addr,
            target,
            task: None,
        };
        p.task = Some(Self::serve(l, target));
        p
    }

    fn serve(l: tokio::net::TcpListener, target: SocketAddr) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            let mut conns = tokio::task::JoinSet::new();
            loop {
                let Ok((mut inbound, _)) = l.accept().await else {
                    continue;
                };
                conns.spawn(async move {
                    if let Ok(mut out) = tokio::net::TcpStream::connect(target).await {
                        let _ = tokio::io::copy_bidirectional(&mut inbound, &mut out).await;
                    }
                });
            }
        })
    }

    /// Closes the listener and every forwarded connection.
    pub fn stop(&mut self) {
        if let Some(t) = self.task.take() {
            t.abort();
        }
    }

    pub async fn restart(&mut self) {
        self.stop();
        let l = loop {
            match tokio::net::TcpListener::bind(self.addr).await {
                Ok(l) => break l,
                Err(_) => tokio::time::sleep(Duration::from_millis(50)).await,
            }
        };
        self.task = Some(Self::serve(l, self.target));
    }
}

/// A running control API.
pub struct Stack {
    /// The public listener (tenant, account and operator endpoints).
    pub addr: SocketAddr,
    /// The node listener (`/v1/nodes/*`, `/v1/ingest/*`; #218): the
    /// worker's `[control] url`.
    pub node_addr: SocketAddr,
    pub url: String,
    pub pg: String,
    pub s3: Option<String>,
    operator: String,
    master_key: String,
    child: Option<Child>,
    pub root: PathBuf,
    /// Tests of one binary share `RENOX_TEST_PG`: one stack at a time.
    _exclusive: tokio::sync::MutexGuard<'static, ()>,
}

static EXCLUSIVE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

impl Stack {
    /// `None` (with a note on stderr) when the services are not configured.
    pub async fn start(name: &str) -> Option<Stack> {
        Self::start_with(name, None).await
    }

    /// Like [`Stack::start`], with the API's S3 endpoint replaced by `s3`
    /// (a [`TcpProxy`] in front of `RENOX_TEST_S3`).
    pub async fn start_with(name: &str, s3: Option<String>) -> Option<Stack> {
        let Ok(pg) = std::env::var("RENOX_TEST_PG") else {
            eprintln!(
                "skipped: set RENOX_TEST_PG (a disposable Postgres database) to run the controlled-mode tests"
            );
            return None;
        };
        if std::process::Command::new("bun")
            .arg("--version")
            .output()
            .is_err()
        {
            eprintln!("skipped: bun is not on the PATH");
            return None;
        }
        let exclusive = EXCLUSIVE.lock().await;
        let root =
            std::env::temp_dir().join(format!("renox-control-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let reset = "const s = new Bun.SQL(process.env.PG); await s.unsafe('drop schema if exists public cascade; create schema public'); await s.close();";
        let ok = Command::new("bun")
            .args(["-e", reset])
            .env("PG", &pg)
            .status()
            .await
            .unwrap()
            .success();
        assert!(ok, "could not reset RENOX_TEST_PG");
        let free_port = || {
            let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap().port()
        };
        let port = free_port();
        let node_port = free_port();
        let mut stack = Stack {
            addr: SocketAddr::from(([127, 0, 0, 1], port)),
            node_addr: SocketAddr::from(([127, 0, 0, 1], node_port)),
            url: format!("http://127.0.0.1:{node_port}"),
            pg,
            s3: s3.or_else(|| std::env::var("RENOX_TEST_S3").ok()),
            operator: token("renox_op_"),
            master_key: {
                let mut k = [0u8; 32];
                getrandom::fill(&mut k).unwrap();
                base64_encode(&k)
            },
            child: None,
            root,
            _exclusive: exclusive,
        };
        stack.start_api().await;
        Some(stack)
    }

    /// Starts (or restarts) the API process and waits for `/v1/healthz`.
    pub async fn start_api(&mut self) {
        let mut cmd = Command::new("bun");
        cmd.arg(repo().join("control/api/src/main.ts"))
            .env("CONTROL_DATABASE_URL", &self.pg)
            .env("CONTROL_LISTEN_PORT", self.addr.port().to_string())
            .env("CONTROL_NODE_LISTEN_HOST", "127.0.0.1")
            .env(
                "CONTROL_NODE_LISTEN_PORT",
                self.node_addr.port().to_string(),
            )
            .env(
                "CONTROL_OPERATOR_TOKEN_SHA256",
                hex(&Sha256::digest(self.operator.as_bytes())),
            )
            .env("CONTROL_MASTER_KEY", &self.master_key)
            .env("CONTROL_PLATFORM_DOMAIN", "renox.test")
            .stdout(Stdio::null())
            .stderr(Stdio::from(
                std::fs::File::create(self.root.join("api.log")).unwrap(),
            ))
            .kill_on_drop(true);
        if let Some(s3) = &self.s3 {
            cmd.env("CONTROL_S3_ENDPOINT", s3)
                .env(
                    "CONTROL_S3_ACCESS_KEY_ID",
                    std::env::var("RENOX_TEST_S3_ACCESS_KEY_ID").unwrap_or_else(|_| "renox".into()),
                )
                .env(
                    "CONTROL_S3_SECRET_ACCESS_KEY",
                    std::env::var("RENOX_TEST_S3_SECRET_ACCESS_KEY")
                        .unwrap_or_else(|_| "renox-dev-minio".into()),
                )
                .env(
                    "CONTROL_S3_REGION",
                    std::env::var("RENOX_TEST_S3_REGION").unwrap_or_else(|_| "us-east-1".into()),
                );
        }
        self.child = Some(cmd.spawn().expect("start bun control/api"));
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            if let Ok(r) = http(self.addr, "GET", "/v1/healthz", "control", &[], b"").await
                && r.status == 200
            {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "control API did not start; see {}",
                self.root.join("api.log").display()
            );
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    /// Kills the API process (degraded-mode tests, #98).
    pub async fn stop_api(&mut self) {
        if let Some(mut c) = self.child.take() {
            let _ = c.kill().await;
            let _ = c.wait().await;
        }
    }

    pub async fn call(
        &self,
        method: &str,
        path: &str,
        token: &str,
        json: Option<serde_json::Value>,
    ) -> Reply {
        let body = json.map(|j| j.to_string().into_bytes()).unwrap_or_default();
        let mut headers = vec![("authorization", format!("Bearer {token}"))];
        if !body.is_empty() {
            headers.push(("content-type", "application/json".into()));
        }
        http(self.addr, method, path, "control", &headers, &body)
            .await
            .expect("control API call")
    }

    pub async fn operator(&self, method: &str, path: &str, json: serde_json::Value) -> Reply {
        self.call(method, path, &self.operator.clone(), Some(json))
            .await
    }

    /// A tenant with app `app`; returns the tenant's bootstrap token.
    pub async fn tenant_with_app(&self, tenant: &str, app: &str, tier: &str) -> String {
        let r = self
            .operator(
                "POST",
                "/v1/admin/tenants",
                serde_json::json!({ "tenant_id": tenant, "name": tenant, "tier": tier }),
            )
            .await;
        assert_eq!(r.status, 201, "{}", r.text());
        let body = r.json();
        let token = body["token"]["token"]
            .as_str()
            .or_else(|| body["token"].as_str())
            .expect("bootstrap token")
            .to_string();
        let r = self
            .call(
                "POST",
                "/v1/apps",
                &token,
                Some(serde_json::json!({ "name": app })),
            )
            .await;
        assert_eq!(r.status, 201, "{}", r.text());
        token
    }

    /// A node token for `node_id`, written to `<root>/<node_id>.token` (0600).
    pub async fn node_token_file(&self, node_id: &str) -> PathBuf {
        let r = self
            .operator(
                "POST",
                "/v1/admin/nodes",
                serde_json::json!({ "node_id": node_id }),
            )
            .await;
        assert_eq!(r.status, 201, "{}", r.text());
        let path = self.root.join(format!("{node_id}.token"));
        std::fs::write(&path, r.json()["token"].as_str().unwrap()).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        path
    }

    /// Uploads the artifact directory `dir` (named by its hash) to `app`.
    pub async fn upload(&self, token: &str, app: &str, dir: &Path) -> String {
        let hash = dir.file_name().unwrap().to_string_lossy().into_owned();
        let tar = tar_of(dir);
        let headers = [
            ("authorization", format!("Bearer {token}")),
            ("content-type", "application/x-tar".to_string()),
            ("x-renox-artifact-hash", hash.clone()),
        ];
        let r = http(
            self.addr,
            "POST",
            &format!("/v1/apps/{app}/deployments"),
            "control",
            &headers,
            &tar,
        )
        .await
        .unwrap();
        assert!(
            r.status == 201 || r.status == 200,
            "upload: {} {}",
            r.status,
            r.text()
        );
        hash
    }

    pub async fn activate(&self, token: &str, app: &str, hash: &str) -> Reply {
        self.call(
            "POST",
            &format!("/v1/apps/{app}/activate"),
            token,
            Some(serde_json::json!({ "hash": hash })),
        )
        .await
    }

    /// One SQL query on the API's database; the rows as JSON.
    pub async fn sql(&self, query: &str) -> serde_json::Value {
        let script = "const s = new Bun.SQL(process.env.PG); const r = await s.unsafe(process.env.Q); console.log(JSON.stringify([...r])); await s.close();";
        let out = Command::new("bun")
            .args(["-e", script])
            .env("PG", &self.pg)
            .env("Q", query)
            .output()
            .await
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        serde_json::from_slice(&out.stdout).unwrap()
    }

    /// A worker.toml for a controlled worker of `node_id` under `dir`.
    pub fn worker_toml(&self, dir: &Path, node_id: &str, token_file: &Path) -> String {
        format!(
            r#"
mode = "controlled"
listen = "127.0.0.1:0"
node_id = "{node_id}"
data_dir = "{d}/data"
artifacts_dir = "{d}/artifacts"
meters_dir = "{d}/meters"
logs_dir = "{d}/logs"
meter_flush_ms = 200
fetch_blocked_addresses = ["203.0.113.250"]
[gateway]
rate_limit_per_ip = 10000.0
rate_limit_burst = 10000
max_connections_per_ip = 1000
[control]
url = "{url}"
node_token_file = "{t}"
health_listen = "127.0.0.1:0"
"#,
            d = dir.display(),
            url = self.url,
            t = token_file.display(),
        )
    }
}

fn base64_encode(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// Polls `f` every 20 ms until it returns `Some`, at most `within`.
pub async fn eventually<T, F, Fut>(within: Duration, mut f: F) -> Option<T>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Option<T>>,
{
    let deadline = Instant::now() + within;
    loop {
        if let Some(v) = f().await {
            return Some(v);
        }
        if Instant::now() >= deadline {
            return None;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}
