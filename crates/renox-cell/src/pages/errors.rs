//! Error pages of page routes (`docs/contracts/errors.md` section 1;
//! `docs/23-failure-modes.md` rule 2 and section 6; #93).
//!
//! A platform error on a page route (`RENOX_CPU_LIMIT`, `RENOX_OOM`,
//! `RENOX_DEADLINE`, `RENOX_RENDER_LIMIT`, `RENOX_INTERNAL`, a collateral
//! recycle victim's code) and an HTML 404 are answered with an HTML page,
//! never the JSON body API routes get:
//!
//! 1. the tenant's `pages/_error` (or `pages/_404` for a 404), given the four
//!    [`ErrorPage`] fields and the page's `locale`, `dir` and `app_name`
//!    (#739; [`ErrorLocale`]), rendered under the fixed error-page
//!    budget ([`renox_template::RenderLimits::ERROR_PAGE`]), so an error
//!    page cannot itself be a DoS vector;
//! 2. the platform default page ([`default_page`], the gateway's own HTML
//!    error page) when there is no template or it fails.
//!
//! Both get the page shell (`renox_template::shell`) with
//! `<meta name="renox-error-code">` when the cell renders them, so the
//! client script can report the code with browser events. The dev overlay
//! is never part of either: `renox dev` injects it in its proxy
//! (`cli/src/dev/overlay/`), outside the artifact and the worker.

use bytes::Bytes;
use http::{HeaderMap, Response};
use renox_template::render::i18n::{Dir, valid_locale};
use renox_template::{ErrorPage, Shell};

/// What the locale of an error page is read from: the request's `?lang=`
/// and `Accept-Language` (#739). The i18n module's stored preferences
/// (user, session, organisation) are not read: an error page must render
/// when the database or the isolate is what failed.
#[derive(Debug, Clone, Default)]
pub struct ErrorRequest {
    pub lang_query: Option<String>,
    pub accept_language: Option<String>,
}

impl ErrorRequest {
    pub fn of(query: Option<&str>, headers: &HeaderMap) -> ErrorRequest {
        ErrorRequest {
            lang_query: query.and_then(|q| {
                q.split('&')
                    .find_map(|kv| kv.strip_prefix("lang="))
                    .map(str::to_string)
            }),
            accept_language: headers
                .get(http::header::ACCEPT_LANGUAGE)
                .and_then(|v| v.to_str().ok())
                .map(str::to_string),
        }
    }
}

/// The locale and direction an error page is rendered in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ErrorLocale {
    /// The tag `setLocale` would get (`ar`, `ar-u-nu-arab`).
    pub locale: String,
    pub dir: Dir,
}

impl Default for ErrorLocale {
    /// No i18n module: `en`, left to right.
    fn default() -> Self {
        ErrorLocale {
            locale: "en".into(),
            dir: Dir::Ltr,
        }
    }
}

/// The i18n module's options, from its `config` in the manifest: a Rust
/// port of `modules/i18n/lib/detect.ts` (`options`, `match`, `negotiate`,
/// `pick`, `tagOf`) without the stored candidates.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct I18nOptions {
    locales: Vec<String>,
    fallback: String,
    digits: String,
    calendar: String,
}

fn primary(tag: &str) -> String {
    tag.split('-').next().unwrap_or("").to_ascii_lowercase()
}

/// The `nu` and `ca` values of a tag's `-u-` extension, and the part before it.
fn split_tag(tag: &str) -> (&str, Option<&str>, Option<&str>) {
    let t = tag.trim();
    let lower = t.to_ascii_lowercase();
    let Some(i) = lower.find("-u-") else {
        return (t, None, None);
    };
    let ext = &lower[i + 3..];
    let nu = ["arab", "latn"].into_iter().find(|n| {
        ext.split('-')
            .zip(ext.split('-').skip(1))
            .any(|(k, v)| k == "nu" && v == *n)
    });
    const CA: [&str; 6] = [
        "gregory",
        "islamic",
        "islamic-civil",
        "islamic-tbla",
        "islamic-umalqura",
        "persian",
    ];
    let ca = CA.into_iter().find(|c| {
        ext.strip_prefix("ca-")
            .is_some_and(|r| r == *c || r.starts_with(&format!("{c}-nu-")))
    });
    (&t[..i], nu, ca)
}

impl I18nOptions {
    /// The options when the manifest's `modules` installs `i18n`.
    pub fn from_modules(modules: Option<&serde_json::Value>) -> Option<I18nOptions> {
        let module = modules?
            .as_array()?
            .iter()
            .find(|m| m.get("name").and_then(|n| n.as_str()) == Some("i18n"))?;
        let config = module.get("config").and_then(|c| c.as_object());
        let get = |k: &str| config.and_then(|c| c.get(k)).and_then(|v| v.as_str());
        let mut locales: Vec<String> = Vec::new();
        for s in get("locales").unwrap_or("en,ar").split(',') {
            let s = s.trim();
            if valid_locale(s) && !s.contains("-u-") && !locales.iter().any(|l| l == s) {
                locales.push(s.to_string());
            }
        }
        if locales.is_empty() {
            locales.push("en".into());
        }
        let want = get("default_locale").unwrap_or("en");
        let fallback = Self::matching(&locales, want).unwrap_or_else(|| locales[0].clone());
        let pick = |k: &str, allowed: &[&str]| {
            get(k)
                .filter(|v| allowed.contains(v))
                .unwrap_or(allowed[0])
                .to_string()
        };
        Some(I18nOptions {
            locales,
            fallback,
            digits: pick("digits", &["latn", "arab", "auto"]),
            calendar: pick("calendar", &["gregory", "islamic-umalqura", "auto"]),
        })
    }

    /// `tag` when offered, else an offered locale with its language.
    fn matching(locales: &[String], tag: &str) -> Option<String> {
        let (base, _, _) = split_tag(tag);
        let well_formed = !base.is_empty()
            && base.split('-').enumerate().all(|(i, p)| {
                let n = p.len();
                p.bytes().all(|b| b.is_ascii_alphanumeric())
                    && if i == 0 {
                        (2..=3).contains(&n) && p.bytes().all(|b| b.is_ascii_alphabetic())
                    } else {
                        (2..=8).contains(&n)
                    }
            });
        if !well_formed {
            return None;
        }
        locales
            .iter()
            .find(|l| l.eq_ignore_ascii_case(base))
            .or_else(|| locales.iter().find(|l| primary(l) == primary(base)))
            .cloned()
    }

    /// `Accept-Language` by quality, the first offered match; `*` is ignored.
    fn negotiate(&self, header: &str) -> Option<String> {
        if header.len() > 1024 {
            return None;
        }
        let mut ranges: Vec<(usize, f64, &str)> = header
            .split(',')
            .enumerate()
            .filter_map(|(i, part)| {
                let mut it = part.trim().split(';');
                let tag = it.next().unwrap_or("").trim();
                let q = it
                    .map(str::trim)
                    .find_map(|p| p.strip_prefix("q="))
                    .map_or(1.0, |q| {
                        q.parse::<f64>()
                            .ok()
                            .filter(|q| q.is_finite())
                            .unwrap_or(0.0)
                    });
                (!tag.is_empty() && tag != "*" && q > 0.0).then_some((i, q, tag))
            })
            .collect();
        ranges.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
        ranges
            .into_iter()
            .find_map(|(_, _, tag)| Self::matching(&self.locales, tag))
    }

    /// The locale and direction of `req`: `?lang=`, `Accept-Language`, the
    /// configured default.
    pub fn resolve(&self, req: &ErrorRequest) -> ErrorLocale {
        let query = req.lang_query.as_deref();
        let locale = query
            .and_then(|q| Self::matching(&self.locales, q))
            .or_else(|| {
                req.accept_language
                    .as_deref()
                    .and_then(|h| self.negotiate(h))
            })
            .unwrap_or_else(|| self.fallback.clone());
        // Digits and calendar only on Arabic pages; `auto` follows what
        // `?lang=` asked for (nothing is stored to read here).
        let (nu, ca) = match query {
            Some(q) if Self::matching(&self.locales, q).is_some() => {
                let (_, nu, ca) = split_tag(q);
                (nu, ca)
            }
            _ => (None, None),
        };
        let arabic = primary(&locale) == "ar";
        let arab_digits = arabic
            && match self.digits.as_str() {
                "auto" => nu == Some("arab"),
                d => d == "arab",
            };
        let calendar = if !arabic {
            "gregory"
        } else if self.calendar == "auto" {
            ca.unwrap_or("gregory")
        } else {
            self.calendar.as_str()
        };
        let mut ext = Vec::new();
        if calendar != "gregory" {
            ext.push(format!("ca-{calendar}"));
        }
        if arab_digits {
            ext.push("nu-arab".to_string());
        }
        let dir = Dir::of_locale(&locale);
        let locale = if ext.is_empty() {
            locale
        } else {
            format!("{locale}-u-{}", ext.join("-"))
        };
        ErrorLocale { locale, dir }
    }
}

/// The platform default page as a response, with the shell tags when the
/// cell knows them.
pub fn default_page(page: ErrorPage<'_>, shell: Option<Shell<'_>>) -> Response<Bytes> {
    let html = renox_gateway::limits::default_page_html(page.status, page.message, page.request_id);
    let html = match shell {
        Some(s) => s.inject(&html),
        None => html,
    };
    Response::builder()
        .status(page.status)
        .header("content-type", "text/html; charset=utf-8")
        .header("cache-control", "no-store")
        .header("x-renox-request-id", page.request_id)
        .body(Bytes::from(html))
        .expect("static response parts are valid")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts(config: serde_json::Value) -> I18nOptions {
        I18nOptions::from_modules(Some(
            &serde_json::json!([{ "name": "i18n", "config": config }]),
        ))
        .unwrap()
    }

    fn req(q: Option<&str>, al: Option<&str>) -> ErrorRequest {
        ErrorRequest {
            lang_query: q.map(str::to_string),
            accept_language: al.map(str::to_string),
        }
    }

    #[test]
    fn locale_follows_query_then_accept_language_then_default() {
        let o = opts(serde_json::json!({}));
        let ar = ErrorLocale {
            locale: "ar".into(),
            dir: Dir::Rtl,
        };
        assert_eq!(o.resolve(&req(Some("ar"), None)), ar);
        assert_eq!(
            o.resolve(&req(None, Some("fr;q=0.9, ar-AE;q=0.8, en;q=0.1"))),
            ar
        );
        assert_eq!(
            o.resolve(&req(Some("en"), Some("ar"))),
            ErrorLocale::default()
        );
        assert_eq!(o.resolve(&req(Some("xx"), None)), ErrorLocale::default());
        let o = opts(serde_json::json!({ "default_locale": "ar" }));
        assert_eq!(o.resolve(&req(None, Some("*"))), ar);
        let o = opts(serde_json::json!({ "digits": "arab" }));
        assert_eq!(o.resolve(&req(Some("ar"), None)).locale, "ar-u-nu-arab");
        assert!(
            I18nOptions::from_modules(Some(&serde_json::json!([{ "name": "auth" }]))).is_none()
        );
        assert!(I18nOptions::from_modules(None).is_none());
    }

    #[test]
    fn default_page_shows_status_message_and_id_only() {
        let page = ErrorPage {
            status: 503,
            code: Some("RENOX_CPU_LIMIT"),
            request_id: "01JBQ3Z7MA0000000000000101",
            message: "The request used too much CPU.",
        };
        let r = default_page(page, None);
        assert_eq!(r.status(), 503);
        let body = std::str::from_utf8(r.body()).unwrap();
        assert!(body.contains("<h1>503</h1>"));
        assert!(body.contains("The request used too much CPU."));
        assert!(body.contains("01JBQ3Z7MA0000000000000101"));
        assert!(!body.contains("RENOX_CPU_LIMIT"), "the code is not shown");
        let shell = Shell {
            request_id: page.request_id,
            deployment: "abc",
            nonce: Some("n"),
            script_src: Some("/__renox/client.js?v=1"),
            error_code: page.code,
        };
        let r = default_page(page, Some(shell));
        let body = std::str::from_utf8(r.body()).unwrap();
        assert!(body.contains("<meta name=\"renox-error-code\" content=\"RENOX_CPU_LIMIT\">"));
        assert!(
            !body.contains("__renox/dev"),
            "no dev overlay in the worker"
        );
    }
}
