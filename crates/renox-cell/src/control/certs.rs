//! Custom-domain certificates from the control plane (#59, #391;
//! `docs/contracts/deploy-api.md` section 10, `control/api/src/domains/README.md`
//! "Node side").
//!
//! - `certificate_update` (hostname, version, `not_after`) on the stream:
//!   the node fetches `GET /v1/nodes/{node_id}/certificates/{hostname}`
//!   with its node token, verifies the bundle, writes
//!   `<cert_dir>/<hostname>/{fullchain,privkey}.pem` atomically and reloads
//!   the [`CertStore`] in process. New handshakes use the new certificate;
//!   established connections keep theirs.
//! - `certificate_remove`: the hostname's directory is deleted (only one
//!   this module wrote) and the store reloaded.
//! - On every (re)connect, after the first route snapshot: the bundle of
//!   every custom hostname of the snapshot is fetched, so a node that was
//!   offline learns the current certificates (the contract has no
//!   certificate snapshot). Directories this module wrote for hostnames no
//!   longer in the snapshot are removed.
//!
//! Messages about one hostname are ordered by `version` (one sequence for
//! all hostnames on the control plane): an update or removal no newer than
//! the last one applied is ignored.
//!
//! The on-disk format is the one `ops/scripts/renew-wildcard-cert.sh`
//! writes: the directory `0750`, `privkey.pem` `0640`, `fullchain.pem`
//! `0644`, each written to a dot-file next to it and renamed. A directory
//! written here also holds `.renox-control` (the version), which marks it
//! as the control plane's: the wildcard and apex directories the renewal
//! script installs are never touched.
//!
//! Verification before anything is written: the bundle names the requested
//! hostname; the chain parses and has the leaf and its issuer; the leaf is
//! valid now, for server authentication, for the hostname (SAN), and is
//! signed by the next certificate of the chain (webpki, with the last
//! certificate of the chain as the anchor: the bundle comes over the
//! authenticated control channel, the check is that it is a coherent,
//! current chain for this name); the private key matches the leaf. A
//! bundle that fails any check is refused and the installed certificate,
//! if any, stays in use.
//!
//! Private keys never reach a log line or an error: errors name the
//! hostname and the check that failed; the bundle type has no `Debug`.

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use ::http::{Method, StatusCode};
use renox_gateway::CertStore;
use rustls::RootCertStore;
use rustls::client::WebPkiServerVerifier;
use rustls::client::danger::ServerCertVerifier;
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, ServerName, UnixTime};
use rustls::sign::CertifiedKey;
use serde::Deserialize;
use serde_json::Value;

use super::http::{CALL_TIMEOUT, ControlClient, ControlError};

/// The marker file of a directory this module wrote; it holds the version.
pub const MARKER: &str = ".renox-control";
/// Directory-name prefix of the operator's wildcard certificates.
const WILDCARD_PREFIX: &str = "_wildcard.";
/// A bundle is at most 64 KiB of chain and 16 KiB of key (schema), plus JSON.
const BUNDLE_LIMIT: usize = 128 * 1024;
/// A failed fetch after `certificate_update` is retried this many times,
/// 1 s, 2 s, 4 s apart; the next reconnect fetches it again anyway.
const FETCH_ATTEMPTS: u32 = 4;

/// `certificate_bundle` (`control-messages.schema.json`). No `Debug`: it
/// holds the private key.
#[derive(Deserialize)]
pub struct Bundle {
    #[serde(rename = "type")]
    pub kind: String,
    pub hostname: String,
    pub version: u64,
    #[serde(default)]
    pub not_after: u64,
    pub chain_pem: String,
    pub key_pem: String,
}

/// Why a certificate was not installed. Never holds key material.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CertError {
    /// The control plane has no certificate for the hostname (404).
    NotFound,
    /// The fetch failed.
    Control(ControlError),
    /// The bundle failed a check (the reason names the check).
    Invalid(String),
    /// Writing `cert_dir` failed.
    Io(String),
}

impl std::fmt::Display for CertError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CertError::NotFound => write!(f, "no certificate on the control plane"),
            CertError::Control(e) => write!(f, "{e}"),
            CertError::Invalid(e) => write!(f, "bundle refused: {e}"),
            CertError::Io(e) => write!(f, "cert_dir: {e}"),
        }
    }
}

impl std::error::Error for CertError {}

/// What an update did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Applied {
    /// Written and the store reloaded.
    Installed,
    /// The same certificate was already installed.
    Unchanged,
    /// A newer message for the hostname was already applied.
    Stale,
}

/// Whether `hostname` can name a directory of `cert_dir`: a lowercase
/// hostname as the gateway parses it, with a dot, and not a wildcard
/// directory name. Refuses `..`, `/` and every other path trick.
pub fn valid_hostname(hostname: &str) -> bool {
    !hostname.starts_with(WILDCARD_PREFIX)
        && !hostname.starts_with('.')
        && hostname.contains('.')
        && renox_gateway::parse_host(hostname).is_ok_and(|h| h == hostname)
}

/// Checks `bundle` for `hostname` at `now` (module doc, "Verification").
pub fn verify_bundle(hostname: &str, bundle: &Bundle, now: UnixTime) -> Result<(), CertError> {
    let invalid = |s: &str| CertError::Invalid(s.to_string());
    if bundle.kind != "certificate_bundle" {
        return Err(invalid("not a certificate_bundle"));
    }
    if bundle.hostname != hostname {
        return Err(invalid("the bundle names another hostname"));
    }
    let chain: Vec<CertificateDer<'static>> =
        CertificateDer::pem_slice_iter(bundle.chain_pem.as_bytes())
            .collect::<Result<_, _>>()
            .map_err(|_| invalid("chain_pem does not parse"))?;
    if chain.len() < 2 {
        return Err(invalid(
            "chain_pem has no issuer certificate after the leaf",
        ));
    }
    // The parser's error does not carry key bytes; it is not shown anyway.
    let key = PrivateKeyDer::from_pem_slice(bundle.key_pem.as_bytes())
        .map_err(|_| invalid("key_pem does not parse"))?;
    let provider = Arc::new(rustls::crypto::ring::default_provider());

    let mut roots = RootCertStore::empty();
    roots
        .add(chain[chain.len() - 1].clone())
        .map_err(|_| invalid("the chain's last certificate is not usable as an issuer"))?;
    let verifier = WebPkiServerVerifier::builder_with_provider(Arc::new(roots), provider.clone())
        .build()
        .map_err(|_| invalid("no verifier"))?;
    let name = ServerName::try_from(hostname.to_string())
        .map_err(|_| invalid("the hostname is not a server name"))?;
    verifier
        .verify_server_cert(&chain[0], &chain[1..], &name, &[], now)
        .map_err(|e| CertError::Invalid(format!("chain: {e}")))?;

    let certified = CertifiedKey::from_der(chain, key, &provider)
        .map_err(|e| CertError::Invalid(format!("key: {e}")))?;
    certified
        .keys_match()
        .map_err(|_| invalid("the private key does not match the certificate"))?;
    Ok(())
}

/// Writes `bundle` under `<cert_dir>/<hostname>/` (module doc, format).
/// Returns false when both files already hold these bytes.
pub fn write_bundle(cert_dir: &Path, hostname: &str, bundle: &Bundle) -> Result<bool, CertError> {
    let io =
        |what: &str, e: std::io::Error| CertError::Io(format!("{hostname}: {what}: {}", e.kind()));
    let dir = cert_dir.join(hostname);
    let same = |name: &str, bytes: &str| {
        std::fs::read(dir.join(name)).is_ok_and(|b| b == bytes.as_bytes())
    };
    let unchanged =
        same("fullchain.pem", &bundle.chain_pem) && same("privkey.pem", &bundle.key_pem);
    if !dir.is_dir() {
        let mut b = std::fs::DirBuilder::new();
        b.recursive(true);
        #[cfg(unix)]
        std::os::unix::fs::DirBuilderExt::mode(&mut b, 0o750);
        b.create(&dir).map_err(|e| io("create the directory", e))?;
    }
    if !unchanged {
        // The key first: the store loads a pair only when both match, so a
        // reload between the two renames keeps the previous certificate.
        write_atomic(&dir, "privkey.pem", bundle.key_pem.as_bytes(), 0o640)
            .map_err(|e| io("privkey.pem", e))?;
        write_atomic(&dir, "fullchain.pem", bundle.chain_pem.as_bytes(), 0o644)
            .map_err(|e| io("fullchain.pem", e))?;
    }
    write_atomic(&dir, MARKER, bundle.version.to_string().as_bytes(), 0o644)
        .map_err(|e| io(MARKER, e))?;
    Ok(!unchanged)
}

/// `<dir>/.<name>.new`, fsynced, renamed over `<dir>/<name>`.
fn write_atomic(dir: &Path, name: &str, bytes: &[u8], mode: u32) -> std::io::Result<()> {
    use std::io::Write;
    let tmp = dir.join(format!(".{name}.new"));
    let _ = std::fs::remove_file(&tmp);
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut o, mode);
    #[cfg(not(unix))]
    let _ = mode;
    let mut f = o.open(&tmp)?;
    f.write_all(bytes)?;
    f.sync_all()?;
    drop(f);
    std::fs::rename(&tmp, dir.join(name))
}

/// The version in a directory's marker; `None` when the directory is not
/// the control plane's.
pub fn managed_version(cert_dir: &Path, hostname: &str) -> Option<u64> {
    std::fs::read_to_string(cert_dir.join(hostname).join(MARKER))
        .ok()
        .and_then(|s| s.trim().parse().ok())
}

/// The certificate side of a controlled node.
pub struct CertSync {
    client: ControlClient,
    cert_dir: PathBuf,
    store: Arc<CertStore>,
    /// The last version applied per hostname (update or removal).
    versions: std::sync::Mutex<HashMap<String, u64>>,
    /// One change at a time: version checks and writes stay consistent.
    serial: tokio::sync::Mutex<()>,
}

impl CertSync {
    pub fn new(client: ControlClient, cert_dir: PathBuf, store: Arc<CertStore>) -> Arc<CertSync> {
        Arc::new(CertSync {
            client,
            cert_dir,
            store,
            versions: std::sync::Mutex::new(HashMap::new()),
            serial: tokio::sync::Mutex::new(()),
        })
    }

    fn stored(&self, hostname: &str) -> u64 {
        let known = self
            .versions
            .lock()
            .expect("certs lock")
            .get(hostname)
            .copied()
            .unwrap_or(0);
        known.max(managed_version(&self.cert_dir, hostname).unwrap_or(0))
    }

    fn record(&self, hostname: &str, version: u64) {
        let mut v = self.versions.lock().expect("certs lock");
        let e = v.entry(hostname.to_string()).or_insert(0);
        *e = (*e).max(version);
    }

    /// Handles `certificate_update` and `certificate_remove` (in a task of
    /// its own: the stream never waits on a fetch). Returns false for any
    /// other message.
    pub fn handle(self: &Arc<Self>, message: &Value) -> bool {
        let kind = message.get("type").and_then(Value::as_str);
        if !matches!(kind, Some("certificate_update" | "certificate_remove")) {
            return false;
        }
        let hostname = message.get("hostname").and_then(Value::as_str);
        let version = message.get("version").and_then(Value::as_u64);
        let (Some(hostname), Some(version)) = (hostname, version) else {
            tracing::warn!(
                kind,
                "certificate message without hostname or version; ignored"
            );
            return true;
        };
        if !valid_hostname(hostname) {
            tracing::warn!(kind, "certificate message for an invalid hostname; ignored");
            return true;
        }
        let me = self.clone();
        let hostname = hostname.to_string();
        if kind == Some("certificate_remove") {
            tokio::spawn(async move { me.remove(&hostname, version).await });
        } else {
            tokio::spawn(async move {
                let mut wait = Duration::from_secs(1);
                for attempt in 1..=FETCH_ATTEMPTS {
                    match me.update(&hostname, Some(version)).await {
                        Ok(_) => return,
                        Err(CertError::Control(e)) if attempt < FETCH_ATTEMPTS => {
                            tracing::warn!(%hostname, error = %e, retry_in_ms = wait.as_millis() as u64, "tls: certificate fetch failed");
                            tokio::time::sleep(wait).await;
                            wait *= 2;
                        }
                        Err(e) => {
                            tracing::error!(%hostname, error = %e, "tls: certificate not installed; the previous one, if any, stays in use");
                            return;
                        }
                    }
                }
            });
        }
        true
    }

    /// Fetches, verifies, writes and reloads one hostname's certificate.
    /// `version` is the message's (`None` on a reconnect sync).
    pub async fn update(&self, hostname: &str, version: Option<u64>) -> Result<Applied, CertError> {
        let _serial = self.serial.lock().await;
        if version.is_some_and(|v| v <= self.stored(hostname)) {
            return Ok(Applied::Stale);
        }
        let bundle = self.fetch(hostname).await?;
        if bundle.version < self.stored(hostname) {
            return Ok(Applied::Stale);
        }
        verify_bundle(hostname, &bundle, UnixTime::now())?;
        let (dir, host) = (self.cert_dir.clone(), hostname.to_string());
        let version = bundle.version;
        let not_after = bundle.not_after;
        let store = self.store.clone();
        let changed = tokio::task::spawn_blocking(move || {
            let changed = write_bundle(&dir, &host, &bundle)?;
            if changed {
                reload(&store)?;
            }
            Ok::<_, CertError>(changed)
        })
        .await
        .map_err(|e| CertError::Io(e.to_string()))??;
        self.record(hostname, version);
        if changed {
            tracing::info!(%hostname, version, not_after, "tls: certificate installed from the control plane");
            Ok(Applied::Installed)
        } else {
            Ok(Applied::Unchanged)
        }
    }

    /// Removes the hostname's directory (only one this module wrote) and
    /// reloads. A removal no newer than the last change is ignored.
    pub async fn remove(&self, hostname: &str, version: u64) {
        let _serial = self.serial.lock().await;
        if version <= self.stored(hostname) {
            return;
        }
        self.record(hostname, version);
        let (dir, host, store) = (
            self.cert_dir.clone(),
            hostname.to_string(),
            self.store.clone(),
        );
        let r = tokio::task::spawn_blocking(move || remove_managed(&dir, &host, &store)).await;
        match r {
            Ok(Ok(true)) => tracing::info!(%hostname, version, "tls: certificate removed"),
            Ok(Ok(false)) => {}
            Ok(Err(e)) => tracing::error!(%hostname, error = %e, "tls: certificate removal failed"),
            Err(e) => tracing::error!(%hostname, error = %e, "tls: certificate removal failed"),
        }
    }

    /// After a (re)connect: fetch the bundle of every custom hostname of
    /// the route snapshot, and drop the directories this module wrote for
    /// hostnames that are no longer in it. Hostnames an operator
    /// certificate covers (a `_wildcard.<parent>` directory, or a
    /// directory without the marker) are not asked for.
    pub async fn sync_all(&self, hostnames: BTreeSet<String>) {
        for hostname in &hostnames {
            if !valid_hostname(hostname) || self.operator_covers(hostname) {
                continue;
            }
            match self.update(hostname, None).await {
                Ok(_) | Err(CertError::NotFound) => {}
                Err(e) => tracing::warn!(%hostname, error = %e, "tls: certificate sync failed"),
            }
        }
        let (dir, store) = (self.cert_dir.clone(), self.store.clone());
        let stale: Vec<String> = managed_hostnames(&dir)
            .into_iter()
            .filter(|h| !hostnames.contains(h))
            .collect();
        if stale.is_empty() {
            return;
        }
        let _serial = self.serial.lock().await;
        let r = tokio::task::spawn_blocking(move || {
            for h in &stale {
                remove_managed(&dir, h, &store)?;
                tracing::info!(hostname = %h, "tls: certificate of a hostname no longer routed removed");
            }
            Ok::<_, CertError>(())
        })
        .await;
        if let Ok(Err(e)) | Err(e) = r.map_err(|e| CertError::Io(e.to_string())) {
            tracing::error!(error = %e, "tls: stale certificate cleanup failed");
        }
    }

    fn operator_covers(&self, hostname: &str) -> bool {
        let own = self.cert_dir.join(hostname);
        if own.is_dir() && managed_version(&self.cert_dir, hostname).is_none() {
            return true;
        }
        hostname.split_once('.').is_some_and(|(_, parent)| {
            self.cert_dir
                .join(format!("{WILDCARD_PREFIX}{parent}"))
                .is_dir()
        })
    }

    async fn fetch(&self, hostname: &str) -> Result<Bundle, CertError> {
        let path = self.client.node_path(&format!("/certificates/{hostname}"));
        let a = self
            .client
            .send(Method::GET, &path, None, &[], CALL_TIMEOUT)
            .await
            .map_err(CertError::Control)?;
        match a.status {
            StatusCode::OK => {}
            StatusCode::NOT_FOUND => return Err(CertError::NotFound),
            s => return Err(CertError::Control(ControlError::Status(s.as_u16()))),
        }
        let bytes = a.bytes(BUNDLE_LIMIT).await.map_err(CertError::Control)?;
        // serde_json's error names a position, never the input.
        serde_json::from_slice(&bytes).map_err(|e| CertError::Invalid(format!("not a bundle: {e}")))
    }
}

/// Hostnames whose directory carries the marker.
fn managed_hostnames(cert_dir: &Path) -> Vec<String> {
    let Ok(rd) = std::fs::read_dir(cert_dir) else {
        return Vec::new();
    };
    rd.filter_map(Result::ok)
        .filter_map(|e| e.file_name().to_str().map(str::to_owned))
        .filter(|h| valid_hostname(h) && managed_version(cert_dir, h).is_some())
        .collect()
}

/// Deletes `<cert_dir>/<hostname>` if this module wrote it, then reloads.
fn remove_managed(cert_dir: &Path, hostname: &str, store: &CertStore) -> Result<bool, CertError> {
    if managed_version(cert_dir, hostname).is_none() {
        return Ok(false);
    }
    std::fs::remove_dir_all(cert_dir.join(hostname))
        .map_err(|e| CertError::Io(format!("{hostname}: remove: {}", e.kind())))?;
    reload(store)?;
    Ok(true)
}

fn reload(store: &CertStore) -> Result<(), CertError> {
    let report = store
        .reload()
        .map_err(|e| CertError::Io(format!("reload: {e}")))?;
    for (dir, reason) in &report.failed {
        tracing::error!(entry = %dir, %reason, "tls: certificate not loaded");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Chain {
        chain_pem: String,
        key_pem: String,
    }

    fn issue(names: &[&str]) -> (Chain, String) {
        use rcgen::{BasicConstraints, CertificateParams, IsCa, Issuer, KeyPair};
        let ca_key = KeyPair::generate().unwrap();
        let mut ca_params = CertificateParams::new(Vec::<String>::new()).unwrap();
        ca_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        let ca_cert = ca_params.self_signed(&ca_key).unwrap();
        let issuer = Issuer::new(ca_params, ca_key);
        let leaf_key = KeyPair::generate().unwrap();
        let mut leaf_params =
            CertificateParams::new(names.iter().map(|s| s.to_string()).collect::<Vec<_>>())
                .unwrap();
        leaf_params.not_before = rcgen::date_time_ymd(2020, 1, 1);
        leaf_params.not_after = rcgen::date_time_ymd(2100, 1, 1);
        let leaf = leaf_params.signed_by(&leaf_key, &issuer).unwrap();
        (
            Chain {
                chain_pem: format!("{}{}", leaf.pem(), ca_cert.pem()),
                key_pem: leaf_key.serialize_pem(),
            },
            KeyPair::generate().unwrap().serialize_pem(),
        )
    }

    fn bundle(host: &str, c: &Chain, key: Option<&str>) -> Bundle {
        Bundle {
            kind: "certificate_bundle".into(),
            hostname: host.into(),
            version: 3,
            not_after: 0,
            chain_pem: c.chain_pem.clone(),
            key_pem: key.unwrap_or(&c.key_pem).to_string(),
        }
    }

    /// docs/24-threat-model.md C, "Custom domain takeover": a bundle is
    /// installed only for the name it was asked for, with a matching key
    /// and a coherent chain.
    #[test]
    fn a_bundle_is_checked_for_name_chain_and_key() {
        let now = UnixTime::now();
        let (good, other_key) = issue(&["shop.example.com"]);
        assert_eq!(
            verify_bundle(
                "shop.example.com",
                &bundle("shop.example.com", &good, None),
                now
            ),
            Ok(())
        );
        // SAN: another name.
        assert!(matches!(
            verify_bundle("evil.example.com", &bundle("evil.example.com", &good, None), now),
            Err(CertError::Invalid(r)) if r.starts_with("chain")
        ));
        // The bundle names another hostname than the one fetched.
        assert!(
            verify_bundle(
                "a.example.com",
                &bundle("shop.example.com", &good, None),
                now
            )
            .is_err()
        );
        // Key mismatch; the error never contains the key.
        let e = verify_bundle(
            "shop.example.com",
            &bundle("shop.example.com", &good, Some(&other_key)),
            now,
        )
        .unwrap_err();
        assert!(!e.to_string().contains("PRIVATE KEY"), "{e}");
        assert!(!e.to_string().contains(&other_key[40..80]), "{e}");
        // A leaf alone: no issuer.
        let leaf_only = Chain {
            chain_pem: good
                .chain_pem
                .split_inclusive("-----END CERTIFICATE-----\n")
                .next()
                .unwrap()
                .into(),
            key_pem: good.key_pem.clone(),
        };
        assert!(
            verify_bundle(
                "shop.example.com",
                &bundle("shop.example.com", &leaf_only, None),
                now
            )
            .is_err()
        );
        // Expired: checked after the leaf's not_after (2100-01-01).
        let later = UnixTime::since_unix_epoch(Duration::from_secs(4_133_980_800));
        assert!(
            verify_bundle(
                "shop.example.com",
                &bundle("shop.example.com", &good, None),
                later
            )
            .is_err()
        );
    }

    #[test]
    fn hostnames_that_are_not_directory_names_are_refused() {
        assert!(valid_hostname("shop.example.com"));
        for bad in [
            "..",
            "../etc",
            "a/b.com",
            "_wildcard.example.com",
            "localhost",
            "Shop.example.com",
            ".hidden.com",
            "",
        ] {
            assert!(!valid_hostname(bad), "{bad}");
        }
    }

    #[test]
    fn the_files_are_written_in_the_renewal_scripts_format_and_only_ours_are_removed() {
        let root = std::env::temp_dir().join(format!("renox-certs-unit-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("_wildcard.renoxium.app")).unwrap();
        std::fs::create_dir_all(root.join("renoxium.app")).unwrap();
        let (store, _) = CertStore::load(&renox_gateway::TlsConfig {
            cert_dir: root.clone(),
        })
        .unwrap();
        let (c, _) = issue(&["shop.example.com"]);
        let b = bundle("shop.example.com", &c, None);
        assert!(write_bundle(&root, "shop.example.com", &b).unwrap());
        assert!(
            !write_bundle(&root, "shop.example.com", &b).unwrap(),
            "same bytes: unchanged"
        );
        reload(&store).unwrap();
        assert!(store.lookup("shop.example.com").is_some());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |p: &str| {
                std::fs::metadata(root.join(p))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777
            };
            assert_eq!(mode("shop.example.com"), 0o750);
            assert_eq!(mode("shop.example.com/privkey.pem"), 0o640);
            assert_eq!(mode("shop.example.com/fullchain.pem"), 0o644);
        }
        assert_eq!(managed_version(&root, "shop.example.com"), Some(3));
        assert_eq!(
            managed_hostnames(&root),
            vec!["shop.example.com".to_string()]
        );
        // The operator's directories carry no marker and are never removed.
        assert!(!remove_managed(&root, "renoxium.app", &store).unwrap());
        assert!(root.join("renoxium.app").is_dir());
        assert!(remove_managed(&root, "shop.example.com", &store).unwrap());
        assert!(store.lookup("shop.example.com").is_none());
        let _ = std::fs::remove_dir_all(&root);
    }
}
