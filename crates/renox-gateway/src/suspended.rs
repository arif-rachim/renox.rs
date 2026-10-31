//! The neutral suspension page (`artifact.md` 1.5 section 5, "Suspended";
//! `errors.md` `RENOX_TENANT_SUSPENDED`; #325, #123).
//!
//! A hostname whose route entry is `suspended` is answered here: 503 with
//! `Retry-After: 3600`, the platform's own static page showing only the
//! entry's `display_name`, no tenant code, no template, no cell touched.

use axum::body::Body;
use axum::http::{HeaderMap, Response, StatusCode, header};

use crate::limits::prefers_html;

pub const CODE: &str = "RENOX_TENANT_SUSPENDED";
pub const MESSAGE: &str = "This service is temporarily unavailable.";
const MESSAGE_AR: &str = "هذه الخدمة غير متاحة مؤقتًا.";
pub const RETRY_AFTER_SECS: u32 = 3600;

fn esc(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

/// The page for a suspended hostname: HTML when `Accept` prefers it, the
/// JSON error body otherwise.
pub fn response(
    display_name: Option<&str>,
    request_id: &str,
    headers: &HeaderMap,
) -> Response<Body> {
    let builder = Response::builder()
        .status(StatusCode::SERVICE_UNAVAILABLE)
        .header(header::RETRY_AFTER, RETRY_AFTER_SECS.to_string())
        .header(header::CACHE_CONTROL, "no-store");
    if prefers_html(headers) {
        builder
            .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
            .header(
                header::CONTENT_SECURITY_POLICY,
                "default-src 'none'; style-src 'unsafe-inline'",
            )
            .body(Body::from(page(display_name, request_id)))
            .expect("valid response")
    } else {
        let body = serde_json::json!({
            "error": { "code": CODE, "request_id": request_id, "message": MESSAGE }
        });
        builder
            .header(header::CONTENT_TYPE, "application/json; charset=utf-8")
            .body(Body::from(body.to_string()))
            .expect("valid response")
    }
}

/// The static page: the name (escaped), the English and Arabic sentence, the request id.
pub fn page(display_name: Option<&str>, request_id: &str) -> String {
    let name = display_name
        .map(|n| format!("<h1>{}</h1>", esc(n)))
        .unwrap_or_default();
    format!(
        "<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\">\
         <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\
         <meta name=\"robots\" content=\"noindex\"><title>503</title>\
         <style>body{{font-family:system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1rem;color:#222}}</style>\
         </head><body>{name}<p>{MESSAGE}</p><p lang=\"ar\" dir=\"rtl\">{MESSAGE_AR}</p>\
         <p><small>Request id: <code>{}</code></small></p></body></html>\n",
        esc(request_id)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_name_is_escaped_and_nothing_else_of_the_tenant_appears() {
        let p = page(Some("<script>x</script> & Co"), "req_1");
        assert!(p.contains("&lt;script&gt;x&lt;/script&gt; &amp; Co"));
        assert!(!p.contains("<script>"));
        assert!(p.contains(MESSAGE_AR));
    }
}
