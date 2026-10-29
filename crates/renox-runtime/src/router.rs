//! Handler lookup: `manifest.routes[]` matched by method and path
//! (`docs/contracts/artifact.md` section 3, "Route objects";
//! `docs/07-app-model.md`, "Routing rules").
//!
//! Pure Rust, no V8: a request with no matching route is answered (404 or
//! 405) without entering the isolate, and these tests run in the non-V8
//! test target.

use std::collections::BTreeMap;

use crate::manifest::{Method, RouteDef, RouteKind};

/// One segment of a compiled route pattern.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Segment {
    /// Matched case-sensitively against the percent-decoded path segment.
    Static(String),
    /// `:name`: exactly one non-empty segment.
    Param(String),
    /// `*name`: one or more segments, only as the last segment.
    CatchAll(String),
}

impl Segment {
    /// Lower is more specific: static beats parameter beats catch-all.
    fn rank(&self) -> u8 {
        match self {
            Segment::Static(_) => 0,
            Segment::Param(_) => 1,
            Segment::CatchAll(_) => 2,
        }
    }
}

/// A route pattern that does not follow the syntax of `artifact.md`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PatternError {
    pub pattern: String,
    pub reason: &'static str,
}

impl std::fmt::Display for PatternError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "invalid route pattern {:?}: {}",
            self.pattern, self.reason
        )
    }
}

impl std::error::Error for PatternError {}

fn valid_name(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some('a'..='z' | '_'))
        && name.len() <= 32
        && chars.all(|c| matches!(c, 'a'..='z' | '0'..='9' | '_'))
}

fn valid_static(s: &str) -> bool {
    !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '~' | '-'))
}

fn compile(pattern: &str) -> Result<Vec<Segment>, PatternError> {
    let err = |reason| PatternError {
        pattern: pattern.to_string(),
        reason,
    };
    if pattern == "/" {
        return Ok(Vec::new());
    }
    let rest = pattern
        .strip_prefix('/')
        .ok_or_else(|| err("must start with /"))?;
    let parts: Vec<&str> = rest.split('/').collect();
    let mut segments = Vec::with_capacity(parts.len());
    let mut names = Vec::new();
    for (i, part) in parts.iter().enumerate() {
        let seg = if let Some(name) = part.strip_prefix(':') {
            Segment::Param(name.to_string())
        } else if let Some(name) = part.strip_prefix('*') {
            if i != parts.len() - 1 {
                return Err(err("a catch-all must be the last segment"));
            }
            Segment::CatchAll(name.to_string())
        } else if valid_static(part) {
            Segment::Static(part.to_string())
        } else {
            return Err(err("invalid or empty static segment"));
        };
        if let Segment::Param(n) | Segment::CatchAll(n) = &seg {
            if !valid_name(n) {
                return Err(err("invalid parameter name"));
            }
            if names.contains(n) {
                return Err(err("duplicate parameter name"));
            }
            names.push(n.clone());
        }
        segments.push(seg);
    }
    Ok(segments)
}

/// A route parameter value: `:id` gives a string, `*slug` a list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParamValue {
    One(String),
    Many(Vec<String>),
}

/// The result of matching a request against the route table.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RouteMatch {
    /// Index into `manifest.routes`, plus the parameters.
    Found {
        route: usize,
        params: BTreeMap<String, ParamValue>,
    },
    /// No pattern matches the path.
    NotFound,
    /// A pattern matches the path but not for this method. `allow` is the
    /// value of the `Allow` header.
    MethodNotAllowed { allow: String },
    /// Artifact v1 trailing slash rule (`artifact.md` section 3, "Trailing
    /// slashes"): a `GET`/`HEAD` path ending in `/` that matches nothing,
    /// whose path without the `/` matches a page route. Answer 308 to
    /// `location` (the query string is the caller's to keep).
    Redirect { location: String },
}

#[derive(Debug)]
struct CompiledRoute {
    /// Index into `manifest.routes`.
    route: usize,
    method: Method,
    page: bool,
    segments: Vec<Segment>,
}

/// The compiled route table of one deployment.
#[derive(Debug)]
pub struct Router {
    routes: Vec<CompiledRoute>,
}

/// Percent-decode one path segment. `None` when the result is not UTF-8:
/// such a segment matches nothing.
fn decode_segment(raw: &str) -> Option<String> {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok()?;
            if let Ok(b) = u8::from_str_radix(hex, 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).ok()
}

impl Router {
    /// A page route answers `GET` (and so `HEAD`), and `POST` when it
    /// declares actions (`artifact.md` section 3, "Methods of a page route").
    pub fn new(routes: &[RouteDef]) -> Result<Router, PatternError> {
        let mut compiled = Vec::with_capacity(routes.len());
        for (i, r) in routes.iter().enumerate() {
            // Tool and job routes have no URL (artifact.md 1.3).
            if matches!(r.kind, RouteKind::Tool | RouteKind::Job) {
                continue;
            }
            let segments = compile(&r.path)?;
            let page = r.kind == RouteKind::Page;
            let actions = page && r.page().is_some_and(|p| !p.actions.is_empty());
            compiled.push(CompiledRoute {
                route: i,
                method: r.method,
                page,
                segments: segments.clone(),
            });
            if actions {
                compiled.push(CompiledRoute {
                    route: i,
                    method: Method::Post,
                    page,
                    segments,
                });
            }
        }
        Ok(Router { routes: compiled })
    }

    /// Match `segments` (already decoded) against one pattern. Returns the
    /// parameters and the specificity key on success.
    fn match_route(
        route: &CompiledRoute,
        segments: &[String],
    ) -> Option<(Vec<u8>, BTreeMap<String, ParamValue>)> {
        let mut params = BTreeMap::new();
        let mut key = Vec::with_capacity(route.segments.len());
        let mut i = 0;
        for seg in &route.segments {
            key.push(seg.rank());
            match seg {
                Segment::Static(s) => {
                    if segments.get(i)? != s {
                        return None;
                    }
                    i += 1;
                }
                Segment::Param(name) => {
                    let v = segments.get(i)?;
                    if v.is_empty() {
                        return None;
                    }
                    params.insert(name.clone(), ParamValue::One(v.clone()));
                    i += 1;
                }
                Segment::CatchAll(name) => {
                    let rest = &segments[i..];
                    if rest.is_empty() || rest.iter().any(|s| s.is_empty()) {
                        return None;
                    }
                    params.insert(name.clone(), ParamValue::Many(rest.to_vec()));
                    i = segments.len();
                }
            }
        }
        (i == segments.len()).then_some((key, params))
    }

    /// Find the handler for `method` and the URL `path` (no query string).
    /// Segment by segment, a static segment beats a parameter, which beats a
    /// catch-all. `HEAD` falls back to the `GET` route when no `HEAD` route
    /// exists (`ops.md` section 6).
    pub fn find(&self, method: &str, path: &str) -> RouteMatch {
        let found = self.find_exact(method, path);
        if found == RouteMatch::NotFound
            && matches!(method, "GET" | "HEAD")
            && path.len() > 1
            && let Some(trimmed) = path.strip_suffix('/')
            && let RouteMatch::Found { route, .. } = self.find_exact("GET", trimmed)
            && self.routes.iter().any(|r| r.route == route && r.page)
        {
            return RouteMatch::Redirect {
                location: trimmed.to_string(),
            };
        }
        found
    }

    fn find_exact(&self, method: &str, path: &str) -> RouteMatch {
        let segments: Vec<String> = if path == "/" {
            Vec::new()
        } else {
            let Some(rest) = path.strip_prefix('/') else {
                return RouteMatch::NotFound;
            };
            match rest
                .split('/')
                .map(decode_segment)
                .collect::<Option<Vec<_>>>()
            {
                Some(s) => s,
                None => return RouteMatch::NotFound,
            }
        };
        let candidates: Vec<(usize, Vec<u8>, BTreeMap<String, ParamValue>)> = self
            .routes
            .iter()
            .enumerate()
            .filter_map(|(i, r)| Self::match_route(r, &segments).map(|(k, p)| (i, k, p)))
            .collect();
        if candidates.is_empty() {
            return RouteMatch::NotFound;
        }
        let best_for = |m: Method| {
            candidates
                .iter()
                .filter(|(i, _, _)| self.routes[*i].method == m)
                .min_by(|a, b| a.1.cmp(&b.1))
        };
        let wanted = Method::parse(method);
        let hit = match wanted {
            Some(Method::Head) => best_for(Method::Head).or_else(|| best_for(Method::Get)),
            Some(m) => best_for(m),
            None => None,
        };
        if let Some((i, _, params)) = hit {
            return RouteMatch::Found {
                route: self.routes[*i].route,
                params: params.clone(),
            };
        }
        let mut allow: Vec<&'static str> = Vec::new();
        for (i, _, _) in &candidates {
            let m = self.routes[*i].method;
            if !allow.contains(&m.as_str()) {
                allow.push(m.as_str());
            }
            if m == Method::Get && !allow.contains(&"HEAD") {
                allow.push("HEAD");
            }
        }
        RouteMatch::MethodNotAllowed {
            allow: allow.join(", "),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::RouteKind;

    fn route(method: Method, path: &str) -> RouteDef {
        RouteDef {
            kind: RouteKind::Function,
            method,
            path: path.to_string(),
            module: "m".to_string(),
            export: method.as_str().to_string(),
            page: None,
            guard: None,
            tool: None,
            job: None,
        }
    }

    fn one(s: &str) -> ParamValue {
        ParamValue::One(s.to_string())
    }

    #[test]
    fn static_and_root() {
        let r = Router::new(&[route(Method::Get, "/"), route(Method::Get, "/api/hello")]).unwrap();
        assert!(matches!(
            r.find("GET", "/"),
            RouteMatch::Found { route: 0, .. }
        ));
        assert!(matches!(
            r.find("GET", "/api/hello"),
            RouteMatch::Found { route: 1, .. }
        ));
        assert_eq!(r.find("GET", "/api/hello/"), RouteMatch::NotFound);
        assert_eq!(r.find("GET", "/api/Hello"), RouteMatch::NotFound);
        assert_eq!(r.find("GET", "/nope"), RouteMatch::NotFound);
    }

    #[test]
    fn static_beats_param_beats_catch_all() {
        let r = Router::new(&[
            route(Method::Get, "/a/*rest"),
            route(Method::Get, "/a/:id"),
            route(Method::Get, "/a/new"),
        ])
        .unwrap();
        assert!(matches!(
            r.find("GET", "/a/new"),
            RouteMatch::Found { route: 2, .. }
        ));
        match r.find("GET", "/a/42") {
            RouteMatch::Found { route: 1, params } => assert_eq!(params["id"], one("42")),
            other => panic!("{other:?}"),
        }
        match r.find("GET", "/a/x/y") {
            RouteMatch::Found { route: 0, params } => assert_eq!(
                params["rest"],
                ParamValue::Many(vec!["x".into(), "y".into()])
            ),
            other => panic!("{other:?}"),
        }
        // A catch-all needs at least one segment.
        assert_eq!(r.find("GET", "/a"), RouteMatch::NotFound);
    }

    #[test]
    fn params_are_percent_decoded() {
        let r = Router::new(&[route(Method::Get, "/p/:name")]).unwrap();
        match r.find("GET", "/p/caf%C3%A9%20x") {
            RouteMatch::Found { params, .. } => assert_eq!(params["name"], one("café x")),
            other => panic!("{other:?}"),
        }
        // Invalid UTF-8 after decoding matches nothing.
        assert_eq!(r.find("GET", "/p/%FF"), RouteMatch::NotFound);
        // An empty segment is not a parameter value.
        assert_eq!(r.find("GET", "/p/"), RouteMatch::NotFound);
    }

    #[test]
    fn method_not_allowed_lists_allow() {
        let r = Router::new(&[route(Method::Get, "/x"), route(Method::Post, "/x")]).unwrap();
        assert_eq!(
            r.find("DELETE", "/x"),
            RouteMatch::MethodNotAllowed {
                allow: "GET, HEAD, POST".into()
            }
        );
        assert_eq!(
            r.find("BREW", "/x"),
            RouteMatch::MethodNotAllowed {
                allow: "GET, HEAD, POST".into()
            }
        );
    }

    #[test]
    fn head_falls_back_to_get() {
        let r = Router::new(&[route(Method::Get, "/x")]).unwrap();
        assert!(matches!(
            r.find("HEAD", "/x"),
            RouteMatch::Found { route: 0, .. }
        ));
        let r = Router::new(&[route(Method::Get, "/x"), route(Method::Head, "/x")]).unwrap();
        assert!(matches!(
            r.find("HEAD", "/x"),
            RouteMatch::Found { route: 1, .. }
        ));
    }

    fn page(path: &str, actions: &[&str]) -> RouteDef {
        serde_json::from_value(serde_json::json!({
            "kind": "page", "path": path, "module": "pages/p", "load": true,
            "actions": actions, "template": "pages/p"
        }))
        .unwrap()
    }

    /// `docs/07-app-model.md`, "Routing rules": one row each. The CLI turns
    /// `about.html`, `products/index.html`, `products/[id].html`,
    /// `docs/[...slug].html` into these patterns; `_layouts/*` and `_404`
    /// are never routes, so nothing can match them.
    #[test]
    fn page_routing_rule_rows() {
        let r = Router::new(&[
            page("/about", &[]),
            page("/products", &[]),
            page("/products/:id", &["addToCart"]),
            page("/docs/*slug", &[]),
            route(Method::Get, "/api/orders"),
        ])
        .unwrap();
        assert!(matches!(
            r.find("GET", "/about"),
            RouteMatch::Found { route: 0, .. }
        ));
        assert!(matches!(
            r.find("GET", "/products"),
            RouteMatch::Found { route: 1, .. }
        ));
        match r.find("GET", "/products/42") {
            RouteMatch::Found { route: 2, params } => assert_eq!(params["id"], one("42")),
            other => panic!("{other:?}"),
        }
        match r.find("GET", "/docs/a/b") {
            RouteMatch::Found { route: 3, params } => {
                assert_eq!(
                    params["slug"],
                    ParamValue::Many(vec!["a".into(), "b".into()])
                )
            }
            other => panic!("{other:?}"),
        }
        assert!(matches!(
            r.find("GET", "/api/orders"),
            RouteMatch::Found { route: 4, .. }
        ));
        for not_a_route in ["/_layouts/main", "/_404", "/_error"] {
            assert_eq!(r.find("GET", not_a_route), RouteMatch::NotFound);
        }
    }

    /// A page answers GET and HEAD, and POST only when it has actions; any
    /// other method is 405 with that Allow list.
    #[test]
    fn page_methods_and_allow() {
        let r = Router::new(&[page("/products/:id", &["addToCart"]), page("/about", &[])]).unwrap();
        assert!(matches!(
            r.find("POST", "/products/1"),
            RouteMatch::Found { route: 0, .. }
        ));
        assert!(matches!(
            r.find("HEAD", "/products/1"),
            RouteMatch::Found { route: 0, .. }
        ));
        assert_eq!(
            r.find("DELETE", "/products/1"),
            RouteMatch::MethodNotAllowed {
                allow: "GET, HEAD, POST".into()
            }
        );
        assert_eq!(
            r.find("POST", "/about"),
            RouteMatch::MethodNotAllowed {
                allow: "GET, HEAD".into()
            }
        );
    }

    /// `artifact.md` section 3, "Trailing slashes": 308 for page routes on
    /// GET/HEAD only; function routes and POST are never redirected.
    #[test]
    fn trailing_slash_redirects_pages_only() {
        let r = Router::new(&[
            page("/products/:id", &["addToCart"]),
            route(Method::Get, "/api/hello"),
        ])
        .unwrap();
        assert_eq!(
            r.find("GET", "/products/42/"),
            RouteMatch::Redirect {
                location: "/products/42".into()
            }
        );
        assert_eq!(
            r.find("HEAD", "/products/42/"),
            RouteMatch::Redirect {
                location: "/products/42".into()
            }
        );
        assert_eq!(r.find("POST", "/products/42/"), RouteMatch::NotFound);
        assert_eq!(r.find("GET", "/api/hello/"), RouteMatch::NotFound);
        assert_eq!(r.find("GET", "/nope/"), RouteMatch::NotFound);
    }

    #[test]
    fn bad_patterns_are_rejected() {
        for p in [
            "", "x", "/a/", "/a//b", "/*a/b", "/:A", "/:a/:a", "/a b", "/:",
        ] {
            assert!(compile(p).is_err(), "{p:?}");
        }
    }
}
