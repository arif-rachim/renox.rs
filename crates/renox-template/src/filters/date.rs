//! Dates for the `date` and `ago` filters: ISO 8601 / Unix-millisecond
//! parsing, Gregorian calendar arithmetic, and the `en-AE` / `ar-AE`
//! patterns (Arabic plural categories for `ago`).

use minijinja::value::{Value, ValueKind};
use minijinja::{Error, ErrorKind};

use super::localize_digits;
use crate::render::{Lang, Locale};

/// A parsed timestamp. `date_only` values (`2026-10-28`) are calendar dates
/// and are never shifted by the time-zone offset.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Timestamp {
    pub ms: i64,
    pub date_only: bool,
}

fn bad(value: &Value) -> Error {
    Error::new(
        ErrorKind::InvalidOperation,
        format!(
            "expected an ISO 8601 date or Unix milliseconds, got {}",
            value.kind()
        ),
    )
}

/// Days since 1970-01-01 of a proleptic Gregorian date (H. Hinnant's
/// `days_from_civil`).
pub fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let m = m as i64;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The date of a day number (inverse of [`days_from_civil`]).
pub fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn num(s: &str) -> Option<i64> {
    (!s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
        .then(|| s.parse().ok())
        .flatten()
}

/// `YYYY-MM-DD`, or `YYYY-MM-DDTHH:MM[:SS[.fff]](Z|±HH:MM)`; a date-time
/// without an offset is UTC.
fn parse_iso(s: &str) -> Option<Timestamp> {
    let s = s.trim();
    let (date, time) = match s.find(['T', ' ']) {
        Some(i) => (&s[..i], Some(&s[i + 1..])),
        None => (s, None),
    };
    let mut parts = date.split('-');
    let y = num(parts.next()?)?;
    let m = num(parts.next()?)? as u32;
    let d = num(parts.next()?)? as u32;
    if parts.next().is_some() || !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    let days = days_from_civil(y, m, d);
    let Some(time) = time else {
        return Some(Timestamp {
            ms: days * 86_400_000,
            date_only: true,
        });
    };
    let (clock, offset_min) = if let Some(c) = time.strip_suffix('Z') {
        (c, 0)
    } else if let Some(i) = time.rfind(['+', '-']) {
        let (c, off) = time.split_at(i);
        let sign = if off.starts_with('-') { -1 } else { 1 };
        let (oh, om) = off[1..].split_once(':').unwrap_or((&off[1..], "0"));
        (c, sign * (num(oh)? * 60 + num(om)?))
    } else {
        (time, 0)
    };
    let mut c = clock.split(':');
    let h = num(c.next()?)?;
    let mi = num(c.next()?)?;
    let (sec, frac_ms) = match c.next() {
        Some(sec) => match sec.split_once('.') {
            Some((s, f)) => {
                let f3: String = f.chars().chain("000".chars()).take(3).collect();
                (num(s)?, num(&f3)?)
            }
            None => (num(sec)?, 0),
        },
        None => (0, 0),
    };
    if h > 23 || mi > 59 || sec > 60 {
        return None;
    }
    let ms = days * 86_400_000 + ((h * 60 + mi - offset_min) * 60 + sec) * 1000 + frac_ms;
    Some(Timestamp {
        ms,
        date_only: false,
    })
}

pub fn parse_timestamp(value: &Value) -> Result<Timestamp, Error> {
    match value.kind() {
        ValueKind::Number => {
            let ms = f64::try_from(value.clone()).map_err(|_| bad(value))?;
            if !ms.is_finite() {
                return Err(bad(value));
            }
            Ok(Timestamp {
                ms: ms as i64,
                date_only: false,
            })
        }
        ValueKind::String => parse_iso(value.as_str().unwrap_or("")).ok_or_else(|| bad(value)),
        _ => Err(bad(value)),
    }
}

const EN_MONTHS_SHORT: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const EN_MONTHS: [&str; 12] = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
];
const AR_MONTHS: [&str; 12] = [
    "يناير",
    "فبراير",
    "مارس",
    "أبريل",
    "مايو",
    "يونيو",
    "يوليو",
    "أغسطس",
    "سبتمبر",
    "أكتوبر",
    "نوفمبر",
    "ديسمبر",
];

/// Formats a timestamp. `offset_minutes` is the app's UTC offset; it is not
/// applied to date-only values.
pub fn format_date(
    ts: Timestamp,
    style: &str,
    offset_minutes: i32,
    locale: Locale,
) -> Result<String, Error> {
    let local = if ts.date_only {
        ts.ms
    } else {
        ts.ms + offset_minutes as i64 * 60_000
    };
    let days = local.div_euclid(86_400_000);
    let in_day = local.rem_euclid(86_400_000) / 1000;
    let (y, m, d) = civil_from_days(days);
    let (hh, mm) = (in_day / 3600, (in_day / 60) % 60);
    let mi = (m - 1) as usize;
    let time = format!("{hh:02}:{mm:02}");
    let s = match (style, locale.lang) {
        ("short", Lang::En) => format!("{d:02}/{m:02}/{y}"),
        // CLDR ar: d‏/M‏/y with right-to-left marks after day and month.
        ("short", Lang::Ar) => format!("{d}\u{200f}/{m}\u{200f}/{y}"),
        ("medium", Lang::En) => format!("{d} {} {y}", EN_MONTHS_SHORT[mi]),
        ("long", Lang::En) => format!("{d} {} {y}", EN_MONTHS[mi]),
        ("medium" | "long", Lang::Ar) => format!("{d} {} {y}", AR_MONTHS[mi]),
        ("datetime", Lang::En) => format!("{d} {} {y}, {time}", EN_MONTHS_SHORT[mi]),
        ("datetime", Lang::Ar) => format!("{d} {} {y}، {time}", AR_MONTHS[mi]),
        ("time", _) => time,
        (other, _) => {
            return Err(Error::new(
                ErrorKind::InvalidOperation,
                format!("unknown date style `{other}` (short, medium, long, datetime, time)"),
            ));
        }
    };
    Ok(localize_digits(&s, locale))
}

/// CLDR plural category for Arabic.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ArPlural {
    Zero,
    One,
    Two,
    Few,
    Many,
    Other,
}

fn ar_plural(n: u64) -> ArPlural {
    match (n, n % 100) {
        (0, _) => ArPlural::Zero,
        (1, _) => ArPlural::One,
        (2, _) => ArPlural::Two,
        (_, 3..=10) => ArPlural::Few,
        (_, 11..=99) => ArPlural::Many,
        _ => ArPlural::Other,
    }
}

/// (one, two, few, many/other) forms of each unit.
const AR_UNITS: [(&str, &str, &str, &str); 6] = [
    ("ثانية واحدة", "ثانيتين", "ثوانٍ", "ثانية"),
    ("دقيقة واحدة", "دقيقتين", "دقائق", "دقيقة"),
    ("ساعة واحدة", "ساعتين", "ساعات", "ساعة"),
    ("يوم واحد", "يومين", "أيام", "يومًا"),
    ("شهر واحد", "شهرين", "أشهر", "شهرًا"),
    ("سنة واحدة", "سنتين", "سنوات", "سنة"),
];
const EN_UNITS: [&str; 6] = ["second", "minute", "hour", "day", "month", "year"];

/// "3 minutes ago" / "in 2 days"; "قبل 3 دقائق" / "خلال يومين".
pub fn format_ago(now_ms: i64, ts_ms: i64, locale: Locale) -> String {
    let diff = (now_ms - ts_ms) / 1000;
    let past = diff >= 0;
    let secs = diff.unsigned_abs();
    if secs < 45 {
        return match locale.lang {
            Lang::En => "just now".into(),
            Lang::Ar => "الآن".into(),
        };
    }
    let (unit, n) = if secs < 3600 {
        (1, (secs + 30) / 60)
    } else if secs < 86_400 {
        (2, (secs + 1800) / 3600)
    } else if secs < 30 * 86_400 {
        (3, (secs + 43_200) / 86_400)
    } else if secs < 365 * 86_400 {
        (4, secs / (30 * 86_400))
    } else {
        (5, secs / (365 * 86_400))
    };
    let n = n.max(1);
    let s = match locale.lang {
        Lang::En => {
            let unit = EN_UNITS[unit];
            let plural = if n == 1 { "" } else { "s" };
            if past {
                format!("{n} {unit}{plural} ago")
            } else {
                format!("in {n} {unit}{plural}")
            }
        }
        Lang::Ar => {
            let (one, two, few, many) = AR_UNITS[unit];
            let phrase = match ar_plural(n) {
                ArPlural::One => one.to_string(),
                ArPlural::Two => two.to_string(),
                ArPlural::Few => format!("{n} {few}"),
                ArPlural::Zero | ArPlural::Many | ArPlural::Other => format!("{n} {many}"),
            };
            if past {
                format!("قبل {phrase}")
            } else {
                format!("خلال {phrase}")
            }
        }
    };
    localize_digits(&s, locale)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn calendar_round_trip() {
        for days in [-719_468, -1, 0, 1, 20_000, 20_754, 2_932_896] {
            let (y, m, d) = civil_from_days(days);
            assert_eq!(days_from_civil(y, m, d), days);
        }
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(days_from_civil(2026, 10, 28), 20_754);
    }

    #[test]
    fn iso_parsing() {
        let t = parse_iso("2026-10-28T10:30:00Z").unwrap();
        assert_eq!(t.ms, 20_754 * 86_400_000 + (10 * 60 + 30) * 60_000);
        let t2 = parse_iso("2026-10-28T14:30:00+04:00").unwrap();
        assert_eq!(t2.ms, t.ms);
        assert!(parse_iso("2026-10-28").unwrap().date_only);
        assert_eq!(parse_iso("2026-10-28T10:30:00.5Z").unwrap().ms, t.ms + 500);
        for bad in ["", "2026-13-01", "28/10/2026", "2026-10-28T25:00Z"] {
            assert!(parse_iso(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn arabic_plural_categories() {
        assert_eq!(ar_plural(1), ArPlural::One);
        assert_eq!(ar_plural(2), ArPlural::Two);
        assert_eq!(ar_plural(3), ArPlural::Few);
        assert_eq!(ar_plural(10), ArPlural::Few);
        assert_eq!(ar_plural(11), ArPlural::Many);
        assert_eq!(ar_plural(99), ArPlural::Many);
        assert_eq!(ar_plural(100), ArPlural::Other);
        assert_eq!(ar_plural(103), ArPlural::Few);
    }
}
