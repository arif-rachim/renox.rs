//! `S3ArtifactStore::download` refuses an object whose bytes do not hash to
//! the deployment hash (#275 item 8; `docs/24-threat-model.md`, "Supply
//! chain": a tampered artifact in object storage is never served). Drives
//! the store through a fake control API and object store
//! (`support/fake_s3.rs`); no Postgres, no MinIO, no V8 isolate.

#[path = "support/fake_s3.rs"]
mod fake_s3;

use std::path::PathBuf;
use std::sync::Arc;

use renox_cell::artifact_s3::S3ArtifactStore;
use renox_cell::control::http::ControlClient;
use renox_cell::{ArtifactError, ArtifactStore};

use fake_s3::{FakeS3, tar_of};

const HELLO_HASH: &str = "802957869194e4c16e462dfcb50bfa6b3e435fca606b96a1223e2b7e21271d7a";

fn hello_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../docs/contracts/examples/hello-artifact")
        .join(HELLO_HASH)
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("renox-cell-s3-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

async fn store(s3: &FakeS3, name: &str) -> (Arc<S3ArtifactStore>, PathBuf) {
    let base = s3.start().await;
    let client = ControlClient::new(
        &base,
        "renox_node_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "node-1",
    )
    .unwrap();
    let dir = scratch(name);
    (Arc::new(S3ArtifactStore::new(&dir, client)), dir)
}

/// The untampered object is fetched, verified, and cached.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_intact_object_is_fetched_and_cached() {
    let s3 = FakeS3::default();
    s3.put(HELLO_HASH, tar_of(&hello_dir()));
    let (store, dir) = store(&s3, "intact").await;
    let s = store.clone();
    let got = tokio::task::spawn_blocking(move || s.get(HELLO_HASH).map(|_| ()))
        .await
        .unwrap();
    assert!(got.is_ok(), "{got:?}");
    assert!(store.is_cached(HELLO_HASH));
    assert_eq!(store.downloads(), 1);
    // Through the 307 to the object store, as with a presigned S3 URL.
    let seen = s3.seen.lock().unwrap().clone();
    assert_eq!(
        seen,
        vec![
            format!("GET /v1/nodes/node-1/artifacts/{HELLO_HASH}"),
            format!("GET /renox-artifacts/{HELLO_HASH}")
        ]
    );
    let _ = std::fs::remove_dir_all(dir);
}

/// One byte of one file changed in the stored object: the download is
/// refused with `HashMismatch`, nothing is cached, and the next request
/// downloads again rather than trusting a partial result.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_tampered_object_is_refused_with_hash_mismatch() {
    let src = scratch("tampered-src");
    for e in ["code/functions/api", ""] {
        std::fs::create_dir_all(src.join(e)).unwrap();
    }
    std::fs::copy(hello_dir().join("manifest.json"), src.join("manifest.json")).unwrap();
    let mut js = std::fs::read(hello_dir().join("code/functions/api/hello.js")).unwrap();
    js[0] = if js[0] == b'/' { b'#' } else { b'/' };
    std::fs::write(src.join("code/functions/api/hello.js"), js).unwrap();

    let s3 = FakeS3::default();
    s3.put(HELLO_HASH, tar_of(&src));
    let (store, dir) = store(&s3, "tampered").await;
    for attempt in 1..=2u64 {
        let s = store.clone();
        let got = tokio::task::spawn_blocking(move || s.get(HELLO_HASH).map(|_| ()))
            .await
            .unwrap();
        match got {
            Err(ArtifactError::HashMismatch { expected, actual }) => {
                assert_eq!(expected, HELLO_HASH);
                assert_ne!(actual, HELLO_HASH);
            }
            other => panic!("attempt {attempt}: expected HashMismatch, got {other:?}"),
        }
        assert!(
            !store.is_cached(HELLO_HASH),
            "a tampered artifact is never cached"
        );
        assert_eq!(store.downloads(), 0);
        // Nothing left behind: no temporary tar, no half-extracted directory.
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
        assert_eq!(s3.seen.lock().unwrap().len() as u64, attempt * 2);
    }
    let _ = std::fs::remove_dir_all(dir);
    let _ = std::fs::remove_dir_all(src);
}
