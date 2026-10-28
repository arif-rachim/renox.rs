//! Every platform filter in `en-AE` and `ar-AE` (`docs/08-template-engine.md`,
//! "Right-to-left and bilingual output"): AED formatting and the optional
//! Eastern Arabic digits.

mod common;

use common::compile_files;
use minijinja::Value;
use renox_template::{Locale, RenderContext, RenderLimits, RenderTarget, Renderer};
use serde_json::json;

/// 2026-10-28T10:30:00Z.
const NOW: i64 = 1_793_183_400_000;

fn render(expr: &str, locale: Locale, data: serde_json::Value) -> String {
    let src = format!("<p>{{{{ {expr} }}}}</p>");
    let c = compile_files(&[("pages/index.html", &src)]).unwrap_or_else(|d| panic!("{d:?}"));
    let r = Renderer::new(c.sources()).unwrap();
    let html = r
        .render(
            RenderTarget::Page("pages/index"),
            serde_json::from_value::<Value>(data).unwrap(),
            &RenderContext {
                locale,
                now_ms: NOW,
                utc_offset_minutes: 240,
                ..RenderContext::default()
            },
            &RenderLimits::DEFAULT,
        )
        .unwrap_or_else(|e| panic!("{expr}: {e:?}"))
        .html;
    html.strip_prefix("<p dir=\"auto\">")
        .and_then(|h| h.strip_suffix("</p>"))
        .unwrap_or(&html)
        .to_string()
}

const EN: Locale = Locale::EN_AE;
const AR: Locale = Locale::AR_AE;
const AR_DIGITS: Locale = Locale::AR_AE_ARABIC_DIGITS;

#[test]
fn money() {
    let d = json!({"p": 1234.5, "s": "99.999", "neg": -3});
    assert_eq!(render("p | money", EN, d.clone()), "AED\u{a0}1,234.50");
    assert_eq!(render("p | money", AR, d.clone()), "1,234.50\u{a0}د.إ.");
    assert_eq!(
        render("p | money", AR_DIGITS, d.clone()),
        "١٬٢٣٤٫٥٠\u{a0}د.إ."
    );
    assert_eq!(render("s | money", EN, d.clone()), "AED\u{a0}100.00");
    assert_eq!(
        render("neg | money(\"SAR\")", EN, d.clone()),
        "SAR\u{a0}-3.00"
    );
    assert_eq!(render("neg | money(\"SAR\")", AR, d), "-3.00\u{a0}ر.س.");
}

#[test]
fn number() {
    let d = json!({"n": 1234567.891, "i": 42, "z": 0.0004});
    assert_eq!(render("n | number", EN, d.clone()), "1,234,567.891");
    assert_eq!(render("n | number(1)", EN, d.clone()), "1,234,567.9");
    assert_eq!(render("i | number", EN, d.clone()), "42");
    assert_eq!(render("z | number", EN, d.clone()), "0");
    assert_eq!(render("n | number", AR, d.clone()), "1,234,567.891");
    assert_eq!(render("n | number(0)", AR_DIGITS, d), "١٬٢٣٤٬٥٦٨");
}

#[test]
fn date() {
    let d = json!({"t": "2026-10-28T22:30:00Z", "day": "2026-01-05", "ms": NOW});
    // 22:30 UTC is 02:30 the next day in Dubai (UTC+4).
    assert_eq!(render("t | date", EN, d.clone()), "29 Oct 2026");
    assert_eq!(
        render("t | date(\"long\")", EN, d.clone()),
        "29 October 2026"
    );
    assert_eq!(render("t | date(\"short\")", EN, d.clone()), "29/10/2026");
    assert_eq!(
        render("t | date(\"datetime\")", EN, d.clone()),
        "29 Oct 2026, 02:30"
    );
    assert_eq!(render("day | date", EN, d.clone()), "5 Jan 2026");
    assert_eq!(render("ms | date(\"time\")", EN, d.clone()), "14:30");
    assert_eq!(render("t | date", AR, d.clone()), "29 أكتوبر 2026");
    assert_eq!(
        render("t | date(\"short\")", AR, d.clone()),
        "29\u{200f}/10\u{200f}/2026"
    );
    assert_eq!(render("day | date", AR_DIGITS, d.clone()), "٥ يناير ٢٠٢٦");
    assert_eq!(
        render("t | date(\"datetime\")", AR, d),
        "29 أكتوبر 2026، 02:30"
    );
}

#[test]
fn ago() {
    let at = |secs: i64| json!({"t": NOW - secs * 1000});
    assert_eq!(render("t | ago", EN, at(10)), "just now");
    assert_eq!(render("t | ago", EN, at(60)), "1 minute ago");
    assert_eq!(render("t | ago", EN, at(180)), "3 minutes ago");
    assert_eq!(render("t | ago", EN, at(-7200)), "in 2 hours");
    assert_eq!(render("t | ago", EN, at(3 * 86_400)), "3 days ago");
    assert_eq!(render("t | ago", AR, at(10)), "الآن");
    assert_eq!(render("t | ago", AR, at(60)), "قبل دقيقة واحدة");
    assert_eq!(render("t | ago", AR, at(120)), "قبل دقيقتين");
    assert_eq!(render("t | ago", AR, at(180)), "قبل 3 دقائق");
    assert_eq!(render("t | ago", AR, at(11 * 60)), "قبل 11 دقيقة");
    assert_eq!(render("t | ago", AR, at(-2 * 86_400)), "خلال يومين");
    assert_eq!(render("t | ago", AR_DIGITS, at(5 * 3600)), "قبل ٥ ساعات");
}

#[test]
fn truncate() {
    let d = json!({"en": "The quick brown fox jumps", "ar": "مرحبا بكم في متجرنا الجديد"});
    assert_eq!(render("en | truncate(9)", EN, d.clone()), "The quick…");
    assert_eq!(
        render("en | truncate(100)", EN, d.clone()),
        "The quick brown fox jumps"
    );
    assert_eq!(render("ar | truncate(9)", AR, d.clone()), "مرحبا بكم…");
    assert_eq!(render("ar | truncate(5, \"...\")", AR, d), "مرحبا...");
}

#[test]
fn json() {
    let d = json!({"v": {"name": "</script><b>'x'", "ar": "متجر", "n": 1}});
    let en = render("v | json", EN, d.clone());
    assert_eq!(
        en,
        r#"{"ar":"متجر","n":1,"name":"\u003c/script\u003e\u003cb\u003e\u0027x\u0027"}"#
    );
    assert_eq!(render("v | json", AR, d), en, "locale-independent");
}

#[test]
fn upper_and_lower() {
    let d = json!({"en": "Shop Now", "ar": "تسوق الآن"});
    assert_eq!(render("en | upper", EN, d.clone()), "SHOP NOW");
    assert_eq!(render("en | lower", EN, d.clone()), "shop now");
    assert_eq!(render("ar | upper", AR, d.clone()), "تسوق الآن");
    assert_eq!(render("ar | lower", AR, d), "تسوق الآن");
}

#[test]
fn filter_errors_are_render_errors() {
    let c = compile_files(&[("pages/index.html", "<p>{{ x | money }}</p>")]).unwrap();
    let r = Renderer::new(c.sources()).unwrap();
    let e = r
        .render(
            RenderTarget::Page("pages/index"),
            serde_json::from_value::<Value>(json!({"x": "abc"})).unwrap(),
            &RenderContext::default(),
            &RenderLimits::DEFAULT,
        )
        .unwrap_err();
    assert!(!e.is_limit());
    assert!(e.to_string().contains("needs a number"), "{e}");
}
