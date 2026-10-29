//! Litestream per tenant file (#255, `docs/06-data.md` "Replication and
//! backup tiers"): every write to a tenant file is streamed to its replica
//! within the sync interval, and an idle tenant costs nothing.
//!
//! Per database a small state machine:
//!
//! ```text
//! off ──(first write)──► starting ──(sidecar runs)──► replicating
//!  ▲                                                      │
//!  └──────────── stopped ◄──(evicted + stop_grace)────────┘
//! ```
//!
//! - **First write.** When a tenant's file is opened ([`DbLifecycle`]) the
//!   watcher starts noting its WAL; the first time the WAL holds frames
//!   (or the file changes) the sidecar starts: `litestream replicate
//!   -config <run_dir>/litestream/<database>.yml` ([`litestream`]), its
//!   output logged with the database id, restarted with a backoff if it
//!   exits.
//! - **Eviction.** When the last cell closes the file, the sidecar keeps
//!   running for `stop_grace_ms` so the last frames ship, then stops.
//! - **Restore before open.** A missing file whose replica exists is
//!   restored before the cell opens it ([`restore`]). A node in
//!   `controlled` mode never opens a missing file before that restore
//!   answered.
//! - **A damaged file** (#103): one that fails the time-bounded
//!   `PRAGMA quick_check` on open, or that the idle-file sweep finds
//!   (`crate::pruning`), is marked unavailable, moved aside as
//!   `<file>.corrupt-<ts>` (never deleted) and restored in the background
//!   ([`Replication::recover_corrupt`]). While the mark holds, the node
//!   answers 503 `RENOX_DB_UNAVAILABLE` for the tenant
//!   ([`Replication::unavailable`]); the first request after the restore
//!   opens the restored file.
//! - **Status** ([`status`]) for the node listener and `getBackups`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use serde_json::{Value, json};

use crate::config::{Mode, ReplicaKind, ReplicationSection};
use crate::manager::DbLifecycle;

pub mod litestream;
pub mod restore;
pub mod status;

/// The sidecar state of one database.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    Off,
    Starting,
    Replicating,
    Stopped,
}

impl State {
    pub fn as_str(self) -> &'static str {
        match self {
            State::Off => "off",
            State::Starting => "starting",
            State::Replicating => "replicating",
            State::Stopped => "stopped",
        }
    }
}

struct Db {
    database: String,
    file: PathBuf,
    state: State,
    /// The file is open by a cell.
    open: bool,
    /// `(size, mtime)` of the WAL and the file when it was opened.
    baseline: (u64, Option<SystemTime>, Option<SystemTime>),
    pid: Option<u32>,
    /// Set by `closed`; the stop happens at this time.
    stop_at: Option<Instant>,
    /// The sidecar exited on its own this many times in a row.
    crashes: u32,
    next_start: Instant,
    running: Arc<AtomicBool>,
}

/// The node's replication. Cheap to clone.
#[derive(Clone)]
pub struct Replication {
    inner: Arc<Inner>,
}

struct Inner {
    section: ReplicationSection,
    mode: Mode,
    node_id: String,
    data_dir: PathBuf,
    run_dir: PathBuf,
    dbs: Mutex<HashMap<String, Db>>,
    /// Sidecars started since start (tests, operator).
    spawned: std::sync::atomic::AtomicU64,
    /// Databases being restored after damage (#103): never opened.
    unavailable: Mutex<HashMap<String, &'static str>>,
    /// Restores of damaged files completed since start (tests, operator).
    recovered: std::sync::atomic::AtomicU64,
    handle: tokio::runtime::Handle,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn wal_of(file: &Path) -> PathBuf {
    PathBuf::from(format!("{}-wal", file.display()))
}

fn signature(file: &Path) -> (u64, Option<SystemTime>, Option<SystemTime>) {
    let wal = std::fs::metadata(wal_of(file)).ok();
    (
        wal.as_ref().map_or(0, |m| m.len()),
        wal.and_then(|m| m.modified().ok()),
        std::fs::metadata(file).ok().and_then(|m| m.modified().ok()),
    )
}

impl Replication {
    /// Starts the watcher on the current runtime. `run_dir` holds the
    /// sidecar configs.
    pub fn start(
        section: ReplicationSection,
        mode: Mode,
        node_id: &str,
        data_dir: &Path,
        run_dir: &Path,
    ) -> Replication {
        if !litestream::available(&section.litestream_bin) {
            tracing::error!(bin = %section.litestream_bin.display(), "replication is on but litestream does not run; tenant files are NOT replicated");
        }
        let r = Replication {
            inner: Arc::new(Inner {
                section,
                mode,
                node_id: node_id.to_string(),
                data_dir: data_dir.to_path_buf(),
                run_dir: run_dir.to_path_buf(),
                dbs: Mutex::new(HashMap::new()),
                spawned: Default::default(),
                unavailable: Mutex::new(HashMap::new()),
                recovered: Default::default(),
                handle: tokio::runtime::Handle::current(),
            }),
        };
        r.spawn_watcher();
        r
    }

    pub fn section(&self) -> &ReplicationSection {
        &self.inner.section
    }

    pub fn node_id(&self) -> &str {
        &self.inner.node_id
    }

    /// The file of a database id (`<tenant_id>` or `<tenant_id>.<app>`).
    pub fn file_of(&self, database: &str) -> PathBuf {
        self.inner.data_dir.join(database).join("app.db")
    }

    /// The sidecar state of `database`.
    pub fn state(&self, database: &str) -> State {
        self.inner
            .dbs
            .lock()
            .expect("dbs lock")
            .get(database)
            .map_or(State::Off, |d| d.state)
    }

    /// Sidecars started since start.
    pub fn sidecars_started(&self) -> u64 {
        self.inner.spawned.load(Ordering::SeqCst)
    }

    /// The config file of `source`'s database, written when missing.
    pub fn config_for(&self, database: &str) -> std::io::Result<PathBuf> {
        litestream::write_config(
            &self.inner.run_dir,
            &self.inner.section,
            &self.file_of(database),
            database,
        )
    }

    /// Restores `database` (from `source`'s replica when given) as of
    /// `timestamp`. Blocking: runs `litestream`.
    pub fn restore_blocking(
        &self,
        database: &str,
        source: Option<&str>,
        timestamp: Option<u64>,
    ) -> Result<restore::Restored, restore::RestoreError> {
        let source = source.unwrap_or(database);
        let config = self
            .config_for(source)
            .map_err(|e| restore::RestoreError::Unavailable(format!("config: {e}")))?;
        restore::restore(
            &self.inner.section,
            &config,
            &self.file_of(source),
            &self.file_of(database),
            timestamp,
            now_ms(),
        )
    }

    /// Why `tenant_id` cannot be served now (`restoring`), when one of its
    /// databases (`<tenant_id>` or `<tenant_id>.<app>`) is being restored
    /// after damage (`errors.md` `RENOX_DB_UNAVAILABLE`).
    pub fn unavailable(&self, tenant_id: &str) -> Option<&'static str> {
        let marks = self.inner.unavailable.lock().expect("unavailable lock");
        marks.iter().find_map(|(db, why)| {
            (db == tenant_id
                || db
                    .strip_prefix(tenant_id)
                    .is_some_and(|rest| rest.starts_with('.')))
            .then_some(*why)
        })
    }

    /// Restores of damaged files completed since start.
    pub fn recovered(&self) -> u64 {
        self.inner.recovered.load(Ordering::SeqCst)
    }

    /// A damaged `database` (#103): marked unavailable, its file moved
    /// aside, and restored from the replica on a thread of its own, retried
    /// with a backoff until it succeeds. The mark is cleared when the
    /// restored file passed its check. A second call while the restore runs
    /// does nothing.
    pub fn recover_corrupt(&self, database: &str) {
        {
            let mut marks = self.inner.unavailable.lock().expect("unavailable lock");
            if marks.contains_key(database) {
                return;
            }
            marks.insert(database.to_string(), "restoring");
        }
        let file = self.file_of(database);
        match restore::quarantine(&file, now_ms()) {
            Ok(to) => {
                tracing::error!(%database, quarantined = %to.display(), "damaged tenant file moved aside; restoring from the replica")
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                tracing::error!(%database, error = %e, "damaged tenant file could not be moved aside; it stays unavailable");
                return;
            }
        }
        let me = self.clone();
        let database = database.to_string();
        std::thread::spawn(move || {
            let mut attempt: u32 = 0;
            loop {
                match me.restore_blocking(&database, None, None) {
                    Ok(r) => {
                        me.inner
                            .unavailable
                            .lock()
                            .expect("unavailable lock")
                            .remove(&database);
                        me.inner.recovered.fetch_add(1, Ordering::SeqCst);
                        tracing::warn!(%database, generation = ?r.generation, elapsed_ms = r.elapsed_ms, "damaged tenant file restored");
                        return;
                    }
                    Err(e) => {
                        attempt += 1;
                        if attempt == 1 || attempt.is_power_of_two() {
                            tracing::error!(%database, attempt, error = %e, "restore of a damaged tenant file failed; retrying");
                        }
                        std::thread::sleep(Duration::from_millis(
                            (500u64 << attempt.min(7)).min(60_000),
                        ));
                    }
                }
            }
        });
    }

    fn spawn_watcher(&self) {
        let me = self.clone();
        let tick = Duration::from_millis(self.inner.section.sync_interval_ms.clamp(50, 1_000));
        self.inner.handle.spawn(async move {
            loop {
                tokio::time::sleep(tick).await;
                me.tick();
            }
        });
    }

    /// One round: start sidecars of written files, stop those past their
    /// grace, restart crashed ones.
    fn tick(&self) {
        let mut to_start = Vec::new();
        let mut to_stop = Vec::new();
        {
            let mut dbs = self.inner.dbs.lock().expect("dbs lock");
            let now = Instant::now();
            for db in dbs.values_mut() {
                let running = db.running.load(Ordering::SeqCst);
                if db.state == State::Replicating && !running && db.stop_at.is_none() {
                    // Exited on its own: restart after a backoff.
                    db.crashes += 1;
                    db.state = State::Starting;
                    db.next_start = now + Duration::from_millis(500u64 << db.crashes.min(6));
                    tracing::error!(database = %db.database, crashes = db.crashes, "litestream exited; restarting");
                }
                match db.stop_at {
                    Some(at) if now >= at => {
                        if running {
                            to_stop.push((db.database.clone(), db.pid));
                        }
                        db.state = State::Stopped;
                        db.stop_at = None;
                    }
                    Some(_) => {}
                    None => {
                        let written =
                            db.open && db.state == State::Off && signature(&db.file) != db.baseline;
                        let restart = db.open
                            && db.state == State::Starting
                            && !running
                            && now >= db.next_start;
                        if written || restart {
                            db.state = State::Starting;
                            to_start.push(db.database.clone());
                        }
                    }
                }
            }
        }
        for (database, pid) in to_stop {
            if let Some(pid) = pid {
                let _ = std::process::Command::new("kill")
                    .args(["-TERM", &pid.to_string()])
                    .status();
            }
            tracing::info!(%database, "litestream stopped after eviction");
        }
        for database in to_start {
            self.spawn_sidecar(&database);
        }
    }

    fn spawn_sidecar(&self, database: &str) {
        let file = self.file_of(database);
        let config = match litestream::write_config(
            &self.inner.run_dir,
            &self.inner.section,
            &file,
            database,
        ) {
            Ok(c) => c,
            Err(e) => {
                tracing::error!(database, error = %e, "litestream config not written");
                return;
            }
        };
        let mut cmd = tokio::process::Command::new(&self.inner.section.litestream_bin);
        cmd.arg("replicate")
            .arg("-config")
            .arg(&config)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                let mut dbs = self.inner.dbs.lock().expect("dbs lock");
                if let Some(db) = dbs.get_mut(database) {
                    db.crashes += 1;
                    db.next_start =
                        Instant::now() + Duration::from_millis(500u64 << db.crashes.min(6));
                    if db.crashes == 1 || db.crashes.is_power_of_two() {
                        tracing::error!(database, error = %e, attempts = db.crashes, "litestream did not start");
                    }
                }
                return;
            }
        };
        self.inner.spawned.fetch_add(1, Ordering::SeqCst);
        let running = Arc::new(AtomicBool::new(true));
        let pid = child.id();
        {
            let mut dbs = self.inner.dbs.lock().expect("dbs lock");
            if let Some(db) = dbs.get_mut(database) {
                db.pid = pid;
                db.running = running.clone();
                db.state = State::Replicating;
            }
        }
        tracing::info!(database, pid, replica = %litestream::replica_location(&self.inner.section, database), "litestream replicating");
        for stream in [
            child
                .stdout
                .take()
                .map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Send + Unpin>),
            child.stderr.take().map(|s| Box::new(s) as _),
        ]
        .into_iter()
        .flatten()
        {
            let database = database.to_string();
            tokio::spawn(async move {
                use tokio::io::AsyncBufReadExt;
                let mut lines = tokio::io::BufReader::new(stream).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    tracing::info!(%database, line = %line, "litestream");
                }
            });
        }
        let db_id = database.to_string();
        tokio::spawn(async move {
            // The exit status names the cause: a signal 31 (SIGSYS) is the
            // seccomp filter, a code is Litestream's own error.
            match child.wait().await {
                Ok(status) => tracing::warn!(database = %db_id, %status, "litestream exited"),
                Err(e) => tracing::warn!(database = %db_id, error = %e, "litestream wait failed"),
            }
            running.store(false, Ordering::SeqCst);
        });
    }

    /// The `replication_status` of `database` (`control-messages.schema.json`).
    pub fn status(&self, tenant_id: &str, database: &str) -> Value {
        status::status(self, tenant_id, database)
    }

    fn replica_json(&self) -> Value {
        match self.inner.section.replica {
            ReplicaKind::File => json!({ "kind": "file" }),
            ReplicaKind::S3 => match &self.inner.section.region {
                Some(r) => json!({ "kind": "s3", "region": r }),
                None => json!({ "kind": "s3" }),
            },
        }
    }
}

impl DbLifecycle for Replication {
    fn before_open(&self, tenant_id: &str, file: &Path) -> Result<(), String> {
        let database = file
            .parent()
            .and_then(Path::file_name)
            .and_then(|n| n.to_str())
            .unwrap_or(tenant_id)
            .to_string();
        if let Some(why) = self.unavailable(&database) {
            return Err(format!("unavailable: {why}"));
        }
        let missing = !file.exists();
        if !missing {
            return match renox_data::integrity::check_file(
                file,
                renox_data::integrity::QUICK_CHECK_LIMIT,
            ) {
                renox_data::integrity::Integrity::Corrupt(why) => {
                    tracing::error!(%database, finding = %why, "tenant file failed quick_check on open");
                    self.recover_corrupt(&database);
                    Err(format!("integrity: {why}"))
                }
                _ => Ok(()),
            };
        }
        match self.restore_blocking(&database, None, None) {
            Ok(r) => {
                tracing::info!(%database, source = r.source, generation = ?r.generation, elapsed_ms = r.elapsed_ms, "tenant file restored before open");
                Ok(())
            }
            Err(restore::RestoreError::Unavailable(why)) if why.contains("no generation") => {
                // A new tenant: nothing to restore.
                Ok(())
            }
            Err(e) if self.inner.mode == Mode::Local => {
                tracing::warn!(%database, error = %e, "no restore; the file starts empty (local mode)");
                Ok(())
            }
            Err(e) => {
                tracing::error!(%database, error = %e, "restore before open failed; the file is not opened");
                Err(format!("restoring: {e}"))
            }
        }
    }

    fn opened(&self, tenant_id: &str, file: &Path) {
        let database = file
            .parent()
            .and_then(Path::file_name)
            .and_then(|n| n.to_str())
            .unwrap_or(tenant_id)
            .to_string();
        let mut dbs = self.inner.dbs.lock().expect("dbs lock");
        let db = dbs.entry(database.clone()).or_insert_with(|| Db {
            database,
            file: file.to_path_buf(),
            state: State::Off,
            open: false,
            baseline: (0, None, None),
            pid: None,
            stop_at: None,
            crashes: 0,
            next_start: Instant::now(),
            running: Arc::new(AtomicBool::new(false)),
        });
        db.open = true;
        db.stop_at = None;
        if !db.running.load(Ordering::SeqCst) {
            db.state = State::Off;
            db.baseline = signature(file);
        } else {
            db.state = State::Replicating;
        }
    }

    fn closed(&self, tenant_id: &str) {
        let mut dbs = self.inner.dbs.lock().expect("dbs lock");
        if let Some(db) = dbs.get_mut(tenant_id) {
            db.open = false;
            if db.running.load(Ordering::SeqCst) || db.state == State::Starting {
                db.stop_at =
                    Some(Instant::now() + Duration::from_millis(self.inner.section.stop_grace_ms));
            } else {
                db.state = State::Off;
            }
        }
    }
}
