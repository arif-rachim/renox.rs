//! `/.well-known/security.txt` (RFC 9116) for the platform's own hosts
//! (#121, `docs/24-threat-model.md` "Security process" item 5): how a
//! researcher reaches us. Answered by the gateway before route lookup, for
//! the hosts listed in [`SecurityTxt::hosts`] only; a tenant's hostname
//! serves whatever the tenant's app serves at that path.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::body::Body;
use axum::http::{self, Response, StatusCode, header};

pub const SECURITY_TXT_PATH: &str = "/.well-known/security.txt";

/// How far ahead `Expires` is set when the file is built (RFC 9116 section
/// 2.5.5 recommends less than a year).
pub const EXPIRES_AFTER: Duration = Duration::from_secs(180 * 24 * 3600);

/// The file and the hosts that serve it.
#[derive(Debug, Clone)]
pub struct SecurityTxt {
    /// Lowercase hostnames, without port.
    pub hosts: Vec<String>,
    body: String,
}

/// The fields of the file.
#[derive(Debug, Clone)]
pub struct Fields {
    /// `mailto:` or `https:` URIs, in order of preference.
    pub contacts: Vec<String>,
    pub policy: Option<String>,
    pub canonical: Option<String>,
    pub preferred_languages: Vec<String>,
    pub expires: SystemTime,
}

impl Fields {
    /// The platform's: `security@renox.app`, English and Arabic, expiring
    /// [`EXPIRES_AFTER`] from `now`.
    pub fn platform(now: SystemTime) -> Fields {
        Fields {
            contacts: vec!["mailto:security@renox.app".into()],
            policy: None,
            canonical: Some(format!("https://renox.app{SECURITY_TXT_PATH}")),
            preferred_languages: vec!["en".into(), "ar".into()],
            expires: now + EXPIRES_AFTER,
        }
    }
}

/// RFC 3339 in UTC with a `Z`, seconds precision.
fn rfc3339(t: SystemTime) -> String {
    let secs = t.duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs()) as i64;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3_600,
        rem % 3_600 / 60,
        rem % 60
    )
}

fn parse_rfc3339_utc(s: &str) -> Option<SystemTime> {
    // `YYYY-MM-DDTHH:MM:SSZ` only: what `rfc3339` writes and what RFC 9116
    // examples use.
    let b = s.as_bytes();
    if b.len() != 20 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[19] != b'Z' {
        return None;
    }
    let n = |r: std::ops::Range<usize>| s.get(r)?.parse::<i64>().ok();
    let (y, m, d) = (n(0..4)?, n(5..7)?, n(8..10)?);
    let (hh, mm, ss) = (n(11..13)?, n(14..16)?, n(17..19)?);
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) || hh > 23 || mm > 59 || ss > 60 {
        return None;
    }
    let (y, m) = if m <= 2 { (y - 1, m + 9) } else { (y, m - 3) };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let doy = (153 * m + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let secs = days * 86_400 + hh * 3_600 + mm * 60 + ss;
    u64::try_from(secs)
        .ok()
        .map(|s| UNIX_EPOCH + Duration::from_secs(s))
}

impl SecurityTxt {
    pub fn new(hosts: &[&str], fields: &Fields) -> SecurityTxt {
        let mut body = String::new();
        for c in &fields.contacts {
            body.push_str(&format!("Contact: {c}\n"));
        }
        body.push_str(&format!("Expires: {}\n", rfc3339(fields.expires)));
        if let Some(p) = &fields.policy {
            body.push_str(&format!("Policy: {p}\n"));
        }
        if let Some(c) = &fields.canonical {
            body.push_str(&format!("Canonical: {c}\n"));
        }
        if !fields.preferred_languages.is_empty() {
            body.push_str(&format!(
                "Preferred-Languages: {}\n",
                fields.preferred_languages.join(", ")
            ));
        }
        SecurityTxt {
            hosts: hosts.iter().map(|h| h.to_ascii_lowercase()).collect(),
            body,
        }
    }

    /// The platform's file for `renox.app` and `www.renox.app`.
    pub fn platform(now: SystemTime) -> SecurityTxt {
        SecurityTxt::new(&["renox.app", "www.renox.app"], &Fields::platform(now))
    }

    pub fn body(&self) -> &str {
        &self.body
    }

    /// Whether `host` (lowercase, no port) serves the file.
    pub fn serves(&self, host: &str) -> bool {
        self.hosts.iter().any(|h| h == host)
    }

    /// The response for `GET` and `HEAD`; anything else is 405.
    pub fn response(&self, method: &http::Method) -> Response<Body> {
        let b = Response::builder()
            .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
            .header(header::CACHE_CONTROL, "max-age=86400");
        match *method {
            http::Method::GET => b.status(StatusCode::OK).body(Body::from(self.body.clone())),
            http::Method::HEAD => b.status(StatusCode::OK).body(Body::empty()),
            _ => b
                .status(StatusCode::METHOD_NOT_ALLOWED)
                .header(header::ALLOW, "GET, HEAD")
                .body(Body::empty()),
        }
        .expect("valid response")
    }
}

/// Checks `text` against RFC 9116 section 2.5 as of `now`: at least one
/// `Contact` (a `mailto:`, `https:` or `tel:` URI), exactly one `Expires`
/// in the future and less than a year ahead, at most one `Canonical`,
/// `Preferred-Languages` and `Expires`, no unknown syntax on a line.
pub fn validate(text: &str, now: SystemTime) -> Result<(), String> {
    let mut contacts = 0;
    let mut expires = Vec::new();
    let mut once = std::collections::HashMap::new();
    for (i, line) in text.lines().enumerate() {
        let line = line.trim_end_matches('\r');
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((name, value)) = line.split_once(": ") else {
            return Err(format!("line {}: not `Field: value`", i + 1));
        };
        let name = name.to_ascii_lowercase();
        match name.as_str() {
            "contact" => {
                if !["mailto:", "https://", "tel:"]
                    .iter()
                    .any(|p| value.starts_with(p))
                {
                    return Err(format!(
                        "line {}: Contact is not a mailto/https/tel URI",
                        i + 1
                    ));
                }
                contacts += 1;
            }
            "expires" => expires.push(value.to_string()),
            "canonical" | "policy" | "encryption" | "acknowledgments" | "hiring" => {
                if !value.starts_with("https://") {
                    return Err(format!("line {}: {name} must be an https URI", i + 1));
                }
            }
            "preferred-languages" => {}
            other => return Err(format!("line {}: unknown field {other}", i + 1)),
        }
        if matches!(
            name.as_str(),
            "canonical" | "preferred-languages" | "expires"
        ) {
            *once.entry(name.clone()).or_insert(0) += 1;
            if once[&name] > 1 {
                return Err(format!("{name} appears more than once"));
            }
        }
    }
    if contacts == 0 {
        return Err("no Contact".into());
    }
    let [exp] = expires.as_slice() else {
        return Err("Expires must appear exactly once".into());
    };
    let t = parse_rfc3339_utc(exp).ok_or_else(|| format!("Expires {exp:?} is not RFC 3339"))?;
    if t <= now {
        return Err(format!("Expires {exp} is in the past"));
    }
    if t > now + Duration::from_secs(366 * 24 * 3600) {
        return Err(format!("Expires {exp} is more than a year ahead"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_platform_file_is_valid() {
        let now = SystemTime::now();
        let f = SecurityTxt::platform(now);
        validate(f.body(), now).unwrap();
        assert!(f.body().contains("Contact: mailto:security@renox.app\n"));
        assert!(f.body().contains("Preferred-Languages: en, ar\n"));
        assert!(f.serves("renox.app") && !f.serves("shop.renox.app"));
    }

    #[test]
    fn rfc3339_round_trips() {
        for secs in [0u64, 951_782_400, 1_793_299_128, 4_102_444_800] {
            let t = UNIX_EPOCH + Duration::from_secs(secs);
            assert_eq!(parse_rfc3339_utc(&rfc3339(t)), Some(t), "{secs}");
        }
        assert_eq!(
            rfc3339(UNIX_EPOCH + Duration::from_secs(951_782_400)),
            "2000-02-29T00:00:00Z"
        );
    }

    #[test]
    fn invalid_files_are_refused() {
        let now = UNIX_EPOCH + Duration::from_secs(1_793_299_128); // 2026-10-29
        let ok = "Contact: mailto:a@b.c\nExpires: 2027-01-01T00:00:00Z\n";
        validate(ok, now).unwrap();
        for (bad, why) in [
            ("Expires: 2027-01-01T00:00:00Z\n", "no Contact"),
            ("Contact: mailto:a@b.c\n", "exactly once"),
            (
                "Contact: mailto:a@b.c\nExpires: 2020-01-01T00:00:00Z\n",
                "past",
            ),
            (
                "Contact: mailto:a@b.c\nExpires: 2030-01-01T00:00:00Z\n",
                "a year",
            ),
            ("Contact: a@b.c\nExpires: 2027-01-01T00:00:00Z\n", "URI"),
            (
                "Contact: mailto:a@b.c\nExpires: 2027-01-01T00:00:00Z\nExpires: 2027-01-02T00:00:00Z\n",
                "more than once",
            ),
            (
                "Contact: mailto:a@b.c\nExpires: 2027-01-01T00:00:00Z\nFoo: bar\n",
                "unknown",
            ),
            (
                "Contact: mailto:a@b.c\nExpires: 2027-01-01T00:00:00Z\nPolicy: http://x\n",
                "https",
            ),
        ] {
            let err = validate(bad, now).unwrap_err();
            assert!(err.contains(why), "{bad:?}: {err}");
        }
    }
}
