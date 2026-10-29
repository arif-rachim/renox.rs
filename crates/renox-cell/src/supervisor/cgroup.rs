//! A child's cgroup (#254, `direct` launcher): under the supervisor's own
//! delegated cgroup v2 (`Delegate=yes` in `ops/systemd/renox-worker.service`)
//!
//! ```text
//! <root>/                      the worker's cgroup (delegated)
//! ├── supervisor/              the supervisor and the shared free tier
//! └── renox-<tenant>.scope/    one per child: cpu.max, memory.max, pids.max
//! ```
//!
//! cgroup v2 keeps processes only in leaves once controllers are enabled
//! for children, so the supervisor first moves itself into `supervisor/`.
//! When the tree is not writable (a container, a laptop, cgroup v1) it
//! logs once and runs without; [`CgroupTree::open`] returns `None`.

use std::path::{Path, PathBuf};

/// The writable tree children are placed in.
#[derive(Debug, Clone)]
pub struct CgroupTree {
    pub root: PathBuf,
}

/// The limits of one child.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    /// Microseconds of CPU per 100 ms period.
    pub cpu_quota_us: u64,
    pub memory_bytes: u64,
    pub pids: u64,
}

/// This process's cgroup v2 directory (`0::/path` of `/proc/self/cgroup`).
pub fn own_cgroup() -> Option<PathBuf> {
    let text = std::fs::read_to_string("/proc/self/cgroup").ok()?;
    let path = text.lines().find_map(|l| l.strip_prefix("0::"))?;
    Some(Path::new("/sys/fs/cgroup").join(path.trim_start_matches('/')))
}

impl CgroupTree {
    /// Prepares `root` (default: this process's own cgroup): moves this
    /// process into `root/supervisor` and enables `cpu`, `memory`, `pids`
    /// for children. `None` (with the reason) when that is not possible.
    pub fn open(root: Option<&Path>) -> Result<CgroupTree, String> {
        let root = match root {
            Some(r) => r.to_path_buf(),
            None => own_cgroup().ok_or("no cgroup v2 entry in /proc/self/cgroup")?,
        };
        let controllers = std::fs::read_to_string(root.join("cgroup.controllers"))
            .map_err(|e| format!("{}: not a cgroup v2 directory ({e})", root.display()))?;
        for c in ["cpu", "memory", "pids"] {
            if !controllers.split_whitespace().any(|x| x == c) {
                return Err(format!(
                    "{}: controller {c} is not delegated",
                    root.display()
                ));
            }
        }
        let own = root.join("supervisor");
        std::fs::create_dir_all(&own).map_err(|e| format!("{}: {e}", own.display()))?;
        std::fs::write(own.join("cgroup.procs"), std::process::id().to_string())
            .map_err(|e| format!("move the supervisor into {}: {e}", own.display()))?;
        std::fs::write(root.join("cgroup.subtree_control"), "+cpu +memory +pids")
            .map_err(|e| format!("enable controllers in {}: {e}", root.display()))?;
        Ok(CgroupTree { root })
    }

    /// The cgroup of `tenant`'s child.
    pub fn child_dir(&self, tenant: &str) -> PathBuf {
        self.root.join(format!("renox-{tenant}.scope"))
    }

    /// Creates the child's cgroup with `limits` and moves `pid` into it.
    pub fn place(&self, tenant: &str, pid: u32, limits: Limits) -> Result<PathBuf, String> {
        let dir = self.child_dir(tenant);
        std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        let write = |file: &str, value: String| {
            std::fs::write(dir.join(file), value)
                .map_err(|e| format!("{}/{file}: {e}", dir.display()))
        };
        write("cpu.max", format!("{} 100000", limits.cpu_quota_us))?;
        write("memory.max", limits.memory_bytes.to_string())?;
        write("pids.max", limits.pids.to_string())?;
        write("cgroup.procs", pid.to_string())?;
        Ok(dir)
    }

    /// Removes an empty child cgroup (after the child exited).
    pub fn remove(&self, tenant: &str) {
        let _ = std::fs::remove_dir(self.child_dir(tenant));
    }
}

/// Reads one value of a child's cgroup (tests, operator).
pub fn read(dir: &Path, file: &str) -> Option<String> {
    std::fs::read_to_string(dir.join(file))
        .ok()
        .map(|s| s.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_non_cgroup_directory_is_refused_with_the_reason() {
        let dir = std::env::temp_dir().join(format!("renox-cgroup-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let e = CgroupTree::open(Some(&dir)).unwrap_err();
        assert!(e.contains("not a cgroup v2 directory"), "{e}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn child_dirs_are_named_by_tenant() {
        let t = CgroupTree {
            root: PathBuf::from("/sys/fs/cgroup/x"),
        };
        assert_eq!(
            t.child_dir("t_a"),
            Path::new("/sys/fs/cgroup/x/renox-t_a.scope")
        );
    }
}
