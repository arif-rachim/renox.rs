//! `renox-worker --config worker.toml`: one Renox worker node (F1).
//! Structured logs on stderr (`RUST_LOG` filters them); tenant logs and
//! meters go to the directories named in the config. `SIGHUP` re-reads the
//! route table file.
//!
//! `renox-worker transpile`: the template compiler for the CLI (#43). Reads
//! `{ "files": { path: source } }` on stdin and writes the result of
//! `renox_template::transpile::compile_json` to stdout; nothing else runs
//! (no V8, no config).

use std::path::PathBuf;
use std::process::ExitCode;

use renox_cell::{Worker, WorkerConfig};

fn usage() -> ExitCode {
    eprintln!("usage: renox-worker --config <worker.toml> | renox-worker transpile");
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
    if std::env::args().nth(1).as_deref() == Some("transpile") {
        return transpile();
    }
    serve()
}

#[tokio::main]
async fn serve() -> ExitCode {
    tracing_subscriber::fmt()
        .json()
        .with_writer(std::io::stderr)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();
    let mut args = std::env::args().skip(1);
    let config_path = match (args.next().as_deref(), args.next()) {
        (Some("--config"), Some(p)) => PathBuf::from(p),
        _ => return usage(),
    };
    let config = match WorkerConfig::load(&config_path) {
        Ok(c) => c,
        Err(e) => {
            tracing::error!(error = %e, "config");
            return ExitCode::FAILURE;
        }
    };
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
