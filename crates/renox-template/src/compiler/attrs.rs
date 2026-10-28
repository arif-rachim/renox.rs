//! Attribute helpers: the directive list, `r-for` parsing, `:class` objects,
//! boolean attributes, interpolation splitting, and HTML escaping of static
//! text.

/// Directives (`r-*` attributes) the compiler knows.
pub const DIRECTIVES: &[&str] = &[
    "r-if",
    "r-else-if",
    "r-else",
    "r-for",
    "r-empty",
    "r-fragment",
    "r-html",
    "r-can",
    "r-cannot",
];

/// HTML boolean attributes: `:name="expr"` emits `name` only when truthy.
const BOOLEAN_ATTRS: &[&str] = &[
    "allowfullscreen",
    "async",
    "autofocus",
    "autoplay",
    "checked",
    "controls",
    "default",
    "defer",
    "disabled",
    "formnovalidate",
    "hidden",
    "inert",
    "ismap",
    "itemscope",
    "loop",
    "multiple",
    "muted",
    "nomodule",
    "novalidate",
    "open",
    "playsinline",
    "readonly",
    "required",
    "selected",
];

pub fn is_boolean_attr(name: &str) -> bool {
    BOOLEAN_ATTRS.contains(&name)
}

/// Attributes whose value is a URL: a bound value is checked at render time
/// for `javascript:` and similar schemes (the `url` platform filter).
pub const URL_ATTRS: &[&str] = &[
    "href",
    "src",
    "action",
    "formaction",
    "poster",
    "cite",
    "data",
    "hx-get",
    "hx-post",
    "hx-put",
    "hx-patch",
    "hx-delete",
];

/// A parsed `r-for`: `p in items` or `(p, i) in items`.
#[derive(Debug, PartialEq, Eq)]
pub struct ForLoop {
    pub item: String,
    pub index: Option<String>,
    pub iterable: String,
}

pub fn parse_for(value: &str) -> Result<ForLoop, String> {
    let (lhs, rhs) = value.split_once(" in ").ok_or_else(|| {
        format!("r-for must be `item in list` or `(item, index) in list`, got `{value}`")
    })?;
    let lhs = lhs.trim();
    let iterable = rhs.trim().to_owned();
    if iterable.is_empty() {
        return Err("r-for has no list after `in`".into());
    }
    let (item, index) = match lhs.strip_prefix('(').and_then(|s| s.strip_suffix(')')) {
        Some(inner) => {
            let (a, b) = inner
                .split_once(',')
                .ok_or_else(|| format!("r-for `({inner})` needs two names: `(item, index)`"))?;
            (a.trim().to_owned(), Some(b.trim().to_owned()))
        }
        None => (lhs.to_owned(), None),
    };
    for name in std::iter::once(&item).chain(index.as_ref()) {
        if !is_identifier(name) || name.starts_with("__") || name == "loop" {
            return Err(format!(
                "r-for variable `{name}` is not an identifier (or is reserved)"
            ));
        }
    }
    Ok(ForLoop {
        item,
        index,
        iterable,
    })
}

pub fn is_identifier(s: &str) -> bool {
    let mut chars = s.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Fragment names (`artifact.md`: `^[a-z_][a-z0-9_]{0,63}$`).
pub fn is_fragment_name(s: &str) -> bool {
    let mut chars = s.chars();
    s.len() <= 64
        && chars
            .next()
            .is_some_and(|c| c.is_ascii_lowercase() || c == '_')
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

/// Fragment targets (`artifact.md`: `^[A-Za-z][A-Za-z0-9_:.-]{0,127}$`).
pub fn is_fragment_target(s: &str) -> bool {
    let mut chars = s.chars();
    s.len() <= 128
        && chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | ':' | '.' | '-'))
}

/// Permission action names for `r-can`: dotted identifiers (`cart.add`,
/// `billing:invoice.read`).
pub fn is_action_name(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.split(['.', ':']).all(|seg| {
            let mut c = seg.chars();
            c.next()
                .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
                && c.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        })
}

/// Parses a `:class` object literal `{ 'a': cond, b: other }` into
/// `(class_name, condition)` pairs. Returns `None` if `value` is not an object.
pub fn parse_class_object(value: &str) -> Option<Result<Vec<(String, String)>, String>> {
    let inner = value.trim().strip_prefix('{')?.strip_suffix('}')?;
    let mut pairs = Vec::new();
    for entry in split_top_level(inner, ',') {
        let entry = entry.trim();
        if entry.is_empty() {
            continue;
        }
        let parts = split_top_level(entry, ':');
        if parts.len() < 2 {
            return Some(Err(format!(
                "`:class` entry `{entry}` must be `name: condition`"
            )));
        }
        let key = parts[0]
            .trim()
            .trim_matches(|c| c == '\'' || c == '"')
            .to_owned();
        let cond = parts[1..].join(":").trim().to_owned();
        let valid = !key.is_empty()
            && key
                .chars()
                .all(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | ':' | '/' | '.'));
        if !valid {
            return Some(Err(format!(
                "`:class` key `{key}` is not a single class name"
            )));
        }
        pairs.push((key, cond));
    }
    Some(Ok(pairs))
}

/// Splits on `sep` outside quotes, parentheses, brackets, and braces.
pub fn split_top_level(s: &str, sep: char) -> Vec<String> {
    let mut parts = Vec::new();
    let mut depth = 0i32;
    let mut quote: Option<char> = None;
    let mut cur = String::new();
    for c in s.chars() {
        if let Some(q) = quote {
            cur.push(c);
            if c == q {
                quote = None;
            }
            continue;
        }
        match c {
            '\'' | '"' => quote = Some(c),
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => depth -= 1,
            _ if c == sep && depth == 0 => {
                parts.push(std::mem::take(&mut cur));
                continue;
            }
            _ => {}
        }
        cur.push(c);
    }
    parts.push(cur);
    parts
}

/// A piece of text or of an attribute value.
#[derive(Debug, PartialEq, Eq)]
pub enum Segment<'a> {
    Static(&'a str),
    /// The inside of `{{ ... }}`.
    Interp(&'a str),
    /// `{%` or `{#`: template statements are not part of the language.
    Statement,
    /// `{{` without `}}`.
    Unclosed,
}

/// Splits text into static parts and `{{ }}` interpolations.
pub fn segments(s: &str) -> Vec<Segment<'_>> {
    let mut out = Vec::new();
    let mut rest = s;
    loop {
        let next = ["{{", "{%", "{#"]
            .iter()
            .filter_map(|d| rest.find(d).map(|i| (i, *d)))
            .min_by_key(|(i, _)| *i);
        let Some((start, delim)) = next else {
            if !rest.is_empty() {
                out.push(Segment::Static(rest));
            }
            return out;
        };
        if start > 0 {
            out.push(Segment::Static(&rest[..start]));
        }
        if delim != "{{" {
            out.push(Segment::Statement);
            rest = &rest[start + 2..];
            continue;
        }
        match rest[start + 2..].find("}}") {
            Some(end) => {
                out.push(Segment::Interp(&rest[start + 2..start + 2 + end]));
                rest = &rest[start + 2 + end + 2..];
            }
            None => {
                out.push(Segment::Unclosed);
                return out;
            }
        }
    }
}

/// Escapes static text content (`&`, `<`, `>`).
pub fn escape_text(s: &str, out: &mut String) {
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            _ => out.push(c),
        }
    }
}

/// Escapes a static attribute value for the given quote character.
pub fn escape_attr(s: &str, quote: char, out: &mut String) {
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '"' if quote == '"' => out.push_str("&quot;"),
            '\'' if quote == '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
}

/// The quote that needs no escaping for this value (`hx-vals='{"a": 1}'`
/// stays readable).
pub fn pick_quote(value: &str) -> char {
    if value.contains('"') && !value.contains('\'') {
        '\''
    } else {
        '"'
    }
}

/// A minijinja string literal for `s`.
pub fn string_literal(s: &str) -> String {
    serde_json::to_string(s).expect("string serialises")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_for_forms() {
        assert_eq!(
            parse_for("(p, i) in products").unwrap(),
            ForLoop {
                item: "p".into(),
                index: Some("i".into()),
                iterable: "products".into()
            }
        );
        assert_eq!(parse_for("p in items").unwrap().index, None);
        assert!(parse_for("p of items").is_err());
        assert!(parse_for("(p) in items").is_err());
        assert!(parse_for("__x in items").is_err());
    }

    #[test]
    fn parses_class_objects() {
        let pairs = parse_class_object("{ 'card--empty': p.stock == 0, active: a }")
            .unwrap()
            .unwrap();
        assert_eq!(
            pairs,
            vec![
                ("card--empty".into(), "p.stock == 0".into()),
                ("active".into(), "a".into())
            ]
        );
        assert!(parse_class_object("isActive").is_none());
        assert!(parse_class_object("{ 'a b': x }").unwrap().is_err());
    }

    #[test]
    fn splits_segments() {
        assert_eq!(
            segments("a {{ x }} b {% if %}"),
            vec![
                Segment::Static("a "),
                Segment::Interp(" x "),
                Segment::Static(" b "),
                Segment::Statement,
                Segment::Static(" if %}"),
            ]
        );
        assert_eq!(
            segments("{{ x"),
            vec![Segment::Unclosed],
            "unclosed interpolation"
        );
    }

    #[test]
    fn names() {
        assert!(is_action_name("cart.add"));
        assert!(is_action_name("billing:invoice.read"));
        assert!(!is_action_name("cart add"));
        assert!(!is_action_name("'x'"));
        assert!(is_fragment_name("product_list"));
        assert!(!is_fragment_name("ProductList"));
        assert!(is_fragment_target("cart-badge"));
        assert!(!is_fragment_target("1x"));
    }
}
