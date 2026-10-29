//! Process tiers (#254, `docs/04-isolation-security.md` "Isolation
//! hierarchy"): the free tier shares this process; a tenant whose route
//! entry says `process = "own"` (the paid tier) runs in a child
//! `renox-worker --child <tenant>` of its own, with its own cells,
//! database handle, sandbox (#253) and cgroup, so a V8 escape in that
//! tenant reaches nothing but that tenant's files.
//!
//! ```text
//! gateway ──► Supervisor ──► shared CellManager (process = "shared")
//!                 │
//!                 └──► <run_dir>/children/<tenant>.sock ──► child (process = "own")
//! ```
//!
//! The [`Supervisor`] is the gateway's dispatcher. For a tenant placed in
//! a child it starts the child on the first request, hands it the
//! deployment's metadata and secrets ([`ipc`], `prepare`) before the first
//! request of each deployment, and forwards the request over the child's
//! socket. A child that exits is started again on the next request, after
//! an exponential backoff; one without a request for `child_idle_secs` is
//! stopped. Route syncs ([`CellManager::set_sync_observer`]) drain a child
//! whose tenant lost its active entry or moved back to `shared`, and drain
//! the shared process's cells of a tenant that moved to `own`.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::body::Body;
use http::{Request, Response, StatusCode};
use renox_gateway::{CellDispatcher, RequestCtx, RouteEntry, RouteStatus};
use serde::{Deserialize, Serialize};

use crate::cell::SecretsRequest;
use crate::config::{Launcher, ProcessSection};
use crate::manager::CellManager;
use crate::tiers::TierName;

pub mod cgroup;
pub mod child;
pub mod ipc;

/// Where a tenant's cells run (route entry `process`, `deploy-api.md` 0.3).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProcessKind {
    #[default]
    Shared,
    Own,
}

impl ProcessKind {
    pub fn is_shared(&self) -> bool {
        *self == ProcessKind::Shared
    }
}

/// The placement of a tenant: the route entries in controlled mode
/// (`RouteState`), `[process] own_tenants` in local mode.
pub trait ProcessLookup: Send + Sync + 'static {
    fn process(&self, tenant_id: &str) -> ProcessKind;
}

/// Local mode: `[process] own_tenants`.
pub struct StaticProcesses(pub HashSet<String>);

impl ProcessLookup for StaticProcesses {
    fn process(&self, tenant_id: &str) -> ProcessKind {
        if self.0.contains(tenant_id) {
            ProcessKind::Own
        } else {
            ProcessKind::Shared
        }
    }
}

/// What the supervisor hands a child before the first request of a
/// deployment (`x-renox-ipc-kind: prepare`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Prepare {
    pub tenant_id: String,
    pub deployment_hash: String,
    /// `free` or `paid`.
    pub tier: String,
    pub app: Option<String>,
    pub secrets_version: u64,
    /// Name → value; in memory only, never logged.
    pub secrets: BTreeMap<String, String>,
}

/// The longest a crashed child waits before it is started again.
pub const MAX_BACKOFF: Duration = Duration::from_secs(30);
/// A child that lived this long resets its backoff.
pub const STABLE_AFTER: Duration = Duration::from_secs(60);
/// A new child has this long to accept on its socket.
pub const START_TIMEOUT: Duration = Duration::from_secs(30);

/// The wait before restart number `restarts` (1 = after the first crash).
pub fn backoff(base: Duration, restarts: u32) -> Duration {
    if restarts == 0 {
        return Duration::ZERO;
    }
    base.saturating_mul(1u32 << (restarts - 1).min(16))
        .min(MAX_BACKOFF)
}

struct ChildState {
    pid: Option<u32>,
    running: Arc<AtomicBool>,
    restarts: u32,
    next_start: Instant,
    started_at: Instant,
    cgroup: Option<PathBuf>,
}

struct ChildSlot {
    tenant: String,
    socket: PathBuf,
    state: tokio::sync::Mutex<ChildState>,
    last_used: Mutex<Instant>,
    /// `(deployment_hash, secrets_version)` handed to the running child.
    prepared: Mutex<HashSet<(String, u64)>>,
    draining: AtomicBool,
}

/// A child as the operator (and the tests) see it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChildInfo {
    pub tenant: String,
    pub pid: Option<u32>,
    pub socket: PathBuf,
    pub restarts: u32,
    pub cgroup: Option<PathBuf>,
}

struct Inner<D> {
    shared: Arc<D>,
    manager: CellManager,
    lookup: Arc<dyn ProcessLookup>,
    section: ProcessSection,
    config_path: PathBuf,
    worker_bin: PathBuf,
    sock_dir: PathBuf,
    cgroup: Option<cgroup::CgroupTree>,
    children: Mutex<HashMap<String, Arc<ChildSlot>>>,
    handle: tokio::runtime::Handle,
}

/// The gateway's dispatcher with process tiers. Cheap to clone.
pub struct Supervisor<D> {
    inner: Arc<Inner<D>>,
}

impl<D> Clone for Supervisor<D> {
    fn clone(&self) -> Self {
        Supervisor {
            inner: self.inner.clone(),
        }
    }
}

/// Why the supervisor did not start.
#[derive(Debug)]
pub struct SupervisorError(pub String);

impl std::fmt::Display for SupervisorError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "process tiers: {}", self.0)
    }
}

impl<D: CellDispatcher> Supervisor<D> {
    /// `shared` serves the shared process's tenants; `manager` is its cell
    /// manager (deployment metadata, secrets and artifacts for children,
    /// route syncs). `require_cgroup`: a controlled node without
    /// `[sandbox] allow_unsandboxed` refuses a tree it cannot write.
    pub fn start(
        shared: Arc<D>,
        manager: CellManager,
        lookup: Arc<dyn ProcessLookup>,
        section: ProcessSection,
        config_path: PathBuf,
        require_cgroup: bool,
    ) -> Result<Supervisor<D>, SupervisorError> {
        let worker_bin = match &section.worker_bin {
            Some(p) => p.clone(),
            None => {
                std::env::current_exe().map_err(|e| SupervisorError(format!("own binary: {e}")))?
            }
        };
        let sock_dir = section.run_dir.join("children");
        std::fs::create_dir_all(&sock_dir)
            .map_err(|e| SupervisorError(format!("{}: {e}", sock_dir.display())))?;
        set_mode(&sock_dir, 0o700);
        let cgroup = match section.launcher {
            Launcher::Systemd => None,
            Launcher::Direct => match cgroup::CgroupTree::open(section.cgroup_root.as_deref()) {
                Ok(t) => {
                    tracing::info!(root = %t.root.display(), "process tiers: child cgroups under the delegated tree");
                    Some(t)
                }
                Err(why) if require_cgroup => {
                    return Err(SupervisorError(format!(
                        "{why}; a controlled node needs a writable cgroup tree for its children (Delegate=yes) or [sandbox] allow_unsandboxed = true"
                    )));
                }
                Err(why) => {
                    tracing::warn!(reason = %why, "process tiers: the cgroup tree is not writable; children run without cgroup limits");
                    None
                }
            },
        };
        let s = Supervisor {
            inner: Arc::new(Inner {
                shared,
                manager: manager.clone(),
                lookup,
                section,
                config_path,
                worker_bin,
                sock_dir,
                cgroup,
                children: Mutex::new(HashMap::new()),
                handle: tokio::runtime::Handle::current(),
            }),
        };
        let observer = s.clone();
        manager.set_sync_observer(Arc::new(move |entries| observer.sync(entries)));
        s.spawn_idle_reaper();
        Ok(s)
    }

    /// The children that exist now.
    pub fn children(&self) -> Vec<ChildInfo> {
        let slots: Vec<Arc<ChildSlot>> = self
            .inner
            .children
            .lock()
            .expect("children lock")
            .values()
            .cloned()
            .collect();
        let mut out: Vec<ChildInfo> = slots
            .iter()
            .filter_map(|slot| {
                let st = slot.state.try_lock().ok()?;
                Some(ChildInfo {
                    tenant: slot.tenant.clone(),
                    pid: st.pid.filter(|_| st.running.load(Ordering::SeqCst)),
                    socket: slot.socket.clone(),
                    restarts: st.restarts,
                    cgroup: st.cgroup.clone(),
                })
            })
            .collect();
        out.sort_by(|a, b| a.tenant.cmp(&b.tenant));
        out
    }

    /// The running child of `tenant`, if any.
    pub fn child(&self, tenant: &str) -> Option<ChildInfo> {
        self.children()
            .into_iter()
            .find(|c| c.tenant == tenant && c.pid.is_some())
    }

    fn slot(&self, tenant: &str) -> Option<Arc<ChildSlot>> {
        let mut children = self.inner.children.lock().expect("children lock");
        if let Some(s) = children.get(tenant) {
            return Some(s.clone());
        }
        if children.len() >= self.inner.section.max_children {
            return None;
        }
        let slot = Arc::new(ChildSlot {
            tenant: tenant.to_string(),
            socket: self.inner.sock_dir.join(format!("{tenant}.sock")),
            state: tokio::sync::Mutex::new(ChildState {
                pid: None,
                running: Arc::new(AtomicBool::new(false)),
                restarts: 0,
                next_start: Instant::now(),
                started_at: Instant::now(),
                cgroup: None,
            }),
            last_used: Mutex::new(Instant::now()),
            prepared: Mutex::new(HashSet::new()),
            draining: AtomicBool::new(false),
        });
        children.insert(tenant.to_string(), slot.clone());
        Some(slot)
    }

    /// Starts the child of `slot` unless it runs; waits for a pending
    /// backoff first (within `deadline`).
    async fn ensure_running(&self, slot: &Arc<ChildSlot>, deadline: Instant) -> Result<(), String> {
        let mut st = slot.state.lock().await;
        if st.running.load(Ordering::SeqCst) {
            return Ok(());
        }
        let now = Instant::now();
        if st.next_start > now {
            if st.next_start > deadline {
                return Err("the child is in its restart backoff".into());
            }
            tokio::time::sleep_until(st.next_start.into()).await;
        }
        slot.prepared.lock().expect("prepared lock").clear();
        let _ = std::fs::remove_file(&slot.socket);
        let running = Arc::new(AtomicBool::new(true));
        let pid = match self.inner.section.launcher {
            Launcher::Direct => self.spawn_direct(slot, running.clone())?,
            Launcher::Systemd => self.spawn_systemd(slot, running.clone()).await?,
        };
        st.pid = Some(pid);
        st.running = running.clone();
        st.started_at = Instant::now();
        st.cgroup = None;
        if let Some(tree) = &self.inner.cgroup {
            let s = &self.inner.section;
            let limits = cgroup::Limits {
                cpu_quota_us: s.child_cpu_quota_us,
                memory_bytes: s.child_memory_bytes,
                pids: s.child_pids,
            };
            match tree.place(&slot.tenant, pid, limits) {
                Ok(dir) => st.cgroup = Some(dir),
                Err(e) => {
                    tracing::warn!(tenant_id = %slot.tenant, error = %e, "child cgroup not applied")
                }
            }
        }
        // Wait until it accepts on its socket, or exits.
        let started = Instant::now();
        loop {
            if tokio::net::UnixStream::connect(&slot.socket).await.is_ok() {
                break;
            }
            if !running.load(Ordering::SeqCst) {
                return Err("the child exited during start".into());
            }
            if started.elapsed() > START_TIMEOUT {
                return Err("the child did not open its socket in time".into());
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        tracing::info!(tenant_id = %slot.tenant, pid, restarts = st.restarts, "child started");
        Ok(())
    }

    fn spawn_direct(&self, slot: &Arc<ChildSlot>, running: Arc<AtomicBool>) -> Result<u32, String> {
        let mut cmd = tokio::process::Command::new(&self.inner.worker_bin);
        cmd.arg("--config")
            .arg(&self.inner.config_path)
            .arg("--child")
            .arg(&slot.tenant)
            .arg("--socket")
            .arg(&slot.socket)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .kill_on_drop(false);
        let mut child = cmd.spawn().map_err(|e| format!("spawn the child: {e}"))?;
        let pid = child.id().ok_or("the child has no pid")?;
        let watcher = self.clone();
        let slot = slot.clone();
        tokio::spawn(async move {
            let status = child.wait().await;
            running.store(false, Ordering::SeqCst);
            watcher
                .exited(
                    &slot,
                    pid,
                    status
                        .map(|s| s.to_string())
                        .unwrap_or_else(|e| e.to_string()),
                )
                .await;
        });
        Ok(pid)
    }

    async fn spawn_systemd(
        &self,
        slot: &Arc<ChildSlot>,
        running: Arc<AtomicBool>,
    ) -> Result<u32, String> {
        let unit = format!("renox-child@{}.service", slot.tenant);
        let ok = tokio::process::Command::new("systemctl")
            .args(["start", &unit])
            .status()
            .await
            .map_err(|e| format!("systemctl start {unit}: {e}"))?
            .success();
        if !ok {
            return Err(format!("systemctl start {unit} failed"));
        }
        let out = tokio::process::Command::new("systemctl")
            .args(["show", "-p", "MainPID", "--value", &unit])
            .output()
            .await
            .map_err(|e| format!("systemctl show {unit}: {e}"))?;
        let pid: u32 = String::from_utf8_lossy(&out.stdout)
            .trim()
            .parse()
            .unwrap_or(0);
        let watcher = self.clone();
        let slot = slot.clone();
        tokio::spawn(async move {
            // systemd owns the process: poll whether it still runs.
            loop {
                tokio::time::sleep(Duration::from_millis(500)).await;
                if pid == 0 || !Path::new(&format!("/proc/{pid}")).exists() {
                    break;
                }
            }
            running.store(false, Ordering::SeqCst);
            watcher.exited(&slot, pid, "exited (systemd)".into()).await;
        });
        Ok(pid)
    }

    /// The child of `slot` exited: schedule the backoff, or forget the
    /// slot if it was being drained.
    async fn exited(&self, slot: &Arc<ChildSlot>, pid: u32, status: String) {
        let _ = std::fs::remove_file(&slot.socket);
        if let Some(tree) = &self.inner.cgroup {
            tree.remove(&slot.tenant);
        }
        if slot.draining.load(Ordering::SeqCst) {
            tracing::info!(tenant_id = %slot.tenant, pid, %status, "child stopped");
            let mut children = self.inner.children.lock().expect("children lock");
            if children
                .get(&slot.tenant)
                .is_some_and(|s| Arc::ptr_eq(s, slot))
            {
                children.remove(&slot.tenant);
            }
            return;
        }
        let mut st = slot.state.lock().await;
        st.restarts = if st.started_at.elapsed() >= STABLE_AFTER {
            1
        } else {
            st.restarts + 1
        };
        let wait = backoff(
            Duration::from_millis(self.inner.section.restart_backoff_ms),
            st.restarts,
        );
        st.next_start = Instant::now() + wait;
        tracing::error!(tenant_id = %slot.tenant, pid, %status, restarts = st.restarts, backoff_ms = wait.as_millis() as u64, "child exited; restarting on the next request");
    }

    /// Hands the deployment of `ctx` to the child once per secret version.
    async fn ensure_prepared(&self, slot: &Arc<ChildSlot>, ctx: &RequestCtx) -> Result<(), String> {
        let config = self.inner.manager.config();
        let meta = config
            .deployments
            .lookup(&ctx.tenant_id, &ctx.deployment_hash);
        let key = (ctx.deployment_hash.clone(), meta.secrets_version);
        if slot.prepared.lock().expect("prepared lock").contains(&key) {
            return Ok(());
        }
        // The artifact on this node's disk (controlled mode fetches it).
        let store = config.artifacts.clone();
        let hash = ctx.deployment_hash.clone();
        tokio::task::spawn_blocking(move || store.get(&hash).map(drop))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| format!("artifact: {e}"))?;
        let secrets = config
            .secrets
            .secrets(SecretsRequest {
                tenant_id: ctx.tenant_id.clone(),
                app: meta.app.clone(),
                deployment_hash: ctx.deployment_hash.clone(),
                secrets_version: meta.secrets_version,
            })
            .await
            .map_err(|e| format!("secrets: {e:?}"))?;
        let prepare = Prepare {
            tenant_id: ctx.tenant_id.clone(),
            deployment_hash: ctx.deployment_hash.clone(),
            tier: match meta.tier {
                TierName::Free => "free".into(),
                TierName::Paid => "paid".into(),
            },
            app: meta.app,
            secrets_version: meta.secrets_version,
            secrets,
        };
        let body = serde_json::to_vec(&prepare).map_err(|e| e.to_string())?;
        let (status, _) = ipc::call(&slot.socket, "prepare", body)
            .await
            .map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(format!("prepare answered {status}"));
        }
        slot.prepared.lock().expect("prepared lock").insert(key);
        Ok(())
    }

    async fn forward(
        &self,
        slot: Arc<ChildSlot>,
        ctx: RequestCtx,
        mut req: Request<Body>,
    ) -> Response<Body> {
        *slot.last_used.lock().expect("last_used lock") = Instant::now();
        if let Err(e) = self.ensure_running(&slot, ctx.deadline).await {
            tracing::error!(tenant_id = %ctx.tenant_id, request_id = %ctx.request_id, error = %e, "child unavailable");
            return unavailable();
        }
        if let Err(e) = self.ensure_prepared(&slot, &ctx).await {
            tracing::error!(tenant_id = %ctx.tenant_id, request_id = %ctx.request_id, error = %e, "child prepare failed");
            return unavailable();
        }
        ipc::encode_ctx(req.headers_mut(), &ctx);
        match ipc::send(&slot.socket, req).await {
            Ok(resp) => resp,
            Err(e) => {
                tracing::error!(tenant_id = %ctx.tenant_id, request_id = %ctx.request_id, error = %e, "child request failed");
                unavailable()
            }
        }
    }

    /// Stops the child of `slot` (drain): it finishes in-flight requests
    /// and exits; the slot is forgotten when it has.
    fn stop(&self, slot: &Arc<ChildSlot>, why: &'static str) {
        if slot.draining.swap(true, Ordering::SeqCst) {
            return;
        }
        let slot = slot.clone();
        let me = self.clone();
        self.inner.handle.spawn(async move {
            let running = slot.state.lock().await.running.load(Ordering::SeqCst);
            if !running {
                me.inner
                    .children
                    .lock()
                    .expect("children lock")
                    .remove(&slot.tenant);
                return;
            }
            tracing::info!(tenant_id = %slot.tenant, why, "child draining");
            match me.inner.section.launcher {
                Launcher::Direct => {
                    let _ = ipc::call(&slot.socket, "shutdown", Vec::new()).await;
                }
                Launcher::Systemd => {
                    let unit = format!("renox-child@{}.service", slot.tenant);
                    let _ = tokio::process::Command::new("systemctl")
                        .args(["stop", &unit])
                        .status()
                        .await;
                }
            }
        });
    }

    /// A route sync: drain children whose tenant has no active entry or
    /// moved to `shared`; drain shared cells of tenants that moved to `own`.
    pub fn sync(&self, entries: &[RouteEntry]) {
        let active: HashSet<&str> = entries
            .iter()
            .filter(|e| e.status == RouteStatus::Active)
            .map(|e| e.tenant_id.as_str())
            .collect();
        let slots: Vec<Arc<ChildSlot>> = self
            .inner
            .children
            .lock()
            .expect("children lock")
            .values()
            .cloned()
            .collect();
        for slot in &slots {
            if !active.contains(slot.tenant.as_str()) {
                self.stop(slot, "no active route entry");
            } else if self.inner.lookup.process(&slot.tenant) == ProcessKind::Shared {
                self.stop(slot, "moved to the shared process");
            }
        }
        for tenant in active {
            if self.inner.lookup.process(tenant) == ProcessKind::Own {
                self.inner.manager.drain_tenant(tenant);
            }
        }
    }

    fn spawn_idle_reaper(&self) {
        let me = self.clone();
        let idle = Duration::from_secs_f64(self.inner.section.child_idle_secs);
        self.inner.handle.spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(500).min(idle)).await;
                let slots: Vec<Arc<ChildSlot>> = me
                    .inner
                    .children
                    .lock()
                    .expect("children lock")
                    .values()
                    .cloned()
                    .collect();
                for slot in slots {
                    let last = *slot.last_used.lock().expect("last_used lock");
                    let running = slot
                        .state
                        .try_lock()
                        .map(|s| s.running.load(Ordering::SeqCst))
                        .unwrap_or(true);
                    if running && last.elapsed() >= idle {
                        me.stop(&slot, "idle");
                    }
                }
            }
        });
    }

    /// Stops every child (worker shutdown).
    pub async fn shutdown(&self) {
        let slots: Vec<Arc<ChildSlot>> = self
            .inner
            .children
            .lock()
            .expect("children lock")
            .values()
            .cloned()
            .collect();
        for slot in &slots {
            self.stop(slot, "worker shutdown");
        }
        let start = Instant::now();
        while !self
            .inner
            .children
            .lock()
            .expect("children lock")
            .is_empty()
            && start.elapsed() < Duration::from_secs(10)
        {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
}

impl<D: CellDispatcher> CellDispatcher for Supervisor<D> {
    async fn dispatch(&self, ctx: RequestCtx, req: Request<Body>) -> Response<Body> {
        if self.inner.lookup.process(&ctx.tenant_id) == ProcessKind::Own {
            match self.slot(&ctx.tenant_id) {
                Some(slot) if !slot.draining.load(Ordering::SeqCst) => {
                    return self.forward(slot, ctx, req).await;
                }
                Some(_) => {}
                None => {
                    tracing::warn!(tenant_id = %ctx.tenant_id, max = self.inner.section.max_children, "max_children reached; serving in the shared process")
                }
            }
        }
        self.inner.shared.dispatch(ctx, req).await
    }
}

fn unavailable() -> Response<Body> {
    let mut r = ipc::error(
        StatusCode::SERVICE_UNAVAILABLE,
        "RENOX_UNAVAILABLE",
        "The service is temporarily unavailable.",
    );
    r.headers_mut().insert(
        http::header::RETRY_AFTER,
        http::HeaderValue::from_static("1"),
    );
    r
}

fn set_mode(path: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_doubles_up_to_thirty_seconds() {
        let base = Duration::from_millis(200);
        assert_eq!(backoff(base, 0), Duration::ZERO);
        assert_eq!(backoff(base, 1), Duration::from_millis(200));
        assert_eq!(backoff(base, 2), Duration::from_millis(400));
        assert_eq!(backoff(base, 5), Duration::from_millis(3200));
        assert_eq!(backoff(base, 40), MAX_BACKOFF);
    }

    #[test]
    fn process_kind_parses_and_defaults_to_shared() {
        assert_eq!(
            serde_json::from_str::<ProcessKind>("\"own\"").unwrap(),
            ProcessKind::Own
        );
        assert_eq!(ProcessKind::default(), ProcessKind::Shared);
        let s = StaticProcesses(["t_a".to_string()].into());
        assert_eq!(s.process("t_a"), ProcessKind::Own);
        assert_eq!(s.process("t_b"), ProcessKind::Shared);
    }
}
