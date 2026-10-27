//! Error codes shared with TypeScript (`docs/contracts/ops.md` section 13)
//! and the platform error response (`docs/contracts/errors.md` section 1).
//! Pure Rust, no V8.

use bytes::Bytes;

/// The codes of `ops.md` section 13 this crate produces in F1.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ErrorCode {
    FetchBlocked,
    FetchFailed,
    FetchEgressLimit,
    NoRequest,
    Deadline,
    CpuLimit,
    Oom,
    Busy,
    Internal,
}

impl ErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorCode::FetchBlocked => "RENOX_FETCH_BLOCKED",
            ErrorCode::FetchFailed => "RENOX_FETCH_FAILED",
            ErrorCode::FetchEgressLimit => "RENOX_FETCH_EGRESS_LIMIT",
            ErrorCode::NoRequest => "RENOX_NO_REQUEST",
            ErrorCode::Deadline => "RENOX_DEADLINE",
            ErrorCode::CpuLimit => "RENOX_CPU_LIMIT",
            ErrorCode::Oom => "RENOX_OOM",
            ErrorCode::Busy => "RENOX_BUSY",
            ErrorCode::Internal => "RENOX_INTERNAL",
        }
    }

    /// HTTP status of the platform response (`errors.md` section 3). `None`
    /// for codes that are only thrown into tenant code.
    pub fn http_status(self) -> Option<u16> {
        match self {
            ErrorCode::Deadline => Some(504),
            ErrorCode::CpuLimit | ErrorCode::Oom | ErrorCode::Busy => Some(503),
            ErrorCode::Internal => Some(500),
            _ => None,
        }
    }

    /// The fixed end-user message (`errors.md`, "Message" column). Never
    /// built from tenant code, request input, or an internal error.
    pub fn message(self) -> &'static str {
        match self {
            ErrorCode::CpuLimit => "The request used more CPU time than its limit.",
            ErrorCode::Oom => "The request ran out of memory.",
            ErrorCode::Deadline => "The request took too long.",
            ErrorCode::Internal => "Internal error. Quote the request id when reporting it.",
            ErrorCode::Busy => "The service is busy. Try again shortly.",
            _ => "Internal error. Quote the request id when reporting it.",
        }
    }
}

/// A response the runtime produces itself (not built by tenant code).
#[derive(Debug, Clone)]
pub struct PlatformResponse;

impl PlatformResponse {
    /// The JSON error body of `errors.md` section 1 for function routes.
    pub fn error(code: ErrorCode, request_id: &str) -> http::Response<Bytes> {
        let status = code.http_status().unwrap_or(500);
        let body = serde_json::json!({
            "error": { "code": code.as_str(), "request_id": request_id, "message": code.message() }
        });
        let mut b = http::Response::builder()
            .status(status)
            .header("content-type", "application/json; charset=utf-8")
            .header("cache-control", "no-store")
            .header("x-renox-request-id", request_id);
        if code == ErrorCode::Busy {
            b = b.header("retry-after", "1");
        }
        b.body(Bytes::from(body.to_string()))
            .expect("static response parts are valid")
    }

    /// 404 from route matching: no tenant code ran.
    pub fn not_found(request_id: &str) -> http::Response<Bytes> {
        Self::plain(404, request_id, None)
    }

    /// 405 from route matching, with `Allow`.
    pub fn method_not_allowed(request_id: &str, allow: &str) -> http::Response<Bytes> {
        Self::plain(405, request_id, Some(allow))
    }

    fn plain(status: u16, request_id: &str, allow: Option<&str>) -> http::Response<Bytes> {
        let mut b = http::Response::builder()
            .status(status)
            .header("content-type", "application/json; charset=utf-8")
            .header("cache-control", "no-store")
            .header("x-renox-request-id", request_id);
        if let Some(allow) = allow {
            b = b.header("allow", allow);
        }
        let reason = if status == 404 {
            "Not Found"
        } else {
            "Method Not Allowed"
        };
        let body = serde_json::json!({ "error": { "status": status, "request_id": request_id, "message": reason } });
        b.body(Bytes::from(body.to_string()))
            .expect("static response parts are valid")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_body_has_only_fixed_fields() {
        let r = PlatformResponse::error(ErrorCode::Busy, "req_12345678");
        assert_eq!(r.status(), 503);
        assert_eq!(r.headers()["retry-after"], "1");
        let v: serde_json::Value = serde_json::from_slice(r.body()).unwrap();
        assert_eq!(v["error"]["code"], "RENOX_BUSY");
        assert_eq!(
            v["error"]["message"],
            "The service is busy. Try again shortly."
        );
        assert_eq!(v["error"].as_object().unwrap().len(), 3);
    }
}
