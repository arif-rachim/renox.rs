//! `op_password_hash` / `op_password_verify` (`docs/contracts/ops.md` 1.3.0,
//! section 16): argon2id with the platform's parameters (m = 64 MiB, t = 3,
//! p = 1, `docs/24-threat-model.md`), run off the isolate thread on the
//! blocking pool, at most [`PasswordPool::per_worker`] at once per worker
//! process; each call is charged 1 ms of tenant CPU, its wall time counts
//! against the request's deadline. A password is never logged and never in
//! an error message.
//!
//! The PHC string, hashing, parsing, and the pool compile without V8; the
//! ops are behind the `v8` feature.

use std::sync::Arc;

use argon2::{Algorithm, Argon2, Params, Version};
use tokio::sync::Semaphore;

/// Memory cost in KiB (64 MiB).
pub const M_COST: u32 = 65_536;
/// Iterations.
pub const T_COST: u32 = 3;
/// Parallelism.
pub const P_COST: u32 = 1;
/// Output bytes.
pub const OUTPUT_LEN: usize = 32;
/// Salt bytes.
pub const SALT_LEN: usize = 16;
/// Longest password, in UTF-8 bytes.
pub const MAX_PASSWORD_BYTES: usize = 1024;
/// CPU charged to the tenant per call (ops.md 1.3.0 section 16, "Metering").
pub const CHARGED_CPU_NS: u64 = 1_000_000;

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Standard base64 without padding (the PHC string's `B64`).
pub fn b64_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for i in 0..=chunk.len() {
            out.push(B64[((n >> (18 - 6 * i)) & 63) as usize] as char);
        }
    }
    out
}

/// Decodes [`b64_encode`]'s form; `None` for anything else.
pub fn b64_decode(s: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0u32);
    for c in s.bytes() {
        let v = B64.iter().position(|&x| x == c)? as u32;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    // Leftover bits must be zero padding of the last character.
    (acc == 0 && s.len() % 4 != 1).then_some(out)
}

fn argon2(m: u32, t: u32, p: u32) -> Option<Argon2<'static>> {
    let params = Params::new(m, t, p, Some(OUTPUT_LEN)).ok()?;
    Some(Argon2::new(Algorithm::Argon2id, Version::V0x13, params))
}

/// A password the bootstrap would accept: 1–1,024 UTF-8 bytes (a JS string
/// with no lone surrogate is always valid UTF-8 once it crosses).
pub fn valid_password(password: &str) -> bool {
    !password.is_empty() && password.len() <= MAX_PASSWORD_BYTES
}

/// The PHC string of `password` with a fresh random salt.
pub fn hash(password: &str) -> Result<String, &'static str> {
    if !valid_password(password) {
        return Err("password must be 1 to 1024 bytes");
    }
    let salt = argon2::password_hash::try_generate_salt().map_err(|_| "no randomness")?;
    hash_with_salt(password, &salt[..SALT_LEN])
}

/// The PHC string of `password` with `salt` (tests use a fixed salt).
pub fn hash_with_salt(password: &str, salt: &[u8]) -> Result<String, &'static str> {
    let mut out = [0u8; OUTPUT_LEN];
    argon2(M_COST, T_COST, P_COST)
        .ok_or("argon2 parameters")?
        .hash_password_into(password.as_bytes(), salt, &mut out)
        .map_err(|_| "argon2 failed")?;
    Ok(format!(
        "$argon2id$v=19$m={M_COST},t={T_COST},p={P_COST}${}${}",
        b64_encode(salt),
        b64_encode(&out)
    ))
}

/// A parsed PHC string, only when its parameters are argon2id v19 and no
/// larger than the platform's (a crafted hash cannot ask for more memory or
/// time, ops.md 1.3.0 section 16).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Phc {
    pub m: u32,
    pub t: u32,
    pub p: u32,
    pub salt: Vec<u8>,
    pub hash: Vec<u8>,
}

pub fn parse_phc(s: &str) -> Option<Phc> {
    let mut parts = s.split('$');
    if !parts.next()?.is_empty() || parts.next()? != "argon2id" || parts.next()? != "v=19" {
        return None;
    }
    let (mut m, mut t, mut p) = (None, None, None);
    for kv in parts.next()?.split(',') {
        let (k, v) = kv.split_once('=')?;
        let v: u32 = v.parse().ok()?;
        match k {
            "m" => m = Some(v),
            "t" => t = Some(v),
            "p" => p = Some(v),
            _ => return None,
        }
    }
    let salt = b64_decode(parts.next()?)?;
    let hash = b64_decode(parts.next()?)?;
    if parts.next().is_some() {
        return None;
    }
    let (m, t, p) = (m?, t?, p?);
    let in_bounds =
        (8..=M_COST).contains(&m) && (1..=T_COST).contains(&t) && (1..=P_COST).contains(&p);
    (in_bounds && (8..=64).contains(&salt.len()) && (16..=64).contains(&hash.len())).then_some(
        Phc {
            m,
            t,
            p,
            salt,
            hash,
        },
    )
}

/// Equal length and bytes, in time that depends only on the lengths.
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// `false` for a malformed hash, one above the platform's parameters, or a
/// wrong password.
pub fn verify(password: &str, phc: &str) -> bool {
    if !valid_password(password) {
        return false;
    }
    let Some(h) = parse_phc(phc) else {
        return false;
    };
    let Some(a) = Params::new(h.m, h.t, h.p, Some(h.hash.len()))
        .ok()
        .map(|params| Argon2::new(Algorithm::Argon2id, Version::V0x13, params))
    else {
        return false;
    };
    let mut out = vec![0u8; h.hash.len()];
    if a.hash_password_into(password.as_bytes(), &h.salt, &mut out)
        .is_err()
    {
        return false;
    }
    constant_time_eq(&out, &h.hash)
}

/// The per-worker slots of password ops (ops.md 1.3.0 section 16, "Off the
/// isolate thread"): a call waits for a slot, then hashes on the blocking
/// pool.
#[derive(Debug, Clone)]
pub struct PasswordPool {
    slots: Arc<Semaphore>,
    per_worker: usize,
}

impl PasswordPool {
    /// Default concurrency of one worker process (#231: 4, configurable).
    pub const DEFAULT_PER_WORKER: usize = 4;

    pub fn new(per_worker: usize) -> PasswordPool {
        let per_worker = per_worker.max(1);
        PasswordPool {
            slots: Arc::new(Semaphore::new(per_worker)),
            per_worker,
        }
    }

    pub fn per_worker(&self) -> usize {
        self.per_worker
    }

    /// Slots free now (tests).
    pub fn available(&self) -> usize {
        self.slots.available_permits()
    }

    /// Runs `f` on the blocking pool once a slot is free.
    pub async fn run<T: Send + 'static>(
        &self,
        f: impl FnOnce() -> T + Send + 'static,
    ) -> Option<T> {
        let permit = self.slots.clone().acquire_owned().await.ok()?;
        tokio::task::spawn_blocking(move || {
            let out = f();
            drop(permit);
            out
        })
        .await
        .ok()
    }
}

static GLOBAL: std::sync::OnceLock<PasswordPool> = std::sync::OnceLock::new();

impl PasswordPool {
    /// Set the worker's concurrency before the first password op (the
    /// worker's configuration); `false` if the pool already exists.
    pub fn configure(per_worker: usize) -> bool {
        GLOBAL.set(PasswordPool::new(per_worker)).is_ok()
    }

    /// The worker process's pool (one per process, ops.md 1.3.0 section 16).
    pub fn global() -> &'static PasswordPool {
        GLOBAL.get_or_init(PasswordPool::default)
    }
}

impl Default for PasswordPool {
    fn default() -> Self {
        PasswordPool::new(PasswordPool::DEFAULT_PER_WORKER)
    }
}

#[cfg(feature = "v8")]
pub(crate) use v8_ops::*;

#[cfg(feature = "v8")]
mod v8_ops {
    use std::cell::RefCell;
    use std::rc::Rc;

    use deno_core::{CancelFuture, OpState, op2};
    use deno_error::JsErrorBox;

    use super::*;
    use crate::ops::request::{live_request, op_error};

    fn bad_input() -> JsErrorBox {
        JsErrorBox::range_error("a password is 1 to 1024 bytes")
    }

    /// The call's cost: 1 ms of CPU on the request (ops.md 1.3.0 section
    /// 16), whatever the hash took on the pool.
    async fn on_pool<T: Send + 'static>(
        state: Rc<RefCell<OpState>>,
        token: u32,
        f: impl FnOnce() -> T + Send + 'static,
    ) -> Result<T, JsErrorBox> {
        let request = live_request(&state.borrow(), token)?;
        let pool = PasswordPool::global();
        let cancel = request.borrow().cancel.clone();
        crate::isolate::charge_cpu(token, CHARGED_CPU_NS);
        match pool.run(f).or_cancel(cancel).await {
            Ok(Some(v)) => Ok(v),
            Ok(None) => Err(op_error(
                "RENOX_INTERNAL",
                serde_json::Value::Null,
                "password pool",
            )),
            Err(_) => Err(op_error(
                "RENOX_DEADLINE",
                serde_json::Value::Null,
                "The request deadline passed.",
            )),
        }
    }

    #[op2]
    #[string]
    pub(crate) async fn op_password_hash(
        state: Rc<RefCell<OpState>>,
        token: u32,
        #[string] password: String,
    ) -> Result<String, JsErrorBox> {
        if !valid_password(&password) {
            return Err(bad_input());
        }
        on_pool(state, token, move || hash(&password))
            .await?
            .map_err(|_| {
                op_error(
                    "RENOX_INTERNAL",
                    serde_json::Value::Null,
                    "password hash failed",
                )
            })
    }

    #[op2]
    pub(crate) async fn op_password_verify(
        state: Rc<RefCell<OpState>>,
        token: u32,
        #[string] password: String,
        #[string] phc: String,
    ) -> Result<bool, JsErrorBox> {
        if !valid_password(&password) {
            return Err(bad_input());
        }
        on_pool(state, token, move || verify(&password, &phc)).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_round_trip() {
        for n in 0..40 {
            let b: Vec<u8> = (0..n).map(|i| (i * 37 % 256) as u8).collect();
            assert_eq!(b64_decode(&b64_encode(&b)).unwrap(), b);
        }
        assert!(b64_decode("a=").is_none());
    }

    #[test]
    fn phc_parameters_are_bounded() {
        let ok = hash_with_salt("correct horse", b"0123456789abcdef").unwrap();
        assert!(ok.starts_with("$argon2id$v=19$m=65536,t=3,p=1$"), "{ok}");
        assert!(parse_phc(&ok).is_some());
        for bad in [
            ok.replace("m=65536", "m=1048576"),
            ok.replace("t=3", "t=100"),
            ok.replace("argon2id", "argon2i"),
            ok.replace("v=19", "v=16"),
            "not a phc string".into(),
        ] {
            assert!(parse_phc(&bad).is_none(), "{bad}");
        }
    }
}
