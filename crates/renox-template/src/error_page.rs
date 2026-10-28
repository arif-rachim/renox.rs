//! The inputs of an error page (`docs/contracts/errors.md` section 1, "Page
//! (HTML) routes"; #93). The tenant's `pages/_error.html` and
//! `pages/_404.html` receive exactly these four values and nothing else: no
//! cause, stack, limit, template name, or usage figure ever reaches an
//! error page. The cell renders them under [`crate::RenderLimits::ERROR_PAGE`].

/// The names a tenant error template can read.
pub const FIELDS: [&str; 4] = ["status", "code", "request_id", "message"];

/// One error page's data.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ErrorPage<'a> {
    /// HTTP status of the response.
    pub status: u16,
    /// The `RENOX_*` code; `None` for a plain 404.
    pub code: Option<&'a str>,
    pub request_id: &'a str,
    /// The catalogue's end-user message for the code.
    pub message: &'a str,
}

impl ErrorPage<'_> {
    /// The template data: an object with exactly [`FIELDS`].
    pub fn data(&self) -> serde_json::Value {
        serde_json::json!({
            "status": self.status,
            "code": self.code,
            "request_id": self.request_id,
            "message": self.message,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn data_has_exactly_the_four_fields() {
        let page = ErrorPage {
            status: 503,
            code: Some("RENOX_CPU_LIMIT"),
            request_id: "01JBQ3Z7MA0000000000000101",
            message: "The request used too much CPU.",
        };
        let data = page.data();
        let mut keys: Vec<&str> = data
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        let mut expected = FIELDS.to_vec();
        expected.sort_unstable();
        assert_eq!(keys, expected);
        assert_eq!(data["code"], "RENOX_CPU_LIMIT");
    }
}
