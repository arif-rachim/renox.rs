//! TLS with certificates from a directory, SNI per hostname, wildcard
//! directories, hot reload, and HSTS on TLS responses only (#23).

mod common;

use std::net::SocketAddr;
use std::path::Path;
use std::sync::Arc;

use common::*;
use renox_gateway::{CertStore, Gateway, GatewayConfig, RouteStatus, RouteTable, TlsConfig};
use rustls::pki_types::{CertificateDer, ServerName};
use rustls::{ClientConfig, ProtocolVersion, RootCertStore};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;

struct Cert {
    der: CertificateDer<'static>,
}

/// Generates a self-signed certificate for `names` and writes it as
/// `<cert_dir>/<dir>/{fullchain,privkey}.pem`.
fn write_cert(cert_dir: &Path, dir: &str, names: &[&str]) -> Cert {
    let rcgen::CertifiedKey { cert, signing_key } =
        rcgen::generate_simple_self_signed(names.iter().map(|n| n.to_string()).collect::<Vec<_>>())
            .unwrap();
    let path = cert_dir.join(dir);
    std::fs::create_dir_all(&path).unwrap();
    std::fs::write(path.join("fullchain.pem"), cert.pem()).unwrap();
    std::fs::write(path.join("privkey.pem"), signing_key.serialize_pem()).unwrap();
    Cert {
        der: cert.der().clone(),
    }
}

async fn start(cert_dir: &Path, artifacts: &Path) -> (SocketAddr, Arc<CertStore>) {
    let (certs, report) = CertStore::load(&TlsConfig {
        cert_dir: cert_dir.to_owned(),
    })
    .unwrap();
    assert!(report.failed.is_empty(), "{:?}", report.failed);
    let routes = Arc::new(RouteTable::new());
    routes
        .upsert(entry("a.test", "t_a", HASH_A, RouteStatus::Active))
        .unwrap();
    let gw = Gateway::new(GatewayConfig::new(artifacts), routes);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let store = certs.clone();
    tokio::spawn(async move { gw.serve_tls(listener, store, FakeDispatcher::new()).await });
    (addr, certs)
}

fn client(roots: &[&Cert], alpn: &[&[u8]]) -> TlsConnector {
    let mut store = RootCertStore::empty();
    for c in roots {
        store.add(c.der.clone()).unwrap();
    }
    let mut config =
        ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_root_certificates(store)
            .with_no_client_auth();
    config.alpn_protocols = alpn.iter().map(|p| p.to_vec()).collect();
    TlsConnector::from(Arc::new(config))
}

async fn connect(
    addr: SocketAddr,
    connector: &TlsConnector,
    sni: &str,
) -> std::io::Result<tokio_rustls::client::TlsStream<TcpStream>> {
    let tcp = TcpStream::connect(addr).await?;
    connector
        .connect(ServerName::try_from(sni.to_owned()).unwrap(), tcp)
        .await
}

fn peer_cert(stream: &tokio_rustls::client::TlsStream<TcpStream>) -> CertificateDer<'static> {
    stream.get_ref().1.peer_certificates().unwrap()[0].clone()
}

#[tokio::test]
async fn sni_selects_the_hostname_certificate() {
    let certs = tempfile::tempdir().unwrap();
    let artifacts = tempfile::tempdir().unwrap();
    let a = write_cert(certs.path(), "a.test", &["a.test"]);
    let b = write_cert(certs.path(), "b.test", &["b.test"]);
    let (addr, _) = start(certs.path(), artifacts.path()).await;

    // Trusting both roots: the server must still pick the right one by SNI.
    let connector = client(&[&a, &b], &[b"http/1.1"]);
    let stream = connect(addr, &connector, "a.test").await.unwrap();
    assert_eq!(peer_cert(&stream), a.der);
    // TLS 1.3 is preferred.
    assert_eq!(
        stream.get_ref().1.protocol_version(),
        Some(ProtocolVersion::TLSv1_3)
    );
    let stream = connect(addr, &connector, "b.test").await.unwrap();
    assert_eq!(peer_cert(&stream), b.der);
}

#[tokio::test]
async fn wildcard_directory_matches_one_label() {
    let certs = tempfile::tempdir().unwrap();
    let artifacts = tempfile::tempdir().unwrap();
    let wild = write_cert(certs.path(), "_wildcard.wild.test", &["*.wild.test"]);
    let (addr, store) = start(certs.path(), artifacts.path()).await;

    let connector = client(&[&wild], &[]);
    let stream = connect(addr, &connector, "x.wild.test").await.unwrap();
    assert_eq!(peer_cert(&stream), wild.der);
    // One label only: neither the apex nor a deeper name match.
    assert!(store.lookup("wild.test").is_none());
    assert!(store.lookup("a.b.wild.test").is_none());
}

/// An SNI with no certificate fails the handshake; the gateway never falls
/// back to another tenant's certificate.
#[tokio::test]
async fn unknown_sni_fails_the_handshake() {
    let certs = tempfile::tempdir().unwrap();
    let artifacts = tempfile::tempdir().unwrap();
    let a = write_cert(certs.path(), "a.test", &["a.test", "unknown.test"]);
    let (addr, _) = start(certs.path(), artifacts.path()).await;
    let connector = client(&[&a], &[]);
    assert!(connect(addr, &connector, "unknown.test").await.is_err());
}

#[tokio::test]
async fn reload_picks_up_a_new_directory_without_dropping_connections() {
    let certs = tempfile::tempdir().unwrap();
    let artifacts = tempfile::tempdir().unwrap();
    let a = write_cert(certs.path(), "a.test", &["a.test"]);
    let (addr, store) = start(certs.path(), artifacts.path()).await;

    // An established keep-alive connection before the reload.
    let connector = client(&[&a], &[b"http/1.1"]);
    let mut open = connect(addr, &connector, "a.test").await.unwrap();

    let c = write_cert(certs.path(), "c.test", &["c.test"]);
    let connector_c = client(&[&c], &[]);
    assert!(connect(addr, &connector_c, "c.test").await.is_err());

    let report = store.reload().unwrap();
    assert_eq!(report.names, vec!["a.test", "c.test"]);
    let stream = connect(addr, &connector_c, "c.test").await.unwrap();
    assert_eq!(peer_cert(&stream), c.der);

    // The connection opened before the reload still works.
    open.write_all(b"GET / HTTP/1.1\r\nHost: a.test\r\nConnection: close\r\n\r\n")
        .await
        .unwrap();
    let mut out = String::new();
    open.read_to_string(&mut out).await.unwrap();
    assert!(out.starts_with("HTTP/1.1 200"), "{out}");
}

/// A broken entry is reported and does not replace a working certificate.
#[tokio::test]
async fn broken_entry_keeps_the_previous_certificate() {
    let certs = tempfile::tempdir().unwrap();
    let a = write_cert(certs.path(), "a.test", &["a.test"]);
    let (store, _) = CertStore::load(&TlsConfig {
        cert_dir: certs.path().to_owned(),
    })
    .unwrap();
    std::fs::write(certs.path().join("a.test/privkey.pem"), "not a key").unwrap();
    std::fs::create_dir_all(certs.path().join("Not_A_Host")).unwrap();
    let report = store.reload().unwrap();
    assert_eq!(report.failed.len(), 2, "{:?}", report.failed);
    assert_eq!(
        store.lookup("a.test").unwrap().end_entity_cert().unwrap(),
        &a.der
    );
}

/// HSTS is sent on TLS responses (`docs/04-isolation-security.md`, "HSTS");
/// plain-HTTP responses never carry it (`tests/gateway.rs`,
/// `security_headers_on_every_response`). ALPN negotiates `h2` when offered.
#[tokio::test]
async fn hsts_on_tls_responses_and_alpn() {
    let certs = tempfile::tempdir().unwrap();
    let artifacts = tempfile::tempdir().unwrap();
    let a = write_cert(certs.path(), "a.test", &["a.test"]);
    let (addr, _) = start(certs.path(), artifacts.path()).await;

    let connector = client(&[&a], &[b"http/1.1"]);
    let mut stream = connect(addr, &connector, "a.test").await.unwrap();
    assert_eq!(stream.get_ref().1.alpn_protocol(), Some(&b"http/1.1"[..]));
    stream
        .write_all(b"GET /x HTTP/1.1\r\nHost: a.test\r\nConnection: close\r\n\r\n")
        .await
        .unwrap();
    let mut out = String::new();
    stream.read_to_string(&mut out).await.unwrap();
    assert!(out.starts_with("HTTP/1.1 200"), "{out}");
    assert!(
        out.to_ascii_lowercase()
            .contains("strict-transport-security: max-age=31536000; includesubdomains\r\n"),
        "{out}"
    );

    let h2 = client(&[&a], &[b"h2", b"http/1.1"]);
    let stream = connect(addr, &h2, "a.test").await.unwrap();
    assert_eq!(stream.get_ref().1.alpn_protocol(), Some(&b"h2"[..]));
}

/// A full HTTP/2 request over TLS reaches the cell and gets HSTS.
#[tokio::test]
async fn http2_request_over_tls() {
    use http_body_util::BodyExt;
    let certs = tempfile::tempdir().unwrap();
    let artifacts = tempfile::tempdir().unwrap();
    let a = write_cert(certs.path(), "a.test", &["a.test"]);
    let (addr, _) = start(certs.path(), artifacts.path()).await;
    let stream = connect(addr, &client(&[&a], &[b"h2"]), "a.test")
        .await
        .unwrap();
    let (mut sender, conn) = hyper::client::conn::http2::handshake(
        hyper_util::rt::TokioExecutor::new(),
        hyper_util::rt::TokioIo::new(stream),
    )
    .await
    .unwrap();
    tokio::spawn(conn);
    let req = axum::http::Request::builder()
        .uri("https://a.test/api/hello")
        .body(http_body_util::Empty::<bytes::Bytes>::new())
        .unwrap();
    let resp = sender.send_request(req).await.unwrap();
    assert_eq!(resp.status(), 200);
    assert_eq!(resp.version(), axum::http::Version::HTTP_2);
    assert_eq!(
        resp.headers()["strict-transport-security"],
        "max-age=31536000; includeSubDomains"
    );
    let body = resp.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(&body[..], b"tenant=t_a");
}
