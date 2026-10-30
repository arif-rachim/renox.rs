//! The replica purge of an erased tenant (`docs/contracts/deploy-api.md`
//! 0.4.1 section 15, `nodeDropTenant?purge_replica=true`; #308).
//!
//! Litestream has no delete command, so the node deletes the replica's
//! objects itself with the sidecar's own credentials: every generation of
//! every database of the tenant (`<tenant_id>` and `<tenant_id>.<app>`).
//!
//! | Replica | What is deleted |
//! | --- | --- |
//! | `file` | the directory `<path>/<database>` of each database |
//! | `s3` | every object under `<prefix>/<database>/`, listed with ListObjectsV2 and deleted one by one, each request signed with AWS Signature Version 4 from `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (and `AWS_SESSION_TOKEN`), or Litestream's `LITESTREAM_ACCESS_KEY_ID` / `LITESTREAM_SECRET_ACCESS_KEY` |
//!
//! A store that does not answer, or answers an error, fails the purge as a
//! whole: nothing is reported purged, and the control plane retries.

use std::path::Path;

use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

use crate::config::{ReplicaKind, ReplicationSection};

/// What a purge did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Purged {
    /// Generations (file replica: database directories; s3: objects) deleted.
    pub deleted: u64,
}

fn is_tenant_database(tenant: &str, name: &str) -> bool {
    name == tenant
        || name
            .strip_prefix(tenant)
            .and_then(|r| r.strip_prefix('.'))
            .is_some_and(|app| !app.is_empty() && !app.contains('/'))
}

/// Purges the file replica of `tenant` under `root`.
pub fn purge_file(root: &Path, tenant: &str) -> std::io::Result<Purged> {
    let mut deleted = 0;
    let entries = match std::fs::read_dir(root) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Purged { deleted }),
        Err(e) => return Err(e),
    };
    for e in entries {
        let e = e?;
        let name = e.file_name();
        let Some(name) = name.to_str() else { continue };
        if is_tenant_database(tenant, name) && e.file_type()?.is_dir() {
            deleted += count_gens(&e.path());
            std::fs::remove_dir_all(e.path())?;
        }
    }
    Ok(Purged { deleted })
}

/// Litestream keeps `generations/<id>/` under a database's replica path.
fn count_gens(db_dir: &Path) -> u64 {
    std::fs::read_dir(db_dir.join("generations"))
        .map(|d| d.count() as u64)
        .unwrap_or(1)
        .max(1)
}

// ---------------------------------------------------------------------------
// S3 with Signature Version 4.

/// Credentials as the sidecar reads them.
#[derive(Debug, Clone)]
pub struct Credentials {
    pub access_key: String,
    pub secret_key: String,
    pub session_token: Option<String>,
}

impl Credentials {
    pub fn from_env() -> Option<Credentials> {
        let get = |a: &str, b: &str| {
            std::env::var(a)
                .ok()
                .or_else(|| std::env::var(b).ok())
                .filter(|v| !v.is_empty())
        };
        Some(Credentials {
            access_key: get("AWS_ACCESS_KEY_ID", "LITESTREAM_ACCESS_KEY_ID")?,
            secret_key: get("AWS_SECRET_ACCESS_KEY", "LITESTREAM_SECRET_ACCESS_KEY")?,
            session_token: std::env::var("AWS_SESSION_TOKEN")
                .ok()
                .filter(|v| !v.is_empty()),
        })
    }
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn sha256_hex(b: &[u8]) -> String {
    hex(&Sha256::digest(b))
}

fn hmac(key: &[u8], data: &str) -> Vec<u8> {
    let mut m = Hmac::<Sha256>::new_from_slice(key).expect("any key length");
    m.update(data.as_bytes());
    m.finalize().into_bytes().to_vec()
}

/// RFC 3986 encoding as SigV4 wants it (`/` kept in paths when `path`).
pub fn uri_encode(s: &str, path: bool) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            b'/' if path => out.push('/'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// The `Authorization` header of one request (AWS SigV4, service `s3`).
/// `headers` are lower-case names with their values, `host` and
/// `x-amz-date` included; `query` is the canonical query string.
#[allow(clippy::too_many_arguments)]
pub fn authorization(
    creds: &Credentials,
    method: &str,
    path: &str,
    query: &str,
    headers: &[(String, String)],
    payload_sha256: &str,
    amz_date: &str,
    region: &str,
) -> String {
    let mut hs: Vec<(String, String)> = headers
        .iter()
        .map(|(k, v)| (k.to_lowercase(), v.trim().to_string()))
        .collect();
    hs.sort();
    let canonical_headers: String = hs.iter().map(|(k, v)| format!("{k}:{v}\n")).collect();
    let signed: Vec<&str> = hs.iter().map(|(k, _)| k.as_str()).collect();
    let signed = signed.join(";");
    let canonical =
        format!("{method}\n{path}\n{query}\n{canonical_headers}\n{signed}\n{payload_sha256}");
    let date = &amz_date[..8];
    let scope = format!("{date}/{region}/s3/aws4_request");
    let to_sign = format!(
        "AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}",
        sha256_hex(canonical.as_bytes())
    );
    let k = hmac(format!("AWS4{}", creds.secret_key).as_bytes(), date);
    let k = hmac(&k, region);
    let k = hmac(&k, "s3");
    let k = hmac(&k, "aws4_request");
    let sig = hex(&hmac(&k, &to_sign));
    format!(
        "AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={signed}, Signature={sig}",
        creds.access_key
    )
}

fn amz_now() -> String {
    let ts = jiff::Timestamp::now();
    ts.strftime("%Y%m%dT%H%M%SZ").to_string()
}

/// The keys of a ListObjectsV2 answer and its continuation token.
pub fn parse_list(xml: &str) -> (Vec<String>, Option<String>) {
    let mut keys = Vec::new();
    let mut rest = xml;
    while let Some(i) = rest.find("<Key>") {
        let after = &rest[i + 5..];
        let Some(j) = after.find("</Key>") else { break };
        keys.push(unescape(&after[..j]));
        rest = &after[j..];
    }
    let next = xml
        .find("<NextContinuationToken>")
        .and_then(|i| {
            let after = &xml[i + 23..];
            after
                .find("</NextContinuationToken>")
                .map(|j| unescape(&after[..j]))
        })
        .filter(|_| xml.contains("<IsTruncated>true</IsTruncated>"));
    (keys, next)
}

fn unescape(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

type HttpsClient = hyper_util::client::legacy::Client<
    hyper_rustls::HttpsConnector<hyper_util::client::legacy::connect::HttpConnector>,
    http_body_util::Full<bytes::Bytes>,
>;

fn client() -> Result<HttpsClient, String> {
    let https = hyper_rustls::HttpsConnectorBuilder::new()
        .with_provider_and_webpki_roots(rustls::crypto::ring::default_provider())
        .map_err(|e| e.to_string())?
        .https_or_http()
        .enable_http1()
        .build();
    Ok(
        hyper_util::client::legacy::Client::builder(hyper_util::rt::TokioExecutor::new())
            .build(https),
    )
}

struct S3 {
    http: HttpsClient,
    creds: Credentials,
    region: String,
    /// `https://s3.<region>.amazonaws.com` or the configured endpoint (path style).
    base: String,
    bucket: String,
}

impl S3 {
    async fn send(
        &self,
        method: &str,
        key: Option<&str>,
        query: &[(&str, String)],
    ) -> Result<(u16, String), String> {
        let base: http::Uri = self
            .base
            .parse()
            .map_err(|e: http::uri::InvalidUri| e.to_string())?;
        let host = base
            .authority()
            .map(|a| a.as_str().to_string())
            .ok_or("the replica endpoint has no host")?;
        let path = match key {
            Some(k) => format!(
                "/{}/{}",
                uri_encode(&self.bucket, false),
                uri_encode(k, true)
            ),
            None => format!("/{}", uri_encode(&self.bucket, false)),
        };
        let mut q: Vec<(String, String)> = query
            .iter()
            .map(|(k, v)| (uri_encode(k, false), uri_encode(v, false)))
            .collect();
        q.sort();
        let query_string = q
            .iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect::<Vec<_>>()
            .join("&");
        let empty = sha256_hex(b"");
        let date = amz_now();
        let mut headers = vec![
            ("host".to_string(), host.clone()),
            ("x-amz-content-sha256".to_string(), empty.clone()),
            ("x-amz-date".to_string(), date.clone()),
        ];
        if let Some(t) = &self.creds.session_token {
            headers.push(("x-amz-security-token".to_string(), t.clone()));
        }
        let auth = authorization(
            &self.creds,
            method,
            &path,
            &query_string,
            &headers,
            &empty,
            &date,
            &self.region,
        );
        let uri = format!(
            "{}{}{}",
            self.base.trim_end_matches('/'),
            path,
            if query_string.is_empty() {
                String::new()
            } else {
                format!("?{query_string}")
            }
        );
        let mut req = http::Request::builder().method(method).uri(uri);
        for (k, v) in &headers {
            if k != "host" {
                req = req.header(k.as_str(), v.as_str());
            }
        }
        let req = req
            .header("authorization", auth)
            .body(http_body_util::Full::new(bytes::Bytes::new()))
            .map_err(|e| e.to_string())?;
        let res = tokio::time::timeout(std::time::Duration::from_secs(30), self.http.request(req))
            .await
            .map_err(|_| "the replica store did not answer".to_string())?
            .map_err(|e| e.to_string())?;
        let status = res.status().as_u16();
        let body = http_body_util::BodyExt::collect(res.into_body())
            .await
            .map_err(|e| e.to_string())?
            .to_bytes();
        Ok((status, String::from_utf8_lossy(&body).into_owned()))
    }
}

/// Purges the S3 replica of `tenant`: the databases are the "directories"
/// directly under the prefix whose name is the tenant's.
pub async fn purge_s3(section: &ReplicationSection, tenant: &str) -> Result<Purged, String> {
    let creds = Credentials::from_env().ok_or("no replica store credentials in the environment")?;
    let region = section.region.clone().unwrap_or_else(|| "us-east-1".into());
    let base = section
        .endpoint
        .clone()
        .unwrap_or_else(|| format!("https://s3.{region}.amazonaws.com"));
    let s3 = S3 {
        http: client()?,
        creds,
        region,
        base,
        bucket: section.bucket.clone().ok_or("no replica bucket")?,
    };
    let prefix = section.prefix.trim_matches('/');
    let under = if prefix.is_empty() {
        String::new()
    } else {
        format!("{prefix}/")
    };
    let mut deleted = 0;
    let mut token: Option<String> = None;
    loop {
        // Every key of the tenant's databases starts with `<prefix>/<tenant>`.
        let mut q = vec![
            ("list-type", "2".to_string()),
            ("prefix", format!("{under}{tenant}")),
        ];
        if let Some(t) = &token {
            q.push(("continuation-token", t.clone()));
        }
        let (status, body) = s3.send("GET", None, &q).await?;
        if status != 200 {
            return Err(format!(
                "the replica store answered {status} to the listing"
            ));
        }
        let (keys, next) = parse_list(&body);
        for key in keys {
            let database = key
                .strip_prefix(&under)
                .and_then(|k| k.split('/').next())
                .unwrap_or("");
            if !is_tenant_database(tenant, database) {
                continue;
            }
            let (status, _) = s3.send("DELETE", Some(&key), &[]).await?;
            if status != 204 && status != 200 {
                return Err(format!("the replica store answered {status} to a delete"));
            }
            deleted += 1;
        }
        match next {
            Some(t) => token = Some(t),
            None => break,
        }
    }
    Ok(Purged { deleted })
}

/// Purges `tenant`'s replica, whichever kind the node replicates to.
pub async fn purge(section: &ReplicationSection, tenant: &str) -> Result<Purged, String> {
    match section.replica {
        ReplicaKind::File => {
            let root = section.path.clone().ok_or("no replica path")?;
            let tenant = tenant.to_string();
            tokio::task::spawn_blocking(move || purge_file(&root, &tenant))
                .await
                .map_err(|e| e.to_string())?
                .map_err(|e| e.to_string())
        }
        ReplicaKind::S3 => purge_s3(section, tenant).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The GetObject example of the AWS Signature Version 4 documentation
    /// ("Example: GET Object", examplebucket, Range: bytes=0-9).
    #[test]
    fn signs_the_aws_documentation_example() {
        let creds = Credentials {
            access_key: "AKIAIOSFODNN7EXAMPLE".into(),
            secret_key: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY".into(),
            session_token: None,
        };
        let empty = sha256_hex(b"");
        assert_eq!(
            empty,
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        let headers = vec![
            ("host".into(), "examplebucket.s3.amazonaws.com".into()),
            ("range".into(), "bytes=0-9".into()),
            ("x-amz-content-sha256".into(), empty.clone()),
            ("x-amz-date".into(), "20130524T000000Z".into()),
        ];
        let auth = authorization(
            &creds,
            "GET",
            "/test.txt",
            "",
            &headers,
            &empty,
            "20130524T000000Z",
            "us-east-1",
        );
        assert_eq!(
            auth,
            "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
        );
    }

    #[test]
    fn a_listing_gives_keys_and_the_continuation() {
        let xml = "<ListBucketResult><IsTruncated>true</IsTruncated><Contents><Key>tenants/t_a/generations/x/wal/1.wal.lz4</Key></Contents><Contents><Key>tenants/t_a.shop/generations/y/snapshots/0.snapshot.lz4</Key></Contents><NextContinuationToken>abc&amp;d</NextContinuationToken></ListBucketResult>";
        let (keys, next) = parse_list(xml);
        assert_eq!(keys.len(), 2);
        assert_eq!(next.as_deref(), Some("abc&d"));
        assert_eq!(
            parse_list("<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>").1,
            None
        );
    }

    #[test]
    fn only_the_tenants_own_databases() {
        assert!(is_tenant_database("t_a", "t_a"));
        assert!(is_tenant_database("t_a", "t_a.shop"));
        assert!(!is_tenant_database("t_a", "t_ab"));
        assert!(!is_tenant_database("t_a", "t_a."));
        assert!(!is_tenant_database("t_a", "t_b.t_a"));
    }

    #[test]
    fn a_file_replica_loses_every_database_of_the_tenant_and_nothing_else() {
        let root = std::env::temp_dir().join(format!("renox-purge-{}", std::process::id()));
        for d in [
            "t_a/generations/g1",
            "t_a/generations/g2",
            "t_a.shop/generations/g3",
            "t_ab/generations/g4",
        ] {
            std::fs::create_dir_all(root.join(d)).unwrap();
        }
        let p = purge_file(&root, "t_a").unwrap();
        assert_eq!(p.deleted, 3);
        assert!(!root.join("t_a").exists() && !root.join("t_a.shop").exists());
        assert!(root.join("t_ab").exists(), "another tenant's replica stays");
        std::fs::remove_dir_all(&root).unwrap();
    }
}
