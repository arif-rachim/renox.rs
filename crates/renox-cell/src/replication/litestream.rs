//! The Litestream binary (#255, pinned by `ops/litestream.lock`, 0.3.x):
//! the config file per tenant file, `litestream replicate`,
//! `litestream restore`, `litestream generations`.

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::config::{ReplicaKind, ReplicationSection};

/// A YAML double-quoted scalar (JSON string syntax is valid YAML).
fn q(s: &str) -> String {
    serde_json::Value::String(s.to_string()).to_string()
}

/// The replica URL-ish location of `database`, for logs and status.
pub fn replica_location(r: &ReplicationSection, database: &str) -> String {
    match r.replica {
        ReplicaKind::File => r
            .path
            .as_deref()
            .unwrap_or(Path::new("."))
            .join(database)
            .display()
            .to_string(),
        ReplicaKind::S3 => format!(
            "s3://{}/{}",
            r.bucket.as_deref().unwrap_or(""),
            prefix_join(&r.prefix, database)
        ),
    }
}

fn prefix_join(prefix: &str, database: &str) -> String {
    let p = prefix.trim_matches('/');
    if p.is_empty() {
        database.to_string()
    } else {
        format!("{p}/{database}")
    }
}

/// The `litestream.yml` of one tenant file: one database, one replica.
pub fn config_yaml(r: &ReplicationSection, file: &Path, database: &str) -> String {
    let mut y = String::from("# Written by renox-worker (#255); one tenant file.\ndbs:\n");
    y.push_str(&format!(
        "  - path: {}\n    replicas:\n",
        q(&file.display().to_string())
    ));
    match r.replica {
        ReplicaKind::File => {
            y.push_str("      - type: file\n");
            y.push_str(&format!(
                "        path: {}\n",
                q(&replica_location(r, database))
            ));
        }
        ReplicaKind::S3 => {
            y.push_str("      - type: s3\n");
            y.push_str(&format!(
                "        bucket: {}\n",
                q(r.bucket.as_deref().unwrap_or(""))
            ));
            y.push_str(&format!(
                "        path: {}\n",
                q(&prefix_join(&r.prefix, database))
            ));
            if let Some(region) = &r.region {
                y.push_str(&format!("        region: {}\n", q(region)));
            }
            if let Some(endpoint) = &r.endpoint {
                y.push_str(&format!(
                    "        endpoint: {}\n        force-path-style: true\n",
                    q(endpoint)
                ));
            }
        }
    }
    y.push_str(&format!(
        "        sync-interval: {}ms\n",
        r.sync_interval_ms
    ));
    y.push_str(&format!(
        "        retention: {}h\n",
        r.retention_hours.max(1)
    ));
    y.push_str(&format!(
        "        snapshot-interval: {}s\n",
        r.snapshot_interval_secs.max(1)
    ));
    y
}

/// Writes the config of `database` under `<run_dir>/litestream/`.
pub fn write_config(
    run_dir: &Path,
    r: &ReplicationSection,
    file: &Path,
    database: &str,
) -> std::io::Result<PathBuf> {
    let dir = run_dir.join("litestream");
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(format!("{database}.yml"));
    std::fs::write(&path, config_yaml(r, file, database))?;
    Ok(path)
}

/// The binary is there and runs.
pub fn available(bin: &Path) -> bool {
    Command::new(bin)
        .arg("version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

/// One line of `litestream generations`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Generation {
    pub id: String,
    pub start_ms: u64,
    pub end_ms: u64,
}

/// Parses the table `litestream generations` prints:
/// `name generation lag start end`, times in RFC 3339 (UTC).
pub fn parse_generations(out: &str) -> Vec<Generation> {
    let mut gens: Vec<Generation> = out
        .lines()
        .skip_while(|l| !l.trim_start().starts_with("name"))
        .skip(1)
        .filter_map(|l| {
            let cols: Vec<&str> = l.split_whitespace().collect();
            if cols.len() < 5 {
                return None;
            }
            let id = cols[1];
            if id.len() != 16 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
                return None;
            }
            Some(Generation {
                id: id.to_ascii_lowercase(),
                start_ms: rfc3339_ms(cols[cols.len() - 2])?,
                end_ms: rfc3339_ms(cols[cols.len() - 1])?,
            })
        })
        .collect();
    gens.sort_by_key(|g| std::cmp::Reverse(g.end_ms));
    gens
}

/// The generations of the tables `litestream snapshots` and `litestream
/// wal` print (`replica generation … created`, one row per file): a
/// generation spans from its oldest file to its newest. Newest first.
pub fn generations_of_files(out: &str) -> Vec<Generation> {
    let mut spans: std::collections::BTreeMap<String, (u64, u64)> = Default::default();
    for l in out.lines() {
        let cols: Vec<&str> = l.split_whitespace().collect();
        if cols.len() < 3 {
            continue;
        }
        let id = cols[1];
        if id.len() != 16 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
            continue;
        }
        let Some(at) = rfc3339_ms(cols[cols.len() - 1]) else {
            continue;
        };
        let span = spans.entry(id.to_ascii_lowercase()).or_insert((at, at));
        span.0 = span.0.min(at);
        span.1 = span.1.max(at);
    }
    let mut gens: Vec<Generation> = spans
        .into_iter()
        .map(|(id, (start_ms, end_ms))| Generation {
            id,
            start_ms,
            end_ms,
        })
        .collect();
    gens.sort_by_key(|g| std::cmp::Reverse(g.end_ms));
    gens
}

/// `2026-10-29T12:00:00Z` or with fractional seconds → Unix ms.
pub fn rfc3339_ms(s: &str) -> Option<u64> {
    let s = s.strip_suffix('Z')?;
    let (date, time) = s.split_once('T')?;
    let mut d = date.split('-').map(|x| x.parse::<i64>());
    let (y, m, day) = (d.next()?.ok()?, d.next()?.ok()?, d.next()?.ok()?);
    let (hms, frac) = time.split_once('.').unwrap_or((time, ""));
    let mut t = hms.split(':').map(|x| x.parse::<i64>());
    let (hh, mm, ss) = (t.next()?.ok()?, t.next()?.ok()?, t.next()?.ok()?);
    let ms_frac: i64 = format!("{:0<3}", &frac[..frac.len().min(3)])
        .parse()
        .unwrap_or(0);
    // Days from civil (Howard Hinnant's algorithm).
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let secs = days * 86_400 + hh * 3600 + mm * 60 + ss;
    u64::try_from(secs * 1000 + ms_frac).ok()
}

/// Unix ms → `2026-10-29T12:00:00Z` (for `restore -timestamp`).
pub fn ms_rfc3339(ms: u64) -> String {
    let secs = (ms / 1000) as i64;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn times_round_trip() {
        assert_eq!(rfc3339_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(rfc3339_ms("2026-10-29T12:00:00Z"), Some(1_793_275_200_000));
        assert_eq!(
            rfc3339_ms("2026-10-29T12:00:00.250Z"),
            Some(1_793_275_200_250)
        );
        assert_eq!(ms_rfc3339(1_793_275_200_000), "2026-10-29T12:00:00Z");
        assert_eq!(rfc3339_ms("garbage"), None);
    }

    #[test]
    fn generations_from_snapshots_and_wal_files() {
        let out = "replica  generation        index  size  created\n\
                   file     56382955d36956c7  0      354   2026-10-29T14:56:26Z\n\
                   file     0123456789abcdef  0      300   2026-10-29T10:00:00Z\n\n\
                   replica  generation        index  offset  size  created\n\
                   file     56382955d36956c7  0      0       504   2026-10-29T14:56:30Z\n\
                   file     56382955d36956c7  1      0       504   2026-10-29T14:58:00Z\n";
        let g = generations_of_files(out);
        assert_eq!(g.len(), 2);
        assert_eq!(g[0].id, "56382955d36956c7");
        assert_eq!(g[0].start_ms, rfc3339_ms("2026-10-29T14:56:26Z").unwrap());
        assert_eq!(g[0].end_ms, rfc3339_ms("2026-10-29T14:58:00Z").unwrap());
        assert_eq!(
            (g[1].start_ms, g[1].end_ms),
            (
                rfc3339_ms("2026-10-29T10:00:00Z").unwrap(),
                rfc3339_ms("2026-10-29T10:00:00Z").unwrap()
            )
        );
        assert!(generations_of_files("no table here\n").is_empty());
    }

    #[test]
    fn generations_table() {
        let out = "name  generation        lag      start                 end\nfile  a1b2c3d4e5f60718  1s       2026-10-29T11:00:00Z  2026-10-29T12:00:00Z\nfile  00000000000000ff  0s       2026-10-29T12:00:01Z  2026-10-29T12:30:00Z\n";
        let g = parse_generations(out);
        assert_eq!(g.len(), 2);
        assert_eq!(g[0].id, "00000000000000ff");
        assert_eq!(g[1].start_ms, 1_793_271_600_000);
        assert!(parse_generations("no replicas\n").is_empty());
    }

    #[test]
    fn config_for_both_replica_kinds() {
        let mut r = ReplicationSection {
            enabled: true,
            path: Some("/var/lib/renox/replica".into()),
            ..Default::default()
        };
        let y = config_yaml(&r, Path::new("/var/lib/renox/data/t_a/app.db"), "t_a");
        assert!(
            y.contains("type: file") && y.contains("\"/var/lib/renox/replica/t_a\""),
            "{y}"
        );
        assert!(
            y.contains("sync-interval: 1000ms")
                && y.contains("retention: 24h")
                && y.contains("snapshot-interval: 3600s"),
            "{y}"
        );
        r.replica = ReplicaKind::S3;
        r.bucket = Some("renox-replica".into());
        r.prefix = "tenants/".into();
        r.region = Some("me-central-1".into());
        let y = config_yaml(&r, Path::new("/d/app.db"), "t_a");
        assert!(
            y.contains("type: s3")
                && y.contains("path: \"tenants/t_a\"")
                && y.contains("region: \"me-central-1\""),
            "{y}"
        );
        assert!(
            !y.contains("AWS_SECRET"),
            "credentials never go into the file"
        );
    }
}
