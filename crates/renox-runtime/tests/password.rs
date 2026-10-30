//! Issue #231: `op_password_hash` / `op_password_verify`
//! (`docs/contracts/ops.md` 1.3.0, section 16): argon2id at m = 64 MiB,
//! t = 3, p = 1 off the isolate thread, bounded per worker. V8-linked.
//!
//! Proves the platform side of the `docs/24-threat-model.md` row "Login
//! brute force, credential stuffing, enumeration" (argon2id at the
//! documented cost, bounded per worker so a burst of logins cannot take the
//! node's CPU, a crafted hash cannot ask for more work), and that a
//! password never reaches a log line.
#![cfg(feature = "v8")]

mod support;

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use renox_runtime::limits::Limits;
use renox_runtime::ops::password::{self, PasswordPool};
use renox_runtime::runtime::MemoryLogSink;
use renox_runtime::{Runtime, RuntimeConfig};
use support::*;

const HANDLER: &str = r#"
export async function GET(ctx) {
  const h = await ctx.password.hash("correct horse battery");
  const tampered = h.slice(0, -2) + (h.endsWith("AA") ? "BB" : "AA");
  let tooLong = null;
  try { await ctx.password.hash("x".repeat(1025)); } catch (e) { tooLong = e.name; }
  return Response.json({
    h,
    ok: await ctx.password.verify("correct horse battery", h),
    wrong: await ctx.password.verify("wrong horse battery", h),
    tampered: await ctx.password.verify("correct horse battery", tampered),
    malformed: await ctx.password.verify("correct horse battery", "$argon2id$v=19$m=999999999,t=3,p=1$AAAA$AAAA"),
    tooLong,
  });
}
"#;

/// Round trip through `ctx.password`; a wrong password, a tampered hash, and
/// a hash above the platform's parameters are all `false`; the call is
/// charged 1 ms of CPU each; the password is in no log line.
#[tokio::test]
async fn hash_and_verify_round_trip_through_ctx_password() {
    let sink = Arc::new(MemoryLogSink::default());
    let rt = Runtime::new(RuntimeConfig {
        log_sink: sink.clone(),
        ..Default::default()
    });
    let (dir, hash) = function_artifact(HANDLER, &[("GET", "/")], &[]);
    let iso = rt
        .create_isolate(spec(&dir, &hash, Limits::FREE))
        .await
        .unwrap();
    let out = iso.dispatch(ctx("req_pw"), get("/")).await;
    assert_eq!(out.response.status(), 200, "{:?}", sink.lines());
    let v = body_json(&out.response);
    let h = v["h"].as_str().unwrap();
    assert!(h.starts_with("$argon2id$v=19$m=65536,t=3,p=1$"), "{h}");
    assert!(password::parse_phc(h).is_some());
    assert_eq!(v["ok"], true);
    assert_eq!(v["wrong"], false);
    assert_eq!(v["tampered"], false);
    assert_eq!(v["malformed"], false);
    assert_eq!(v["tooLong"], "RangeError");
    // 5 password ops (the over-long one is refused before the pool): at least
    // 5 ms of CPU, though the hashing itself ran on the blocking pool.
    assert!(out.meter.cpu_ms >= 5.0, "{}", out.meter.cpu_ms);
    assert!(
        !sink
            .lines()
            .iter()
            .any(|l| format!("{l:?}").contains("correct horse")),
        "the password reached a log line"
    );
}

/// A tampered hash is refused by a comparison over the whole digest: a
/// change in the first byte and in the last one take the same work (the
/// argon2 run), and the comparison itself is length-only dependent.
#[test]
fn verify_of_a_tampered_phc_string_is_false_in_constant_time() {
    let good = password::hash_with_salt("pw", b"0123456789abcdef").unwrap();
    assert!(password::verify("pw", &good));
    let digest_start = good.rfind('$').unwrap() + 1;
    let flip = |at: usize| {
        let mut b = good.clone().into_bytes();
        b[at] = if b[at] == b'A' { b'B' } else { b'A' };
        String::from_utf8(b).unwrap()
    };
    let first = flip(digest_start);
    let last = flip(good.len() - 2);
    let time = |s: &str| {
        let t = Instant::now();
        assert!(!password::verify("pw", s));
        t.elapsed()
    };
    let (a, b) = (time(&first), time(&last));
    let (lo, hi) = if a < b { (a, b) } else { (b, a) };
    assert!(hi.as_secs_f64() < lo.as_secs_f64() * 3.0, "{a:?} vs {b:?}");
    // The comparison: same answer for a difference anywhere, length first.
    let x = [7u8; 32];
    let mut y = x;
    y[31] ^= 1;
    assert!(!password::constant_time_eq(&x, &y));
    assert!(!password::constant_time_eq(&x, &x[..31]));
    assert!(password::constant_time_eq(&x, &x));
}

/// With 4 slots, the 5th concurrent hash waits until one frees up.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_fifth_concurrent_hash_waits_for_a_slot() {
    let pool = PasswordPool::new(4);
    let running = Arc::new(AtomicUsize::new(0));
    let peak = Arc::new(AtomicUsize::new(0));
    let mut tasks = Vec::new();
    for i in 0..5 {
        let (pool, running, peak) = (pool.clone(), running.clone(), peak.clone());
        tasks.push(tokio::spawn(async move {
            pool.run(move || {
                let now = running.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(now, Ordering::SeqCst);
                let h = password::hash(&format!("password {i}")).unwrap();
                running.fetch_sub(1, Ordering::SeqCst);
                h
            })
            .await
            .unwrap()
        }));
    }
    // While the first four run, every slot is taken and the fifth waits.
    let t = Instant::now();
    while running.load(Ordering::SeqCst) < 4 && t.elapsed() < Duration::from_secs(10) {
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    assert_eq!(pool.available(), 0);
    for t in tasks {
        assert!(t.await.unwrap().starts_with("$argon2id$"));
    }
    assert_eq!(peak.load(Ordering::SeqCst), 4, "never more than 4 at once");
    assert_eq!(pool.available(), 4);
    assert_eq!(
        PasswordPool::default().per_worker(),
        PasswordPool::DEFAULT_PER_WORKER
    );
}

/// The cost of one hash at the platform's parameters (#275 item 2;
/// `docs/24-threat-model.md` A, "Login brute force": argon2id at m = 64 MiB,
/// t = 3, p = 1). Prints the median of 5 runs for
/// `bench/results/*-argon2id-dev-container.md`; asserts only that the
/// parameters are the ones in the PHC string and that one hash is neither
/// trivially cheap (under 5 ms would mean the memory cost was not applied)
/// nor pathological (over 5 s). The `node-small` number is O3's (#158).
#[test]
fn argon2id_hash_time_at_the_platform_parameters() {
    let mut ms = Vec::new();
    for i in 0..5 {
        let t = Instant::now();
        let h = password::hash(&format!("correct horse battery {i}")).unwrap();
        ms.push(t.elapsed().as_secs_f64() * 1000.0);
        assert!(h.starts_with("$argon2id$v=19$m=65536,t=3,p=1$"), "{h}");
    }
    ms.sort_by(f64::total_cmp);
    let (min, median, max) = (ms[0], ms[2], ms[4]);
    eprintln!(
        "argon2id m=65536 t=3 p=1: median {median:.1} ms, min {min:.1} ms, max {max:.1} ms over 5 hashes ({} build)",
        if cfg!(debug_assertions) {
            "debug"
        } else {
            "release"
        }
    );
    assert!(median > 5.0, "{median} ms: the memory cost was not applied");
    assert!(median < 5000.0, "{median} ms");
}
