//! The request id (`docs/contracts/ops.md` section 6, `errors.md` section 1,
//! `client-events.md` section 1): a ULID assigned by the gateway, sent to
//! the cell in `x-renox-request-id`, and set on **every** response: routed
//! responses (pages, fragments, functions, static files, errors) through
//! `finish_response` in `lib.rs`, and the fixed responses written below
//! routing (503 at the connection cap, 400 and 431 from the HTTP/1 guard)
//! through [`raw_response`].

/// Response and cell-request header carrying the id.
pub const REQUEST_ID_HEADER: &str = "x-renox-request-id";

/// A fresh request id.
pub fn new_request_id() -> String {
    ulid::Ulid::generate().to_string()
}

/// A complete HTTP/1.1 response with no body, `connection: close`, the
/// given extra headers, and a fresh `x-renox-request-id`. Used where the
/// gateway writes bytes to the socket itself instead of going through hyper.
pub fn raw_response(status_line: &str, headers: &[(&str, &str)]) -> Vec<u8> {
    let mut out = format!("HTTP/1.1 {status_line}\r\ncontent-length: 0\r\n");
    for (name, value) in headers {
        out.push_str(name);
        out.push_str(": ");
        out.push_str(value);
        out.push_str("\r\n");
    }
    out.push_str(REQUEST_ID_HEADER);
    out.push_str(": ");
    out.push_str(&new_request_id());
    out.push_str("\r\nconnection: close\r\n\r\n");
    out.into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raw_responses_carry_a_fresh_id() {
        let a = String::from_utf8(raw_response(
            "503 Service Unavailable",
            &[("retry-after", "1")],
        ))
        .unwrap();
        assert!(a.starts_with("HTTP/1.1 503 Service Unavailable\r\n"));
        assert!(a.contains("\r\nretry-after: 1\r\n"));
        assert!(a.ends_with("\r\nconnection: close\r\n\r\n"));
        let id = a
            .lines()
            .find_map(|l| l.strip_prefix("x-renox-request-id: "))
            .unwrap();
        assert_eq!(id.len(), 26);
        let b = String::from_utf8(raw_response("400 Bad Request", &[])).unwrap();
        assert!(!b.contains(id));
    }
}
