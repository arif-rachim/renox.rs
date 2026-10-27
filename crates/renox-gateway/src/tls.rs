//! TLS termination with `rustls` from certificates on disk, chosen by SNI.
//!
//! Certificates are issued by the control plane (ACME, F3, #59) and pushed
//! to the gateways; keys never enter a tenant cell
//! (`docs/05-tenant-lifecycle.md`, "Custom domains"). In F1 the gateway only
//! loads them from a directory:
//!
//! ```text
//! <cert_dir>/<hostname>/fullchain.pem        exact name, e.g. a.example.com
//! <cert_dir>/<hostname>/privkey.pem
//! <cert_dir>/_wildcard.<domain>/fullchain.pem   matches *.<domain> (one label)
//! <cert_dir>/_wildcard.<domain>/privkey.pem
//! ```
//!
//! The certificate map is an `ArcSwap`, so a handshake reads it without a
//! lock and [`CertStore::reload`] swaps in a new map without touching
//! established connections. TLS 1.3 is preferred, TLS 1.2 is the minimum;
//! ALPN offers `h2` and `http/1.1`. Responses on TLS connections carry HSTS
//! (`docs/04-isolation-security.md`, "HSTS").

use std::collections::HashMap;
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use arc_swap::ArcSwap;
use rustls::crypto::CryptoProvider;
use rustls::server::{ClientHello, ResolvesServerCert};
use rustls::sign::CertifiedKey;
use rustls::{ServerConfig, version};
use rustls_pki_types::pem::PemObject;
use rustls_pki_types::{CertificateDer, PrivateKeyDer};

/// `Strict-Transport-Security` value on TLS responses.
pub const HSTS: &str = "max-age=31536000; includeSubDomains";

/// Directory-name prefix for wildcard certificates.
const WILDCARD_PREFIX: &str = "_wildcard.";

/// Where the gateway finds its certificates.
#[derive(Clone, Debug)]
pub struct TlsConfig {
    pub cert_dir: PathBuf,
}

/// Request extension the gateway sets on requests that arrived over TLS.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TlsConnection;

/// A certificate store failure. Messages name the entry (a hostname
/// directory) and never contain key material.
#[derive(Debug)]
pub enum TlsError {
    /// The certificate directory itself could not be read.
    Dir(std::io::Error),
}

impl fmt::Display for TlsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Dir(e) => write!(f, "certificate directory unreadable: {e}"),
        }
    }
}

impl std::error::Error for TlsError {}

/// Outcome of a (re)load.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct LoadReport {
    /// Names now served: hostnames and `*.<domain>` patterns, sorted.
    pub names: Vec<String>,
    /// Entries that failed to load: `(directory name, reason)`. For a name
    /// that was served before, the previous certificate stays in use.
    pub failed: Vec<(String, String)>,
}

/// SNI → certificate, backed by a directory and swappable at runtime.
pub struct CertStore {
    dir: PathBuf,
    provider: Arc<CryptoProvider>,
    certs: ArcSwap<HashMap<String, Arc<CertifiedKey>>>,
}

impl fmt::Debug for CertStore {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CertStore")
            .field("names", &self.certs.load().len())
            .finish()
    }
}

impl CertStore {
    /// Loads every certificate under `config.cert_dir`.
    pub fn load(config: &TlsConfig) -> Result<(Arc<Self>, LoadReport), TlsError> {
        let store = Arc::new(Self {
            dir: config.cert_dir.clone(),
            provider: Arc::new(rustls::crypto::ring::default_provider()),
            certs: ArcSwap::from_pointee(HashMap::new()),
        });
        let report = store.reload()?;
        Ok((store, report))
    }

    /// Re-reads the directory and swaps in the new map. Handshakes in
    /// progress and established connections are not affected. If the
    /// directory cannot be read, the current map stays in use.
    pub fn reload(&self) -> Result<LoadReport, TlsError> {
        let current = self.certs.load_full();
        let mut next = HashMap::new();
        let mut report = LoadReport::default();
        for dirent in std::fs::read_dir(&self.dir).map_err(TlsError::Dir)? {
            let Ok(dirent) = dirent else { continue };
            let Some(dir_name) = dirent.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            if !dirent.file_type().is_ok_and(|t| t.is_dir()) {
                continue;
            }
            let Some(name) = sni_name_for_dir(&dir_name) else {
                report
                    .failed
                    .push((dir_name, "not a hostname or _wildcard.<domain>".into()));
                continue;
            };
            match load_certified_key(&dirent.path(), &self.provider) {
                Ok(key) => {
                    next.insert(name, Arc::new(key));
                }
                Err(reason) => {
                    if let Some(prev) = current.get(&name) {
                        next.insert(name, prev.clone());
                    }
                    report.failed.push((dir_name, reason));
                }
            }
        }
        report.names = next.keys().cloned().collect();
        report.names.sort();
        self.certs.store(Arc::new(next));
        Ok(report)
    }

    /// The certificate for an SNI name: exact match first, then the
    /// wildcard of its parent domain (one label only, as in RFC 6125).
    pub fn lookup(&self, sni: &str) -> Option<Arc<CertifiedKey>> {
        let sni = sni.strip_suffix('.').unwrap_or(sni).to_ascii_lowercase();
        let certs = self.certs.load();
        if let Some(key) = certs.get(&sni) {
            return Some(key.clone());
        }
        let (_, parent) = sni.split_once('.')?;
        if !parent.contains('.') {
            // Never match `*.com`-style patterns.
            return None;
        }
        certs.get(&format!("*.{parent}")).cloned()
    }

    /// A `rustls` server configuration resolving certificates from this
    /// store: TLS 1.3 and 1.2, ALPN `h2` then `http/1.1`.
    pub fn server_config(self: &Arc<Self>) -> Arc<ServerConfig> {
        let mut config = ServerConfig::builder_with_provider(self.provider.clone())
            .with_protocol_versions(&[&version::TLS13, &version::TLS12])
            .expect("ring supports TLS 1.2 and 1.3")
            .with_no_client_auth()
            .with_cert_resolver(self.clone());
        config.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
        Arc::new(config)
    }
}

impl ResolvesServerCert for CertStore {
    /// No SNI, or an SNI with no certificate, aborts the handshake: the
    /// gateway never presents another tenant's certificate as a fallback.
    fn resolve(&self, client_hello: ClientHello<'_>) -> Option<Arc<CertifiedKey>> {
        self.lookup(client_hello.server_name()?)
    }
}

/// `a.example.com` → `a.example.com`; `_wildcard.example.com` →
/// `*.example.com`. Anything else (including `_wildcard.com`) → `None`.
fn sni_name_for_dir(dir: &str) -> Option<String> {
    if let Some(domain) = dir.strip_prefix(WILDCARD_PREFIX) {
        let domain = crate::route_table::parse_host(domain).ok()?;
        return (domain == dir[WILDCARD_PREFIX.len()..] && domain.contains('.'))
            .then(|| format!("*.{domain}"));
    }
    let host = crate::route_table::parse_host(dir).ok()?;
    (host == dir && host.contains('.')).then_some(host)
}

fn load_certified_key(dir: &Path, provider: &CryptoProvider) -> Result<CertifiedKey, String> {
    let chain: Vec<CertificateDer<'static>> =
        CertificateDer::pem_file_iter(dir.join("fullchain.pem"))
            .map_err(|e| format!("fullchain.pem: {e}"))?
            .collect::<Result<_, _>>()
            .map_err(|e| format!("fullchain.pem: {e}"))?;
    if chain.is_empty() {
        return Err("fullchain.pem: no certificate".into());
    }
    // The error type of the key parser does not include key bytes.
    let key = PrivateKeyDer::from_pem_file(dir.join("privkey.pem"))
        .map_err(|e| format!("privkey.pem: {e}"))?;
    let certified =
        CertifiedKey::from_der(chain, key, provider).map_err(|e| format!("key pair: {e}"))?;
    certified
        .keys_match()
        .map_err(|e| format!("key does not match certificate: {e}"))?;
    Ok(certified)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn directory_names() {
        assert_eq!(sni_name_for_dir("a.test").as_deref(), Some("a.test"));
        assert_eq!(
            sni_name_for_dir("_wildcard.wild.test").as_deref(),
            Some("*.wild.test")
        );
        assert_eq!(sni_name_for_dir("_wildcard.com"), None);
        assert_eq!(sni_name_for_dir("A.test"), None);
        assert_eq!(sni_name_for_dir("localhost"), None);
        assert_eq!(sni_name_for_dir(".hidden"), None);
        assert_eq!(sni_name_for_dir("a.test:443"), None);
    }
}
