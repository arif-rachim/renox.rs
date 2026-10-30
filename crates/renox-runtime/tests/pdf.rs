//! Issue #322: `ctx.pdf` (`docs/contracts/ops.md` 1.7.0 section 24).
//! V8-linked for the op; the layout checks need no isolate.
//!
//! A bilingual tax invoice (English and Arabic, right-to-left blocks, a
//! table): the text comes out in order, the Arabic runs are set in Noto
//! Naskh Arabic (shaped by the bundled font, never a fallback box), the PDF
//! is small, the render time is metered, and template data cannot inject
//! typst code.

mod support;

use std::sync::Arc;
use std::time::Instant;

use renox_runtime::ops::pdf::{
    PdfOptions, TemplateHost, TemplateSlot, html_to_pdf, layout, text_runs,
};
use renox_runtime::{Runtime, RuntimeConfig};
use support::{body_json, ctx, get, spec, write_artifact};

const INVOICE: &str = r#"<!doctype html>
<html lang="en">
<body>
  <h1>Tax Invoice</h1>
  <p>Hello Trading LLC — TRN 100123456700003</p>
  <div dir="rtl" lang="ar">
    <h2>فاتورة ضريبية</h2>
    <p>شركة هلا للتجارة</p>
  </div>
  <table>
    <tr><th>Item</th><th>Qty</th><th>Amount (AED)</th></tr>
    <tr><td>Starter plan</td><td>1</td><td>79.00</td></tr>
    <tr><td>VAT 5 %</td><td></td><td>3.95</td></tr>
    <tr><td><strong>Total</strong></td><td></td><td><strong>82.95</strong></td></tr>
  </table>
  <p>Thank you for your business.</p>
</body>
</html>"#;

#[test]
fn a_bilingual_invoice_lays_out_in_order_with_arabic_in_the_naskh_font_and_stays_small() {
    let t = Instant::now();
    let doc = layout(INVOICE, &PdfOptions::default()).unwrap();
    let runs = text_runs(&doc);
    let text: Vec<&str> = runs.iter().map(|(t, _)| t.as_str()).collect();
    let joined = text.join(" ");
    let order = [
        "Tax Invoice",
        "Hello Trading",
        "Item",
        "Starter plan",
        "79.00",
        "VAT",
        "3.95",
        "Total",
        "82.95",
        "Thank you",
    ];
    let mut at = 0;
    for word in order {
        let i = joined[at..]
            .find(word)
            .unwrap_or_else(|| panic!("{word} after {at} in {joined}"));
        at += i + word.len();
    }
    // The Arabic heading and line: set in the bundled Arabic font.
    let arabic: Vec<&(String, String)> = runs
        .iter()
        .filter(|(t, _)| t.chars().any(|c| ('\u{0600}'..='\u{06FF}').contains(&c)))
        .collect();
    assert!(!arabic.is_empty(), "{runs:?}");
    assert!(
        arabic.iter().all(|(_, f)| f == "Noto Naskh Arabic"),
        "{arabic:?}"
    );
    // Runs are per shaped segment; every letter of the heading is laid out.
    let all: String = arabic.iter().map(|(t, _)| t.as_str()).collect();
    assert!("فاتورةضريبية".chars().all(|c| all.contains(c)), "{all}");
    let latin: Vec<&(String, String)> =
        runs.iter().filter(|(t, _)| t.contains("Invoice")).collect();
    assert!(latin.iter().all(|(_, f)| f == "Noto Sans"));
    let pdf = html_to_pdf(INVOICE, &PdfOptions::default()).unwrap();
    let ms = t.elapsed().as_millis();
    assert!(pdf.starts_with(b"%PDF-"));
    assert_eq!(doc.pages().len(), 1);
    assert!(pdf.len() < 200 * 1024, "{} bytes", pdf.len());
    eprintln!(
        "bilingual invoice: {} bytes, {ms} ms (layout + PDF, debug build)",
        pdf.len()
    );
}

#[test]
fn template_data_is_text_never_typst() {
    let evil = r#"<p>#set page(width: 1pt) #read("/etc/passwd") ] [ "</p>"#;
    let doc = layout(evil, &PdfOptions::default()).unwrap();
    let text: String = text_runs(&doc)
        .into_iter()
        .map(|(t, _)| t)
        .collect::<Vec<_>>()
        .join("");
    assert!(
        text.contains("#set page(width: 1pt)") && text.contains("#read"),
        "{text}"
    );
}

struct Html;

impl TemplateHost for Html {
    fn render(&self, template: &str, data_json: &str) -> Result<String, String> {
        if template != "pages/invoice" {
            return Err(format!("unknown template {template}"));
        }
        let data: serde_json::Value = serde_json::from_str(data_json).map_err(|e| e.to_string())?;
        let n = data["lines"].as_u64().unwrap_or(1);
        let rows: String = (0..n).map(|i| format!("<p>Line {i}</p>")).collect();
        Ok(format!(
            "<html><body><h1>{}</h1>{rows}</body></html>",
            data["title"].as_str().unwrap_or("")
        ))
    }
}

const APP: &str = r#"
export async function GET(ctx) {
  const lines = Number(ctx.url.searchParams.get("lines") ?? "1");
  try {
    const bytes = await ctx.pdf.render("pages/invoice", { title: "Invoice 42", lines }, { page: "A4" });
    return Response.json({ ok: true, len: bytes.length, head: new TextDecoder().decode(bytes.slice(0, 5)) });
  } catch (e) {
    return Response.json({ ok: false, code: e.code ?? null, name: e.name });
  }
}
"#;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ctx_pdf_renders_meters_and_refuses_past_the_page_limit() {
    let rt = Runtime::new(RuntimeConfig::default());
    let manifest = serde_json::json!({
        "artifact": { "version": 1 },
        "app": { "name": "invoices", "timezone": "Asia/Dubai" },
        "code": { "format": "esm-dir", "entry": { "functions/f": "functions/f.js" } },
        "routes": [{ "kind": "function", "method": "GET", "path": "/pdf", "module": "functions/f", "export": "GET" }],
        "permissions": { "network": [], "secrets": [] },
    });
    let m = serde_json::to_vec(&manifest).unwrap();
    let (dir, hash) = write_artifact(&[
        ("manifest.json", &m),
        ("code/functions/f.js", APP.as_bytes()),
    ]);
    let mut s = spec(
        &dir,
        &hash,
        renox_runtime::limits::Limits {
            cpu_ms: 5_000,
            ..renox_runtime::limits::Limits::FREE
        },
    );
    s.templates = Some(TemplateSlot(Arc::new(Html)));
    let iso = rt.create_isolate(s).await.unwrap();
    let out = iso.dispatch(ctx("req_pdf_ok_00000001"), get("/pdf")).await;
    let v = body_json(&out.response);
    assert_eq!(v["ok"], true, "{v}");
    assert_eq!(v["head"], "%PDF-");
    assert!(out.meter.render_pdf_ms > 0.0, "render_pdf_ms is metered");
    // 201 pages of one line each would pass the limit: about 50 lines a page.
    let big = iso
        .dispatch(ctx("req_pdf_big_0000001"), get("/pdf?lines=12000"))
        .await;
    let v = body_json(&big.response);
    assert_eq!(v["code"], "RENOX_PDF_LIMIT", "{v}");
    assert_eq!(v["name"], "PdfLimitError");
}
