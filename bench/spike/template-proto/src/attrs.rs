//! Directive and attribute handlers: expression translation, `r-for`
//! parsing, `:class` objects, boolean attributes, and HTML escaping that
//! leaves template delimiters alone.

/// Directives handled by the F0 prototype.
pub const DIRECTIVES: [&str; 7] = [
    "r-if",
    "r-else-if",
    "r-else",
    "r-for",
    "r-empty",
    "r-fragment",
    "r-html",
];

/// Directives from `docs/08-template-engine.md` that are deferred to F2.
pub const DEFERRED_DIRECTIVES: [&str; 2] = ["r-can", "r-cannot"];

/// HTML boolean attributes: `:name="expr"` emits `name` only when truthy.
const BOOLEAN_ATTRS: [&str; 24] = [
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

/// Translates the JavaScript-style operators the template language allows
/// (`&&`, `||`, prefix `!`) to minijinja (`and`, `or`, `not`). String
/// literals are copied unchanged. `!=` is kept.
pub fn translate_expr(expr: &str) -> String {
    let mut out = String::with_capacity(expr.len() + 8);
    let mut chars = expr.trim().chars().peekable();
    let mut quote: Option<char> = None;
    while let Some(c) = chars.next() {
        if let Some(q) = quote {
            out.push(c);
            if c == '\\' {
                if let Some(n) = chars.next() {
                    out.push(n);
                }
            } else if c == q {
                quote = None;
            }
            continue;
        }
        match c {
            '\'' | '"' => {
                quote = Some(c);
                out.push(c);
            }
            '&' if chars.peek() == Some(&'&') => {
                chars.next();
                out.push_str(" and ");
            }
            '|' if chars.peek() == Some(&'|') => {
                chars.next();
                out.push_str(" or ");
            }
            '!' if chars.peek() != Some(&'=') => out.push_str(" not "),
            _ => out.push(c),
        }
    }
    collapse_spaces(&out)
}

fn collapse_spaces(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut quote: Option<char> = None;
    let mut prev_space = false;
    for c in s.trim().chars() {
        if let Some(q) = quote {
            out.push(c);
            if c == q {
                quote = None;
            }
            continue;
        }
        if c == '\'' || c == '"' {
            quote = Some(c);
        }
        if c == ' ' {
            if !prev_space {
                out.push(c);
            }
            prev_space = true;
        } else {
            out.push(c);
            prev_space = false;
        }
    }
    out
}

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
        if !is_identifier(name) {
            return Err(format!("r-for variable `{name}` is not an identifier"));
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
        if key.is_empty() || key.contains(|c: char| c.is_whitespace() || c == '"' || c == '\'') {
            return Some(Err(format!(
                "`:class` key `{key}` is not a single class name"
            )));
        }
        pairs.push((key, cond));
    }
    Some(Ok(pairs))
}

/// Splits on `sep` outside quotes, parentheses, brackets, and braces.
fn split_top_level(s: &str, sep: char) -> Vec<String> {
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

/// Escapes text content (`&`, `<`, `>`) except inside `{{ }}`, `{% %}`, `{# #}`.
pub fn escape_text(s: &str, out: &mut String) {
    escape_outside_tags(s, out, |c, out| match c {
        '&' => out.push_str("&amp;"),
        '<' => out.push_str("&lt;"),
        '>' => out.push_str("&gt;"),
        _ => out.push(c),
    });
}

/// Writes ` name="value"` (bare ` name` for empty boolean attributes), picking the quote that needs no escaping when
/// possible (`hx-vals='{"a": 1}'` stays readable). Template delimiters are
/// never escaped.
pub fn write_attr(name: &str, value: &str, out: &mut String) {
    out.push(' ');
    out.push_str(name);
    if value.is_empty() && is_boolean_attr(name) {
        return;
    }
    let quote = if value.contains('"') && !value.contains('\'') {
        '\''
    } else {
        '"'
    };
    out.push('=');
    out.push(quote);
    escape_outside_tags(value, out, |c, out| match c {
        '&' => out.push_str("&amp;"),
        c if c == quote => out.push_str(if quote == '"' { "&quot;" } else { "&#39;" }),
        _ => out.push(c),
    });
    out.push(quote);
}

fn escape_outside_tags(s: &str, out: &mut String, mut escape: impl FnMut(char, &mut String)) {
    let mut rest = s;
    while let Some(start) = find_tag_start(rest) {
        for c in rest[..start].chars() {
            escape(c, out);
        }
        let close = match &rest[start..start + 2] {
            "{{" => "}}",
            "{%" => "%}",
            _ => "#}",
        };
        let end = rest[start + 2..]
            .find(close)
            .map_or(rest.len(), |e| start + 2 + e + 2);
        out.push_str(&rest[start..end]);
        rest = &rest[end..];
    }
    for c in rest.chars() {
        escape(c, out);
    }
}

fn find_tag_start(s: &str) -> Option<usize> {
    ["{{", "{%", "{#"].iter().filter_map(|d| s.find(d)).min()
}

/// True if the text contains minijinja syntax and must be wrapped in
/// `{% raw %}` to stay literal (used for `<script>` and `<style>`).
pub fn needs_raw(s: &str) -> bool {
    find_tag_start(s).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn translates_js_operators_outside_strings() {
        assert_eq!(
            translate_expr("a && !b || c != 'x && y'"),
            "a and not b or c != 'x && y'"
        );
        assert_eq!(translate_expr("!ok"), "not ok");
        assert_eq!(translate_expr("p.stock == 0"), "p.stock == 0");
    }

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
    }

    #[test]
    fn parses_class_objects() {
        let pairs = parse_class_object("{ 'card--empty': p.stock == 0, active: is(a, b) }")
            .unwrap()
            .unwrap();
        assert_eq!(
            pairs,
            vec![
                ("card--empty".into(), "p.stock == 0".into()),
                ("active".into(), "is(a, b)".into())
            ]
        );
        assert!(parse_class_object("isActive").is_none());
    }

    #[test]
    fn escaping_leaves_delimiters() {
        let mut out = String::new();
        escape_text("a < b & {{ x < y }} {% if a > b %}", &mut out);
        assert_eq!(out, "a &lt; b &amp; {{ x < y }} {% if a > b %}");
        let mut out = String::new();
        write_attr("hx-vals", r#"{"id": "{{ p.id }}"}"#, &mut out);
        assert_eq!(out, r#" hx-vals='{"id": "{{ p.id }}"}'"#);
    }
}
