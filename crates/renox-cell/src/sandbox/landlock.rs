//! Landlock rules (#253): read and execute on the artifacts dir and the
//! worker binary's dir, read-write on the data, meters and logs dirs, read
//! only on the few system files of [`super::SYSTEM_READ`], nothing else;
//! with Landlock ABI 4 (Linux 6.7) also TCP `bind` to the configured
//! listeners only and TCP `connect` to [`super::Profile::connect_ports`]
//! only. Two layers, so the report can say which part the kernel enforces.

use landlock::{
    ABI, Access, AccessFs, AccessNet, BitFlags, CompatLevel, Compatible, NetPort, PathBeneath,
    PathFd, Ruleset, RulesetAttr, RulesetCreatedAttr, RulesetStatus,
};

use super::{Enforcement, LandlockReport, Profile, SandboxError};

/// The newest ABI whose file-system rights this code was tested with.
const FS_ABI: ABI = ABI::V5;

fn err(what: &str) -> impl Fn(landlock::RulesetError) -> SandboxError + '_ {
    move |e| SandboxError(format!("Landlock {what}: {e}"))
}

fn status(s: RulesetStatus) -> Enforcement {
    match s {
        RulesetStatus::FullyEnforced => Enforcement::Full,
        RulesetStatus::PartiallyEnforced => Enforcement::Partial,
        RulesetStatus::NotEnforced => Enforcement::Unsupported,
    }
}

/// Rules for the paths that exist; a missing path (no `/lib64` on this
/// distribution, a dir created later) gets no rule and stays unreachable.
fn rules<'a>(
    paths: &'a [std::path::PathBuf],
    access: BitFlags<AccessFs>,
) -> impl Iterator<Item = PathBeneath<PathFd>> + 'a {
    paths.iter().filter_map(move |p| {
        let fd = PathFd::new(p).ok()?;
        let file = std::fs::metadata(p).ok()?.is_file();
        // A file takes only the rights that apply to files.
        let access = if file {
            access & AccessFs::from_file(FS_ABI)
        } else {
            access
        };
        Some(PathBeneath::new(fd, access))
    })
}

/// Applies both layers to the calling thread (and every thread and process
/// it creates afterwards).
pub fn apply(profile: &Profile) -> Result<LandlockReport, SandboxError> {
    // The worker creates these at start; they must exist to get a rule.
    for dir in profile.read_write.iter().chain(&profile.read_exec) {
        if !dir.exists() {
            std::fs::create_dir_all(dir)
                .map_err(|e| SandboxError(format!("create {}: {e}", dir.display())))?;
        }
    }
    let read: BitFlags<AccessFs> = AccessFs::ReadFile | AccessFs::ReadDir;
    let read_exec = AccessFs::from_read(FS_ABI);
    let read_write = AccessFs::from_all(FS_ABI) & !BitFlags::from(AccessFs::Execute);

    let fs = Ruleset::default()
        .handle_access(AccessFs::from_all(FS_ABI))
        .map_err(err("file system rules"))?
        .create()
        .map_err(err("file system ruleset"))?
        .add_rules(rules(&profile.read_exec, read_exec).map(Ok::<_, landlock::RulesetError>))
        .map_err(err("read-exec rules"))?
        .add_rules(rules(&profile.read_only, read).map(Ok::<_, landlock::RulesetError>))
        .map_err(err("read-only rules"))?
        .add_rules(rules(&profile.read_write, read_write).map(Ok::<_, landlock::RulesetError>))
        .map_err(err("read-write rules"))?
        .restrict_self()
        .map_err(err("restrict_self (file system)"))?;
    let fs = status(fs.ruleset);

    // Network rules need ABI 4: as a hard requirement, so an older kernel
    // reports `Unsupported` instead of silently dropping them.
    let net = match Ruleset::default()
        .set_compatibility(CompatLevel::HardRequirement)
        .handle_access(AccessNet::from_all(ABI::V4))
    {
        Err(_) => Enforcement::Unsupported,
        Ok(ruleset) => {
            let mut created = ruleset.create().map_err(err("network ruleset"))?;
            for &port in &profile.connect_ports {
                created = created
                    .add_rule(NetPort::new(port, AccessNet::ConnectTcp))
                    .map_err(err("connect rule"))?;
            }
            for &port in &profile.bind_ports {
                created = created
                    .add_rule(NetPort::new(port, AccessNet::BindTcp))
                    .map_err(err("bind rule"))?;
            }
            status(
                created
                    .restrict_self()
                    .map_err(err("restrict_self (network)"))?
                    .ruleset,
            )
        }
    };
    Ok(LandlockReport { fs, net })
}
