//! Translation catalogs and the `t` filter (`docs/08-template-engine.md`,
//! "Right-to-left"; #233).
//!
//! A deployment carries one catalog per module and locale (`<locale>.json`,
//! nested objects flattened to dotted keys); the app's catalogs override the
//! modules'. Messages use a subset of ICU MessageFormat: `{name}`,
//! `{n, number}`, `{n, plural, =0 {..} one {# item} other {# items}}` with
//! the CLDR categories of English and Arabic (`zero`, `one`, `two`, `few`,
//! `many`, `other`), and `{x, select, a {..} other {..}}`. A message is text:
//! the result is HTML-escaped like any other value, so a catalog cannot
//! inject markup.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt;
use std::sync::{Arc, Mutex};

use minijinja::value::{Kwargs, Value, ValueKind};
use minijinja::{Error, ErrorKind, State};

use super::{Lang, Locale, scope_of};
use crate::filters::format_number;

/// Called once per deployment and `(locale, key)` for a key no catalog
/// has: the cell logs it as `i18n_missing`.
pub type MissingFn = dyn Fn(&str, &str) + Send + Sync;

/// The catalogs of one deployment.
#[derive(Default)]
pub struct Catalogs {
    /// locale (lower case) -> key -> message; the app's.
    app: HashMap<String, HashMap<String, String>>,
    /// locale -> key -> message; the modules', the first module that has a
    /// key wins.
    modules: HashMap<String, HashMap<String, String>>,
    missing: Mutex<HashSet<(String, String)>>,
    on_missing: Option<Arc<MissingFn>>,
}

impl fmt::Debug for Catalogs {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Catalogs")
            .field("app", &self.app.keys().collect::<Vec<_>>())
            .field("modules", &self.modules.keys().collect::<Vec<_>>())
            .finish_non_exhaustive()
    }
}

/// Largest catalog file accepted.
pub const MAX_CATALOG_BYTES: usize = 1024 * 1024;

impl Catalogs {
    pub fn new() -> Catalogs {
        Catalogs::default()
    }

    /// Adds `<locale>.json` of `module` (`"app"` for the app). Nested
    /// objects become dotted keys; a top-level `_meta` object (review
    /// notes, machine-translation marks) is skipped. Values must be strings.
    pub fn add(&mut self, module: &str, locale: &str, json: &str) -> Result<(), String> {
        if json.len() > MAX_CATALOG_BYTES {
            return Err(format!("catalog {module}/{locale}.json is over 1 MiB"));
        }
        if !valid_locale(locale) {
            return Err(format!("catalog locale `{locale}` is not a BCP 47 tag"));
        }
        let root: serde_json::Value = serde_json::from_str(json)
            .map_err(|e| format!("catalog {module}/{locale}.json: {e}"))?;
        let serde_json::Value::Object(map) = root else {
            return Err(format!("catalog {module}/{locale}.json must be an object"));
        };
        let mut flat = BTreeMap::new();
        for (k, v) in map {
            if k == "_meta" {
                continue;
            }
            flatten(&k, v, &mut flat)
                .map_err(|e| format!("catalog {module}/{locale}.json: {e}"))?;
        }
        let layer = if module == "app" {
            &mut self.app
        } else {
            &mut self.modules
        };
        let target = layer.entry(locale.to_ascii_lowercase()).or_default();
        for (k, v) in flat {
            if module == "app" {
                target.insert(k, v);
            } else {
                target.entry(k).or_insert(v);
            }
        }
        Ok(())
    }

    /// Called once per missing `(locale, key)`.
    pub fn on_missing(mut self, f: Arc<MissingFn>) -> Catalogs {
        self.on_missing = Some(f);
        self
    }

    pub fn is_empty(&self) -> bool {
        self.app.is_empty() && self.modules.is_empty()
    }

    /// The message for `key`: the exact locale, then its language (`ar` for
    /// `ar-AE`), then `en`; the app's before the modules' at each step.
    pub fn lookup(&self, locale: &str, key: &str) -> Option<&str> {
        let lower = locale.to_ascii_lowercase();
        let lang = lower.split('-').next().unwrap_or("en").to_string();
        let mut tried: Vec<&str> = vec![lower.as_str()];
        if lang != lower {
            tried.push(&lang);
        }
        if lang != "en" {
            tried.push("en");
        }
        for loc in tried {
            for layer in [&self.app, &self.modules] {
                if let Some(m) = layer.get(loc).and_then(|m| m.get(key)) {
                    return Some(m);
                }
            }
        }
        None
    }

    fn report_missing(&self, locale: &str, key: &str) {
        let first = self
            .missing
            .lock()
            .map(|mut m| m.insert((locale.to_string(), key.to_string())))
            .unwrap_or(false);
        if first && let Some(f) = &self.on_missing {
            f(locale, key);
        }
    }
}

fn flatten(
    prefix: &str,
    v: serde_json::Value,
    out: &mut BTreeMap<String, String>,
) -> Result<(), String> {
    match v {
        serde_json::Value::String(s) => {
            out.insert(prefix.to_string(), s);
            Ok(())
        }
        serde_json::Value::Object(m) => {
            for (k, v) in m {
                flatten(&format!("{prefix}.{k}"), v, out)?;
            }
            Ok(())
        }
        _ => Err(format!("`{prefix}` must be a string or an object")),
    }
}

/// `^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$`, at most 35 characters (`ops.md`
/// section 14, "Locale").
pub fn valid_locale(tag: &str) -> bool {
    if tag.len() > 64 {
        return false;
    }
    // ops.md 1.4.0: the language part, then optionally one `-u-` extension
    // with `ca` and/or `nu`, in that order, values from the contract's lists.
    let (base, ext) = match tag.find("-u-") {
        Some(i) => (&tag[..i], Some(&tag[i + 3..])),
        None => (tag, None),
    };
    let mut parts = base.split('-');
    let first = parts.next().unwrap_or("");
    let base_ok = base.len() <= 35
        && (2..=3).contains(&first.len())
        && first.bytes().all(|b| b.is_ascii_lowercase())
        && parts
            .all(|p| (2..=8).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_alphanumeric()));
    base_ok && ext.is_none_or(valid_extension)
}

/// `ca-<calendar>` and/or `nu-<system>`, in that order, each once.
fn valid_extension(ext: &str) -> bool {
    const CA: [&str; 6] = [
        "gregory",
        "islamic",
        "islamic-civil",
        "islamic-tbla",
        "islamic-umalqura",
        "persian",
    ];
    const NU: [&str; 3] = ["latn", "arab", "arabext"];
    let (ca, nu) = match ext.strip_prefix("ca-") {
        Some(rest) => match rest.find("-nu-") {
            Some(i) => (Some(&rest[..i]), Some(&rest[i + 4..])),
            None => (Some(rest), None),
        },
        None => (None, ext.strip_prefix("nu-")),
    };
    (ca.is_some() || nu.is_some())
        && ca.is_none_or(|c| CA.contains(&c))
        && nu.is_none_or(|n| NU.contains(&n))
}

/// The text direction of a page.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Dir {
    #[default]
    Ltr,
    Rtl,
}

impl Dir {
    pub fn as_str(self) -> &'static str {
        match self {
            Dir::Ltr => "ltr",
            Dir::Rtl => "rtl",
        }
    }

    pub fn parse(s: &str) -> Option<Dir> {
        match s {
            "ltr" => Some(Dir::Ltr),
            "rtl" => Some(Dir::Rtl),
            _ => None,
        }
    }

    /// The default direction of a language (`ops.md` section 14, "Locale").
    pub fn of_locale(tag: &str) -> Dir {
        let lang = tag.split('-').next().unwrap_or("").to_ascii_lowercase();
        match lang.as_str() {
            "ar" | "fa" | "he" | "ur" | "ps" | "sd" | "ug" | "yi" | "dv" | "ckb" => Dir::Rtl,
            _ => Dir::Ltr,
        }
    }
}

/// The CLDR plural category of `n` in `lang`.
pub fn plural_category(n: f64, lang: Lang) -> &'static str {
    let int = n.fract() == 0.0 && (0.0..1e15).contains(&n);
    match lang {
        Lang::En => {
            if int && n == 1.0 {
                "one"
            } else {
                "other"
            }
        }
        Lang::Ar => {
            if !int {
                return "other";
            }
            let n = n as u64;
            match (n, n % 100) {
                (0, _) => "zero",
                (1, _) => "one",
                (2, _) => "two",
                (_, 3..=10) => "few",
                (_, 11..=99) => "many",
                _ => "other",
            }
        }
    }
}

/// A message argument: a number (plural, `#`, `number`) or text.
#[derive(Debug, Clone, PartialEq)]
pub enum Arg {
    Num(f64),
    Text(String),
}

impl Arg {
    fn from_value(v: &Value) -> Arg {
        match v.kind() {
            ValueKind::Number => f64::try_from(v.clone())
                .map(Arg::Num)
                .unwrap_or_else(|_| Arg::Text(v.to_string())),
            ValueKind::Undefined | ValueKind::None => Arg::Text(String::new()),
            _ => Arg::Text(v.to_string()),
        }
    }

    fn display(&self, locale: Locale) -> String {
        match self {
            Arg::Num(n) => format_number(*n, None, locale),
            Arg::Text(s) => s.clone(),
        }
    }
}

/// Formats an ICU message. A malformed message is returned as written, so
/// a catalog mistake shows instead of failing the page.
pub fn format_message(msg: &str, args: &HashMap<String, Arg>, locale: Locale) -> String {
    let chars: Vec<char> = msg.chars().collect();
    let mut p = Parser {
        s: &chars,
        i: 0,
        args,
        locale,
    };
    match p.message(None, false) {
        Some(out) if p.i == chars.len() => out,
        _ => msg.to_string(),
    }
}

struct Parser<'a> {
    s: &'a [char],
    i: usize,
    args: &'a HashMap<String, Arg>,
    locale: Locale,
}

impl Parser<'_> {
    fn peek(&self) -> Option<char> {
        self.s.get(self.i).copied()
    }

    fn ws(&mut self) {
        while self.peek().is_some_and(char::is_whitespace) {
            self.i += 1;
        }
    }

    fn ident(&mut self) -> String {
        let start = self.i;
        while self
            .peek()
            .is_some_and(|c| c.is_alphanumeric() || c == '_' || c == '=' || c == '.' || c == '-')
        {
            self.i += 1;
        }
        self.s[start..self.i].iter().collect()
    }

    /// Text up to the end or an unmatched `}` (when `nested`); `#` is the
    /// plural number inside a plural branch.
    fn message(&mut self, hash: Option<f64>, nested: bool) -> Option<String> {
        let mut out = String::new();
        while let Some(c) = self.peek() {
            match c {
                '}' if nested => return Some(out),
                '}' => return None,
                '{' => {
                    self.i += 1;
                    out.push_str(&self.argument()?);
                }
                '#' if hash.is_some() => {
                    self.i += 1;
                    out.push_str(&format_number(hash.unwrap_or(0.0), None, self.locale));
                }
                '\'' => {
                    self.i += 1;
                    match self.peek() {
                        // '' is one quote.
                        Some('\'') => {
                            self.i += 1;
                            out.push('\'');
                        }
                        // '{...}' quotes syntax characters.
                        Some('{' | '}' | '#') => {
                            while let Some(q) = self.peek() {
                                self.i += 1;
                                if q == '\'' {
                                    break;
                                }
                                out.push(q);
                            }
                        }
                        _ => out.push('\''),
                    }
                }
                _ => {
                    self.i += 1;
                    out.push(c);
                }
            }
        }
        if nested { None } else { Some(out) }
    }

    /// After `{`: `name}`, `name, number}`, `name, plural, ...}`,
    /// `name, select, ...}`.
    fn argument(&mut self) -> Option<String> {
        self.ws();
        let name = self.ident();
        if name.is_empty() {
            return None;
        }
        self.ws();
        let arg = self.args.get(&name).cloned();
        match self.peek()? {
            '}' => {
                self.i += 1;
                Some(
                    arg.map(|a| a.display(self.locale))
                        .unwrap_or_else(|| format!("{{{name}}}")),
                )
            }
            ',' => {
                self.i += 1;
                self.ws();
                let kind = self.ident();
                self.ws();
                match kind.as_str() {
                    "number" => {
                        if self.peek()? != '}' {
                            return None;
                        }
                        self.i += 1;
                        Some(arg.map(|a| a.display(self.locale)).unwrap_or_default())
                    }
                    "plural" | "select" => {
                        if self.peek()? != ',' {
                            return None;
                        }
                        self.i += 1;
                        self.branches(&kind, arg)
                    }
                    _ => None,
                }
            }
            _ => None,
        }
    }

    fn branches(&mut self, kind: &str, arg: Option<Arg>) -> Option<String> {
        let (n, text) = match &arg {
            Some(Arg::Num(n)) => (Some(*n), n.to_string()),
            Some(Arg::Text(t)) => (t.trim().parse::<f64>().ok(), t.clone()),
            None => (None, String::new()),
        };
        let category = n.map(|n| plural_category(n, self.locale.lang));
        let mut chosen: Option<(u8, String)> = None;
        let mut other: Option<String> = None;
        loop {
            self.ws();
            if self.peek()? == '}' {
                self.i += 1;
                break;
            }
            let selector = self.ident();
            if selector.is_empty() {
                return None;
            }
            self.ws();
            if self.peek()? != '{' {
                return None;
            }
            self.i += 1;
            let hash = if kind == "plural" { n } else { None };
            let body = self.message(hash, true)?;
            if self.peek()? != '}' {
                return None;
            }
            self.i += 1;
            // Exact `=n` beats a category; a category beats `other`.
            let rank = if kind == "plural" {
                match selector.strip_prefix('=') {
                    Some(exact) => (exact.parse::<f64>().ok() == n).then_some(2),
                    None => (Some(selector.as_str()) == category).then_some(1),
                }
            } else {
                (selector == text).then_some(1)
            };
            if selector == "other" {
                other = Some(body.clone());
            }
            if let Some(r) = rank
                && chosen.as_ref().is_none_or(|(c, _)| *c < r)
            {
                chosen = Some((r, body));
            }
        }
        chosen.map(|(_, b)| b).or(other).or(Some(String::new()))
    }
}

/// `{{ "cart.items" | t(count=n) }}` or `{{ "cart.items" | t({"count": n}) }}`:
/// the message of the page's locale, formatted. A missing key renders the
/// key and is reported once per deployment.
pub fn t(state: &State, key: &Value, args: Option<Value>, kwargs: Kwargs) -> Result<String, Error> {
    let Some(key) = key.as_str() else {
        return Err(Error::new(
            ErrorKind::InvalidOperation,
            format!("`t` needs a string key, got {}", key.kind()),
        ));
    };
    let Some(scope) = scope_of(state) else {
        return Ok(key.to_string());
    };
    let mut map = HashMap::new();
    if let Some(a) = args {
        if a.kind() != ValueKind::Map {
            return Err(Error::new(
                ErrorKind::InvalidOperation,
                "`t` arguments must be an object",
            ));
        }
        for k in a.try_iter()? {
            let v = a.get_item(&k)?;
            map.insert(k.to_string(), Arg::from_value(&v));
        }
    }
    for k in kwargs.args() {
        let v: Value = kwargs.get(k)?;
        map.insert(k.to_string(), Arg::from_value(&v));
    }
    kwargs.assert_all_used()?;
    let Some(catalogs) = scope.catalogs.as_ref() else {
        return Ok(key.to_string());
    };
    match catalogs.lookup(&scope.lang, key) {
        Some(msg) => Ok(format_message(msg, &map, scope.locale)),
        None => {
            catalogs.report_missing(&scope.lang, key);
            Ok(key.to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(pairs: &[(&str, Arg)]) -> HashMap<String, Arg> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect()
    }

    #[test]
    fn plural_and_select() {
        let m = "{n, plural, =0 {no items} one {# item} other {# items}}";
        let en = Locale::EN_AE;
        assert_eq!(
            format_message(m, &args(&[("n", Arg::Num(0.0))]), en),
            "no items"
        );
        assert_eq!(
            format_message(m, &args(&[("n", Arg::Num(1.0))]), en),
            "1 item"
        );
        assert_eq!(
            format_message(m, &args(&[("n", Arg::Num(1200.0))]), en),
            "1,200 items"
        );
        let s = "{g, select, female {she} male {he} other {they}} paid";
        assert_eq!(
            format_message(s, &args(&[("g", Arg::Text("female".into()))]), en),
            "she paid"
        );
        assert_eq!(
            format_message(s, &args(&[("g", Arg::Text("x".into()))]), en),
            "they paid"
        );
        assert_eq!(
            format_message("it''s '{literal}'", &args(&[]), en),
            "it's {literal}"
        );
        // Malformed: shown as written.
        assert_eq!(
            format_message("{n, plural, one {x}", &args(&[]), en),
            "{n, plural, one {x}"
        );
    }

    #[test]
    fn arabic_categories() {
        let ar = Locale::AR_AE;
        for (n, c) in [
            (0, "zero"),
            (1, "one"),
            (2, "two"),
            (3, "few"),
            (10, "few"),
            (11, "many"),
            (99, "many"),
            (100, "other"),
            (102, "other"),
            (103, "few"),
        ] {
            assert_eq!(plural_category(n as f64, ar.lang), c, "{n}");
        }
        assert_eq!(plural_category(1.5, Lang::Ar), "other");
    }

    #[test]
    fn locale_tags_and_dir() {
        assert!(valid_locale("ar-AE"));
        assert!(valid_locale("en"));
        assert!(!valid_locale("AR"));
        assert!(!valid_locale("e"));
        assert_eq!(Dir::of_locale("ar-AE"), Dir::Rtl);
        assert_eq!(Dir::of_locale("ckb"), Dir::Rtl);
        assert_eq!(Dir::of_locale("en-AE"), Dir::Ltr);
    }

    #[test]
    fn app_overrides_modules_and_fallback() {
        let mut c = Catalogs::new();
        c.add(
            "auth",
            "en",
            r#"{"auth": {"login": "Sign in", "out": "Sign out"}, "_meta": {"x": 1}}"#,
        )
        .unwrap();
        c.add("app", "en", r#"{"auth": {"login": "Log in"}}"#)
            .unwrap();
        c.add("auth", "ar", r#"{"auth": {"login": "تسجيل الدخول"}}"#)
            .unwrap();
        assert_eq!(c.lookup("en", "auth.login"), Some("Log in"));
        assert_eq!(c.lookup("ar-AE", "auth.login"), Some("تسجيل الدخول"));
        assert_eq!(c.lookup("ar-AE", "auth.out"), Some("Sign out"));
        assert_eq!(c.lookup("en", "_meta.x"), None);
        assert!(c.add("app", "en", r#"{"a": 1}"#).is_err());
        assert!(c.add("app", "EN", "{}").is_err());
    }
}
