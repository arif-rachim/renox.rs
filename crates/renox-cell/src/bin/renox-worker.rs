//! `renox-worker --config worker.toml`: one Renox worker node (F1).
//! Structured logs on stderr (`RUST_LOG` filters them); tenant logs and
//! meters go to the directories named in the config. `SIGHUP` re-reads the
//! route table file.
//!
//! `renox-worker transpile`: the template compiler for the CLI (#43). Reads
//! `{ "files": { path: source } }` on stdin and writes the result of
//! `renox_template::transpile::compile_json` to stdout; nothing else runs
//! (no V8, no config).
//!
//! `renox-worker --sandbox-selftest --config worker.toml`: applies the
//! `[sandbox]` profile of that config to itself (#253), then tries to read
//! `/etc/passwd` and to connect to the metadata address and the control
//! plane's port; prints a table and exits non-zero if either of the first
//! two got through.
//!
//! `renox-worker --config worker.toml --child <tenant> --socket <path>`:
//! one tenant's own worker process behind the supervisor (#254).
//!
//! With `[sandbox] enabled = true` the Landlock rules are applied here,
//! before the async runtime starts any thread (Landlock reaches only the
//! threads created after it); the seccomp allowlist follows in
//! `Worker::start` once the listeners are bound.

use std::path::PathBuf;
use std::process::ExitCode;

use renox_cell::{Worker, WorkerConfig};

fn usage() -> ExitCode {
    eprintln!(
        "usage: renox-worker --config <worker.toml> | renox-worker --sandbox-selftest --config <worker.toml> | renox-worker --config <worker.toml> --child <tenant> --socket <path> | renox-worker transpile"
    );
    ExitCode::from(2)
}

fn transpile() -> ExitCode {
    use std::io::{Read, Write};
    let mut input = String::new();
    if std::io::stdin().read_to_string(&mut input).is_err() {
        eprintln!("renox-worker transpile: stdin is not UTF-8");
        return ExitCode::from(2);
    }
    let out = renox_template::transpile::compile_json(&input);
    let mut stdout = std::io::stdout().lock();
    if stdout
        .write_all(out.as_bytes())
        .and_then(|_| stdout.flush())
        .is_err()
    {
        return ExitCode::FAILURE;
    }
    ExitCode::SUCCESS
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    match args.as_slice() {
        ["transpile"] => transpile(),
        ["--sandbox-selftest", "--config", p] | ["--config", p, "--sandbox-selftest"] => {
            sandbox_selftest(PathBuf::from(p))
        }
        ["--config", p] => serve(PathBuf::from(p)),
        ["--config", p, "--child", tenant, "--socket", socket] => {
            child(PathBuf::from(p), tenant.to_string(), PathBuf::from(socket))
        }
        _ => usage(),
    }
}

fn init_tracing() {
    tracing_subscriber::fmt()
        .json()
        .with_writer(std::io::stderr)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();
}

fn load(config_path: &std::path::Path) -> Option<WorkerConfig> {
    match WorkerConfig::load(config_path) {
        Ok(c) => Some(c),
        Err(e) => {
            tracing::error!(error = %e, "config");
            None
        }
    }
}

#[cfg(target_os = "linux")]
fn sandbox_selftest(config_path: PathBuf) -> ExitCode {
    init_tracing();
    let Some(config) = load(&config_path) else {
        return ExitCode::FAILURE;
    };
    match renox_cell::sandbox::selftest(&config) {
        Ok((landlock, syscalls, probes)) => {
            println!(
                "sandbox: landlock fs {}, landlock net {}, seccomp {} syscalls ({:?})",
                landlock.fs.as_str(),
                landlock.net.as_str(),
                syscalls,
                config.sandbox.mode
            );
            for p in &probes {
                let verdict = match (p.must_refuse, p.refused) {
                    (true, true) | (false, false) => "ok",
                    (true, false) => "FAIL",
                    (false, true) => "warn",
                };
                println!("{verdict:<4} {:<60} {}", p.what, p.outcome);
            }
            if renox_cell::sandbox::selftest_failed(&probes) {
                ExitCode::FAILURE
            } else {
                ExitCode::SUCCESS
            }
        }
        Err(e) => {
            eprintln!("{e}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn sandbox_selftest(_config_path: PathBuf) -> ExitCode {
    eprintln!("renox-worker --sandbox-selftest: the sandbox needs Linux");
    ExitCode::FAILURE
}

/// `--child <tenant> --socket <path>` (#254): one paid tenant's own worker,
/// started by the supervisor (`renox_cell::supervisor::child`).
fn child(config_path: PathBuf, tenant: String, socket: PathBuf) -> ExitCode {
    init_tracing();
    let Some(config) = load(&config_path) else {
        return ExitCode::FAILURE;
    };
    if config.sandbox.enabled {
        let exe = std::env::current_exe().ok();
        let profile = renox_cell::supervisor::child::child_profile(
            &config,
            &tenant,
            exe.as_deref().and_then(std::path::Path::parent),
        );
        if let Err(e) = renox_cell::sandbox::restrict_paths_and_ports(&profile) {
            tracing::error!(error = %e, "child start");
            return ExitCode::FAILURE;
        }
    }
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(r) => r,
        Err(e) => {
            tracing::error!(error = %e, "start the async runtime");
            return ExitCode::FAILURE;
        }
    };
    match runtime.block_on(renox_cell::supervisor::child::serve(config, tenant, socket)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            tracing::error!(error = %e, "child");
            ExitCode::FAILURE
        }
    }
}

fn serve(config_path: PathBuf) -> ExitCode {
    init_tracing();
    let Some(config) = load(&config_path) else {
        return ExitCode::FAILURE;
    };
    // #253: Landlock before the runtime's threads exist.
    if config.sandbox.enabled {
        let exe = std::env::current_exe().ok();
        let profile = renox_cell::sandbox::Profile::from_config(
            &config,
            exe.as_deref().and_then(std::path::Path::parent),
        );
        if let Err(e) = renox_cell::sandbox::restrict_paths_and_ports(&profile) {
            tracing::error!(error = %e, "start");
            return ExitCode::FAILURE;
        }
    }
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(r) => r,
        Err(e) => {
            tracing::error!(error = %e, "start the async runtime");
            return ExitCode::FAILURE;
        }
    };
    runtime.block_on(run(config))
}

async fn run(config: WorkerConfig) -> ExitCode {
    let worker = match Worker::start(config).await {
        Ok(w) => w,
        Err(e) => {
            tracing::error!(error = %e, "start");
            return ExitCode::FAILURE;
        }
    };
    let mut hup = match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::hangup()) {
        Ok(s) => s,
        Err(e) => {
            tracing::error!(error = %e, "install the SIGHUP handler");
            return ExitCode::FAILURE;
        }
    };
    loop {
        tokio::select! {
            _ = hup.recv() => {
                if let Err(e) = worker.reload_routes() {
                    tracing::error!(error = %e, "route table reload refused; the previous table stays in use");
                }
            }
            _ = tokio::signal::ctrl_c() => {
                tracing::info!("shutting down");
                worker.shutdown().await;
                return ExitCode::SUCCESS;
            }
        }
    }
}
