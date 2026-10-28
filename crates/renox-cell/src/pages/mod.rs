//! The cell's side of page routes before dispatch (#41;
//! `docs/contracts/ops.md` section 14): the session cookie, the CSRF check
//! of page actions, and removing the platform's cookies and header from what
//! tenant code sees. Rendering is `render.rs`.
//!
//! Order for every request of a deployment with page routes:
//!
//! 1. `x-renox-csrf` is removed from the headers (kept aside).
//! 2. The route is matched with the runtime's router. Anything that is not a
//!    page route continues unchanged (function routes are not CSRF-checked:
//!    they are APIs, and webhooks verify signatures).
//! 3. Page route: the signed session cookie is verified, or a fresh id is
//!    minted; the platform cookies are removed from `Cookie`; the session
//!    goes to the runtime as a [`PageSession`] request extension.
//! 4. Page action (`POST ?/<name>` naming a declared action): the token from
//!    `x-renox-csrf` or the `_csrf` form field must equal the
//!    `__Host-renox_csrf` cookie, and both the session's token. Otherwise
//!    403 `RENOX_CSRF` and no tenant code runs (no meter record).

pub mod errors;
pub mod keys;
pub mod session;

use http::HeaderMap;
use renox_runtime::manifest::{RouteDef, RouteKind};
use renox_runtime::pages::{PageCall, PageSession, page_call};
use renox_runtime::router::{RouteMatch, Router};

pub use keys::{KeyError, PlatformKey};
pub use session::SessionKeys;

/// `RENOX_CSRF` (`errors.md` section 3).
pub const CSRF_CODE: &str = "RENOX_CSRF";
pub const CSRF_MESSAGE: &str = "The request could not be verified. Reload the page and try again.";

/// The page routes of one deployment.
pub struct PageGuard {
    routes: Vec<RouteDef>,
    router: Router,
    keys: SessionKeys,
}

impl std::fmt::Debug for PageGuard {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PageGuard")
            .field("routes", &self.routes.len())
            .finish_non_exhaustive()
    }
}

/// What the guard decided for one request.
#[derive(Debug, PartialEq, Eq)]
pub enum Gate {
    /// Not a page route: dispatch unchanged.
    Pass,
    /// A page route: dispatch with the session; `csrf_token` goes to the
    /// renderer (`<x-form>`, `<x-csrf>`), `set_cookie` onto the response.
    Page {
        session: PageSession,
        csrf_token: String,
        set_cookie: Vec<String>,
    },
    /// A page action without a valid token: 403 `RENOX_CSRF`.
    Refused {
        route: String,
        action: String,
        /// `missing` or `mismatch` (`errors.md`, `RENOX_CSRF` row).
        reason: &'static str,
    },
}

impl PageGuard {
    /// `None` for a deployment without page routes.
    pub fn new(routes: &[RouteDef], keys: SessionKeys) -> Option<PageGuard> {
        if !routes.iter().any(|r| r.kind == RouteKind::Page) {
            return None;
        }
        let router = Router::new(routes).ok()?;
        Some(PageGuard {
            routes: routes.to_vec(),
            router,
            keys,
        })
    }

    /// Steps 1-4 of the module doc. `headers` is changed in place.
    pub fn check(
        &self,
        method: &str,
        path: &str,
        query: Option<&str>,
        headers: &mut HeaderMap,
        body: &[u8],
        same_site_none: bool,
    ) -> Gate {
        let header_token = headers
            .remove(session::CSRF_HEADER)
            .and_then(|v| v.to_str().ok().map(str::to_string));
        let RouteMatch::Found { route, .. } = self.router.find(method, path) else {
            return Gate::Pass;
        };
        let def = &self.routes[route];
        if def.kind != RouteKind::Page {
            return Gate::Pass;
        }
        let mut set_cookie = Vec::new();
        let session_id = match session::cookie(headers, session::SESSION_COOKIE)
            .and_then(|v| self.keys.verify_session(&v))
        {
            Some(id) => id,
            None => {
                let id = SessionKeys::new_session_id();
                set_cookie.push(session::session_cookie(
                    &self.keys.sign_session(&id),
                    same_site_none,
                ));
                id
            }
        };
        let expected = self.keys.csrf_token(&session_id);
        let cookie_token = session::cookie(headers, session::CSRF_COOKIE);
        if !cookie_token
            .as_deref()
            .is_some_and(|c| session::same(c, &expected))
        {
            set_cookie.push(session::csrf_cookie(&expected));
        }
        session::strip_platform_cookies(headers);
        if let PageCall::Action(action) = page_call(def, method, query) {
            let submitted = header_token.or_else(|| session::form_token(headers, body));
            let reason = match (&submitted, &cookie_token) {
                (None, _) | (_, None) => Some("missing"),
                (Some(s), Some(c)) => {
                    (!(session::same(s, c) && session::same(c, &expected))).then_some("mismatch")
                }
            };
            if let Some(reason) = reason {
                return Gate::Refused {
                    route: format!("POST {}", def.path),
                    action,
                    reason,
                };
            }
        }
        Gate::Page {
            session: PageSession { id: session_id },
            csrf_token: expected,
            set_cookie,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn guard() -> PageGuard {
        let routes: Vec<RouteDef> = serde_json::from_value(serde_json::json!([
            { "kind": "page", "path": "/products/:id", "module": "pages/p", "load": true, "actions": ["addToCart"], "template": "pages/p" },
            { "kind": "function", "method": "POST", "path": "/api/x", "module": "functions/x", "export": "POST" }
        ]))
        .unwrap();
        PageGuard::new(&routes, SessionKeys::new([5u8; 32])).unwrap()
    }

    fn get_cookies(g: &PageGuard) -> (String, String, String) {
        let mut h = HeaderMap::new();
        match g.check("GET", "/products/1", None, &mut h, b"", false) {
            Gate::Page {
                session,
                csrf_token,
                set_cookie,
            } => {
                assert_eq!(set_cookie.len(), 2);
                let sid = set_cookie[0].split(';').next().unwrap().to_string();
                assert!(
                    set_cookie[0].contains("HttpOnly") && set_cookie[0].contains("SameSite=Lax")
                );
                assert!(!set_cookie[1].contains("HttpOnly"));
                (sid, csrf_token, session.id)
            }
            other => panic!("{other:?}"),
        }
    }

    fn headers(cookie: &str, extra: &[(&str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert("cookie", cookie.parse().unwrap());
        for (k, v) in extra {
            h.insert(
                http::HeaderName::from_bytes(k.as_bytes()).unwrap(),
                v.parse().unwrap(),
            );
        }
        h
    }

    /// `docs/23-failure-modes.md`, "CSRF token missing or wrong";
    /// `docs/24-threat-model.md`, "CSRF on actions".
    #[test]
    fn actions_need_the_session_token() {
        let g = guard();
        let (sid, token, id) = get_cookies(&g);
        let both = format!("{sid}; {}={token}; theme=dark", session::CSRF_COOKIE);

        // No token at all.
        let mut h = headers(&both, &[]);
        assert!(matches!(
            g.check(
                "POST",
                "/products/1",
                Some("/addToCart"),
                &mut h,
                b"",
                false
            ),
            Gate::Refused {
                reason: "missing",
                ..
            }
        ));
        // A wrong header token.
        let mut h = headers(&both, &[("x-renox-csrf", "AAAA")]);
        assert!(matches!(
            g.check(
                "POST",
                "/products/1",
                Some("/addToCart"),
                &mut h,
                b"",
                false
            ),
            Gate::Refused {
                reason: "mismatch",
                ..
            }
        ));
        // Header token without the cookie: missing (double submit).
        let mut h = headers(&sid, &[("x-renox-csrf", &token)]);
        assert!(matches!(
            g.check(
                "POST",
                "/products/1",
                Some("/addToCart"),
                &mut h,
                b"",
                false
            ),
            Gate::Refused {
                reason: "missing",
                ..
            }
        ));
        // Another session's token pair: mismatch.
        let (_, other_token, _) = get_cookies(&g);
        let forged = format!("{sid}; {}={other_token}", session::CSRF_COOKIE);
        let mut h = headers(&forged, &[("x-renox-csrf", &other_token)]);
        assert!(matches!(
            g.check(
                "POST",
                "/products/1",
                Some("/addToCart"),
                &mut h,
                b"",
                false
            ),
            Gate::Refused {
                reason: "mismatch",
                ..
            }
        ));
        // The header token: runs, and the platform cookies and header are gone.
        let mut h = headers(&both, &[("x-renox-csrf", &token)]);
        match g.check(
            "POST",
            "/products/1",
            Some("/addToCart"),
            &mut h,
            b"",
            false,
        ) {
            Gate::Page {
                session,
                set_cookie,
                ..
            } => {
                assert_eq!(session.id, id);
                assert!(set_cookie.is_empty());
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(h.get("cookie").unwrap(), "theme=dark");
        assert!(h.get("x-renox-csrf").is_none());
        // The form field.
        let mut h = headers(
            &both,
            &[("content-type", "application/x-www-form-urlencoded")],
        );
        let body = format!("productId=1&_csrf={token}");
        assert!(matches!(
            g.check(
                "POST",
                "/products/1",
                Some("/addToCart"),
                &mut h,
                body.as_bytes(),
                false
            ),
            Gate::Page { .. }
        ));
    }

    #[test]
    fn functions_and_gets_pass() {
        let g = guard();
        let mut h = headers("a=1", &[("x-renox-csrf", "t")]);
        assert_eq!(
            g.check("POST", "/api/x", None, &mut h, b"", false),
            Gate::Pass
        );
        assert!(h.get("x-renox-csrf").is_none(), "removed for every route");
        let mut h = HeaderMap::new();
        assert!(matches!(
            g.check("GET", "/products/2", None, &mut h, b"", false),
            Gate::Page { .. }
        ));
        // An unknown action is the runtime's 404, not a CSRF refusal.
        let mut h = HeaderMap::new();
        assert!(matches!(
            g.check("POST", "/products/2", Some("/nope"), &mut h, b"", false),
            Gate::Page { .. }
        ));
    }
}
