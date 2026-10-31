//! Inbound webhooks (`docs/contracts/ops.md` 1.7.0 section 22; #322):
//! `op_webhook_verify` checks the provider's signature over the raw body,
//! records the event id in `renox__webhook_events` (a second delivery is a
//! duplicate), and keeps a per-provider bucket of **unverified** requests.
//!
//! | Provider | Header | Scheme |
//! | --- | --- | --- |
//! | `stripe` | `Stripe-Signature` (`t=…,v1=…`) | HMAC-SHA256 hex of `<t>.<body>`, 300 s tolerance |
//! | `checkout` | `Cko-Signature` | HMAC-SHA256 hex of the body |
//! | `telr` | `X-Telr-Signature` | HMAC-SHA256 hex of the body |
//! | `paytabs` | `Signature` | HMAC-SHA256 hex of the body |
//! | `ngenius` | `X-NGenius-Signature` | HMAC-SHA256 hex of the body |
//! | `tabby` | `X-Tabby-Signature` | HMAC-SHA256 hex of the body |
//! | `tamara` | `Tamara-Signature` | HMAC-SHA256 hex of the body |
//! | `generic` | the caller's header | HMAC-SHA256 hex of the body (`sha256=` prefix allowed) |
//! | `apple`, `google` | — | Not verified yet (JWS chain, Pub/Sub JWT): refused |
//!
//! The key is the secret `WEBHOOK_<PROVIDER>_SECRET` (the bootstrap reads it
//! from the caller's own `ctx.secrets`), or the generic `secret`.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;

use hmac::{Hmac, KeyInit, Mac};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

/// Stripe's timestamp tolerance.
pub const STRIPE_TOLERANCE_S: i64 = 300;
/// Unverified requests per provider and app (*proposed*, ops.md section 22).
pub const UNVERIFIED_PER_SECOND: f64 = 50.0;
pub const UNVERIFIED_BURST: f64 = 500.0;

/// Why a signature did not verify (never the expected value).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    MissingHeader,
    BadHeader,
    Mismatch,
    Expired,
    NoSecret,
    Unsupported,
}

impl Refusal {
    pub fn as_str(self) -> &'static str {
        match self {
            Refusal::MissingHeader => "missing_header",
            Refusal::BadHeader => "bad_header",
            Refusal::Mismatch => "mismatch",
            Refusal::Expired => "expired",
            Refusal::NoSecret => "no_secret",
            Refusal::Unsupported => "unsupported_provider",
        }
    }
}

/// The header a provider signs in.
pub fn provider_header(provider: &str) -> Option<&'static str> {
    Some(match provider {
        "stripe" => "stripe-signature",
        "checkout" => "cko-signature",
        "telr" => "x-telr-signature",
        "paytabs" => "signature",
        "ngenius" => "x-ngenius-signature",
        "tabby" => "x-tabby-signature",
        "tamara" => "tamara-signature",
        _ => return None,
    })
}

fn hmac_hex(key: &[u8], parts: &[&[u8]]) -> String {
    let mut m = Hmac::<Sha256>::new_from_slice(key).expect("any key length");
    for p in parts {
        m.update(p);
    }
    m.finalize()
        .into_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && bool::from(a.as_bytes().ct_eq(b.as_bytes()))
}

/// Verifies one delivery. `headers` are lower-case names; `now_s` Unix seconds.
pub fn verify(
    provider: &str,
    secret: Option<&str>,
    header: Option<&str>,
    body: &[u8],
    headers: &[(String, String)],
    now_s: i64,
) -> Result<(), Refusal> {
    let get = |name: &str| {
        headers
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.trim().to_string())
    };
    let secret = secret.filter(|s| !s.is_empty()).ok_or(Refusal::NoSecret)?;
    match provider {
        "apple" | "google" => Err(Refusal::Unsupported),
        "stripe" => {
            let value = get("stripe-signature").ok_or(Refusal::MissingHeader)?;
            let mut t: Option<i64> = None;
            let mut sigs = Vec::new();
            for part in value.split(',') {
                match part.trim().split_once('=') {
                    Some(("t", v)) => t = v.parse().ok(),
                    Some(("v1", v)) => sigs.push(v.to_ascii_lowercase()),
                    _ => {}
                }
            }
            let t = t.ok_or(Refusal::BadHeader)?;
            if sigs.is_empty() {
                return Err(Refusal::BadHeader);
            }
            let want = hmac_hex(secret.as_bytes(), &[t.to_string().as_bytes(), b".", body]);
            if !sigs.iter().any(|s| same(s, &want)) {
                return Err(Refusal::Mismatch);
            }
            if (now_s - t).abs() > STRIPE_TOLERANCE_S {
                return Err(Refusal::Expired);
            }
            Ok(())
        }
        "generic" => {
            let name = header
                .map(str::to_ascii_lowercase)
                .ok_or(Refusal::MissingHeader)?;
            let value = get(&name).ok_or(Refusal::MissingHeader)?;
            let value = value
                .strip_prefix("sha256=")
                .unwrap_or(&value)
                .to_ascii_lowercase();
            if same(&value, &hmac_hex(secret.as_bytes(), &[body])) {
                Ok(())
            } else {
                Err(Refusal::Mismatch)
            }
        }
        p => {
            let name = provider_header(p).ok_or(Refusal::Unsupported)?;
            let value = get(name)
                .ok_or(Refusal::MissingHeader)?
                .to_ascii_lowercase();
            if same(&value, &hmac_hex(secret.as_bytes(), &[body])) {
                Ok(())
            } else {
                Err(Refusal::Mismatch)
            }
        }
    }
}

/// The provider's event id: `id`, then `event_id` / `eventId` of the JSON
/// body, else the SHA-256 of the body (a re-sent identical body is a duplicate).
pub fn event_id(body: &[u8]) -> String {
    if let Ok(v) = serde_json::from_slice::<serde_json::Value>(body) {
        for k in ["id", "event_id", "eventId"] {
            match v.get(k) {
                Some(serde_json::Value::String(s)) if !s.is_empty() && s.len() <= 255 => {
                    return s.clone();
                }
                Some(serde_json::Value::Number(n)) => return n.to_string(),
                _ => {}
            }
        }
    }
    Sha256::digest(body)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Per (tenant, provider) buckets of unverified requests, for the process.
/// (tenant, provider) -> (tokens, last refill).
type Buckets = HashMap<(String, String), (f64, Instant)>;
static BUCKETS: Mutex<Option<Buckets>> = Mutex::new(None);

/// Takes one token for an unverified request; `false` when the bucket is empty.
pub fn take_unverified(tenant: &str, provider: &str, per_second: f64, burst: f64) -> bool {
    let mut g = BUCKETS.lock().expect("webhook buckets");
    let map = g.get_or_insert_with(HashMap::new);
    let now = Instant::now();
    let e = map
        .entry((tenant.to_string(), provider.to_string()))
        .or_insert((burst, now));
    e.0 = (e.0 + now.duration_since(e.1).as_secs_f64() * per_second).min(burst);
    e.1 = now;
    if e.0 >= 1.0 {
        e.0 -= 1.0;
        true
    } else {
        false
    }
}

#[cfg(feature = "v8")]
pub(crate) use ops::*;

#[cfg(feature = "v8")]
mod ops {
    use std::cell::RefCell;
    use std::rc::Rc;
    use std::time::{SystemTime, UNIX_EPOCH};

    use deno_core::{JsBuffer, OpState, op2};
    use deno_error::JsErrorBox;
    use renox_data::Value;
    use serde::Serialize;

    use super::*;
    use crate::ops::db::DbEnv;
    use crate::ops::request::{live_request, op_error};

    /// The tenant and the bucket rate of an isolate's webhook ops.
    pub struct WebhookEnv {
        pub tenant_id: String,
        pub per_second: f64,
        pub burst: f64,
    }

    #[derive(Serialize)]
    pub(crate) struct Verified {
        provider: String,
        event_id: String,
        received_at: i64,
        payload_json: String,
        duplicate: bool,
    }

    /// `op_webhook_verify(token, provider, secret, header, body, headers)`.
    #[op2]
    #[serde]
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn op_webhook_verify(
        state: Rc<RefCell<OpState>>,
        token: u32,
        #[string] provider: String,
        #[string] secret: Option<String>,
        #[string] header: Option<String>,
        #[buffer] body: JsBuffer,
        #[serde] headers: Vec<(String, String)>,
    ) -> Result<Verified, JsErrorBox> {
        let request = live_request(&state.borrow(), token)?;
        let (env, db) = {
            let s = state.borrow();
            (
                s.borrow::<Rc<WebhookEnv>>().clone(),
                s.borrow::<Rc<DbEnv>>().db.clone(),
            )
        };
        let headers: Vec<(String, String)> = headers
            .into_iter()
            .map(|(k, v)| (k.to_ascii_lowercase(), v))
            .collect();
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        if let Err(refusal) = verify(
            &provider,
            secret.as_deref(),
            header.as_deref(),
            &body,
            &headers,
            now_ms / 1000,
        ) {
            // Only unverified requests count; past the bucket they are 429, never 401.
            if !take_unverified(&env.tenant_id, &provider, env.per_second, env.burst) {
                return Err(op_error(
                    "RENOX_RATE_LIMITED",
                    serde_json::json!({ "provider": provider }),
                    "Too many unverified webhook requests.",
                ));
            }
            tracing::info!(tenant_id = %env.tenant_id, provider = %provider, reason = refusal.as_str(), "webhook signature refused");
            return Err(op_error(
                "RENOX_WEBHOOK_SIGNATURE",
                serde_json::json!({ "provider": provider, "reason": refusal.as_str() }),
                "The webhook signature is not valid.",
            ));
        }
        let id = event_id(&body);
        let payload_json = String::from_utf8_lossy(&body).into_owned();
        let duplicate = match db {
            None => false,
            Some(db) => {
                let tx = request.borrow().resources.db_tx;
                let (p, e) = (provider.clone(), id.clone());
                let inserted = db
                    .call_tx(tx, move |db, t| {
                        db.with_policy(None, || {
                            let sql = "insert into renox__webhook_events (provider, event_id, received_at) values (?, ?, ?) on conflict do nothing";
                            let params = [Value::Text(p), Value::Text(e), Value::Integer(now_ms)];
                            match t {
                                Some(t) => t.execute(sql, &params),
                                None => db.execute(sql, &params),
                            }
                            .map(|r| r.changes)
                        })?
                    })
                    .await
                    .map_err(|e| {
                        tracing::warn!(error = %e, "webhook event not recorded");
                        op_error("RENOX_INTERNAL", serde_json::Value::Null, "The webhook event could not be recorded.")
                    })?;
                inserted == 0
            }
        };
        Ok(Verified {
            provider,
            event_id: id,
            received_at: now_ms,
            payload_json,
            duplicate,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h(name: &str, v: &str) -> Vec<(String, String)> {
        vec![(name.to_string(), v.to_string())]
    }

    #[test]
    fn stripe_checks_the_signature_and_the_timestamp() {
        let body = br#"{"id":"evt_1","type":"invoice.paid"}"#;
        let sig = hmac_hex(b"whsec", &[b"1000.", body]);
        let ok = h("stripe-signature", &format!("t=1000,v1={sig}"));
        assert_eq!(
            verify("stripe", Some("whsec"), None, body, &ok, 1100),
            Ok(())
        );
        assert_eq!(
            verify("stripe", Some("whsec"), None, body, &ok, 2000),
            Err(Refusal::Expired)
        );
        assert_eq!(
            verify("stripe", Some("other"), None, body, &ok, 1100),
            Err(Refusal::Mismatch)
        );
        assert_eq!(
            verify("stripe", Some("whsec"), None, b"tampered", &ok, 1100),
            Err(Refusal::Mismatch)
        );
        assert_eq!(
            verify("stripe", Some("whsec"), None, body, &[], 1100),
            Err(Refusal::MissingHeader)
        );
    }

    #[test]
    fn the_body_hmac_providers_and_generic() {
        let body = b"{\"id\":42}";
        let sig = hmac_hex(b"k", &[body]);
        for p in ["checkout", "telr", "paytabs", "ngenius", "tabby", "tamara"] {
            let hs = h(provider_header(p).unwrap(), &sig);
            assert_eq!(verify(p, Some("k"), None, body, &hs, 0), Ok(()), "{p}");
            assert_eq!(
                verify(p, Some("k"), None, b"x", &hs, 0),
                Err(Refusal::Mismatch),
                "{p}"
            );
        }
        let hs = h("x-sig", &format!("sha256={sig}"));
        assert_eq!(
            verify("generic", Some("k"), Some("X-Sig"), body, &hs, 0),
            Ok(())
        );
        assert_eq!(
            verify("apple", Some("k"), None, body, &hs, 0),
            Err(Refusal::Unsupported)
        );
        assert_eq!(
            verify("checkout", None, None, body, &hs, 0),
            Err(Refusal::NoSecret)
        );
    }

    #[test]
    fn event_ids_come_from_the_payload_or_the_body_hash() {
        assert_eq!(event_id(br#"{"id":"evt_9"}"#), "evt_9");
        assert_eq!(event_id(br#"{"event_id":"e1"}"#), "e1");
        assert_eq!(event_id(b"not json").len(), 64);
    }
}
