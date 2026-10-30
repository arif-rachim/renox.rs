//! Platform filters (`docs/08-template-engine.md`): `money`, `date`, `ago`,
//! `number`, `truncate`, `json`, `upper`, `lower`, locale-aware for `en-AE`
//! and `ar-AE` (RTL section: AED formatting, Eastern Arabic digits optional).
//!
//! The locale comes from the render ([`crate::RenderContext::locale`]), not
//! from tenant data. Formatting follows the CLDR patterns for `en-AE` and
//! `ar-AE` written out by hand for the two locales the platform supports,
//! instead of linking ICU data (see the README, "Filters").

use minijinja::value::{Value, ValueKind};
use minijinja::{Error, ErrorKind, State};

use crate::render::{Lang, Locale, scope_of};

mod date;

pub use date::{civil_from_days, format_date};

fn locale(state: &State) -> Locale {
    scope_of(state).map(|s| s.locale).unwrap_or_default()
}

/// A value the loader did not provide (undefined or `null`): formatting
/// filters render it as nothing. A fragment request evaluates the whole page
/// before it renders the block, and its loader may skip the data the rest of
/// the page needs (`docs/08-template-engine.md`, "Optimizations and limits").
fn is_missing(v: &Value) -> bool {
    matches!(v.kind(), ValueKind::Undefined | ValueKind::None)
}

fn to_f64(v: &Value, filter: &str) -> Result<f64, Error> {
    let n = match v.kind() {
        ValueKind::Number => f64::try_from(v.clone()).ok(),
        ValueKind::String => v.as_str().and_then(|s| s.trim().parse::<f64>().ok()),
        _ => None,
    };
    n.filter(|n| n.is_finite()).ok_or_else(|| {
        Error::new(
            ErrorKind::InvalidOperation,
            format!("`{filter}` needs a number, got {}", v.kind()),
        )
    })
}

const ARABIC_DIGITS: [char; 10] = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'];

/// Replaces ASCII digits with Eastern Arabic digits when the locale asks.
pub fn localize_digits(s: &str, locale: Locale) -> String {
    if !locale.arabic_digits {
        return s.to_string();
    }
    s.chars()
        .map(|c| match c.to_digit(10) {
            Some(d) => ARABIC_DIGITS[d as usize],
            None => c,
        })
        .collect()
}

/// Grouped decimal number in the locale's symbols. `decimals = None` keeps
/// up to three fraction digits and drops trailing zeros.
pub fn format_number(n: f64, decimals: Option<usize>, locale: Locale) -> String {
    let fixed = match decimals {
        Some(d) => format!("{:.*}", d, n.abs()),
        None => {
            let s = format!("{:.3}", n.abs());
            let s = s.trim_end_matches('0').trim_end_matches('.');
            s.to_string()
        }
    };
    let (int, frac) = match fixed.split_once('.') {
        Some((i, f)) => (i.to_string(), Some(f.to_string())),
        None => (fixed.clone(), None),
    };
    let (group, decimal, minus) = if locale.arabic_digits {
        ('٬', '٫', "\u{61C}-")
    } else {
        (',', '.', "-")
    };
    let mut grouped = String::new();
    for (i, c) in int.chars().enumerate() {
        if i > 0 && (int.len() - i) % 3 == 0 {
            grouped.push(group);
        }
        grouped.push(c);
    }
    let mut out = String::new();
    let is_zero = fixed.chars().all(|c| c == '0' || c == '.');
    if n < 0.0 && !is_zero {
        out.push_str(minus);
    }
    out.push_str(&grouped);
    if let Some(f) = frac {
        out.push(decimal);
        out.push_str(&f);
    }
    localize_digits(&out, locale)
}

/// `{{ n | number }}`, `{{ n | number(2) }}`.
pub fn number(state: &State, value: &Value, decimals: Option<u32>) -> Result<String, Error> {
    if is_missing(value) {
        return Ok(String::new());
    }
    let n = to_f64(value, "number")?;
    Ok(format_number(
        n,
        decimals.map(|d| d.min(10) as usize),
        locale(state),
    ))
}

fn currency_symbol(code: &str, lang: Lang) -> String {
    match (code, lang) {
        ("AED", Lang::En) => "AED".into(),
        ("AED", Lang::Ar) => "د.إ.".into(),
        ("SAR", Lang::Ar) => "ر.س.".into(),
        ("USD", _) => "US$".into(),
        ("EUR", _) => "€".into(),
        (other, _) => other.to_string(),
    }
}

/// `{{ price | money }}` (AED) or `{{ price | money("SAR") }}`: two
/// decimals, grouped. `en-AE`: `AED 1,234.50`; `ar-AE`: `1,234.50 د.إ.`,
/// or `١٬٢٣٤٫٥٠ د.إ.` with Eastern Arabic digits. The space is U+00A0.
pub fn money(state: &State, value: &Value, currency: Option<&str>) -> Result<String, Error> {
    if is_missing(value) {
        return Ok(String::new());
    }
    let n = to_f64(value, "money")?;
    let code = currency.unwrap_or("AED");
    if code.len() != 3 || !code.chars().all(|c| c.is_ascii_uppercase()) {
        return Err(Error::new(
            ErrorKind::InvalidOperation,
            format!("`money` needs an ISO 4217 code, got `{code}`"),
        ));
    }
    let locale = locale(state);
    let amount = format_number(n, Some(2), locale);
    let symbol = currency_symbol(code, locale.lang);
    Ok(match locale.lang {
        Lang::En => format!("{symbol}\u{a0}{amount}"),
        Lang::Ar => format!("{amount}\u{a0}{symbol}"),
    })
}

/// `{{ text | truncate(40) }}`: at most `length` characters plus `…`.
pub fn truncate(value: &Value, length: Option<u32>, end: Option<&str>) -> Result<Value, Error> {
    let s = value.to_string();
    let length = length.unwrap_or(255) as usize;
    if s.chars().count() <= length {
        return Ok(value.clone());
    }
    let cut: String = s.chars().take(length).collect();
    Ok(Value::from(format!(
        "{}{}",
        cut.trim_end(),
        end.unwrap_or("…")
    )))
}

/// `{{ data | json }}`: JSON safe inside HTML text and attributes (`<`,
/// `>`, `&`, `'` escaped as `\u00XX`).
pub fn json(value: &Value) -> Result<Value, Error> {
    let s = serde_json::to_string(value).map_err(|e| {
        Error::new(
            ErrorKind::InvalidOperation,
            format!("`json` cannot serialise this value: {e}"),
        )
    })?;
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '<' => out.push_str("\\u003c"),
            '>' => out.push_str("\\u003e"),
            '&' => out.push_str("\\u0026"),
            '\'' => out.push_str("\\u0027"),
            _ => out.push(c),
        }
    }
    Ok(Value::from_safe_string(out))
}

/// Locale-independent case mapping (Arabic has no case and passes through).
pub fn upper(value: &Value) -> String {
    value.to_string().to_uppercase()
}

pub fn lower(value: &Value) -> String {
    value.to_string().to_lowercase()
}

/// `{{ ts | date }}`, `{{ ts | date("short") }}`; styles `short`, `medium`
/// (default), `long`, `datetime`, `time`. Accepts an ISO 8601 string or
/// Unix milliseconds.
pub fn date(state: &State, value: &Value, style: Option<&str>) -> Result<String, Error> {
    let (offset, locale) = scope_of(state)
        .map(|s| (s.utc_offset_minutes, s.locale))
        .unwrap_or((0, Locale::default()));
    let ts = date::parse_timestamp(value)?;
    format_date(ts, style.unwrap_or("medium"), offset, locale)
}

/// `{{ ts | ago }}`: relative time to the render's `now`.
pub fn ago(state: &State, value: &Value) -> Result<String, Error> {
    let (now, locale) = scope_of(state)
        .map(|s| (s.now_ms, s.locale))
        .unwrap_or((0, Locale::default()));
    let ts = date::parse_timestamp(value)?;
    Ok(date::format_ago(now, ts.ms, locale))
}

fn digits_of(value: &Value) -> String {
    value
        .to_string()
        .chars()
        .filter(char::is_ascii_digit)
        .collect()
}

/// Keeps a left-to-right run (a phone number, an id) in place inside
/// Arabic text: wrapped in U+2066 LEFT-TO-RIGHT ISOLATE ... U+2069.
fn ltr_run(s: String, state: &State) -> String {
    match locale(state).lang {
        Lang::Ar => format!("\u{2066}{s}\u{2069}"),
        Lang::En => s,
    }
}

/// `{{ phone | phone_ae }}`: a UAE number (`0501234567`, `+971501234567`,
/// `00971 4 123 4567`) displayed as E.164 groups, `+971 50 123 4567` or
/// `+971 4 123 4567`. Anything else is shown as given; validation is the
/// `gcc` module's (#243).
pub fn phone_ae(state: &State, value: &Value) -> String {
    if is_missing(value) {
        return String::new();
    }
    let raw = value.to_string();
    let d = digits_of(value);
    let national = d
        .strip_prefix("00971")
        .or_else(|| d.strip_prefix("971"))
        .or_else(|| d.strip_prefix('0'))
        .unwrap_or(&d);
    let grouped = match national.len() {
        // Mobile: 5X XXX XXXX.
        9 if national.starts_with('5') => Some(format!(
            "+971 {} {} {}",
            &national[..2],
            &national[2..5],
            &national[5..]
        )),
        // Landline: A XXX XXXX (area codes 2, 3, 4, 6, 7, 9).
        8 if matches!(
            national.as_bytes()[0],
            b'2' | b'3' | b'4' | b'6' | b'7' | b'9'
        ) =>
        {
            Some(format!(
                "+971 {} {} {}",
                &national[..1],
                &national[1..4],
                &national[4..]
            ))
        }
        _ => None,
    };
    match grouped {
        Some(g) => ltr_run(g, state),
        None => raw,
    }
}

/// `{{ id | emirates_id }}`: 15 digits starting `784` grouped as
/// `784-YYYY-NNNNNNN-C`; anything else as given.
pub fn emirates_id(state: &State, value: &Value) -> String {
    if is_missing(value) {
        return String::new();
    }
    let d = digits_of(value);
    if d.len() == 15 && d.starts_with("784") {
        ltr_run(
            format!("{}-{}-{}-{}", &d[..3], &d[3..7], &d[7..14], &d[14..]),
            state,
        )
    } else {
        value.to_string()
    }
}

/// `{{ trn | trn }}`: a 15-digit Tax Registration Number grouped
/// `XXX XXXX XXXX XXXX`; anything else as given.
pub fn trn(state: &State, value: &Value) -> String {
    if is_missing(value) {
        return String::new();
    }
    let d = digits_of(value);
    if d.len() == 15 {
        ltr_run(
            format!("{} {} {} {}", &d[..3], &d[3..7], &d[7..11], &d[11..]),
            state,
        )
    } else {
        value.to_string()
    }
}

/// Internal: bound URL attributes. Anything but a relative URL or an
/// `http`, `https`, `mailto`, or `tel` URL becomes a harmless placeholder,
/// so `:href="user.website"` cannot carry `javascript:`.
pub fn url(value: &Value) -> Value {
    let s = value.to_string();
    // Browsers ignore ASCII tab and newline inside URLs and strip leading
    // controls and spaces; check the scheme as they would see it.
    let squeezed: String = s
        .chars()
        .filter(|c| !matches!(c, '\t' | '\n' | '\r'))
        .collect();
    let trimmed = squeezed.trim_start_matches(|c: char| c <= ' ');
    let scheme_end = trimmed.find([':', '/', '?', '#']);
    if let Some(i) = scheme_end
        && trimmed[i..].starts_with(':')
    {
        let scheme = trimmed[..i].to_ascii_lowercase();
        if !matches!(scheme.as_str(), "http" | "https" | "mailto" | "tel") {
            return Value::from("about:invalid#renox-unsafe-url");
        }
    }
    Value::from(s)
}

/// Internal (`<x-image>`, ops.md 1.7.0 section 21; #321): the `src`,
/// `srcset` (1x and 2x), `width` and `height` attributes of a stored image,
/// from the file object the loader passes (`ctx.storage.get`: `key`,
/// `width`, `height`, and `exp` / `sig` from `ctx.storage.sign` for a
/// private file). `opts` is `[width or none, fit, focus, placeholder]`.
/// A value without a `key` renders no attributes.
pub fn image(
    file: &Value,
    width: Option<i64>,
    fit: Option<String>,
    focus: Option<String>,
    placeholder: Option<bool>,
) -> Value {
    let get = |k: &str| {
        file.get_attr(k)
            .ok()
            .filter(|v| !v.is_undefined() && !v.is_none())
    };
    let Some(key) = get("key").map(|v| v.to_string()) else {
        return Value::from_safe_string(String::new());
    };
    // Keys are `^[a-z0-9][a-z0-9/_.-]{0,255}$` (ops.md section 21); refuse anything else.
    if key.is_empty()
        || !key.chars().all(|c| {
            c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '/' | '_' | '.' | '-')
        })
    {
        return Value::from_safe_string(String::new());
    }
    let num = |k: &str| {
        get(k)
            .and_then(|v| i64::try_from(v).ok())
            .filter(|n| *n > 0)
    };
    let (fw, fh) = (num("width"), num("height"));
    let w = width.filter(|n| *n > 0).or(fw).unwrap_or(400);
    let mut extra = String::new();
    for (name, v) in [("fit", fit), ("focus", focus)] {
        if let Some(v) = v.filter(|v| matches!(v.as_str(), "cover" | "contain" | "center" | "face"))
        {
            extra.push_str(&format!("&amp;{name}={v}"));
        }
    }
    if let (Some(exp), Some(sig)) = (get("exp"), get("sig")) {
        let sig = sig.to_string();
        let exp = exp.to_string();
        if sig.chars().all(|c| c.is_ascii_hexdigit()) && exp.chars().all(|c| c.is_ascii_digit()) {
            extra.push_str(&format!("&amp;exp={exp}&amp;sig={sig}"));
        }
    }
    let url = |width: i64| format!("/_img/{key}?w={width}{extra}");
    let mut out = format!(
        " src=\"{}\" srcset=\"{} 1x, {} 2x\" width=\"{w}\"",
        url(w),
        url(w),
        url(w * 2)
    );
    if let (Some(fw), Some(fh)) = (fw, fh) {
        let h = ((fh as f64) * (w as f64) / (fw as f64)).round().max(1.0) as i64;
        out.push_str(&format!(" height=\"{h}\""));
    }
    if placeholder == Some(true) {
        out.push_str(&format!(
            " style=\"background-size:cover;background-image:url({})\"",
            url(16)
        ));
    }
    Value::from_safe_string(out)
}
