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
//!
//! `renox-worker check-policies`: V24 and policy test cases for the CLI
//! (#283). Reads `{ "manifest": {..}, "policies": { "<artifact path>":
//! "<text>" }, "cases"?: [{ principal: { type, id, roles?, attrs? },
//! action, resource?, context? }], "explain"?: bool }` on stdin and prints
//! `{ "errors": [{ file, line, column, message }], "results": [{ allow,
//! reason, policies, explanation? }] }`: the engine the cell builds
//! (`renox_cell::authz::engine_for_check`). No V8, no database.
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
        "usage: renox-worker --config <worker.toml> | renox-worker --sandbox-selftest --config <worker.toml> | renox-worker --config <worker.toml> --child <tenant> --socket <path> | renox-worker transpile | renox-worker check-policies | renox-worker migrate <artifact dir> <db file>"
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

fn check_policies() -> ExitCode {
    use std::io::Read;
    #[derive(serde::Deserialize)]
    struct Case {
        principal: CasePrincipal,
        action: String,
        #[serde(default)]
        resource: Option<serde_json::Value>,
        #[serde(default)]
        context: Option<serde_json::Map<String, serde_json::Value>>,
    }
    #[derive(serde::Deserialize)]
    struct CasePrincipal {
        #[serde(rename = "type")]
        ty: String,
        id: String,
        #[serde(default)]
        roles: Vec<String>,
        #[serde(default)]
        attrs: serde_json::Map<String, serde_json::Value>,
    }
    #[derive(serde::Deserialize)]
    struct Input {
        manifest: serde_json::Value,
        #[serde(default)]
        policies: std::collections::BTreeMap<String, String>,
        #[serde(default)]
        cases: Vec<Case>,
        #[serde(default)]
        explain: bool,
        /// Table → column → declared type of the entity tables (#292).
        #[serde(default)]
        columns: std::collections::BTreeMap<String, std::collections::BTreeMap<String, String>>,
    }
    let mut raw = String::new();
    if std::io::stdin().read_to_string(&mut raw).is_err() {
        eprintln!("renox-worker check-policies: stdin is not UTF-8");
        return ExitCode::from(2);
    }
    let input: Input = match serde_json::from_str(&raw) {
        Ok(i) => i,
        Err(e) => {
            eprintln!("renox-worker check-policies: {e}");
            return ExitCode::from(2);
        }
    };
    let policies: Vec<(String, String)> = input.policies.into_iter().collect();
    let engine = match renox_cell::authz::engine_for_check(
        &input.manifest,
        &policies,
        &input.columns,
    ) {
        Ok(e) => e,
        Err(errs) => {
            let errors: Vec<serde_json::Value> = errs
                .iter()
                .map(|e| serde_json::json!({ "file": e.file, "line": e.line, "column": e.column, "message": e.message }))
                .collect();
            println!("{}", serde_json::json!({ "errors": errors, "results": [] }));
            return ExitCode::SUCCESS;
        }
    };
    let platform = renox_authz::PlatformContext::default();
    let results: Vec<serde_json::Value> = input
        .cases
        .iter()
        .map(|c| {
            let mut p = match c.principal.ty.as_str() {
                "System" => renox_authz::Principal::system(&c.principal.id),
                "Anonymous" => renox_authz::Principal::anonymous(),
                _ => renox_authz::Principal::user(&c.principal.id),
            };
            for r in &c.principal.roles {
                p = p.with_role(r, "global", None);
            }
            for (k, v) in &c.principal.attrs {
                p = p.with_attr(k, v.clone());
            }
            let d = engine.check(&p, &c.action, c.resource.as_ref(), None, c.context.as_ref(), &platform);
            let mut out = serde_json::json!({ "allow": d.allow, "reason": d.reason.as_str(), "policies": d.policies });
            if input.explain {
                let x = engine.explain(&p, &c.action, c.resource.as_ref(), None, c.context.as_ref(), &platform);
                out["explanation"] = serde_json::json!({ "decision": x.decision, "reasons": x.reasons, "errors": x.errors, "text": x.text() });
            }
            out
        })
        .collect();
    println!(
        "{}",
        serde_json::json!({ "errors": [], "results": results })
    );
    ExitCode::SUCCESS
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    match args.as_slice() {
        ["transpile"] => transpile(),
        ["check-policies"] => check_policies(),
        ["migrate", artifact, db_file] => migrate(artifact, db_file),
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

type OtelLayer = tracing_opentelemetry::OpenTelemetryLayer<
    tracing_subscriber::Registry,
    opentelemetry_sdk::trace::SdkTracer,
>;

/// Installs the OpenTelemetry layer once `[telemetry]` is read (#295).
static OTEL: std::sync::OnceLock<
    tracing_subscriber::reload::Handle<Option<OtelLayer>, tracing_subscriber::Registry>,
> = std::sync::OnceLock::new();

/// JSON lines on stderr with the current span and the span list, so a line
/// inside a request names its `trace_id` and `request_id` (#295); the
/// OpenTelemetry layer is a no-op until [`start_telemetry`] fills it.
fn init_tracing() {
    use tracing_subscriber::layer::SubscriberExt;
    use tracing_subscriber::util::SubscriberInitExt;
    let (otel, handle) = tracing_subscriber::reload::Layer::new(None::<OtelLayer>);
    let _ = OTEL.set(handle);
    let _ = tracing_subscriber::registry()
        .with(otel)
        .with(
            tracing_subscriber::fmt::layer()
                .json()
                .with_current_span(true)
                .with_span_list(true)
                .with_writer(std::io::stderr),
        )
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .try_init();
}

/// `[telemetry] otlp_endpoint`: export spans over OTLP/HTTP (#295). Runs
/// inside the runtime (the exporter uses it). The provider is returned so
/// the caller flushes it at shutdown.
fn start_telemetry(
    config: &WorkerConfig,
) -> Result<Option<opentelemetry_sdk::trace::SdkTracerProvider>, String> {
    let Some(provider) = renox_cell::telemetry::otlp_provider(&config.telemetry)? else {
        return Ok(None);
    };
    if let Some(h) = OTEL.get() {
        h.reload(Some(renox_cell::telemetry::layer(&provider)))
            .map_err(|e| e.to_string())?;
    }
    tracing::info!(
        sample_ratio = config.telemetry.sample_ratio,
        service_name = %config.telemetry.service_name,
        "traces exported over OTLP/HTTP"
    );
    Ok(Some(provider))
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
    let provider = match start_telemetry(&config) {
        Ok(p) => p,
        Err(e) => {
            tracing::error!(error = %e, "start");
            return ExitCode::FAILURE;
        }
    };
    let _flush = FlushOnDrop(provider);
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

/// Flushes the exported spans when the worker stops.
struct FlushOnDrop(Option<opentelemetry_sdk::trace::SdkTracerProvider>);

impl Drop for FlushOnDrop {
    fn drop(&mut self) {
        if let Some(p) = self.0.take() {
            let _ = p.shutdown();
        }
    }
}
