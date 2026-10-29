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
//! `renox-worker migrate <artifact dir> <db file>`: the artifact's migration
//! plan against a local tenant file for `renox migrate` (#235): each
//! installed module in the manifest's order under its own prefix, then the
//! app's (`renox_data::migrate_all`), every file checked against
//! `migrations/checksums.json`. Prints one JSON object on stdout: `{ "ok":
//! true, "modules": [{ "module", "applied", "skipped" }] }` or `{ "ok":
//! false, "module", "error", "modules" }` (exit 2). No V8.

use std::path::PathBuf;
use std::process::ExitCode;

use renox_cell::{Worker, WorkerConfig};

fn usage() -> ExitCode {
    eprintln!(
        "usage: renox-worker --config <worker.toml> | renox-worker transpile | renox-worker migrate <artifact dir> <db file>"
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

/// The `.sql` files of one module's migration folder, by name.
fn migration_files(dir: &std::path::Path) -> std::io::Result<Vec<renox_data::MigrationFile>> {
    let mut files = Vec::new();
    if dir.is_dir() {
        for entry in std::fs::read_dir(dir)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.ends_with(".sql") {
                let sql = std::fs::read_to_string(entry.path())?;
                files.push(renox_data::MigrationFile { name, sql });
            }
        }
    }
    files.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(files)
}

fn migrate(artifact: &str, db_file: &str) -> ExitCode {
    let fail = |msg: String| {
        println!(
            "{}",
            serde_json::json!({ "ok": false, "error": msg, "modules": [] })
        );
        ExitCode::from(2)
    };
    let dir = std::path::Path::new(artifact);
    let manifest: serde_json::Value = match std::fs::read(dir.join("manifest.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
    {
        Some(m) => m,
        None => return fail("manifest.json cannot be read".into()),
    };
    let mut plan = Vec::new();
    let mut names = Vec::new();
    for m in manifest["modules"].as_array().into_iter().flatten() {
        let Some(name) = m["name"].as_str() else {
            return fail("a modules entry has no name".into());
        };
        let dependencies = m["dependencies"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|d| d.as_str().map(str::to_string))
            .collect();
        let files = match migration_files(&dir.join("migrations").join(name)) {
            Ok(f) => f,
            Err(e) => return fail(format!("migrations/{name}: {e}")),
        };
        names.push(name.to_string());
        plan.push(renox_data::ModuleMigrations {
            module: name.to_string(),
            dependencies,
            files,
        });
    }
    let files = match migration_files(&dir.join("migrations").join("app")) {
        Ok(f) => f,
        Err(e) => return fail(format!("migrations/app: {e}")),
    };
    plan.push(renox_data::ModuleMigrations {
        module: "app".into(),
        dependencies: names,
        files,
    });
    let checksums: Option<std::collections::BTreeMap<String, String>> =
        std::fs::read(dir.join("migrations/checksums.json"))
            .ok()
            .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
            .and_then(|v| serde_json::from_value(v["files"].clone()).ok());
    if plan.iter().any(|m| !m.files.is_empty()) && checksums.is_none() {
        return fail("migrations/checksums.json is missing or invalid".into());
    }
    if let Some(parent) = std::path::Path::new(db_file).parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let db = match renox_data::TenantDb::open(db_file, renox_data::DbOptions::default()) {
        Ok(d) => d,
        Err(e) => return fail(format!("open {db_file}: {e}")),
    };
    let report = |r: &renox_data::PlanReport| -> Vec<serde_json::Value> {
        r.modules
            .iter()
            .map(|(m, r)| serde_json::json!({ "module": m, "applied": r.applied, "skipped": r.skipped }))
            .collect()
    };
    let result = renox_data::migrate_all(&db, &plan, checksums.as_ref());
    let _ = db.close();
    match result {
        Ok(r) => {
            println!(
                "{}",
                serde_json::json!({ "ok": true, "modules": report(&r) })
            );
            ExitCode::SUCCESS
        }
        Err(e) => {
            println!(
                "{}",
                serde_json::json!({ "ok": false, "module": e.module, "error": e.error.to_string(), "modules": report(&e.done) })
            );
            ExitCode::from(2)
        }
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("transpile") => return transpile(),
        Some("migrate") => {
            return match (args.get(2), args.get(3), args.len()) {
                (Some(a), Some(d), 4) => migrate(a, d),
                _ => usage(),
            };
        }
        _ => {}
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
