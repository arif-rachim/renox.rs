//! Streaming tar extraction with the upload caps of
//! `docs/contracts/deploy-api.md` section 4 (rules T1–T8, #95), for the
//! artifacts a controlled-mode worker fetches (#55, #162). The control
//! plane applies the same rules at upload (`control/api/src/deployments/extract.ts`);
//! the node applies them again, because the bytes it reads come from object
//! storage, not from the control plane.
//!
//! | Rule | Here |
//! | --- | --- |
//! | T1 entry types | regular files and directories only; pax `x` headers read for `path` and `size` only, `g` headers skipped; every other type refused |
//! | T2 total file bytes | [`TarCaps::total_bytes`] |
//! | T3 entries | [`TarCaps::entries`] |
//! | T4 paths | `artifact.md` section 1 after one leading `./` is removed; NFC |
//! | T5 one file | [`TarCaps::file_bytes`] |
//! | T6 gzip ratio | not applicable: the stored object is the uncompressed tar |
//! | T7 duplicates | a path twice, or as both a file and a directory |
//! | T8 wall clock | [`TarCaps::deadline`] |
//!
//! Extraction stops at the first violation and removes what it wrote, so
//! nothing beyond the caps stays on disk. Links are never created, and
//! every file is created with `create_new` under a directory this
//! function created, so no entry can write outside `dest`.

use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::Path;
use std::time::{Duration, Instant};

use renox_runtime::manifest::check_relative_path;
use unicode_normalization::is_nfc;

const BLOCK: usize = 512;

/// The caps of `deploy-api.md` section 4; [`TarCaps::default`] is the
/// contract's values.
#[derive(Debug, Clone, Copy)]
pub struct TarCaps {
    /// T2: total bytes of all file entries.
    pub total_bytes: u64,
    /// T3: entries, files and directories.
    pub entries: usize,
    /// T5: bytes of one file entry.
    pub file_bytes: u64,
    /// T8: wall clock for the whole extraction.
    pub deadline: Duration,
    /// Size of one pax extended header (not a contract rule: a bound on
    /// what the reader holds in memory).
    pub pax_bytes: u64,
}

impl Default for TarCaps {
    fn default() -> Self {
        TarCaps {
            total_bytes: 100 * 1024 * 1024,
            entries: 10_000,
            file_bytes: 20 * 1024 * 1024,
            deadline: Duration::from_secs(30),
            pax_bytes: 64 * 1024,
        }
    }
}

/// Why an extraction stopped. `path` is the entry path from the archive;
/// messages never name a path of the machine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TarError {
    /// A T rule (`"T1"` … `"T8"`).
    Rule {
        rule: &'static str,
        path: Option<String>,
        reason: String,
    },
    /// The archive is not a well-formed tar (bad checksum, truncated, bad
    /// number field).
    Malformed(String),
    /// Reading the source or writing the destination failed.
    Io(String),
}

impl std::fmt::Display for TarError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TarError::Rule {
                rule,
                path: Some(p),
                reason,
            } => write!(f, "{rule}: {p:?}: {reason}"),
            TarError::Rule { rule, reason, .. } => write!(f, "{rule}: {reason}"),
            TarError::Malformed(r) => write!(f, "malformed tar: {r}"),
            TarError::Io(r) => write!(f, "tar i/o: {r}"),
        }
    }
}

impl std::error::Error for TarError {}

/// What was extracted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct TarReport {
    pub files: usize,
    pub dirs: usize,
    pub bytes: u64,
}

fn rule(rule: &'static str, path: Option<&str>, reason: impl Into<String>) -> TarError {
    TarError::Rule {
        rule,
        path: path.map(str::to_owned),
        reason: reason.into(),
    }
}

fn io(e: std::io::Error) -> TarError {
    TarError::Io(e.kind().to_string())
}

/// Extracts the tar read from `src` into `dest`, which must not exist yet.
/// On any error `dest` is removed again.
pub fn extract(src: impl Read, dest: &Path, caps: &TarCaps) -> Result<TarReport, TarError> {
    fs::create_dir(dest).map_err(io)?;
    let result = Extractor {
        src,
        dest,
        caps,
        started: Instant::now(),
        report: TarReport::default(),
        entries: 0,
        kinds: HashMap::new(),
        implicit_dirs: HashSet::new(),
    }
    .run();
    if result.is_err() {
        let _ = fs::remove_dir_all(dest);
    }
    result
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    File,
    Dir,
}

struct Extractor<'a, R> {
    src: R,
    dest: &'a Path,
    caps: &'a TarCaps,
    started: Instant,
    report: TarReport,
    entries: usize,
    /// Every entry seen, by normalised path.
    kinds: HashMap<String, Kind>,
    /// Parents of every entry seen (directories whether listed or not).
    implicit_dirs: HashSet<String>,
}

/// Overrides from a pax `x` header for the next entry.
#[derive(Default)]
struct Pax {
    path: Option<String>,
    size: Option<u64>,
}

impl<R: Read> Extractor<'_, R> {
    fn run(mut self) -> Result<TarReport, TarError> {
        let mut pax = Pax::default();
        loop {
            self.check_deadline()?;
            let Some(header) = self.read_block()? else {
                return Err(TarError::Malformed("no end-of-archive marker".into()));
            };
            if header.iter().all(|b| *b == 0) {
                // End of archive (the second zero block, if any, is ignored).
                return Ok(self.report);
            }
            verify_checksum(&header)?;
            let size = octal(&header[124..136], "size")?;
            let typeflag = header[156];
            match typeflag {
                b'x' => {
                    if pax.path.is_some() || pax.size.is_some() {
                        return Err(TarError::Malformed("two pax headers for one entry".into()));
                    }
                    pax = self.read_pax(size)?;
                    continue;
                }
                b'g' => {
                    // Global pax headers carry nothing the node uses.
                    if size > self.caps.pax_bytes {
                        return Err(TarError::Malformed("pax header too large".into()));
                    }
                    self.skip(size)?;
                    continue;
                }
                _ => {}
            }
            let raw_name = match pax.path.take() {
                Some(p) => p,
                None => header_name(&header)?,
            };
            let size = pax.size.take().unwrap_or(size);
            let kind = match typeflag {
                b'0' | 0 | b'7' => Kind::File,
                b'5' => Kind::Dir,
                b'1' => return Err(rule("T1", Some(&raw_name), "hard link")),
                b'2' => return Err(rule("T1", Some(&raw_name), "symbolic link")),
                b'3' | b'4' => return Err(rule("T1", Some(&raw_name), "device")),
                b'6' => return Err(rule("T1", Some(&raw_name), "FIFO")),
                b'S' => return Err(rule("T1", Some(&raw_name), "sparse file")),
                other => {
                    return Err(rule(
                        "T1",
                        Some(&raw_name),
                        format!("entry type {:?} is not a file or directory", other as char),
                    ));
                }
            };
            // The `./` entry that `tar -C <dir> .` writes.
            if kind == Kind::Dir && matches!(raw_name.as_str(), "." | "./") {
                self.skip(size)?;
                continue;
            }
            self.entries += 1;
            if self.entries > self.caps.entries {
                return Err(rule(
                    "T3",
                    None,
                    format!("more than {} entries", self.caps.entries),
                ));
            }
            let path = normalise(&raw_name, kind)?;
            self.check_unique(&path, kind)?;
            match kind {
                Kind::Dir => {
                    self.skip(size)?;
                    fs::create_dir_all(self.dest.join(&path)).map_err(io)?;
                    self.report.dirs += 1;
                }
                Kind::File => {
                    if size > self.caps.file_bytes {
                        return Err(rule(
                            "T5",
                            Some(&path),
                            format!("file larger than {} bytes", self.caps.file_bytes),
                        ));
                    }
                    if self.report.bytes + size > self.caps.total_bytes {
                        return Err(rule(
                            "T2",
                            Some(&path),
                            format!("files larger than {} bytes in total", self.caps.total_bytes),
                        ));
                    }
                    self.write_file(&path, size)?;
                    self.report.files += 1;
                    self.report.bytes += size;
                }
            }
        }
    }

    fn check_deadline(&self) -> Result<(), TarError> {
        if self.started.elapsed() >= self.caps.deadline {
            return Err(rule(
                "T8",
                None,
                format!("extraction took longer than {:?}", self.caps.deadline),
            ));
        }
        Ok(())
    }

    /// One block, or `None` at a clean end of input.
    fn read_block(&mut self) -> Result<Option<[u8; BLOCK]>, TarError> {
        let mut block = [0u8; BLOCK];
        let mut read = 0;
        while read < BLOCK {
            match self.src.read(&mut block[read..]) {
                Ok(0) if read == 0 => return Ok(None),
                Ok(0) => return Err(TarError::Malformed("truncated block".into())),
                Ok(n) => read += n,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                Err(e) => return Err(io(e)),
            }
        }
        Ok(Some(block))
    }

    fn padded(size: u64) -> u64 {
        size.div_ceil(BLOCK as u64) * BLOCK as u64
    }

    /// Reads `size` bytes of entry data (plus padding) into `sink`.
    fn copy(
        &mut self,
        size: u64,
        mut sink: impl FnMut(&[u8]) -> Result<(), TarError>,
    ) -> Result<(), TarError> {
        let mut left = Self::padded(size);
        let mut data_left = size;
        while left > 0 {
            self.check_deadline()?;
            let block = self
                .read_block()?
                .ok_or_else(|| TarError::Malformed("truncated entry".into()))?;
            let take = data_left.min(BLOCK as u64) as usize;
            if take > 0 {
                sink(&block[..take])?;
            }
            data_left -= take as u64;
            left -= BLOCK as u64;
        }
        Ok(())
    }

    fn skip(&mut self, size: u64) -> Result<(), TarError> {
        self.copy(size, |_| Ok(()))
    }

    fn write_file(&mut self, path: &str, size: u64) -> Result<(), TarError> {
        let target = self.dest.join(path);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(io)?;
        }
        let mut file: File = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
            .map_err(io)?;
        self.copy(size, |chunk| file.write_all(chunk).map_err(io))?;
        file.flush().map_err(io)
    }

    fn read_pax(&mut self, size: u64) -> Result<Pax, TarError> {
        if size > self.caps.pax_bytes {
            return Err(TarError::Malformed("pax header too large".into()));
        }
        let mut data = Vec::with_capacity(size as usize);
        self.copy(size, |chunk| {
            data.extend_from_slice(chunk);
            Ok(())
        })?;
        parse_pax(&data)
    }

    /// T7: a path appears once, and never as both a file and a directory.
    fn check_unique(&mut self, path: &str, kind: Kind) -> Result<(), TarError> {
        if self.kinds.contains_key(path) {
            return Err(rule("T7", Some(path), "the path appears twice"));
        }
        if kind == Kind::File && self.implicit_dirs.contains(path) {
            return Err(rule(
                "T7",
                Some(path),
                "the path is both a file and a directory",
            ));
        }
        let mut parent = path;
        while let Some((p, _)) = parent.rsplit_once('/') {
            if self.kinds.get(p) == Some(&Kind::File) {
                return Err(rule(
                    "T7",
                    Some(p),
                    "the path is both a file and a directory",
                ));
            }
            self.implicit_dirs.insert(p.to_string());
            parent = p;
        }
        self.kinds.insert(path.to_string(), kind);
        Ok(())
    }
}

/// T4: one leading `./` removed, a directory's trailing `/` removed, then
/// the `artifact.md` path rules and NFC.
fn normalise(raw: &str, kind: Kind) -> Result<String, TarError> {
    let mut p = raw.strip_prefix("./").unwrap_or(raw);
    if kind == Kind::Dir {
        p = p.strip_suffix('/').unwrap_or(p);
    }
    check_relative_path(p).map_err(|reason| rule("T4", Some(raw), reason))?;
    if !is_nfc(p) {
        return Err(rule("T4", Some(raw), "not in Unicode NFC"));
    }
    Ok(p.to_string())
}

fn verify_checksum(header: &[u8; BLOCK]) -> Result<(), TarError> {
    let stored = octal(&header[148..156], "checksum")?;
    let sum: u64 = header
        .iter()
        .enumerate()
        .map(|(i, b)| {
            if (148..156).contains(&i) {
                32
            } else {
                u64::from(*b)
            }
        })
        .sum();
    if sum != stored {
        return Err(TarError::Malformed("header checksum mismatch".into()));
    }
    Ok(())
}

/// A NUL- or space-terminated octal field. Base-256 numbers are refused:
/// no entry within the caps needs one.
fn octal(field: &[u8], what: &str) -> Result<u64, TarError> {
    if field.first().is_some_and(|b| b & 0x80 != 0) {
        return Err(TarError::Malformed(format!("{what}: base-256 number")));
    }
    let digits: Vec<u8> = field
        .iter()
        .copied()
        .skip_while(|b| *b == b' ')
        .take_while(|b| *b != 0 && *b != b' ')
        .collect();
    if digits.is_empty() {
        return Ok(0);
    }
    let text = std::str::from_utf8(&digits)
        .map_err(|_| TarError::Malformed(format!("{what}: not octal")))?;
    u64::from_str_radix(text, 8).map_err(|_| TarError::Malformed(format!("{what}: not octal")))
}

fn cstr(field: &[u8]) -> &[u8] {
    let end = field.iter().position(|b| *b == 0).unwrap_or(field.len());
    &field[..end]
}

/// `name`, with the ustar `prefix` in front when the magic says ustar.
fn header_name(header: &[u8; BLOCK]) -> Result<String, TarError> {
    let name = cstr(&header[0..100]);
    let prefix = if &header[257..262] == b"ustar" {
        cstr(&header[345..500])
    } else {
        &[]
    };
    let mut full = Vec::with_capacity(prefix.len() + 1 + name.len());
    if !prefix.is_empty() {
        full.extend_from_slice(prefix);
        full.push(b'/');
    }
    full.extend_from_slice(name);
    String::from_utf8(full).map_err(|_| rule("T4", None, "entry name is not UTF-8"))
}

/// Pax records `"<len> <key>=<value>\n"`; only `path` and `size` are used.
fn parse_pax(data: &[u8]) -> Result<Pax, TarError> {
    let bad = || TarError::Malformed("bad pax record".into());
    let mut pax = Pax::default();
    let mut rest = data;
    while !rest.is_empty() {
        if rest.iter().all(|b| *b == 0) {
            break;
        }
        let space = rest.iter().position(|b| *b == b' ').ok_or_else(bad)?;
        let len: usize = std::str::from_utf8(&rest[..space])
            .ok()
            .and_then(|s| s.parse().ok())
            .ok_or_else(bad)?;
        if len <= space + 1 || len > rest.len() || rest[len - 1] != b'\n' {
            return Err(bad());
        }
        let record = &rest[space + 1..len - 1];
        let eq = record.iter().position(|b| *b == b'=').ok_or_else(bad)?;
        let (key, value) = (&record[..eq], &record[eq + 1..]);
        match key {
            b"path" => {
                pax.path = Some(
                    String::from_utf8(value.to_vec())
                        .map_err(|_| rule("T4", None, "pax path is not UTF-8"))?,
                )
            }
            b"size" => {
                pax.size = Some(
                    std::str::from_utf8(value)
                        .ok()
                        .and_then(|s| s.parse().ok())
                        .ok_or_else(bad)?,
                )
            }
            _ => {}
        }
        rest = &rest[len..];
    }
    Ok(pax)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static N: AtomicU64 = AtomicU64::new(0);

    fn dest() -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!(
            "renox-tar-safe-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::SeqCst)
        ));
        fs::create_dir_all(&root).unwrap();
        root.join("out")
    }

    fn header(name: &str, size: u64, typeflag: u8) -> [u8; BLOCK] {
        let mut h = [0u8; BLOCK];
        h[..name.len()].copy_from_slice(name.as_bytes());
        h[100..107].copy_from_slice(b"0000644");
        h[124..136].copy_from_slice(format!("{size:011o}\0").as_bytes());
        h[136..148].copy_from_slice(b"00000000000\0");
        h[156] = typeflag;
        h[257..263].copy_from_slice(b"ustar\0");
        h[263..265].copy_from_slice(b"00");
        h[148..156].copy_from_slice(b"        ");
        let sum: u64 = h.iter().map(|b| u64::from(*b)).sum();
        h[148..156].copy_from_slice(format!("{sum:06o}\0 ").as_bytes());
        h
    }

    #[derive(Default)]
    struct Tar(Vec<u8>);

    impl Tar {
        fn entry(mut self, name: &str, typeflag: u8, data: &[u8]) -> Self {
            self.0
                .extend_from_slice(&header(name, data.len() as u64, typeflag));
            self.0.extend_from_slice(data);
            let pad = (BLOCK - data.len() % BLOCK) % BLOCK;
            self.0.extend(std::iter::repeat_n(0, pad));
            self
        }
        fn file(self, name: &str, data: &[u8]) -> Self {
            self.entry(name, b'0', data)
        }
        fn dir(self, name: &str) -> Self {
            self.entry(name, b'5', b"")
        }
        fn pax(self, records: &[(&str, &str)]) -> Self {
            let mut body = String::new();
            for (k, v) in records {
                let rec = format!(" {k}={v}\n");
                let mut len = rec.len() + 1;
                while format!("{len}{rec}").len() != len {
                    len += 1;
                }
                body.push_str(&format!("{len}{rec}"));
            }
            self.entry("PaxHeader", b'x', body.as_bytes())
        }
        fn end(mut self) -> Vec<u8> {
            self.0.extend(std::iter::repeat_n(0, 2 * BLOCK));
            self.0
        }
    }

    fn run(tar: Vec<u8>, caps: &TarCaps) -> (Result<TarReport, TarError>, std::path::PathBuf) {
        let d = dest();
        (extract(tar.as_slice(), &d, caps), d)
    }

    fn rule_of(r: Result<TarReport, TarError>) -> &'static str {
        match r {
            Err(TarError::Rule { rule, .. }) => rule,
            other => panic!("expected a rule violation, got {other:?}"),
        }
    }

    #[test]
    fn extracts_files_and_directories() {
        let tar = Tar::default()
            .dir("./")
            .dir("./code/")
            .file("./manifest.json", b"{}")
            .file("./code/a.js", &[7u8; 1500])
            .end();
        let (r, d) = run(tar, &TarCaps::default());
        assert_eq!(
            r.unwrap(),
            TarReport {
                files: 2,
                dirs: 1,
                bytes: 1502
            }
        );
        assert_eq!(fs::read(d.join("manifest.json")).unwrap(), b"{}");
        assert_eq!(fs::read(d.join("code/a.js")).unwrap(), vec![7u8; 1500]);
    }

    #[test]
    fn pax_path_and_size_apply_to_the_next_entry() {
        let long = format!("code/{}/x.js", "d".repeat(150));
        let tar = Tar::default()
            .pax(&[("path", &long), ("mtime", "1.5")])
            .file("short", b"abc")
            .end();
        let (r, d) = run(tar, &TarCaps::default());
        assert_eq!(r.unwrap().files, 1);
        assert_eq!(fs::read(d.join(&long)).unwrap(), b"abc");
    }

    /// `docs/24-threat-model.md` section E (artifact upload) and
    /// `docs/23-failure-modes.md` "Malicious artifact": T1, links and
    /// special files.
    #[test]
    fn links_devices_and_fifos_are_refused() {
        for flag in *b"12346SL" {
            let tar = Tar::default().entry("x", flag, b"").end();
            let (r, d) = run(tar, &TarCaps::default());
            assert_eq!(rule_of(r), "T1", "type {}", flag as char);
            assert!(!d.exists(), "nothing stays on disk");
        }
    }

    /// T4: traversal and absolute paths never leave `dest`.
    #[test]
    fn unsafe_paths_are_refused() {
        for name in [
            "../evil",
            "/etc/passwd",
            "a/../../b",
            "a\\b",
            "c:x",
            "a//b",
            "./../x",
        ] {
            let tar = Tar::default().file(name, b"x").end();
            let (r, _) = run(tar, &TarCaps::default());
            assert_eq!(rule_of(r), "T4", "{name}");
        }
        let deep = vec!["d"; 33].join("/");
        let (r, _) = run(
            Tar::default().pax(&[("path", &deep)]).file("x", b"").end(),
            &TarCaps::default(),
        );
        assert_eq!(rule_of(r), "T4");
        let (r, _) = run(
            Tar::default().file("e\u{301}.js", b"").end(),
            &TarCaps::default(),
        );
        assert_eq!(rule_of(r), "T4", "NFD name");
    }

    #[test]
    fn caps_on_entries_and_sizes() {
        let caps = TarCaps {
            entries: 3,
            total_bytes: 10,
            file_bytes: 6,
            ..TarCaps::default()
        };
        let many = Tar::default()
            .file("a", b"")
            .file("b", b"")
            .file("c", b"")
            .file("d", b"")
            .end();
        assert_eq!(rule_of(run(many, &caps).0), "T3");
        let big = Tar::default().file("a", b"1234567").end();
        assert_eq!(rule_of(run(big, &caps).0), "T5");
        let total = Tar::default()
            .file("a", b"123456")
            .file("b", b"12345")
            .end();
        let (r, d) = run(total, &caps);
        assert_eq!(rule_of(r), "T2");
        assert!(!d.exists(), "the first file is removed again");
        // A pax size cannot hide a large entry behind a small ustar size.
        let mut lied = Tar::default().pax(&[("size", "7")]).end();
        lied.truncate(lied.len() - 2 * BLOCK);
        lied.extend_from_slice(&header("a", 0, b'0'));
        lied.extend_from_slice(&[1u8; BLOCK]);
        lied.extend(std::iter::repeat_n(0, 2 * BLOCK));
        assert_eq!(rule_of(run(lied, &caps).0), "T5");
    }

    #[test]
    fn duplicates_and_file_directory_clashes() {
        let twice = Tar::default().file("a", b"1").file("./a", b"2").end();
        assert_eq!(rule_of(run(twice, &TarCaps::default()).0), "T7");
        let file_then_child = Tar::default().file("a", b"1").file("a/b", b"2").end();
        assert_eq!(rule_of(run(file_then_child, &TarCaps::default()).0), "T7");
        let child_then_file = Tar::default().file("a/b", b"2").file("a", b"1").end();
        assert_eq!(rule_of(run(child_then_file, &TarCaps::default()).0), "T7");
        let dir_twice = Tar::default().dir("a/").dir("a").end();
        assert_eq!(rule_of(run(dir_twice, &TarCaps::default()).0), "T7");
    }

    #[test]
    fn deadline() {
        let caps = TarCaps {
            deadline: Duration::ZERO,
            ..TarCaps::default()
        };
        let tar = Tar::default().file("a", b"1").end();
        assert_eq!(rule_of(run(tar, &caps).0), "T8");
    }

    #[test]
    fn malformed_archives() {
        let mut bad_sum = Tar::default().file("a", b"1").end();
        bad_sum[0] = b'b';
        assert!(matches!(
            run(bad_sum, &TarCaps::default()).0,
            Err(TarError::Malformed(_))
        ));
        let mut truncated = Tar::default().file("a", &[1u8; 600]).end();
        truncated.truncate(BLOCK + 100);
        let (r, d) = run(truncated, &TarCaps::default());
        assert!(matches!(r, Err(TarError::Malformed(_))));
        assert!(!d.exists());
        let no_end = Tar::default().file("a", b"1").0;
        assert!(matches!(
            run(no_end, &TarCaps::default()).0,
            Err(TarError::Malformed(_))
        ));
    }

    #[test]
    fn destination_must_be_new() {
        let d = dest();
        fs::create_dir_all(&d).unwrap();
        let tar = Tar::default().file("a", b"1").end();
        assert!(matches!(
            extract(tar.as_slice(), &d, &TarCaps::default()),
            Err(TarError::Io(_))
        ));
    }
}
