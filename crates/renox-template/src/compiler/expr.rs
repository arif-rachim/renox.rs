//! Directive and interpolation expressions: translation from the template
//! language to minijinja, and the checks that keep it a DSL with no code
//! execution (`docs/08-template-engine.md`, "The expression language is
//! deliberately small"; AGENTS.md, "Templates are a DSL").
//!
//! Allowed: property access (`a.b`, `a[0]`, `a["k"]`), literals, comparisons,
//! `&&`, `||`, `!`, `??`, `x if c else y`, tests (`is defined`), and filters
//! from the allowlist. Rejected: free function calls, method calls, names
//! starting with `__` (reserved for the platform value), unknown filters and
//! tests.

use std::collections::BTreeSet;

use minijinja::Environment;

/// Platform filters (`docs/08-template-engine.md`) plus the safe builtins
/// the renderer registers. `safe` is not here: raw HTML is `r-html`.
pub const FILTERS: &[&str] = &[
    "money", "date", "ago", "number", "truncate", "json", "upper", "lower", "default", "length",
    "first", "last", "join", "trim", "round", "abs",
];

/// Tests usable after `is` / `is not`.
pub const TESTS: &[&str] = &[
    "defined",
    "undefined",
    "none",
    "true",
    "false",
    "number",
    "string",
    "sequence",
    "mapping",
    "even",
    "odd",
    "divisibleby",
    "eq",
    "ne",
    "lt",
    "le",
    "gt",
    "ge",
    "in",
    "startingwith",
    "endingwith",
];

/// Keywords that may precede `(` without making it a call.
const GROUPING_KEYWORDS: &[&str] = &["and", "or", "not", "in", "if", "else", "is"];

/// Checks and translates expressions. `filters` is the allowlist
/// ([`FILTERS`] plus module filters from the compile options).
pub struct ExprChecker {
    env: Environment<'static>,
    filters: BTreeSet<String>,
}

impl ExprChecker {
    pub fn new(extra_filters: &BTreeSet<String>) -> ExprChecker {
        let mut filters: BTreeSet<String> = FILTERS.iter().map(|s| s.to_string()).collect();
        filters.extend(extra_filters.iter().cloned());
        ExprChecker {
            env: Environment::empty(),
            filters,
        }
    }

    /// Translates `raw` to a minijinja expression and checks it. The error
    /// is a one-line reason without position (the caller adds it).
    pub fn check(&self, raw: &str) -> Result<String, String> {
        let raw = raw.trim();
        if raw.is_empty() {
            return Err("empty expression".into());
        }
        let translated = translate(raw)?;
        self.check_tokens(&translated)?;
        if let Err(e) = self.env.compile_expression(&translated) {
            return Err(format!(
                "invalid expression: {}",
                e.detail().unwrap_or("syntax error")
            ));
        }
        Ok(translated)
    }

    /// Scans the translated expression outside string literals: no calls
    /// except filter and test arguments, no reserved names, known filters
    /// and tests only.
    fn check_tokens(&self, expr: &str) -> Result<(), String> {
        let tokens = tokenize(expr)?;
        for (i, tok) in tokens.iter().enumerate() {
            match tok {
                Tok::Ident(name) => {
                    let prev = i.checked_sub(1).map(|j| &tokens[j]);
                    let after_dot = matches!(prev, Some(Tok::Punct('.')));
                    if name.starts_with("__") {
                        return Err(format!("`{name}` is reserved for the platform"));
                    }
                    if matches!(prev, Some(Tok::Punct('|'))) && !self.filters.contains(name) {
                        return Err(format!("unknown filter `{name}`"));
                    }
                    let after_is = matches!(prev, Some(Tok::Ident(p)) if p == "is")
                        || (matches!(prev, Some(Tok::Ident(p)) if p == "not")
                            && matches!(i.checked_sub(2).map(|j| &tokens[j]), Some(Tok::Ident(p)) if p == "is"));
                    if after_is && !TESTS.contains(&name.as_str()) && name != "not" {
                        return Err(format!("unknown test `{name}`"));
                    }
                    if matches!(tokens.get(i + 1), Some(Tok::Punct('(')))
                        && !GROUPING_KEYWORDS.contains(&name.as_str())
                    {
                        let filter_call = matches!(prev, Some(Tok::Punct('|')));
                        if after_dot {
                            return Err(format!("method calls are not allowed (`.{name}(`)"));
                        }
                        if !filter_call && !after_is {
                            return Err(format!(
                                "function calls are not allowed (`{name}(`); compute the value in the loader"
                            ));
                        }
                    }
                }
                Tok::Punct('(') => {
                    if let Some(Tok::Punct(')' | ']')) = i.checked_sub(1).map(|j| &tokens[j]) {
                        return Err("function calls are not allowed".into());
                    }
                }
                _ => {}
            }
        }
        Ok(())
    }
}

#[derive(Debug, PartialEq)]
enum Tok {
    Ident(String),
    Punct(char),
    Other,
}

fn tokenize(expr: &str) -> Result<Vec<Tok>, String> {
    let mut out = Vec::new();
    let mut chars = expr.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\'' || c == '"' {
            let mut closed = false;
            while let Some(n) = chars.next() {
                if n == '\\' {
                    chars.next();
                } else if n == c {
                    closed = true;
                    break;
                }
            }
            if !closed {
                return Err("unterminated string literal".into());
            }
            out.push(Tok::Other);
        } else if c.is_alphabetic() || c == '_' {
            let mut name = String::from(c);
            while let Some(&n) = chars.peek() {
                if n.is_alphanumeric() || n == '_' {
                    name.push(n);
                    chars.next();
                } else {
                    break;
                }
            }
            out.push(Tok::Ident(name));
        } else if c.is_ascii_digit() {
            while chars
                .peek()
                .is_some_and(|n| n.is_ascii_alphanumeric() || *n == '.' || *n == '_')
            {
                chars.next();
            }
            out.push(Tok::Other);
        } else if c.is_whitespace() {
            continue;
        } else {
            out.push(Tok::Punct(c));
        }
    }
    Ok(out)
}

/// Translates the JavaScript-style operators (`&&`, `||`, prefix `!`, `??`)
/// to minijinja. String literals are copied unchanged; `!=` is kept.
pub fn translate(expr: &str) -> Result<String, String> {
    let parts = split_top_level_op(expr, "??");
    if parts.len() > 1 {
        if parts.iter().any(|p| p.trim().is_empty()) {
            return Err("`??` needs an operand on both sides".into());
        }
        // a ?? b ?? c  ->  a if a is defined and a is not none else (b ?? c)
        let mut acc = translate_ops(parts.last().expect("non-empty").trim());
        for part in parts[..parts.len() - 1].iter().rev() {
            let a = translate_ops(part.trim());
            acc = format!("(({a}) if ({a}) is defined and ({a}) is not none else ({acc}))");
        }
        return Ok(acc);
    }
    Ok(translate_ops(expr.trim()))
}

fn translate_ops(expr: &str) -> String {
    let mut out = String::with_capacity(expr.len() + 8);
    let mut chars = expr.chars().peekable();
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

/// Splits on a two-character operator outside quotes and brackets.
fn split_top_level_op(s: &str, op: &str) -> Vec<String> {
    let op: Vec<char> = op.chars().collect();
    let chars: Vec<char> = s.chars().collect();
    let mut parts = Vec::new();
    let mut cur = String::new();
    let mut depth = 0i32;
    let mut quote: Option<char> = None;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if let Some(q) = quote {
            cur.push(c);
            if c == '\\' && i + 1 < chars.len() {
                cur.push(chars[i + 1]);
                i += 2;
                continue;
            }
            if c == q {
                quote = None;
            }
            i += 1;
            continue;
        }
        match c {
            '\'' | '"' => quote = Some(c),
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => depth -= 1,
            _ => {}
        }
        if depth == 0 && chars[i..].starts_with(&op) {
            parts.push(std::mem::take(&mut cur));
            i += op.len();
            continue;
        }
        cur.push(c);
        i += 1;
    }
    parts.push(cur);
    parts
}

#[cfg(test)]
mod tests {
    use super::*;

    fn check(e: &str) -> Result<String, String> {
        ExprChecker::new(&BTreeSet::new()).check(e)
    }

    #[test]
    fn translates_js_operators_outside_strings() {
        assert_eq!(
            check("a && !b || c != 'x && y'").unwrap(),
            "a and not b or c != 'x && y'"
        );
        assert_eq!(check("!ok").unwrap(), "not ok");
        assert_eq!(check("p.stock == 0").unwrap(), "p.stock == 0");
    }

    #[test]
    fn nullish_coalescing() {
        assert_eq!(
            check("user.name ?? 'Guest'").unwrap(),
            "((user.name) if (user.name) is defined and (user.name) is not none else ('Guest'))"
        );
        assert!(check("?? a").is_err());
        assert_eq!(check("'a ?? b'").unwrap(), "'a ?? b'");
    }

    #[test]
    fn filters_and_tests() {
        assert!(check("p.price | money").is_ok());
        assert!(check("name | truncate(20)").is_ok());
        assert!(check("x is defined").is_ok());
        assert!(check("x is not none").is_ok());
        assert!(check("x is divisibleby(3)").is_ok());
        assert_eq!(check("x | safe").unwrap_err(), "unknown filter `safe`");
        assert_eq!(check("x | pprint").unwrap_err(), "unknown filter `pprint`");
        assert_eq!(
            check("x is callable").unwrap_err(),
            "unknown test `callable`"
        );
    }

    #[test]
    fn calls_and_reserved_names_are_rejected() {
        for bad in [
            "range(10)",
            "can('x', y)",
            "user.items()",
            "f(1)(2)",
            "a[0](1)",
            "namespace()",
            "__renox.csp_nonce",
            "x | default(__renox)",
        ] {
            assert!(check(bad).is_err(), "{bad}");
        }
        assert!(check("not (a or b)").is_ok());
        assert!(check("x in (1, 2)").is_ok());
        assert!(check("(a if b else c)").is_ok());
    }

    #[test]
    fn syntax_errors_are_reported() {
        assert!(check("a ==").unwrap_err().starts_with("invalid expression"));
        assert!(check("'open").is_err());
    }
}
