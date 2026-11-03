//! Issue #391: a controlled TLS worker installs custom-domain certificates
//! from the control plane (`docs/contracts/deploy-api.md` section 10,
//! `control/api/src/domains/README.md` "Node side"), against the fake
//! control plane of `support/fake_control.rs`, so CI's rust job runs it.
//!
//! - `certificate_update` → the bundle is fetched with the node token,
//!   verified, written to `<cert_dir>/<hostname>/` and the hostname is served
//!   over TLS without a restart or a SIGHUP.
//! - A bundle whose key does not match is refused; the installed
//!   certificate stays in use (`docs/23-failure-modes.md`, "Certificate
//!   renewal fails": the previous certificate keeps serving).
//! - `certificate_remove` → the handshake for the hostname is refused.
//! - Reconnect → every custom hostname of the route snapshot is fetched
//!   again, a hostname covered by the operator's wildcard is not asked for,
//!   and a directory the control plane wrote for a hostname no longer routed
//!   is removed.

#[path = "support/fake_control.rs"]
mod fake;
#[path = "support/control_stack.rs"]
mod stack;

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use fake::{FakeControl, entry};
use renox_cell::{Worker, WorkerConfig};
use rustls::pki_types::{CertificateDer, ServerName};
use rustls::{ClientConfig, RootCertStore};
use serde_json::json;
use stack::{HELLO_HASH, eventually, hello_dir, tar_of};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_rustls::TlsConnector;

const NODE: &str = "node-certs-1";

/// A CA and a leaf for `host` signed by it.
struct Issued {
    ca: CertificateDer<'static>,
    chain_pem: String,
    key_pem: String,
}

fn issue(host: &str) -> Issued {
    use rcgen::{BasicConstraints, CertificateParams, IsCa, Issuer, KeyPair};
    let ca_key = KeyPair::generate().unwrap();
    let mut ca_params = CertificateParams::new(Vec::<String>::new()).unwrap();
    ca_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    let ca = ca_params.self_signed(&ca_key).unwrap();
    let issuer = Issuer::new(ca_params, ca_key);
    let leaf_key = KeyPair::generate().unwrap();
    let leaf = CertificateParams::new(vec![host.to_string()])
        .unwrap()
        .signed_by(&leaf_key, &issuer)
        .unwrap();
    Issued {
        ca: ca.der().clone(),
        chain_pem: format!("{}{}", leaf.pem(), ca.pem()),
        key_pem: leaf_key.serialize_pem(),
    }
}

fn bundle(host: &str, version: u64, i: &Issued, key_pem: &str) -> serde_json::Value {
    json!({
        "type": "certificate_bundle", "schema_version": 0, "hostname": host,
        "version": version, "not_after": 4_102_444_800_000u64,
        "chain_pem": i.chain_pem, "key_pem": key_pem,
    })
}

fn update(host: &str, version: u64) -> serde_json::Value {
    json!({ "type": "certificate_update", "schema_version": 0, "hostname": host, "version": version, "not_after": 4_102_444_800_000u64 })
}

/// GET `/api/hello` over TLS with `sni`; `Err` when the handshake fails.
async fn tls_get(
    addr: std::net::SocketAddr,
    sni: &str,
    ca: &CertificateDer<'static>,
) -> Result<u16, String> {
    let mut roots = RootCertStore::empty();
    roots.add(ca.clone()).unwrap();
    let config =
        ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_root_certificates(roots)
            .with_no_client_auth();
    let tcp = tokio::net::TcpStream::connect(addr)
        .await
        .map_err(|e| e.to_string())?;
    let mut tls = TlsConnector::from(Arc::new(config))
        .connect(ServerName::try_from(sni.to_string()).unwrap(), tcp)
        .await
        .map_err(|e| e.to_string())?;
    tls.write_all(
        format!("GET /api/hello HTTP/1.1\r\nhost: {sni}\r\nconnection: close\r\n\r\n").as_bytes(),
    )
    .await
    .map_err(|e| e.to_string())?;
    let mut raw = Vec::new();
    let _ = tokio::time::timeout(Duration::from_secs(10), tls.read_to_end(&mut raw)).await;
    let head = String::from_utf8_lossy(&raw);
    head.split(' ')
        .nth(1)
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| format!("no status in {head:?}"))
}

fn worker_toml(root: &Path, control: &FakeControl, token_file: &Path) -> String {
    format!(
        r#"mode = "controlled"
listen = "127.0.0.1:0"
node_id = "{NODE}"
data_dir = "data"
artifacts_dir = "artifacts"
meters_dir = "meters"
logs_dir = "logs"
fetch_blocked_addresses = ["203.0.113.250"]
[control]
url = "{}"
node_token_file = "{}"
[tls]
cert_dir = "{}"
[sandbox]
allow_unsandboxed = true
"#,
        control.url(),
        token_file.display(),
        root.join("certs").display(),
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn certificates_from_the_control_plane_are_installed_served_and_removed() {
    let root = std::env::temp_dir().join(format!("renox-cell-certs-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let certs = root.join("certs");
    // The operator's wildcard for the platform domain (renew-wildcard-cert.sh).
    let wildcard = issue("*.renoxium.test");
    std::fs::create_dir_all(certs.join("_wildcard.renoxium.test")).unwrap();
    std::fs::write(
        certs.join("_wildcard.renoxium.test/fullchain.pem"),
        &wildcard.chain_pem,
    )
    .unwrap();
    std::fs::write(
        certs.join("_wildcard.renoxium.test/privkey.pem"),
        &wildcard.key_pem,
    )
    .unwrap();
    // A directory the control plane wrote earlier, for a hostname no longer routed.
    let gone = issue("gone.example.com");
    std::fs::create_dir_all(certs.join("gone.example.com")).unwrap();
    std::fs::write(
        certs.join("gone.example.com/fullchain.pem"),
        &gone.chain_pem,
    )
    .unwrap();
    std::fs::write(certs.join("gone.example.com/privkey.pem"), &gone.key_pem).unwrap();
    std::fs::write(certs.join("gone.example.com/.renox-control"), "1").unwrap();

    let control = FakeControl::start().await;
    let shop = issue("shop.example.com");
    {
        let mut st = control.state.lock().unwrap();
        st.route_version = 1;
        st.entries = vec![
            entry(
                "hello.renoxium.test",
                "t_shop",
                "hello",
                HELLO_HASH,
                NODE,
                1,
            ),
            entry("shop.example.com", "t_shop", "hello", HELLO_HASH, NODE, 1),
        ];
        st.artifacts.insert(HELLO_HASH.into(), tar_of(&hello_dir()));
    }
    let token_file = root.join("node.token");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(&token_file, stack::token("renox_node_")).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&token_file, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    let config = WorkerConfig::parse(&worker_toml(&root, &control, &token_file), &root).unwrap();
    let worker = Worker::start(config).await.unwrap();
    let addr = worker.addr;

    // Connected: the stale directory is removed, the wildcard host is not asked for.
    assert!(
        eventually(Duration::from_secs(10), || async {
            (!certs.join("gone.example.com").exists()).then_some(())
        })
        .await
        .is_some(),
        "the directory of a hostname no longer routed stays"
    );
    assert!(
        certs.join("_wildcard.renoxium.test").is_dir(),
        "the operator's wildcard is never touched"
    );
    // No certificate yet for the custom domain: the handshake is refused.
    assert!(tls_get(addr, "shop.example.com", &shop.ca).await.is_err());
    // The platform hostname is served by the wildcard.
    assert_eq!(
        tls_get(addr, "hello.renoxium.test", &wildcard.ca).await,
        Ok(200)
    );

    // certificate_update: fetched, written, served without SIGHUP.
    control.state.lock().unwrap().certs.insert(
        "shop.example.com".into(),
        bundle("shop.example.com", 2, &shop, &shop.key_pem),
    );
    control.send(update("shop.example.com", 2));
    let served = eventually(Duration::from_secs(10), || async {
        tls_get(addr, "shop.example.com", &shop.ca).await.ok()
    })
    .await;
    assert_eq!(
        served,
        Some(200),
        "the custom hostname is not served over TLS"
    );
    let dir = certs.join("shop.example.com");
    assert_eq!(
        std::fs::read_to_string(dir.join("fullchain.pem")).unwrap(),
        shop.chain_pem
    );
    assert_eq!(
        std::fs::read_to_string(dir.join("privkey.pem")).unwrap(),
        shop.key_pem
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&dir.join("privkey.pem")), 0o640);
        assert_eq!(mode(&dir.join("fullchain.pem")), 0o644);
    }
    let fetched = |host: &str| {
        control
            .requests()
            .iter()
            .filter(|r| *r == &format!("GET /v1/nodes/{NODE}/certificates/{host}"))
            .count()
    };
    assert_eq!(
        fetched("shop.example.com"),
        2,
        "once at connect (404), once on the update"
    );

    // A renewal whose key does not match: refused, the installed one keeps serving.
    let renewed = issue("shop.example.com");
    control.state.lock().unwrap().certs.insert(
        "shop.example.com".into(),
        bundle("shop.example.com", 3, &renewed, &shop.key_pem),
    );
    control.send(update("shop.example.com", 3));
    assert!(
        eventually(Duration::from_secs(5), || async {
            (fetched("shop.example.com") == 3).then_some(())
        })
        .await
        .is_some()
    );
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        std::fs::read_to_string(dir.join("fullchain.pem")).unwrap(),
        shop.chain_pem
    );
    assert_eq!(tls_get(addr, "shop.example.com", &shop.ca).await, Ok(200));

    // An update older than what is installed is not even fetched.
    control.send(update("shop.example.com", 2));
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(fetched("shop.example.com"), 3);

    // certificate_remove: the handshake is refused again.
    control.send(json!({ "type": "certificate_remove", "schema_version": 0, "hostname": "shop.example.com", "version": 4 }));
    assert!(
        eventually(Duration::from_secs(5), || async {
            tls_get(addr, "shop.example.com", &shop.ca)
                .await
                .is_err()
                .then_some(())
        })
        .await
        .is_some(),
        "the removed certificate is still served"
    );
    assert!(!dir.exists());

    // Reconnect: the bundle of every custom hostname is fetched again.
    let current = issue("shop.example.com");
    control.state.lock().unwrap().certs.insert(
        "shop.example.com".into(),
        bundle("shop.example.com", 5, &current, &current.key_pem),
    );
    control.drop_streams();
    let served = eventually(Duration::from_secs(15), || async {
        tls_get(addr, "shop.example.com", &current.ca).await.ok()
    })
    .await;
    assert_eq!(
        served,
        Some(200),
        "the certificate is not fetched again after a reconnect"
    );
    assert_eq!(
        fetched("hello.renoxium.test"),
        0,
        "a hostname under the operator's wildcard is never asked for"
    );

    worker.shutdown().await;
    let _ = std::fs::remove_dir_all(&root);
}
