//! `op_events_emit` and the event delivery ack (`docs/contracts/ops.md`
//! 1.3.0, section 15.4). A module emits only the events it exports; the
//! payload is checked against the exported schema in Rust
//! (`RENOX_EVENT_PAYLOAD`); a durable event is a row of `renox__outbox`
//! written in the emitter's current transaction (ADR D14), so a rolled-back
//! transaction never delivers. In-memory handlers are run by the bootstrap.
//!
//! The schema check and the ids compile without V8; the ops are behind the
//! `v8` feature.

use std::time::{SystemTime, UNIX_EPOCH};

/// Payload cap: 64 KiB of JSON.
pub const MAX_PAYLOAD_BYTES: usize = 64 * 1024;

const CROCKFORD: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// A ULID: 48 bits of Unix ms, 80 random bits, Crockford base32.
pub fn ulid() -> String {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let random = argon2::password_hash::try_generate_salt().unwrap_or([0u8; 16]);
    let mut n: u128 = u128::from(ms & 0xFFFF_FFFF_FFFF);
    for b in &random[..10] {
        n = (n << 8) | u128::from(*b);
    }
    (0..26)
        .rev()
        .map(|i| CROCKFORD[((n >> (i * 5)) & 31) as usize] as char)
        .collect()
}

/// Why a payload was refused (`details.reason` of `RENOX_EVENT_PAYLOAD`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PayloadProblem {
    Schema,
    NotJson,
    TooLarge,
}

impl PayloadProblem {
    pub fn as_str(self) -> &'static str {
        match self {
            PayloadProblem::Schema => "schema",
            PayloadProblem::NotJson => "not_json",
            PayloadProblem::TooLarge => "too_large",
        }
    }
}

/// Checks `payload_json` against `schema` (the manifest's keyword subset:
/// type, properties, required, additionalProperties, items, enum, const,
/// minLength, maxLength, minimum, maximum, minItems, maxItems, oneOf, anyOf;
/// other keywords are ignored). Returns the parsed payload.
pub fn check_payload(
    schema: &serde_json::Value,
    payload_json: &str,
) -> Result<serde_json::Value, PayloadProblem> {
    if payload_json.len() > MAX_PAYLOAD_BYTES {
        return Err(PayloadProblem::TooLarge);
    }
    let v: serde_json::Value =
        serde_json::from_str(payload_json).map_err(|_| PayloadProblem::NotJson)?;
    if matches_schema(schema, &v) {
        Ok(v)
    } else {
        Err(PayloadProblem::Schema)
    }
}

fn type_ok(t: &str, v: &serde_json::Value) -> bool {
    use serde_json::Value as J;
    match t {
        "object" => v.is_object(),
        "array" => v.is_array(),
        "string" => v.is_string(),
        "boolean" => v.is_boolean(),
        "null" => v.is_null(),
        "number" => v.is_number(),
        "integer" => match v {
            J::Number(n) => {
                n.is_i64() || n.is_u64() || n.as_f64().is_some_and(|f| f.fract() == 0.0)
            }
            _ => false,
        },
        _ => false,
    }
}

/// Whether `v` satisfies `schema`.
pub fn matches_schema(schema: &serde_json::Value, v: &serde_json::Value) -> bool {
    use serde_json::Value as J;
    let J::Object(s) = schema else {
        return schema.as_bool().unwrap_or(true);
    };
    if let Some(t) = s.get("type") {
        let ok = match t {
            J::String(t) => type_ok(t, v),
            J::Array(ts) => ts.iter().any(|t| t.as_str().is_some_and(|t| type_ok(t, v))),
            _ => true,
        };
        if !ok {
            return false;
        }
    }
    if let Some(c) = s.get("const")
        && c != v
    {
        return false;
    }
    if let Some(J::Array(e)) = s.get("enum")
        && !e.contains(v)
    {
        return false;
    }
    for k in ["oneOf", "anyOf"] {
        if let Some(J::Array(subs)) = s.get(k) {
            let n = subs.iter().filter(|sub| matches_schema(sub, v)).count();
            if (k == "oneOf" && n != 1) || (k == "anyOf" && n == 0) {
                return false;
            }
        }
    }
    let num = |k: &str| s.get(k).and_then(J::as_f64);
    match v {
        J::String(st) => {
            let len = st.chars().count() as f64;
            if num("minLength").is_some_and(|m| len < m)
                || num("maxLength").is_some_and(|m| len > m)
            {
                return false;
            }
        }
        J::Number(n) => {
            let f = n.as_f64().unwrap_or(0.0);
            if num("minimum").is_some_and(|m| f < m) || num("maximum").is_some_and(|m| f > m) {
                return false;
            }
        }
        J::Array(a) => {
            let len = a.len() as f64;
            if num("minItems").is_some_and(|m| len < m) || num("maxItems").is_some_and(|m| len > m)
            {
                return false;
            }
            if let Some(items) = s.get("items")
                && !a.iter().all(|x| matches_schema(items, x))
            {
                return false;
            }
        }
        J::Object(o) => {
            if let Some(J::Array(req)) = s.get("required")
                && !req
                    .iter()
                    .all(|k| k.as_str().is_some_and(|k| o.contains_key(k)))
            {
                return false;
            }
            let props = s.get("properties").and_then(J::as_object);
            for (k, x) in o {
                match props.and_then(|p| p.get(k)) {
                    Some(ps) => {
                        if !matches_schema(ps, x) {
                            return false;
                        }
                    }
                    None => match s.get("additionalProperties") {
                        Some(J::Bool(false)) => return false,
                        Some(extra @ J::Object(_)) if !matches_schema(extra, x) => return false,
                        _ => {}
                    },
                }
            }
        }
        _ => {}
    }
    true
}

#[cfg(feature = "v8")]
pub(crate) use v8_ops::*;

#[cfg(feature = "v8")]
mod v8_ops {
    use std::cell::RefCell;
    use std::rc::Rc;

    use deno_core::{OpState, op2};
    use deno_error::JsErrorBox;
    use renox_data::outbox::OutboxEvent;

    use super::*;
    use crate::ops::db::DbEnv;
    use crate::ops::request::{live_request, op_error};

    fn undeclared(module: &str, name: &str) -> JsErrorBox {
        op_error(
            "RENOX_MODULE_UNDECLARED",
            serde_json::json!({ "module": module, "target": name }),
            &format!("module {module} does not export event {name}"),
        )
    }

    /// The handle `tx` if it is the request's open transaction; 0 = none.
    fn request_tx(
        state: &Rc<RefCell<OpState>>,
        token: u32,
        tx: u32,
    ) -> Result<Option<u32>, JsErrorBox> {
        let request = live_request(&state.borrow(), token)?;
        if tx == 0 {
            return Ok(None);
        }
        if request.borrow().resources.db_tx == Some(tx) {
            Ok(Some(tx))
        } else {
            Err(op_error(
                "RENOX_DB_TX_STATE",
                serde_json::Value::Null,
                "the transaction is not open",
            ))
        }
    }

    /// `ctx.events.emit` (ops.md 1.3.0 section 15.4). Resolves with the
    /// event id; for a durable event, once its row is written.
    #[op2]
    #[string]
    pub(crate) async fn op_events_emit(
        state: Rc<RefCell<OpState>>,
        token: u32,
        #[string] name: String,
        #[string] payload_json: String,
        durable: bool,
        #[string] module: Option<String>,
        tx: u32,
    ) -> Result<String, JsErrorBox> {
        let env = state.borrow().borrow::<Rc<DbEnv>>().clone();
        let module = module.unwrap_or_else(|| crate::ops::modules::APP.to_string());
        let Some(schema) = env
            .modules
            .get(&module)
            .and_then(|m| m.exports.events.get(&name))
            .cloned()
        else {
            return Err(undeclared(&module, &name));
        };
        if let Err(p) = check_payload(&schema, &payload_json) {
            return Err(op_error(
                "RENOX_EVENT_PAYLOAD",
                serde_json::json!({ "event": name, "reason": p.as_str() }),
                &format!("payload of {name} does not match its schema"),
            ));
        }
        let tx = request_tx(&state, token, tx)?;
        let id = ulid();
        if !durable {
            return Ok(id);
        }
        let Some(db) = env.db.clone() else {
            return Err(op_error(
                "RENOX_DB_SQL",
                serde_json::Value::Null,
                "no database",
            ));
        };
        let ev = OutboxEvent {
            id: id.clone(),
            name,
            payload: payload_json,
            module,
            created_at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0),
        };
        db.call_tx(tx, move |db, t| match t {
            Some(t) => renox_data::outbox::emit(db, t, &ev),
            None => renox_data::outbox::emit_autocommit(db, &ev),
        })
        .await
        .map_err(|e| op_error(e.code(), serde_json::Value::Null, &e.to_string()))?;
        Ok(id)
    }

    /// A delivery is done: delete its outbox row inside the handler's own
    /// transaction, so the handler's writes and the ack commit together
    /// (ops.md 1.3.0 section 15.4, "Delivery").
    #[op2]
    pub(crate) async fn op_events_ack(
        state: Rc<RefCell<OpState>>,
        token: u32,
        tx: u32,
        #[string] id: String,
        #[string] module: String,
    ) -> Result<bool, JsErrorBox> {
        let env = state.borrow().borrow::<Rc<DbEnv>>().clone();
        let tx = request_tx(&state, token, tx)?;
        let Some(db) = env.db.clone() else {
            return Ok(false);
        };
        db.call_tx(tx, move |db, t| match t {
            Some(t) => renox_data::outbox::delivered(db, t, &id, &module),
            None => Ok(false),
        })
        .await
        .map_err(|e| op_error(e.code(), serde_json::Value::Null, &e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ulids_are_26_crockford_characters_and_sort_by_time() {
        let a = ulid();
        assert_eq!(a.len(), 26);
        assert!(a.bytes().all(|b| CROCKFORD.contains(&b)));
        std::thread::sleep(std::time::Duration::from_millis(2));
        assert!(ulid()[..10] >= a[..10]);
    }

    #[test]
    fn payload_schema_subset() {
        let schema = serde_json::json!({ "type": "object", "required": ["invoice_id"], "additionalProperties": false,
            "properties": { "invoice_id": { "type": "string", "minLength": 1 }, "amount": { "type": "integer", "minimum": 0 } } });
        assert!(check_payload(&schema, r#"{"invoice_id":"i1","amount":5}"#).is_ok());
        for (bad, why) in [
            (r#"{"amount":5}"#, PayloadProblem::Schema),
            (r#"{"invoice_id":"i1","extra":1}"#, PayloadProblem::Schema),
            (r#"{"invoice_id":"i1","amount":-1}"#, PayloadProblem::Schema),
            (
                r#"{"invoice_id":"i1","amount":1.5}"#,
                PayloadProblem::Schema,
            ),
            ("not json", PayloadProblem::NotJson),
        ] {
            assert_eq!(check_payload(&schema, bad).unwrap_err(), why, "{bad}");
        }
        let big = format!("{{\"invoice_id\":\"{}\"}}", "x".repeat(MAX_PAYLOAD_BYTES));
        assert_eq!(
            check_payload(&schema, &big).unwrap_err(),
            PayloadProblem::TooLarge
        );
    }
}
