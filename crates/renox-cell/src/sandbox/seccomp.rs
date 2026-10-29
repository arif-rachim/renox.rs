//! The seccomp allowlist (#253): `sandbox/syscalls.<arch>.txt`, produced by
//! `ops/scripts/trace-syscalls.sh`, plus `[sandbox] extra_syscalls`. Every
//! other system call kills the process in `enforce` (`SECCOMP_RET_KILL_PROCESS`)
//! or is logged by the kernel in `audit` (`SECCOMP_RET_LOG`). Built with
//! `seccompiler` (no libseccomp) and loaded on every thread with `TSYNC`;
//! loading sets `no_new_privs`.

use std::collections::BTreeSet;

use seccompiler::{BpfProgram, TargetArch};

use super::SandboxError;
use crate::config::SandboxMode;

/// The traced allowlist of the architecture this binary was built for.
#[cfg(target_arch = "x86_64")]
pub const ALLOWLIST: &str = include_str!("../../sandbox/syscalls.x86_64.txt");
#[cfg(target_arch = "aarch64")]
pub const ALLOWLIST: &str = include_str!("../../sandbox/syscalls.aarch64.txt");
#[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
pub const ALLOWLIST: &str = "";

#[cfg(target_arch = "x86_64")]
const ARCH: Option<TargetArch> = Some(TargetArch::x86_64);
#[cfg(target_arch = "aarch64")]
const ARCH: Option<TargetArch> = Some(TargetArch::aarch64);
#[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
const ARCH: Option<TargetArch> = None;

/// The names of a list file: the first word of every line that is not a
/// comment.
pub fn names(list: &str) -> BTreeSet<String> {
    list.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .filter_map(|l| l.split_whitespace().next())
        .map(str::to_string)
        .collect()
}

/// `CLONE_THREAD` (linux/sched.h), the same value on x86_64 and aarch64.
const CLONE_THREAD: u64 = 0x0001_0000;

/// Compiles `names` into a BPF program for `arch`. An unknown name is an
/// error that names it.
pub fn compile(
    names: &BTreeSet<String>,
    mode: SandboxMode,
    arch: TargetArch,
) -> Result<BpfProgram, SandboxError> {
    let mut filter: Vec<_> = names
        .iter()
        .map(|n| serde_json::json!({ "syscall": n }))
        .collect();
    // `clone` only for a new thread (flags with CLONE_THREAD), never a new
    // process. Go programs the worker starts (the Litestream sidecars, #255)
    // inherit this filter and create their threads with `clone`; `clone3`
    // is already allowed whole (seccomp cannot read its flags), so this adds
    // no way to fork.
    if !names.contains("clone") {
        filter.push(serde_json::json!({
            "syscall": "clone",
            "args": [{ "index": 0, "type": "qword", "op": { "masked_eq": CLONE_THREAD }, "val": CLONE_THREAD }],
        }));
    }
    let json = serde_json::json!({
        "worker": {
            "mismatch_action": match mode {
                SandboxMode::Enforce => "kill_process",
                SandboxMode::Audit => "log",
            },
            "match_action": "allow",
            "filter": filter,
        }
    });
    let mut map = seccompiler::compile_from_json(json.to_string().as_bytes(), arch)
        .map_err(|e| SandboxError(format!("seccomp allowlist: {e}")))?;
    map.remove("worker")
        .ok_or_else(|| SandboxError("seccomp allowlist: no program".into()))
}

/// The kernel accepts seccomp filters with the actions we use.
pub fn available() -> bool {
    std::fs::read_to_string("/proc/sys/kernel/seccomp/actions_avail")
        .is_ok_and(|a| a.split_whitespace().any(|x| x == "kill_process") && a.contains("log"))
}

/// Loads the allowlist plus `extra` on every thread of the process.
/// Returns the number of allowed syscalls.
pub fn apply(mode: SandboxMode, extra: &[String]) -> Result<usize, SandboxError> {
    let arch =
        ARCH.ok_or_else(|| SandboxError("no seccomp allowlist for this architecture".into()))?;
    let mut all = names(ALLOWLIST);
    if all.is_empty() {
        return Err(SandboxError("the seccomp allowlist is empty".into()));
    }
    all.extend(extra.iter().cloned());
    let program = compile(&all, mode, arch)?;
    seccompiler::apply_filter_all_threads(&program)
        .map_err(|e| SandboxError(format!("load the seccomp filter: {e}")))?;
    Ok(all.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Both shipped lists compile for their architecture, so a bad name in
    /// a generated list fails here and not at a node's start.
    #[test]
    fn both_lists_compile() {
        for (list, arch) in [
            (
                include_str!("../../sandbox/syscalls.x86_64.txt"),
                TargetArch::x86_64,
            ),
            (
                include_str!("../../sandbox/syscalls.aarch64.txt"),
                TargetArch::aarch64,
            ),
        ] {
            let n = names(list);
            assert!(n.len() > 50, "{arch:?}: {} names", n.len());
            for mode in [SandboxMode::Enforce, SandboxMode::Audit] {
                compile(&n, mode, arch).unwrap_or_else(|e| panic!("{arch:?}: {e}"));
            }
        }
    }

    #[test]
    fn the_lists_never_allow_what_an_escape_would_want_first() {
        // Kernel attack surface an escaped isolate reaches for and the
        // worker never needs (docs/24-threat-model.md, "Isolate escape").
        for list in [
            include_str!("../../sandbox/syscalls.x86_64.txt"),
            include_str!("../../sandbox/syscalls.aarch64.txt"),
        ] {
            let n = names(list);
            for never in [
                "ptrace",
                "process_vm_readv",
                "process_vm_writev",
                "bpf",
                "mount",
                "umount2",
                "init_module",
                "finit_module",
                "kexec_load",
                "setns",
                "unshare",
                "pivot_root",
                "chroot",
                "keyctl",
                "add_key",
                "perf_event_open",
                "userfaultfd",
                "open_by_handle_at",
            ] {
                assert!(!n.contains(never), "{never} must stay out of the allowlist");
            }
        }
    }

    #[test]
    fn an_unknown_name_is_named() {
        let mut n = names(ALLOWLIST);
        n.insert("not_a_syscall".into());
        let e = compile(&n, SandboxMode::Enforce, TargetArch::x86_64).unwrap_err();
        assert!(
            e.0.contains("not_a_syscall") || e.0.contains("syscall"),
            "{e}"
        );
    }

    #[test]
    fn comments_and_reasons_are_not_names() {
        let n = names("# header\nread\nexecve   children (#254)\n\n");
        assert_eq!(n.into_iter().collect::<Vec<_>>(), ["execve", "read"]);
    }
}
