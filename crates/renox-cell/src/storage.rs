//! The file store behind `ctx.storage` (`docs/contracts/ops.md` 1.7.0
//! section 21; #321): the cell's side of `renox_runtime::ops::storage`.
//!
//! | Piece | Here |
//! | --- | --- |
//! | Bytes | an [`ObjectStore`]: [`DirStore`] (a local directory, `renox dev` and tests) or [`S3Store`] (the platform bucket, SigV4 like the replica purge) |
//! | Signed URLs | HMAC-SHA256 with the tenant's key ([`PlatformKey::tenant_key`]) over `<path>?exp=<unix s>` |
//! | Limits | the tier's (*proposed* free 1 GiB / 10 MiB, paid 50 GiB / 100 MiB) |
//! | Image dimensions | the `image` crate's header read |
//!
//! The isolate never sees a credential: the ops call [`CellStorage`] in Rust.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use bytes::Bytes;
use hmac::{Hmac, KeyInit, Mac};
use renox_runtime::ops::storage::{HostFuture, StorageHost, StorageLimits};
use sha2::Sha256;

use crate::pages::PlatformKey;
use crate::replication::purge::{Credentials, authorization, uri_encode};

/// Object keys to bytes.
pub trait ObjectStore: Send + Sync {
    fn put(&self, key: String, bytes: Bytes, content_type: String) -> HostFuture<()>;
    fn get(&self, key: String) -> HostFuture<Option<Bytes>>;
    fn delete(&self, key: String) -> HostFuture<()>;
}

/// A local directory: `<root>/<object key>`.
pub struct DirStore {
    root: PathBuf,
}

impl DirStore {
    pub fn new(root: impl Into<PathBuf>) -> DirStore {
        DirStore { root: root.into() }
    }

    fn path(&self, key: &str) -> Result<PathBuf, String> {
        // Keys are checked by the ops; refuse anything that could leave the root anyway.
        if key
            .split('/')
            .any(|s| s.is_empty() || s == "." || s == "..")
            || key.contains('\\')
        {
            return Err("bad object key".into());
        }
        Ok(self.root.join(key))
    }
}

impl ObjectStore for DirStore {
    fn put(&self, key: String, bytes: Bytes, _content_type: String) -> HostFuture<()> {
        let path = self.path(&key);
        Box::pin(async move {
            let path = path?;
            tokio::task::spawn_blocking(move || -> std::io::Result<()> {
                if let Some(dir) = path.parent() {
                    std::fs::create_dir_all(dir)?;
                }
                let tmp = path.with_extension("renox-tmp");
                std::fs::write(&tmp, &bytes)?;
                std::fs::rename(&tmp, &path)
            })
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())
        })
    }

    fn get(&self, key: String) -> HostFuture<Option<Bytes>> {
        let path = self.path(&key);
        Box::pin(async move {
            let path = path?;
            match tokio::fs::read(&path).await {
                Ok(b) => Ok(Some(Bytes::from(b))),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
                Err(e) => Err(e.to_string()),
            }
        })
    }

    fn delete(&self, key: String) -> HostFuture<()> {
        let path = self.path(&key);
        Box::pin(async move {
            match tokio::fs::remove_file(path?).await {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(e) => Err(e.to_string()),
            }
        })
    }
}

type HttpsClient = hyper_util::client::legacy::Client<
    hyper_rustls::HttpsConnector<hyper_util::client::legacy::connect::HttpConnector>,
    http_body_util::Full<Bytes>,
>;

/// The platform bucket (path-style requests, SigV4), credentials from the
/// environment like the replication sidecar's.
pub struct S3Store {
    http: HttpsClient,
    creds: Credentials,
    region: String,
    base: String,
    bucket: String,
}

impl S3Store {
    pub fn new(
        endpoint: Option<String>,
        region: String,
        bucket: String,
    ) -> Result<S3Store, String> {
        let creds =
            Credentials::from_env().ok_or("no object store credentials in the environment")?;
        let https = hyper_rustls::HttpsConnectorBuilder::new()
            .with_provider_and_webpki_roots(rustls::crypto::ring::default_provider())
            .map_err(|e| e.to_string())?
            .https_or_http()
            .enable_http1()
            .build();
        let http =
            hyper_util::client::legacy::Client::builder(hyper_util::rt::TokioExecutor::new())
                .build(https);
        let base = endpoint.unwrap_or_else(|| format!("https://s3.{region}.amazonaws.com"));
        Ok(S3Store {
            http,
            creds,
            region,
            base,
            bucket,
        })
    }

    async fn send(
        &self,
        method: &str,
        key: &str,
        body: Bytes,
        content_type: Option<&str>,
    ) -> Result<(u16, Bytes), String> {
        use sha2::Digest;
        let base: http::Uri = self
            .base
            .parse()
            .map_err(|e: http::uri::InvalidUri| e.to_string())?;
        let host = base
            .authority()
            .map(|a| a.as_str().to_string())
            .ok_or("the store endpoint has no host")?;
        let path = format!(
            "/{}/{}",
            uri_encode(&self.bucket, false),
            uri_encode(key, true)
        );
        let payload: String = Sha256::digest(&body)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        let date = jiff::Timestamp::now()
            .strftime("%Y%m%dT%H%M%SZ")
            .to_string();
        let mut headers = vec![
            ("host".to_string(), host),
            ("x-amz-content-sha256".to_string(), payload.clone()),
            ("x-amz-date".to_string(), date.clone()),
        ];
        if let Some(t) = &self.creds.session_token {
            headers.push(("x-amz-security-token".to_string(), t.clone()));
        }
        let auth = authorization(
            &self.creds,
            method,
            &path,
            "",
            &headers,
            &payload,
            &date,
            &self.region,
        );
        let mut req = http::Request::builder().method(method).uri(format!(
            "{}{}",
            self.base.trim_end_matches('/'),
            path
        ));
        for (k, v) in &headers {
            if k != "host" {
                req = req.header(k.as_str(), v.as_str());
            }
        }
        if let Some(ct) = content_type {
            req = req.header("content-type", ct);
        }
        let req = req
            .header("authorization", auth)
            .body(http_body_util::Full::new(body))
            .map_err(|e| e.to_string())?;
        let res = tokio::time::timeout(std::time::Duration::from_secs(30), self.http.request(req))
            .await
            .map_err(|_| "the object store did not answer".to_string())?
            .map_err(|e| e.to_string())?;
        let status = res.status().as_u16();
        let body = http_body_util::BodyExt::collect(res.into_body())
            .await
            .map_err(|e| e.to_string())?
            .to_bytes();
        Ok((status, body))
    }
}

impl ObjectStore for Arc<S3Store> {
    fn put(&self, key: String, bytes: Bytes, content_type: String) -> HostFuture<()> {
        let s = self.clone();
        Box::pin(async move {
            match s.send("PUT", &key, bytes, Some(&content_type)).await? {
                (200..=299, _) => Ok(()),
                (status, _) => Err(format!("object store PUT answered {status}")),
            }
        })
    }

    fn get(&self, key: String) -> HostFuture<Option<Bytes>> {
        let s = self.clone();
        Box::pin(async move {
            match s.send("GET", &key, Bytes::new(), None).await? {
                (200..=299, body) => Ok(Some(body)),
                (404, _) => Ok(None),
                (status, _) => Err(format!("object store GET answered {status}")),
            }
        })
    }

    fn delete(&self, key: String) -> HostFuture<()> {
        let s = self.clone();
        Box::pin(async move {
            match s.send("DELETE", &key, Bytes::new(), None).await? {
                (200..=299 | 404, _) => Ok(()),
                (status, _) => Err(format!("object store DELETE answered {status}")),
            }
        })
    }
}

/// The tier's storage limits.
pub fn limits_for(tier: crate::TierName) -> StorageLimits {
    match tier {
        crate::TierName::Free => StorageLimits::FREE,
        crate::TierName::Paid => StorageLimits::PAID,
    }
}

/// `ctx.storage`'s host for one cell: the node's store, the tenant's
/// signing key and the tier's limits.
pub struct CellStorage {
    store: Arc<dyn ObjectStore>,
    key: [u8; 32],
    limits: StorageLimits,
}

impl CellStorage {
    pub fn new(
        store: Arc<dyn ObjectStore>,
        platform_key: &PlatformKey,
        tenant_id: &str,
        limits: StorageLimits,
    ) -> CellStorage {
        // A key of its own: never the page/session key of the tenant.
        let key = platform_key.tenant_key(&format!("storage:{tenant_id}"));
        CellStorage { store, key, limits }
    }

    pub fn store(&self) -> &Arc<dyn ObjectStore> {
        &self.store
    }

    fn mac(&self, path: &str, exp: u64) -> String {
        let mut m = Hmac::<Sha256>::new_from_slice(&self.key).expect("any key length");
        m.update(format!("{path}?exp={exp}").as_bytes());
        m.finalize()
            .into_bytes()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    }

    /// Whether `sig` signs `path` until `exp` (Unix seconds) and `exp` has not passed.
    pub fn verify(&self, path: &str, exp: u64, sig: &str, now_s: u64) -> bool {
        if exp < now_s {
            return false;
        }
        let want = self.mac(path, exp);
        crate::pages::session::same(&want, sig)
    }
}

impl StorageHost for CellStorage {
    fn put(&self, object: String, bytes: Bytes, content_type: String) -> HostFuture<()> {
        self.store.put(object, bytes, content_type)
    }

    fn get(&self, object: String) -> HostFuture<Option<Bytes>> {
        self.store.get(object)
    }

    fn delete(&self, object: String) -> HostFuture<()> {
        self.store.delete(object)
    }

    fn sign(&self, _tenant: &str, path: &str, exp: u64) -> String {
        self.mac(path, exp)
    }

    fn limits(&self, _tenant: &str) -> StorageLimits {
        self.limits
    }

    fn dimensions(&self, bytes: &[u8]) -> Option<(u32, u32)> {
        image::ImageReader::new(std::io::Cursor::new(bytes))
            .with_guessed_format()
            .ok()?
            .into_dimensions()
            .ok()
    }
}

/// The node's default store: `<data_dir>/files` (local mode, `renox dev`, tests).
pub fn local_store(data_dir: &Path) -> Arc<dyn ObjectStore> {
    Arc::new(DirStore::new(data_dir.join("files")))
}
