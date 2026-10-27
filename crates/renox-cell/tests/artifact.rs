//! Issue #30: artifact loader v0. The canonical hash against the shared
//! vectors, verification on first use, and the refusals of
//! `docs/23-failure-modes.md`, "Artifact hash mismatch, symlink, `..` path"
//! and "Bundle over 20 MB, route conflict, unknown permission key".

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use renox_cell::artifact::{
    ArtifactError, ArtifactStore, LocalArtifactStore, Manifest, canonical_hash, canonical_listing,
    hash_files,
};

static N: AtomicU64 = AtomicU64::new(0);

const HELLO_HASH: &str = "802957869194e4c16e462dfcb50bfa6b3e435fca606b96a1223e2b7e21271d7a";

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "renox-artifact-test-{}-{name}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn repo(rel: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(rel)
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

fn b64(s: &str) -> Vec<u8> {
    const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::new();
    let mut buf = 0u32;
    let mut bits = 0;
    for c in s.bytes().filter(|&c| c != b'=') {
        buf = (buf << 6) | A.iter().position(|&a| a == c).unwrap() as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
            buf &= (1 << bits) - 1;
        }
    }
    out
}

/// Every vector of `docs/contracts/examples/hash-vectors.json` (shared with
/// the CLI's TypeScript implementation, #32): the in-memory listing and
/// hash match, and the same files written to disk hash the same through
/// the directory walk.
#[test]
fn hash_vectors_match_in_memory_and_on_disk() {
    let text = std::fs::read_to_string(repo("docs/contracts/examples/hash-vectors.json")).unwrap();
    let doc: serde_json::Value = serde_json::from_str(&text).unwrap();
    let vectors = doc["vectors"].as_array().unwrap();
    assert!(vectors.len() >= 3);
    for v in vectors {
        let name = v["name"].as_str().unwrap();
        let files: Vec<(String, Vec<u8>)> = v["files"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| {
                (
                    f["path"].as_str().unwrap().to_string(),
                    b64(f["content_base64"].as_str().unwrap()),
                )
            })
            .collect();
        assert_eq!(
            canonical_listing(&files),
            v["listing"].as_str().unwrap(),
            "{name}"
        );
        assert_eq!(hash_files(&files), v["hash"].as_str().unwrap(), "{name}");
        let dir = scratch(name);
        for (p, bytes) in &files {
            let path = dir.join(p);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, bytes).unwrap();
        }
        assert_eq!(
            canonical_hash(&dir).unwrap(),
            v["hash"].as_str().unwrap(),
            "{name} on disk"
        );
    }
    assert_eq!(vectors[0]["hash"], HELLO_HASH);
}

fn store_with_hello() -> (LocalArtifactStore, PathBuf) {
    let root = scratch("store");
    copy_dir(
        &repo("docs/contracts/examples/hello-artifact").join(HELLO_HASH),
        &root.join(HELLO_HASH),
    );
    (LocalArtifactStore::new(&root), root)
}

/// The worked example verifies, and the result is cached.
#[test]
fn worked_example_verifies_and_is_cached() {
    let (store, _) = store_with_hello();
    let a = store.get(HELLO_HASH).unwrap();
    assert_eq!(a.hash, HELLO_HASH);
    assert_eq!(a.manifest.inner.app.name, "hello");
    assert_eq!(store.verified_count(), 1);
    assert_eq!(store.get(HELLO_HASH).unwrap().hash, HELLO_HASH);
    assert_eq!(store.verified_count(), 1);
}

/// `docs/23-failure-modes.md`, "Artifact hash mismatch": one modified byte
/// fails with `HashMismatch`; the failure is not cached.
#[test]
fn a_modified_byte_fails_with_hash_mismatch() {
    let (store, root) = store_with_hello();
    let file = root.join(HELLO_HASH).join("code/functions/api/hello.js");
    let mut bytes = std::fs::read(&file).unwrap();
    bytes[0] ^= 1;
    std::fs::write(&file, &bytes).unwrap();
    match store.get(HELLO_HASH) {
        Err(ArtifactError::HashMismatch { expected, actual }) => {
            assert_eq!(expected, HELLO_HASH);
            assert_ne!(actual, HELLO_HASH);
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(store.verified_count(), 0);
    bytes[0] ^= 1;
    std::fs::write(&file, &bytes).unwrap();
    assert!(store.get(HELLO_HASH).is_ok());
}

/// `docs/23-failure-modes.md`, "symlink": a symbolic link inside the
/// artifact is refused (V1), and the error names the artifact path only.
#[cfg(unix)]
#[test]
fn a_symlink_inside_is_refused() {
    let (store, root) = store_with_hello();
    let dir = root.join(HELLO_HASH);
    std::os::unix::fs::symlink("/etc/passwd", dir.join("code/passwd.js")).unwrap();
    let e = store.get(HELLO_HASH).unwrap_err();
    match &e {
        ArtifactError::Invalid { rule, reason } => {
            assert_eq!(*rule, "V1");
            assert!(reason.contains("symbolic link"), "{reason}");
            assert!(!reason.contains(root.to_str().unwrap()), "{reason}");
        }
        other => panic!("{other:?}"),
    }
}

/// A `..` path in a manifest field is refused (V1 or V3: the schema's path
/// pattern refuses it first).
#[test]
fn a_dotdot_path_is_refused() {
    let m = std::fs::read_to_string(repo(
        "docs/contracts/examples/artifact/manifest.path-escape.invalid.json",
    ))
    .unwrap();
    let e = Manifest::from_slice(m.as_bytes()).unwrap_err();
    assert!(
        matches!(
            e,
            ArtifactError::Invalid {
                rule: "V1" | "V3",
                ..
            }
        ),
        "{e:?}"
    );
}

/// `docs/23-failure-modes.md`, "route conflict" (V8), with the contract's
/// own invalid example; and "unknown permission key" (V3/V9 by the schema).
#[test]
fn conflicting_routes_and_unknown_keys_are_refused() {
    let m = std::fs::read_to_string(repo(
        "docs/contracts/examples/artifact/manifest.route-conflict.invalid.json",
    ))
    .unwrap();
    match Manifest::from_slice(m.as_bytes()).unwrap_err() {
        ArtifactError::Invalid { rule, reason } => {
            assert_eq!(rule, "V8", "{reason}");
            assert!(reason.contains("conflict"));
        }
        other => panic!("{other:?}"),
    }
    let m = std::fs::read_to_string(repo(
        "docs/contracts/examples/artifact/manifest.unknown-permission.invalid.json",
    ))
    .unwrap();
    assert!(matches!(
        Manifest::from_slice(m.as_bytes()).unwrap_err(),
        ArtifactError::Invalid { rule: "V3", .. }
    ));
    // A static segment beats a parameter: no conflict.
    let ok = r#"{
      "artifact": { "version": 0 },
      "app": { "name": "x", "timezone": "UTC" },
      "code": { "format": "esm-dir", "entry": { "functions/a": "functions/a.js" } },
      "routes": [
        { "kind": "function", "method": "GET", "path": "/a/new", "module": "functions/a", "export": "GET" },
        { "kind": "function", "method": "GET", "path": "/a/:id", "module": "functions/a", "export": "GET" },
        { "kind": "function", "method": "POST", "path": "/a/:slug", "module": "functions/a", "export": "POST" }
      ],
      "permissions": { "network": [], "secrets": [] }
    }"#;
    assert!(Manifest::from_slice(ok.as_bytes()).is_ok());
}

/// The notes example (with migrations) verifies, including V11; a
/// migration file that differs from `checksums.json` is refused.
#[test]
fn migrations_must_match_their_checksums() {
    let src = repo("docs/contracts/examples/artifact/notes-artifact");
    let hash = std::fs::read_dir(&src)
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .file_name()
        .into_string()
        .unwrap();
    let root = scratch("notes");
    copy_dir(&src.join(&hash), &root.join(&hash));
    let store = LocalArtifactStore::new(&root);
    store.get(&hash).unwrap();

    // Same tree with an edited migration, re-hashed so V2 passes and V11 is reached.
    let tmp = scratch("notes-edited");
    copy_dir(&src.join(&hash), &tmp);
    std::fs::write(
        tmp.join("migrations/app/001_init.sql"),
        "create table app__x (id integer);\n",
    )
    .unwrap();
    let edited = canonical_hash(&tmp).unwrap();
    copy_dir(&tmp, &root.join(&edited));
    match store.get(&edited).unwrap_err() {
        ArtifactError::Invalid { rule, .. } => assert_eq!(rule, "V11"),
        other => panic!("{other:?}"),
    }
}

/// Unknown and malformed hashes.
#[test]
fn unknown_and_malformed_hashes() {
    let (store, _) = store_with_hello();
    let missing = "0".repeat(64);
    assert_eq!(
        store.get(&missing).unwrap_err(),
        ArtifactError::NotFound(missing)
    );
    assert!(matches!(
        store.get("../etc").unwrap_err(),
        ArtifactError::Invalid { rule: "V2", .. }
    ));
    assert!(matches!(
        store.get(&HELLO_HASH.to_uppercase()).unwrap_err(),
        ArtifactError::Invalid { rule: "V2", .. }
    ));
}
