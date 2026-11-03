//! Issue #401: `renox-worker --version` prints the crate version, the same
//! value the worker registers with (`worker_version`), instead of the usage
//! text. `release-worker.yml` checks that a `worker-v*` tag equals it.

use std::process::Command;

#[test]
fn version_prints_the_crate_version() {
    for flag in ["--version", "-V"] {
        let out = Command::new(env!("CARGO_BIN_EXE_renox-worker"))
            .arg(flag)
            .output()
            .unwrap();
        assert!(out.status.success(), "{flag}: {:?}", out.status);
        assert_eq!(
            String::from_utf8_lossy(&out.stdout),
            format!("renox-worker {}\n", env!("CARGO_PKG_VERSION"))
        );
        assert_eq!(renox_cell::WORKER_VERSION, env!("CARGO_PKG_VERSION"));
    }
    assert_ne!(
        renox_cell::WORKER_VERSION,
        "0.0.0",
        "a released worker never reports 0.0.0"
    );
}
