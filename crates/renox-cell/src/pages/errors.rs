//! Error pages of page routes (`docs/contracts/errors.md` section 1;
//! `docs/23-failure-modes.md` rule 2 and section 6; #93).
//!
//! A platform error on a page route (`RENOX_CPU_LIMIT`, `RENOX_OOM`,
//! `RENOX_DEADLINE`, `RENOX_RENDER_LIMIT`, `RENOX_INTERNAL`, a collateral
//! recycle victim's code) and an HTML 404 are answered with an HTML page,
//! never the JSON body API routes get:
//!
//! 1. the tenant's `pages/_error` (or `pages/_404` for a 404), given exactly
//!    the four [`ErrorPage`] fields, rendered under the fixed error-page
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
use http::Response;
use renox_template::{ErrorPage, Shell};

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
