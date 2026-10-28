//! Issue #154: the files the `packaged` feature embeds (build.rs, README
//! "Packaging"). `write_packaged_sources` is the first step of a release
//! build (`.github/workflows/release-worker.yml`):
//!
//! ```text
//! RENOX_PACKAGED_DIR=$dir cargo test --release --locked -p renox-runtime \
//!   --test packaged -- --ignored --exact write_packaged_sources
//! RENOX_PACKAGED_DIR=$dir cargo build --release --locked -p renox-cell \
//!   --bin renox-worker --features renox-runtime/packaged
//! ```
#![cfg(feature = "v8")]

use std::path::{Path, PathBuf};

use renox_runtime::{Runtime, RuntimeConfig};

fn read_tsv(dir: &Path) -> Vec<(String, String, PathBuf)> {
    std::fs::read_to_string(dir.join("lazy.tsv"))
        .unwrap()
        .lines()
        .map(|l| {
            let cols: Vec<&str> = l.split('\t').collect();
            assert_eq!(cols.len(), 3, "{l:?}");
            (cols[0].into(), cols[1].into(), dir.join(cols[2]))
        })
        .collect()
}

/// `write_packaged` writes the process's snapshot byte for byte and one
/// file per residual lazy source, in the layout build.rs reads.
#[test]
fn write_packaged_writes_the_layout_build_rs_reads() {
    let rt = Runtime::new(RuntimeConfig::default());
    let dir = std::env::temp_dir().join(format!("renox-packaged-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    rt.write_packaged(&dir).unwrap();

    let snapshot = std::fs::read(dir.join("snapshot.bin")).unwrap();
    assert_eq!(snapshot.len(), rt.snapshot_bytes());
    let entries = read_tsv(&dir);
    let specifiers: Vec<&str> = entries.iter().map(|(_, s, _)| s.as_str()).collect();
    assert_eq!(specifiers, rt.residual_lazy_specifiers());
    for (kind, specifier, file) in &entries {
        assert!(kind == "js" || kind == "esm", "{kind}");
        assert!(
            specifier.starts_with("ext:") || specifier.starts_with("node:"),
            "{specifier}"
        );
        let source = std::fs::read_to_string(file).unwrap();
        assert!(!source.is_empty(), "{specifier}");
        assert!(
            source.is_ascii(),
            "{specifier}: deno_core needs 7-bit ASCII"
        );
    }
    assert!(!Runtime::is_packaged());
    let _ = std::fs::remove_dir_all(&dir);
}

/// Release step 1: write the packaged sources to `RENOX_PACKAGED_DIR`.
#[test]
#[ignore = "release tool: run with RENOX_PACKAGED_DIR set (see the module doc)"]
fn write_packaged_sources() {
    let dir = std::env::var_os("RENOX_PACKAGED_DIR").expect("RENOX_PACKAGED_DIR");
    let rt = Runtime::new(RuntimeConfig::default());
    rt.write_packaged(Path::new(&dir)).unwrap();
    println!(
        "packaged sources: {} snapshot bytes, {} lazy sources -> {}",
        rt.snapshot_bytes(),
        rt.residual_lazy_specifiers().len(),
        Path::new(&dir).display()
    );
}
