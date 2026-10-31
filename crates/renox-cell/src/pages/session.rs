//! Page sessions and CSRF tokens (`docs/contracts/ops.md` section 14,
//! "Session" and "CSRF, before the action"; `docs/04-isolation-security.md`,
//! "Web-layer protections").
//!
//! - Session: `__Host-renox_sid=<id>.<mac>`, `id` 128 random bits as
//!   base64url (22 characters), `mac` = HMAC-SHA256(tenant key, "sid|" id).
//!   A missing or invalid cookie gets a fresh id.
//! - CSRF: the token is HMAC-SHA256(tenant key, "csrf|" session id), so it is
//!   bound to the session. It travels as the double-submit cookie
//!   `__Host-renox_csrf` (readable by the page's script, so htmx can copy it
//!   into `x-renox-csrf`) and in the `_csrf` form field `<x-form>` and
//!   `<x-csrf>` emit. An action runs only when the submitted token equals
//!   the cookie and both equal the session's token. Comparisons are
//!   constant-time.
//! - BREACH (#111; `docs/24-threat-model.md`, "BREACH"): a token written
//!   into a response body is masked per response, `base64url(mask ||
//!   mask XOR token)` with 32 fresh random bytes of mask ([`mask_token`]),
//!   so compressed HTML never repeats the secret. The check unmasks what
//!   the client submits ([`unmask_token`]); the unmasked form (the cookie
//!   value, which travels only in headers) is accepted too.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, KeyInit, Mac};
use http::HeaderMap;
use sha2::Sha256;
use subtle::ConstantTimeEq;

pub const SESSION_COOKIE: &str = "__Host-renox_sid";
pub const CSRF_COOKIE: &str = "__Host-renox_csrf";
/// The header htmx requests carry the token in. The gateway lets it through
/// (it removes every other client `x-renox-*` header); the cell removes it
/// before the isolate, so tenant code never sees it.
pub const CSRF_HEADER: &str = "x-renox-csrf";
/// The form field `<x-form>` and `<x-csrf>` emit.
pub const CSRF_FIELD: &str = "_csrf";

type HmacSha256 = Hmac<Sha256>;

/// The page keys of one tenant (derived in `keys.rs`).
#[derive(Clone)]
pub struct SessionKeys {
    key: [u8; 32],
}

impl std::fmt::Debug for SessionKeys {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SessionKeys([redacted])")
    }
}

fn valid_id(id: &str) -> bool {
    id.len() == 22
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

impl SessionKeys {
    pub fn new(key: [u8; 32]) -> SessionKeys {
        SessionKeys { key }
    }

    fn mac(&self, label: &str, msg: &str) -> HmacSha256 {
        let mut m = HmacSha256::new_from_slice(&self.key).expect("HMAC takes any key length");
        m.update(label.as_bytes());
        m.update(b"|");
        m.update(msg.as_bytes());
        m
    }

    /// A fresh session id: 128 random bits, base64url (22 characters).
    pub fn new_session_id() -> String {
        let mut b = [0u8; 16];
        getrandom::fill(&mut b).expect("the OS random source is available");
        URL_SAFE_NO_PAD.encode(b)
    }

    /// The signed cookie value `<id>.<mac>`.
    pub fn sign_session(&self, id: &str) -> String {
        let mac = self.mac("sid", id).finalize().into_bytes();
        format!("{id}.{}", URL_SAFE_NO_PAD.encode(mac))
    }

    /// The id of a signed cookie value, if its signature is this tenant's.
    pub fn verify_session(&self, value: &str) -> Option<String> {
        let (id, mac) = value.split_once('.')?;
        if !valid_id(id) {
            return None;
        }
        let mac = URL_SAFE_NO_PAD.decode(mac).ok()?;
        self.mac("sid", id).verify_slice(&mac).ok()?;
        Some(id.to_string())
    }

    /// The CSRF token bound to a session.
    pub fn csrf_token(&self, session_id: &str) -> String {
        URL_SAFE_NO_PAD.encode(self.mac("csrf", session_id).finalize().into_bytes())
    }
}

/// Length of the raw token (HMAC-SHA256).
const TOKEN_BYTES: usize = 32;

/// The token as written into a response body: `base64url(mask || mask XOR
/// token)` with a fresh random mask (86 characters). `token` is the
/// session's token ([`SessionKeys::csrf_token`]).
pub fn mask_token(token: &str) -> String {
    let raw = URL_SAFE_NO_PAD
        .decode(token)
        .expect("csrf_token is base64url of 32 bytes");
    let mut out = vec![0u8; 2 * raw.len()];
    let (mask, masked) = out.split_at_mut(raw.len());
    getrandom::fill(mask).expect("the OS random source is available");
    for ((m, x), t) in masked.iter_mut().zip(mask.iter()).zip(raw.iter()) {
        *m = x ^ t;
    }
    URL_SAFE_NO_PAD.encode(out)
}

/// The session token a submitted value stands for: a masked token is
/// unmasked, an unmasked one (43 characters) is returned as is. `None` for
/// anything else, which the check treats as a mismatch.
pub fn unmask_token(submitted: &str) -> Option<String> {
    let bytes = URL_SAFE_NO_PAD.decode(submitted).ok()?;
    match bytes.len() {
        TOKEN_BYTES => Some(submitted.to_string()),
        n if n == 2 * TOKEN_BYTES => {
            let (mask, masked) = bytes.split_at(TOKEN_BYTES);
            let raw: Vec<u8> = mask.iter().zip(masked).map(|(m, x)| m ^ x).collect();
            Some(URL_SAFE_NO_PAD.encode(raw))
        }
        _ => None,
    }
}

/// Constant-time string equality.
pub fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && bool::from(a.as_bytes().ct_eq(b.as_bytes()))
}

/// The value of cookie `name` in the request's `Cookie` headers.
pub fn cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get_all(http::header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(k, _)| *k == name)
        .map(|(_, v)| v.to_string())
}

/// Removes the platform cookies from `Cookie`, so tenant code sees neither
/// the session signature nor the CSRF token (it gets `ctx.session.id`).
pub fn strip_platform_cookies(headers: &mut HeaderMap) {
    let kept: Vec<String> = headers
        .get_all(http::header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .filter(|p| {
            let name = p.split('=').next().unwrap_or("");
            name != SESSION_COOKIE && name != CSRF_COOKIE
        })
        .map(str::to_string)
        .collect();
    headers.remove(http::header::COOKIE);
    if !kept.is_empty()
        && let Ok(v) = http::HeaderValue::from_str(&kept.join("; "))
    {
        headers.insert(http::header::COOKIE, v);
    }
}

/// `Set-Cookie` for the session (`HttpOnly`, `Secure`, `SameSite=Lax`,
/// `Path=/`; `__Host-` forbids `Domain`). `same_site_none` is the CORS
/// credentials case (`artifact.md`, `cors.credentials`).
pub fn session_cookie(value: &str, same_site_none: bool) -> String {
    let same_site = if same_site_none { "None" } else { "Lax" };
    format!("{SESSION_COOKIE}={value}; Path=/; Secure; HttpOnly; SameSite={same_site}")
}

/// `Set-Cookie` for the double-submit CSRF cookie: readable by the page's
/// script (no `HttpOnly`), so the client can copy it into `x-renox-csrf`.
pub fn csrf_cookie(token: &str) -> String {
    format!("{CSRF_COOKIE}={token}; Path=/; Secure; SameSite=Lax")
}

/// The `_csrf` field of a form body, from `application/x-www-form-urlencoded`
/// or `multipart/form-data`; `None` for any other body.
pub fn form_token(headers: &HeaderMap, body: &[u8]) -> Option<String> {
    let ct = headers
        .get(http::header::CONTENT_TYPE)?
        .to_str()
        .ok()?
        .to_string();
    let lower = ct.to_ascii_lowercase();
    if lower.starts_with("application/x-www-form-urlencoded") {
        return form_urlencoded::parse(body)
            .find(|(k, _)| k == CSRF_FIELD)
            .map(|(_, v)| v.into_owned());
    }
    if lower.starts_with("multipart/form-data") {
        let boundary = ct.split(';').map(str::trim).find_map(|p| {
            let (k, v) = p.split_once('=')?;
            k.trim()
                .eq_ignore_ascii_case("boundary")
                .then(|| v.trim().trim_matches('"').to_string())
        })?;
        return multipart_field(body, &boundary, CSRF_FIELD);
    }
    None
}

/// The value of the first text part named `name` (RFC 7578). A part with a
/// `filename` is never the token.
fn multipart_field(body: &[u8], boundary: &str, name: &str) -> Option<String> {
    let delim = format!("--{boundary}");
    let text = body;
    let mut parts = split_bytes(text, delim.as_bytes()).into_iter().skip(1);
    parts.find_map(|part| {
        let part = part.strip_prefix(b"\r\n")?;
        let head_end = find(part, b"\r\n\r\n")?;
        let head = std::str::from_utf8(&part[..head_end]).ok()?;
        let disposition = head
            .split("\r\n")
            .find(|l| l.to_ascii_lowercase().starts_with("content-disposition:"))?;
        let mut field = None;
        let mut file = false;
        for p in disposition.split(';').map(str::trim) {
            if let Some(v) = p.strip_prefix("name=") {
                field = Some(v.trim_matches('"'));
            } else if p.starts_with("filename") {
                file = true;
            }
        }
        if file || field != Some(name) {
            return None;
        }
        let value = &part[head_end + 4..];
        let value = value.strip_suffix(b"\r\n").unwrap_or(value);
        String::from_utf8(value.to_vec()).ok()
    })
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

fn split_bytes<'a>(hay: &'a [u8], delim: &[u8]) -> Vec<&'a [u8]> {
    let mut out = Vec::new();
    let mut rest = hay;
    while let Some(i) = find(rest, delim) {
        out.push(&rest[..i]);
        rest = &rest[i + delim.len()..];
    }
    out.push(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keys() -> SessionKeys {
        SessionKeys::new([3u8; 32])
    }

    #[test]
    fn signed_session_round_trip() {
        let k = keys();
        let id = SessionKeys::new_session_id();
        assert_eq!(id.len(), 22);
        let v = k.sign_session(&id);
        assert_eq!(k.verify_session(&v), Some(id.clone()));
        // Another tenant's key, a changed id, a cut signature: refused.
        assert_eq!(SessionKeys::new([4u8; 32]).verify_session(&v), None);
        let forged = format!("{}{}", &id[..21], if id.ends_with('A') { "B" } else { "A" });
        assert_eq!(k.verify_session(&v.replacen(&id, &forged, 1)), None);
        assert_eq!(k.verify_session(&v[..v.len() - 2]), None);
        assert_eq!(k.verify_session(&id), None);
        // The token is bound to the session.
        assert_ne!(
            k.csrf_token(&id),
            k.csrf_token(&SessionKeys::new_session_id())
        );
    }

    #[test]
    fn cookies_are_read_and_stripped() {
        let mut h = HeaderMap::new();
        h.insert(
            "cookie",
            "a=1; __Host-renox_sid=x.y; __Host-renox_csrf=t; b=2"
                .parse()
                .unwrap(),
        );
        assert_eq!(cookie(&h, SESSION_COOKIE).as_deref(), Some("x.y"));
        assert_eq!(cookie(&h, CSRF_COOKIE).as_deref(), Some("t"));
        strip_platform_cookies(&mut h);
        assert_eq!(h.get("cookie").unwrap(), "a=1; b=2");
        let mut only = HeaderMap::new();
        only.insert("cookie", "__Host-renox_sid=x.y".parse().unwrap());
        strip_platform_cookies(&mut only);
        assert!(only.get("cookie").is_none());
    }

    #[test]
    fn form_tokens() {
        let mut h = HeaderMap::new();
        h.insert(
            "content-type",
            "application/x-www-form-urlencoded".parse().unwrap(),
        );
        assert_eq!(
            form_token(&h, b"productId=4&_csrf=abc%2D1").as_deref(),
            Some("abc-1")
        );
        assert_eq!(form_token(&h, b"productId=4"), None);
        h.insert(
            "content-type",
            "multipart/form-data; boundary=\"XyZ\"".parse().unwrap(),
        );
        let body = b"--XyZ\r\nContent-Disposition: form-data; name=\"f\"; filename=\"_csrf\"\r\n\r\nnope\r\n--XyZ\r\nContent-Disposition: form-data; name=\"_csrf\"\r\n\r\ntok\r\n--XyZ--\r\n";
        assert_eq!(form_token(&h, body).as_deref(), Some("tok"));
        h.insert("content-type", "application/json".parse().unwrap());
        assert_eq!(form_token(&h, b"{\"_csrf\":\"x\"}"), None);
    }

    /// `docs/24-threat-model.md`, "BREACH: CSRF token recovered through
    /// compressed responses" (#111).
    #[test]
    fn masked_tokens_differ_per_response_and_unmask_to_the_token() {
        let k = keys();
        let token = k.csrf_token(&SessionKeys::new_session_id());
        let (a, b) = (mask_token(&token), mask_token(&token));
        assert_ne!(a, b);
        assert_eq!(a.len(), 86);
        assert!(!a.contains(&token) && !b.contains(&token));
        assert_eq!(unmask_token(&a).as_deref(), Some(token.as_str()));
        assert_eq!(unmask_token(&b).as_deref(), Some(token.as_str()));
        assert_eq!(unmask_token(&token).as_deref(), Some(token.as_str()));
        // Flip one bit of the mask: it unmasks to another value.
        let mut raw = URL_SAFE_NO_PAD.decode(&a).unwrap();
        raw[0] ^= 1;
        let flipped = URL_SAFE_NO_PAD.encode(&raw);
        assert_ne!(unmask_token(&flipped).as_deref(), Some(token.as_str()));
        assert_eq!(unmask_token("short"), None);
        assert_eq!(unmask_token("not base64 !"), None);
    }

    #[test]
    fn constant_time_equality() {
        assert!(same("abc", "abc"));
        assert!(!same("abc", "abd"));
        assert!(!same("abc", "ab"));
    }
}
