//! Issue #162: `renox-worker` with `[tls]`, end to end (V8-linked). SNI
//! picks the certificate per hostname, the plain listener redirects to
//! HTTPS with 308 and serves ACME HTTP-01 challenges (and only it does),
//! the SNI/`Host` rule of #107 holds on the worker's TLS listener, and a
//! certificate reload (control message or SIGHUP) takes effect for new
//! handshakes without dropping established connections.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use renox_cell::{Worker, WorkerConfig};
use rustls::pki_types::{CertificateDer, ServerName};
use rustls::{ClientConfig, RootCertStore};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;
use tokio_rustls::client::TlsStream;

const HELLO_HASH: &str = "802957869194e4c16e462dfcb50bfa6b3e435fca606b96a1223e2b7e21271d7a";
const TOKEN: &str = "evaGxfADs6pSRb2LAv9IZf17Dt3juxGJ-PCt92wr-oA";
const KEY_AUTH: &str =
    "evaGxfADs6pSRb2LAv9IZf17Dt3juxGJ-PCt92wr-oA.9jg46WB3rR_AHD-EBXdN7cBkH1WOu0tA3M9fm21mqTI";

static N: AtomicU64 = AtomicU64::new(0);

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "renox-cell-tls-{}-{name}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for e in std::fs::read_dir(from).unwrap() {
        let e = e.unwrap();
        let target = to.join(e.file_name());
        if e.file_type().unwrap().is_dir() {
            copy_dir(&e.path(), &target);
        } else {
            std::fs::copy(e.path(), target).unwrap();
        }
    }
}

/// A self-signed certificate for `names`, written as
/// `<cert_dir>/<dir>/{fullchain,privkey}.pem`.
fn write_cert(cert_dir: &Path, dir: &str, names: &[&str]) -> CertificateDer<'static> {
    let rcgen::CertifiedKey { cert, signing_key } =
        rcgen::generate_simple_self_signed(names.iter().map(|n| n.to_string()).collect::<Vec<_>>())
            .unwrap();
    let path = cert_dir.join(dir);
    std::fs::create_dir_all(&path).unwrap();
    // Written next to the target and renamed, the way a deploy tool
    // replaces them, so a reload never sees half a file.
    for (name, pem) in [
        ("fullchain.pem", cert.pem()),
        ("privkey.pem", signing_key.serialize_pem()),
    ] {
        let tmp = path.join(format!(".{name}.tmp"));
        std::fs::write(&tmp, pem).unwrap();
        std::fs::rename(&tmp, path.join(name)).unwrap();
    }
    cert.der().clone()
}

struct Env {
    _root: PathBuf,
    certs: PathBuf,
    worker: Worker,
    a: CertificateDer<'static>,
    b: CertificateDer<'static>,
}

async fn start() -> Env {
    let root = scratch("worker");
    let certs = root.join("certs");
    let a = write_cert(&certs, "a.test", &["a.test"]);
    let b = write_cert(&certs, "b.test", &["b.test"]);
    let acme = root.join("acme");
    std::fs::create_dir_all(&acme).unwrap();
    std::fs::write(acme.join(TOKEN), KEY_AUTH).unwrap();
    let hello = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../docs/contracts/examples/hello-artifact")
        .join(HELLO_HASH);
    copy_dir(&hello, &root.join("artifacts").join(HELLO_HASH));
    let routes = serde_json::json!({ "version": 0, "entries": [
        { "hostname": "a.test", "tenant_id": "t_a", "deployment_hash": HELLO_HASH, "status": "active", "updated_at": 1 },
        { "hostname": "b.test", "tenant_id": "t_b", "deployment_hash": HELLO_HASH, "status": "active", "updated_at": 1 },
        { "hostname": "c.test", "tenant_id": "t_c", "deployment_hash": HELLO_HASH, "status": "active", "updated_at": 1 },
    ]});
    std::fs::write(root.join("routes.json"), routes.to_string()).unwrap();
    let text = r#"
listen = "127.0.0.1:0"
data_dir = "data"
artifacts_dir = "artifacts"
routes_file = "routes.json"
meters_dir = "meters"
logs_dir = "logs"
meter_flush_ms = 50

[tls]
cert_dir = "certs"
http_listen = "127.0.0.1:0"
acme_dir = "acme"
"#;
    let config = WorkerConfig::parse(text, &root).unwrap();
    let worker = Worker::start(config).await.unwrap();
    Env {
        _root: root,
        certs,
        worker,
        a,
        b,
    }
}

fn connector(roots: &[&CertificateDer<'static>]) -> TlsConnector {
    let mut store = RootCertStore::empty();
    for c in roots {
        store.add((*c).clone()).unwrap();
    }
    let mut config =
        ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_root_certificates(store)
            .with_no_client_auth();
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    TlsConnector::from(Arc::new(config))
}

async fn tls(
    addr: SocketAddr,
    connector: &TlsConnector,
    sni: &str,
) -> std::io::Result<TlsStream<TcpStream>> {
    let tcp = TcpStream::connect(addr).await?;
    connector
        .connect(ServerName::try_from(sni.to_owned()).unwrap(), tcp)
        .await
}

/// The certificate the server presented on a connection.
fn presented(s: &TlsStream<TcpStream>) -> CertificateDer<'static> {
    s.get_ref().1.peer_certificates().unwrap()[0].clone()
}

struct Reply {
    status: u16,
    head: String,
    body: String,
}

impl Reply {
    fn header(&self, name: &str) -> Option<&str> {
        self.head.lines().find_map(|l| {
            let (k, v) = l.split_once(':')?;
            k.eq_ignore_ascii_case(name).then(|| v.trim())
        })
    }
}

/// One HTTP/1.1 request on an open connection; reads exactly one response
/// (`Content-Length` framed), so the connection can be used again.
async fn request<S: AsyncRead + AsyncWrite + Unpin>(
    s: &mut S,
    method: &str,
    host: &str,
    path: &str,
) -> Reply {
    let req = format!("{method} {path} HTTP/1.1\r\nHost: {host}\r\nContent-Length: 0\r\n\r\n");
    s.write_all(req.as_bytes()).await.unwrap();
    let mut buf = Vec::new();
    let mut byte = [0u8; 1];
    while !buf.ends_with(b"\r\n\r\n") {
        let n = s.read(&mut byte).await.unwrap();
        assert!(n == 1, "connection closed in the response head");
        buf.push(byte[0]);
    }
    let head = String::from_utf8(buf).unwrap();
    let status = head.split(' ').nth(1).unwrap().parse().unwrap();
    let mut reply = Reply {
        status,
        head,
        body: String::new(),
    };
    let len: usize = reply
        .header("content-length")
        .map_or(0, |v| v.parse().unwrap());
    let mut body = vec![0u8; len];
    s.read_exact(&mut body).await.unwrap();
    reply.body = String::from_utf8(body).unwrap();
    reply
}

async fn plain(addr: SocketAddr, method: &str, host: &str, path: &str) -> Reply {
    let mut s = TcpStream::connect(addr).await.unwrap();
    request(&mut s, method, host, path).await
}

async fn wait_until<F: std::future::Future<Output = bool>>(
    what: &str,
    timeout: Duration,
    mut f: impl FnMut() -> F,
) {
    let start = Instant::now();
    while !f().await {
        assert!(start.elapsed() < timeout, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// SNI chooses the certificate per hostname; a hostname without one fails
/// the handshake (no fallback to another tenant's certificate); requests
/// are served over TLS with HSTS. `docs/24-threat-model.md` section C,
/// "Host/SNI confusion": SNI `a.test` with `Host: b.test` is 421
/// `RENOX_HOST_MISMATCH` on the worker's listener.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sni_per_hostname_and_host_check() {
    let e = start().await;
    let addr = e.worker.addr;
    let both = connector(&[&e.a, &e.b]);
    for (host, cert) in [("a.test", &e.a), ("b.test", &e.b)] {
        let mut s = tls(addr, &both, host).await.unwrap();
        assert_eq!(&presented(&s), cert, "{host}");
        let r = request(&mut s, "GET", host, "/api/hello").await;
        assert_eq!(r.status, 200, "{host}: {}", r.body);
        assert_eq!(r.body, r#"{"ok":true}"#);
        assert!(r.header("strict-transport-security").is_some());
    }
    assert!(tls(addr, &both, "unknown.test").await.is_err());
    // c.test has a route but no certificate yet.
    assert!(tls(addr, &both, "c.test").await.is_err());

    let mut s = tls(addr, &both, "a.test").await.unwrap();
    let r = request(&mut s, "GET", "b.test", "/api/hello").await;
    assert_eq!(r.status, 421);
    assert!(r.body.contains("RENOX_HOST_MISMATCH"), "{}", r.body);
}

/// The plain listener: 308 to the HTTPS URL for every method and path,
/// ACME challenges answered from `acme_dir`; the TLS listener never serves
/// the challenge directory (it is the tenant's path space there).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn redirect_and_acme_on_the_plain_listener_only() {
    let e = start().await;
    let http = e.worker.http_addr.expect("plain listener");
    let port = e.worker.addr.port();
    for (method, path) in [("GET", "/"), ("POST", "/api/hello?x=1"), ("HEAD", "/a/b")] {
        let r = plain(http, method, "a.test", path).await;
        assert_eq!(r.status, 308, "{method} {path}");
        assert_eq!(
            r.header("location"),
            Some(format!("https://a.test:{port}{path}").as_str())
        );
    }
    let challenge = format!("/.well-known/acme-challenge/{TOKEN}");
    let r = plain(http, "GET", "a.test", &challenge).await;
    assert_eq!(r.status, 200);
    assert_eq!(r.body, KEY_AUTH);
    let r = plain(http, "GET", "a.test", "/.well-known/acme-challenge/unknown").await;
    assert_eq!(r.status, 404);
    let r = plain(
        http,
        "GET",
        "a.test",
        "/.well-known/acme-challenge/..%2Facme",
    )
    .await;
    assert_eq!(r.status, 404);

    let mut s = tls(e.worker.addr, &connector(&[&e.a]), "a.test")
        .await
        .unwrap();
    let r = request(&mut s, "GET", "a.test", &challenge).await;
    assert_ne!(r.body, KEY_AUTH);
    assert_eq!(r.status, 404);
}

/// A certificate replaced on disk and reloaded (the control-message path,
/// `Worker::reload_certificates`) is presented on new handshakes, while a
/// connection opened before the reload keeps serving requests. SIGHUP
/// reloads too: a certificate added for `c.test` becomes reachable.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn hot_reload_keeps_established_connections() {
    let e = start().await;
    let addr = e.worker.addr;
    let old = connector(&[&e.a]);
    let mut before = tls(addr, &old, "a.test").await.unwrap();
    assert_eq!(
        request(&mut before, "GET", "a.test", "/api/hello")
            .await
            .status,
        200
    );

    let renewed = write_cert(&e.certs, "a.test", &["a.test"]);
    let report = e.worker.reload_certificates().unwrap().unwrap();
    assert_eq!(report.names, ["a.test", "b.test"]);
    assert!(report.failed.is_empty(), "{:?}", report.failed);

    // The established connection still works, on the old certificate.
    assert_eq!(presented(&before), e.a);
    for _ in 0..3 {
        let r = request(&mut before, "GET", "a.test", "/api/hello").await;
        assert_eq!(r.status, 200, "{}", r.body);
    }
    // New handshakes get the renewed certificate.
    let fresh = tls(addr, &connector(&[&renewed]), "a.test").await.unwrap();
    assert_eq!(presented(&fresh), renewed);
    // A fresh client config: `old` would resume its TLS session.
    assert!(tls(addr, &connector(&[&e.a]), "a.test").await.is_err());

    // A broken file does not take a served name down: the previous
    // certificate stays in use and the failure is reported.
    std::fs::write(e.certs.join("b.test/privkey.pem"), "not a key").unwrap();
    let report = e.worker.reload_certificates().unwrap().unwrap();
    assert_eq!(report.failed.len(), 1);
    assert_eq!(report.names, ["a.test", "b.test"]);
    assert!(tls(addr, &connector(&[&e.b]), "b.test").await.is_ok());

    // SIGHUP: the worker's own handler reloads the directory.
    let c = write_cert(&e.certs, "c.test", &["c.test"]);
    let cc = connector(&[&c]);
    // SAFETY: sends SIGHUP to this process, whose handler the worker installed.
    assert_eq!(
        unsafe { libc::kill(std::process::id() as i32, libc::SIGHUP) },
        0
    );
    wait_until("SIGHUP reload", Duration::from_secs(5), || {
        let cc = cc.clone();
        async move { tls(addr, &cc, "c.test").await.is_ok() }
    })
    .await;
    let mut s = tls(addr, &cc, "c.test").await.unwrap();
    assert_eq!(
        request(&mut s, "GET", "c.test", "/api/hello").await.status,
        200
    );
    assert_eq!(
        request(&mut before, "GET", "a.test", "/api/hello")
            .await
            .status,
        200
    );
}
