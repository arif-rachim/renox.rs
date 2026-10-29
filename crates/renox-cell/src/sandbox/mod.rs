//! The worker's own sandbox (#253, ADR D6 layered isolation,
//! `docs/04-isolation-security.md` "Defense in depth"): after a V8 escape,
//! code running in the process can make only the system calls the
//! benchmarks and tests showed the worker needs (seccomp, [`seccomp`]) and
//! can touch only its own directories and ports (Landlock, [`landlock`]).
//!
//! Two steps, because the two mechanisms differ in how they reach threads:
//!
//! 1. [`restrict_paths_and_ports`] (Landlock) applies to the calling thread
//!    and the threads and processes it creates later, never to threads that
//!    already exist. `renox-worker` calls it in `main`, right after reading
//!    the config and before the async runtime starts any thread.
//! 2. [`restrict_syscalls`] (seccomp) is loaded with `TSYNC`, so it reaches
//!    every thread. [`crate::Worker::start`] calls it once the listeners are
//!    bound, the config, keys and tokens are read, and the route table is
//!    loaded.
//!
//! `renox-worker --sandbox-selftest` applies both and then tries what an
//! escaped isolate would ([`selftest`]).

use std::path::{Path, PathBuf};

use crate::config::{Mode, SandboxMode, SandboxSection, WorkerConfig};

#[cfg(target_os = "linux")]
pub mod landlock;
#[cfg(target_os = "linux")]
pub mod seccomp;

/// Why the sandbox could not be applied. Never contains file contents.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SandboxError(pub String);

impl std::fmt::Display for SandboxError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "sandbox: {}", self.0)
    }
}

impl std::error::Error for SandboxError {}

/// Read-only system files the worker's libc needs after start: name
/// resolution for `fetch` and the control plane, time zones, the CPU and
/// cgroup information the runtime sizes its thread pools with, and the
/// shared libraries `getaddrinfo` may load (NSS modules). `/etc/passwd`
/// and the rest of `/etc` are deliberately absent.
pub const SYSTEM_READ: &[&str] = &[
    "/etc/resolv.conf",
    "/etc/hosts",
    "/etc/nsswitch.conf",
    "/etc/gai.conf",
    "/etc/host.conf",
    "/etc/localtime",
    "/usr/share/zoneinfo",
    "/lib",
    "/lib64",
    "/usr/lib",
    "/usr/lib64",
    "/proc/self",
    "/proc/cpuinfo",
    "/proc/meminfo",
    "/proc/stat",
    "/proc/sys/kernel/seccomp",
    "/proc/sys/vm/overcommit_memory",
    "/sys/fs/cgroup",
    "/sys/devices/system/cpu",
    "/dev/urandom",
];

/// Read-write device files.
pub const SYSTEM_READ_WRITE: &[&str] = &["/dev/null"];

/// TCP ports `connect` may always reach: HTTPS (`fetch`, S3, the control
/// plane's default) and DNS over TCP.
pub const DEFAULT_CONNECT_PORTS: &[u16] = &[443, 53];

/// What the worker may touch once sandboxed, from its config.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Profile {
    pub mode: SandboxMode,
    /// Read and execute: the artifacts dir and the worker binary's dir.
    pub read_exec: Vec<PathBuf>,
    /// Read only: [`SYSTEM_READ`], the route table file, TLS and ACME dirs,
    /// the platform key and node token, `extra_read_paths`.
    pub read_only: Vec<PathBuf>,
    /// Read and write: data (with the spool), meters, logs, `/dev/null`.
    pub read_write: Vec<PathBuf>,
    /// Ports `connect` may reach (Landlock ABI 4).
    pub connect_ports: Vec<u16>,
    /// Ports the listeners bind (Landlock ABI 4).
    pub bind_ports: Vec<u16>,
    /// On top of `sandbox/syscalls.<arch>.txt`.
    pub extra_syscalls: Vec<String>,
}

impl Profile {
    /// The profile of `config`; `exe_dir` is the directory of the running
    /// binary (children and the Litestream sidecar are started from there).
    pub fn from_config(config: &WorkerConfig, exe_dir: Option<&Path>) -> Profile {
        let s: &SandboxSection = &config.sandbox;
        let mut read_exec = vec![config.artifacts_dir.clone()];
        read_exec.extend(exe_dir.map(Path::to_path_buf));
        let mut read_only: Vec<PathBuf> = SYSTEM_READ.iter().map(PathBuf::from).collect();
        if !config.routes_file.as_os_str().is_empty() {
            read_only.push(config.routes_file.clone());
        }
        read_only.extend(config.platform_key_file.clone());
        if let Some(tls) = &config.tls {
            read_only.push(tls.cert_dir.clone());
            read_only.extend(tls.acme_dir.clone());
        }
        if let Some(control) = &config.control {
            read_only.push(control.node_token_file.clone());
        }
        read_only.extend(s.extra_read_paths.iter().cloned());
        // A build without `renox-runtime/packaged` (tests, `renox dev` from a
        // checkout) reads the Deno extension sources from the cargo registry
        // when it builds its platform snapshot (crates/renox-runtime README,
        // "Packaging"). A release is packaged and a node has no registry.
        if let Some(src) = cargo_registry_src() {
            read_only.push(src);
        }
        // The same builds read the `renox` extension's own JavaScript from
        // the checkout they were built in.
        let runtime_src = Path::new(env!("CARGO_MANIFEST_DIR")).join("../renox-runtime/src");
        if runtime_src.is_dir() {
            read_only.push(runtime_src);
        }
        let mut read_write = vec![
            config.data_dir.clone(),
            config.meters_dir.clone(),
            config.logs_dir.clone(),
            // The platform snapshot is written there once per process
            // (`PrivateTmp` on a node).
            std::env::temp_dir(),
        ];
        read_write.extend(SYSTEM_READ_WRITE.iter().map(PathBuf::from));

        let mut connect_ports = DEFAULT_CONNECT_PORTS.to_vec();
        if config.mode == Mode::Controlled
            && let Some(port) = config.control.as_ref().and_then(|c| control_port(&c.url))
        {
            connect_ports.push(port);
        }
        connect_ports.extend(s.extra_connect_ports.iter().copied());
        connect_ports.sort_unstable();
        connect_ports.dedup();

        let mut bind_ports = vec![config.listen.port()];
        bind_ports.extend(
            config
                .tls
                .as_ref()
                .and_then(|t| t.http_listen)
                .map(|a| a.port()),
        );
        bind_ports.extend(
            config
                .control
                .as_ref()
                .and_then(|c| c.health_listen)
                .map(|a| a.port()),
        );
        bind_ports.sort_unstable();
        bind_ports.dedup();

        Profile {
            mode: s.mode,
            read_exec,
            read_only,
            read_write,
            connect_ports,
            bind_ports,
            extra_syscalls: s.extra_syscalls.clone(),
        }
    }
}

/// `$CARGO_HOME/registry/src` (default `~/.cargo`), when it exists.
fn cargo_registry_src() -> Option<PathBuf> {
    let home = std::env::var_os("CARGO_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".cargo")))?;
    let src = home.join("registry").join("src");
    src.is_dir().then_some(src)
}

/// The port of `[control] url` (443 or 80 when the URL has none).
pub fn control_port(url: &str) -> Option<u16> {
    let uri: http::Uri = url.parse().ok()?;
    Some(uri.port_u16().unwrap_or(match uri.scheme_str() {
        Some("http") => 80,
        _ => 443,
    }))
}

/// How far a mechanism got.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Enforcement {
    /// Every rule applies.
    Full,
    /// The kernel knows only part of the rules (an older Landlock ABI).
    Partial,
    /// The kernel lacks the mechanism; nothing applies.
    Unsupported,
}

impl Enforcement {
    pub fn as_str(self) -> &'static str {
        match self {
            Enforcement::Full => "full",
            Enforcement::Partial => "partial",
            Enforcement::Unsupported => "unsupported",
        }
    }
}

/// What [`restrict_paths_and_ports`] achieved.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LandlockReport {
    /// File system rules.
    pub fs: Enforcement,
    /// TCP bind and connect rules (Landlock ABI 4, Linux 6.7).
    pub net: Enforcement,
}

static LANDLOCK_APPLIED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// [`restrict_paths_and_ports`] ran in this process.
pub fn landlock_applied() -> bool {
    LANDLOCK_APPLIED.load(std::sync::atomic::Ordering::SeqCst)
}

/// Step 1: Landlock. Call before any thread is started. A kernel without
/// Landlock logs one warning and continues (seccomp still applies).
#[cfg(target_os = "linux")]
pub fn restrict_paths_and_ports(profile: &Profile) -> Result<LandlockReport, SandboxError> {
    let report = landlock::apply(profile)?;
    LANDLOCK_APPLIED.store(true, std::sync::atomic::Ordering::SeqCst);
    match (report.fs, report.net) {
        (Enforcement::Unsupported, _) => {
            tracing::warn!("sandbox: this kernel has no Landlock; continuing with seccomp only")
        }
        (_, Enforcement::Unsupported) => tracing::warn!(
            "sandbox: this kernel's Landlock has no network rules (ABI < 4); bind and connect are not restricted by port"
        ),
        _ => {}
    }
    tracing::info!(
        fs = report.fs.as_str(),
        net = report.net.as_str(),
        "sandbox: Landlock applied"
    );
    Ok(report)
}

#[cfg(not(target_os = "linux"))]
pub fn restrict_paths_and_ports(_profile: &Profile) -> Result<LandlockReport, SandboxError> {
    Err(SandboxError(
        "[sandbox] needs Linux (seccomp and Landlock)".into(),
    ))
}

/// Step 2: the seccomp allowlist on every thread. In `enforce` a kernel
/// without seccomp refuses to start; in `audit` it logs and continues.
#[cfg(target_os = "linux")]
pub fn restrict_syscalls(profile: &Profile) -> Result<usize, SandboxError> {
    if !seccomp::available() {
        return match profile.mode {
            SandboxMode::Enforce => Err(SandboxError(
                "the kernel has no seccomp filter support; refusing to start with [sandbox] mode = \"enforce\"".into(),
            )),
            SandboxMode::Audit => {
                tracing::warn!("sandbox: the kernel has no seccomp filter support; continuing without it (audit)");
                Ok(0)
            }
        };
    }
    let n = seccomp::apply(profile.mode, &profile.extra_syscalls)?;
    tracing::info!(syscalls = n, mode = ?profile.mode, "sandbox: seccomp allowlist applied to every thread");
    Ok(n)
}

#[cfg(not(target_os = "linux"))]
pub fn restrict_syscalls(_profile: &Profile) -> Result<usize, SandboxError> {
    Err(SandboxError(
        "[sandbox] needs Linux (seccomp and Landlock)".into(),
    ))
}

/// Tests only (`test-support`): `RENOX_TEST_SANDBOX=enforce|audit` loads
/// the seccomp allowlist into the test process once, so the whole
/// `renox-cell` suite runs under it (#253; CI's rust job sets it). Landlock
/// is not applied here: its rules name one worker's directories, and the
/// test process starts many workers with directories of their own;
/// `tests/sandbox.rs` covers it with the real binary.
#[cfg(all(feature = "test-support", target_os = "linux"))]
pub fn apply_test_sandbox() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    let mode = match std::env::var("RENOX_TEST_SANDBOX").as_deref() {
        Ok("enforce") => SandboxMode::Enforce,
        Ok("audit") => SandboxMode::Audit,
        _ => return,
    };
    ONCE.call_once(|| {
        let n = seccomp::apply(mode, &[]).expect("RENOX_TEST_SANDBOX: seccomp allowlist");
        tracing::info!(
            syscalls = n,
            ?mode,
            "RENOX_TEST_SANDBOX: seccomp applied to the test process"
        );
    });
}

#[cfg(not(all(feature = "test-support", target_os = "linux")))]
pub fn apply_test_sandbox() {}

/// One line of the self-test table.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Probe {
    pub what: String,
    /// `refused (EACCES)`, `allowed`, ...
    pub outcome: String,
    pub refused: bool,
    /// The sandbox must refuse it.
    pub must_refuse: bool,
}

/// `renox-worker --sandbox-selftest`: applies the profile of `config` (as
/// if `[sandbox] enabled = true`) in this process, then tries what an
/// escaped isolate would, from Rust: read `/etc/passwd`, connect to the
/// cloud metadata address, connect to the control plane's port; and what
/// the worker itself needs: list the artifacts dir, write in the data dir.
/// Returns the table; [`selftest_failed`] says whether a must-refuse probe
/// got through. Call it single-threaded (before any runtime).
#[cfg(target_os = "linux")]
pub fn selftest(
    config: &WorkerConfig,
) -> Result<(LandlockReport, usize, Vec<Probe>), SandboxError> {
    use std::io::Write;
    use std::net::{SocketAddr, TcpStream};
    use std::time::Duration;

    let exe = std::env::current_exe().ok();
    let profile = Profile::from_config(config, exe.as_deref().and_then(Path::parent));
    for d in [&config.data_dir, &config.artifacts_dir] {
        std::fs::create_dir_all(d)
            .map_err(|e| SandboxError(format!("create {}: {e}", d.display())))?;
    }
    let landlock = landlock::apply(&profile)?;
    let syscalls = restrict_syscalls(&profile)?;

    fn outcome(r: std::io::Result<()>) -> (String, bool) {
        match r {
            Ok(()) => ("allowed".into(), false),
            Err(e) => match e.raw_os_error() {
                Some(code) if code == libc_eacces() || code == libc_eperm() => (
                    format!(
                        "refused ({})",
                        if code == libc_eacces() {
                            "EACCES"
                        } else {
                            "EPERM"
                        }
                    ),
                    true,
                ),
                _ => (format!("allowed ({})", e.kind()), false),
            },
        }
    }
    let connect = |addr: SocketAddr| -> std::io::Result<()> {
        TcpStream::connect_timeout(&addr, Duration::from_millis(500)).map(drop)
    };
    let mut probes = Vec::new();
    let mut push = |what: String, r: std::io::Result<()>, must_refuse: bool| {
        let (outcome, refused) = outcome(r);
        probes.push(Probe {
            what,
            outcome,
            refused,
            must_refuse,
        });
    };
    push(
        "open(\"/etc/passwd\")".into(),
        std::fs::File::open("/etc/passwd").map(drop),
        true,
    );
    push(
        "connect(169.254.169.254:80)".into(),
        connect("169.254.169.254:80".parse().expect("address")),
        true,
    );
    if let Some(port) = config.control.as_ref().and_then(|c| control_port(&c.url)) {
        push(
            format!("connect(127.0.0.1:{port}) (control plane port)"),
            connect(SocketAddr::from(([127, 0, 0, 1], port))),
            false,
        );
    }
    push(
        format!("read_dir({}) (artifacts)", config.artifacts_dir.display()),
        std::fs::read_dir(&config.artifacts_dir).map(drop),
        false,
    );
    let probe_file = config.data_dir.join(".sandbox-selftest");
    push(
        format!("write({}) (data)", probe_file.display()),
        std::fs::File::create(&probe_file)
            .and_then(|mut f| f.write_all(b"ok"))
            .and_then(|()| std::fs::remove_file(&probe_file)),
        false,
    );
    Ok((landlock, syscalls, probes))
}

#[cfg(target_os = "linux")]
fn libc_eacces() -> i32 {
    13
}

#[cfg(target_os = "linux")]
fn libc_eperm() -> i32 {
    1
}

/// A probe the sandbox must refuse got through.
pub fn selftest_failed(probes: &[Probe]) -> bool {
    probes.iter().any(|p| p.must_refuse && !p.refused)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(extra: &str) -> WorkerConfig {
        let text = format!(
            "listen = \"0.0.0.0:443\"\ndata_dir=\"d\"\nartifacts_dir=\"a\"\nmeters_dir=\"m\"\nlogs_dir=\"l\"\n{extra}"
        );
        WorkerConfig::parse(&text, Path::new("/srv")).unwrap()
    }

    #[test]
    fn profile_holds_only_the_worker_dirs() {
        let c = config(
            "mode = \"controlled\"\nfetch_blocked_addresses = [\"203.0.113.1\"]\n[control]\nurl = \"https://10.0.0.5:8788\"\nnode_token_file = \"node.token\"\nhealth_listen = \"10.0.0.6:9090\"\n[tls]\ncert_dir = \"certs\"\nhttp_listen = \"0.0.0.0:80\"\n[sandbox]\nenabled = true\nextra_connect_ports = [80]\nextra_read_paths = [\"/etc/ssl/extra\"]\n",
        );
        let p = Profile::from_config(&c, Some(Path::new("/opt/renox/bin")));
        assert_eq!(
            p.read_exec,
            [PathBuf::from("/srv/a"), PathBuf::from("/opt/renox/bin")]
        );
        assert_eq!(
            p.read_write,
            [
                PathBuf::from("/srv/d"),
                PathBuf::from("/srv/m"),
                PathBuf::from("/srv/l"),
                std::env::temp_dir(),
                PathBuf::from("/dev/null")
            ]
        );
        assert!(p.read_only.contains(&PathBuf::from("/srv/node.token")));
        assert!(p.read_only.contains(&PathBuf::from("/srv/certs")));
        assert!(p.read_only.contains(&PathBuf::from("/etc/ssl/extra")));
        // docs/24-threat-model.md "Isolate escape (V8 bug)": no account
        // database, no SSH keys, nothing else under /etc.
        for never in ["/etc/passwd", "/etc/shadow", "/etc", "/root", "/home", "/"] {
            assert!(
                !p.read_only
                    .iter()
                    .chain(&p.read_write)
                    .chain(&p.read_exec)
                    .any(|x| x == Path::new(never)),
                "{never}"
            );
        }
        assert_eq!(p.connect_ports, [53, 80, 443, 8788]);
        assert_eq!(p.bind_ports, [80, 443, 9090]);
    }

    #[test]
    fn control_port_defaults() {
        assert_eq!(control_port("https://c.renox.test"), Some(443));
        assert_eq!(control_port("http://127.0.0.1"), Some(80));
        assert_eq!(control_port("https://c:8788/"), Some(8788));
    }

    #[test]
    fn a_must_refuse_probe_that_got_through_fails() {
        let p = |refused, must_refuse| Probe {
            what: "x".into(),
            outcome: String::new(),
            refused,
            must_refuse,
        };
        assert!(!selftest_failed(&[p(true, true), p(false, false)]));
        assert!(selftest_failed(&[p(false, true)]));
    }
}
