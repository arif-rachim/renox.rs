//! The platform tags of a page shell (`docs/contracts/client-events.md`
//! section 1, #126): the request id and deployment `<meta>` tags the client
//! script correlates browser events with, and the client script itself,
//! carrying the request's CSP nonce.
//!
//! They go first in `<head>`, so the script installs its error handlers
//! before any tenant script runs and finds the meta tags already parsed.
//! Only whole documents get them: a fragment has no `<head>`, and the
//! script reads a fragment's request id from its `x-renox-request-id`
//! header instead.

/// What the shell tags carry for one response.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Shell<'a> {
    pub request_id: &'a str,
    /// The deployment's artifact hash.
    pub deployment: &'a str,
    /// The request's CSP nonce; `None` leaves the script without one (the
    /// strict CSP then blocks it, which is what a missing nonce should do).
    pub nonce: Option<&'a str>,
    /// `src` of the client script (`/__renox/client.js?v=<hash>`); `None`
    /// when client events are off (`[client] events = false`).
    pub script_src: Option<&'a str>,
    /// `RENOX_*` code of an error page (`client-events.md` Open 4): the
    /// script reports it with events from that page.
    pub error_code: Option<&'a str>,
}

impl Shell<'_> {
    /// The tags, in order: meta request id, meta deployment, meta error
    /// code, script.
    pub fn tags(&self) -> String {
        let mut out = format!(
            "<meta name=\"renox-request-id\" content=\"{}\"><meta name=\"renox-deployment\" content=\"{}\">",
            escape(self.request_id),
            escape(self.deployment)
        );
        if let Some(code) = self.error_code {
            out.push_str(&format!(
                "<meta name=\"renox-error-code\" content=\"{}\">",
                escape(code)
            ));
        }
        if let Some(src) = self.script_src {
            out.push_str("<script");
            if let Some(n) = self.nonce {
                out.push_str(&format!(" nonce=\"{}\"", escape(n)));
            }
            out.push_str(&format!(" src=\"{}\"></script>", escape(src)));
        }
        out
    }

    /// `html` with [`Shell::tags`] right after its opening `<head>` tag;
    /// unchanged when it has none (not a document).
    pub fn inject(&self, html: &str) -> String {
        match head_end(html) {
            Some(at) => {
                let tags = self.tags();
                let mut out = String::with_capacity(html.len() + tags.len());
                out.push_str(&html[..at]);
                out.push_str(&tags);
                out.push_str(&html[at..]);
                out
            }
            None => html.to_string(),
        }
    }
}

/// The byte offset just past the first `<head ...>` tag (ASCII
/// case-insensitive; `<header>` does not count).
fn head_end(html: &str) -> Option<usize> {
    let bytes = html.as_bytes();
    let mut from = 0;
    while let Some(i) = bytes[from..].iter().position(|&b| b == b'<') {
        let start = from + i;
        let name = bytes.get(start + 1..start + 5)?;
        if name.eq_ignore_ascii_case(b"head") {
            match bytes.get(start + 5) {
                Some(b'>') => return Some(start + 6),
                Some(c) if c.is_ascii_whitespace() || *c == b'/' => {
                    let close = bytes[start..].iter().position(|&b| b == b'>')?;
                    return Some(start + close + 1);
                }
                _ => {}
            }
        }
        from = start + 1;
    }
    None
}

fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '"' => out.push_str("&quot;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            _ => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHELL: Shell<'static> = Shell {
        request_id: "01JBQ3Z7MA0000000000000101",
        deployment: "abc123",
        nonce: Some("N0nce+/="),
        script_src: Some("/__renox/client.js?v=0123456789abcdef"),
        error_code: None,
    };

    #[test]
    fn tags_go_first_in_head() {
        let html = "<!doctype html><html><head><title>x</title></head><body><header>h</header></body></html>";
        assert_eq!(
            SHELL.inject(html),
            "<!doctype html><html><head><meta name=\"renox-request-id\" content=\"01JBQ3Z7MA0000000000000101\"><meta name=\"renox-deployment\" content=\"abc123\"><script nonce=\"N0nce+/=\" src=\"/__renox/client.js?v=0123456789abcdef\"></script><title>x</title></head><body><header>h</header></body></html>"
        );
        let attrs = "<HTML><HEAD lang=\"en\">\n<title>x</title></HEAD></HTML>";
        assert!(
            SHELL
                .inject(attrs)
                .starts_with("<HTML><HEAD lang=\"en\"><meta name=\"renox-request-id\"")
        );
    }

    #[test]
    fn fragments_and_header_only_are_unchanged() {
        assert_eq!(SHELL.inject("<li>x</li>"), "<li>x</li>");
        assert_eq!(
            SHELL.inject("<header>no head</header>"),
            "<header>no head</header>"
        );
        assert_eq!(SHELL.inject("<hea"), "<hea");
    }

    #[test]
    fn events_off_and_error_code() {
        let off = Shell {
            script_src: None,
            error_code: Some("RENOX_CPU_LIMIT"),
            ..SHELL
        };
        let tags = off.tags();
        assert!(!tags.contains("<script"));
        assert!(tags.ends_with("<meta name=\"renox-error-code\" content=\"RENOX_CPU_LIMIT\">"));
        let hostile = Shell {
            deployment: "\"><script>",
            ..SHELL
        };
        assert!(
            hostile
                .tags()
                .contains("content=\"&quot;&gt;&lt;script&gt;\"")
        );
    }
}
