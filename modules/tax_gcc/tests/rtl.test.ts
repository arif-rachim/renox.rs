// The tax pages in both directions (#336; docs/08-template-engine.md, RTL):
// the VAT return with its documents and the bilingual tax invoice in `en`
// (ltr) and `ar` (rtl), snapshotted. Then the locale extensions on the
// invoice: amounts in AED with their fils (two decimals) and dates as
// DD/MM/YYYY through the renderer's filters, Eastern Arabic digits with
// `nu-arab`, and the Umm al-Qura Hijri date with `ca-islamic-umalqura`.
import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { join } from "node:path";

import { bothDirections, stableIds } from "../../i18n/tests/rtl.ts";
import { app, type TestApp } from "../../../sdk/src/test.ts";
import { hijri } from "../lib/hijri.ts";

const MODULE = join(import.meta.dir, "..");
const worker = process.env.RENOX_TEST_SPEC ?? process.env.RENOX_WORKER_PATH;
const t = worker ? await app({ project: MODULE }) : (undefined as unknown as TestApp);
const PASSWORD = "correct horse battery";
const SECRET = "whsec_billing_test_0123456789abcdef";
const PERIOD = "?from=2000-01-01&to=2100-01-01";

async function user(name: string, role?: string): Promise<TestApp> {
  const u = t.as(name);
  expect((await u.action("/auth/register", "default", { email: `${name}@example.com`, password: PASSWORD, display_name: name })).status).toBe(200);
  expect((await u.action("/auth/login", "default", { email: `${name}@example.com`, password: PASSWORD })).status).toBe(303);
  if (role) expect((await u.request("POST", `/api/grant?role=${role}`)).status).toBe(200);
  return u;
}

function hook(event: unknown) {
  const body = JSON.stringify(event);
  const ts = Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", SECRET).update(`${ts}.${body}`).digest("hex");
  return t.request("POST", "/billing/webhooks/stripe", { body, headers: { "content-type": "application/json", "stripe-signature": `t=${ts},v1=${sig}` } });
}

async function issuedAt(): Promise<number> {
  for (let i = 0; i < 60; i++) {
    const r = t.db.query<{ issued_at: number }>("select issued_at from tax_gcc__documents where number = 'INV-000001'");
    if (r[0] !== undefined) return r[0].issued_at;
    await Bun.sleep(50);
  }
  throw new Error("no tax invoice");
}

/** A cell of the totals table by its English label. */
const total = (html: string, label: string): string => new RegExp(`<td>${label}[^<]*</td><td[^>]*>([^<]*)</td>`, "u").exec(html)?.[1] ?? "";
const grand = (html: string): string => /<strong dir="auto">([^<]*)<\/strong><\/td><\/tr>\s*<\/tbody><\/table>\s*<\/article>/u.exec(html)?.[1] ?? "";

describe.skipIf(!worker)("tax_gcc in both directions", () => {
  let farah: TestApp;
  let at = 0;

  test("the return and the invoice in en (ltr) and ar (rtl), snapshotted, no English left", async () => {
    await user("sara");
    const id = t.db.query<{ id: string }>("select id from auth__users where email = 'sara@example.com'")[0]?.id as string;
    // AED 1,234.56 net: VAT 61.73, total 1,296.29.
    const event = { id: "evt_rtl_1", type: "invoice.finalized", data: { object: { id: "in_rtl", customer: "cus_1", amount_due: 123456, currency: "aed", metadata: { customer_id: id } } } };
    expect((await hook(event)).status).toBe(200);
    at = await issuedAt();
    farah = await user("farah", "finance");
    await bothDirections(
      MODULE,
      [
        { name: "return", path: `/tax${PERIOD}`, as: farah, template: "pages/index.html", arabic: "INV-000001" },
        { name: "invoice", path: "/tax/invoices/INV-000001", as: farah, template: "pages/invoices/[number].html", arabic: "فاتورة ضريبية" },
      ],
      stableIds,
    );
  });

  test("amounts: two decimals and grouping in both languages, Eastern Arabic digits with nu-arab", async () => {
    const en = (await farah.page("/tax/invoices/INV-000001?lang=en")).html;
    expect(grand(en)).toBe("1,296.29");
    expect(total(en, "Standard rated")).toBe("1,234.56");
    expect(total(en, "VAT /")).toBe("61.73");
    expect(total(en, "Zero rated")).toBe("0.00");
    const ar = (await farah.page("/tax/invoices/INV-000001?lang=ar")).html;
    expect(total(ar, "VAT /")).toBe("61.73");
    const arab = (await farah.page("/tax/invoices/INV-000001?lang=ar-u-nu-arab")).html;
    expect(arab).toContain('<html lang="ar-u-nu-arab" dir="rtl">');
    expect(total(arab, "VAT /")).toBe("٦١٫٧٣");
    expect(total(arab, "Zero rated")).toBe("٠٫٠٠");
    expect(grand(arab)).toBe("١٬٢٩٦٫٢٩");
    // The return page too.
    expect((await farah.page(`/tax${PERIOD}&lang=ar-u-nu-arab`)).html).toContain('<td dir="auto">٦١٫٧٣</td>');
  });

  test("dates: DD/MM/YYYY in English, d/M/y in Arabic, the Hijri date only with ca-islamic-umalqura", async () => {
    const d = new Date(at + 240 * 60_000);
    const dd = String(d.getUTCDate()).padStart(2, "0");
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const en = (await farah.page("/tax/invoices/INV-000001?lang=en")).html;
    expect(en).toContain(`<time dir="auto">${dd}/${mm}/${d.getUTCFullYear()}</time>`);
    expect(en).not.toContain("tax-hijri");
    const ar = (await farah.page("/tax/invoices/INV-000001?lang=ar")).html;
    expect(ar).toContain(`<time dir="auto">${d.getUTCDate()}‏/${d.getUTCMonth() + 1}‏/${d.getUTCFullYear()}</time>`);
    expect(ar).not.toContain("tax-hijri");
    const tag = "ar-u-ca-islamic-umalqura-nu-arab";
    const both = (await farah.page(`/tax/invoices/INV-000001?lang=${tag}`)).html;
    expect(both).toContain(`<html lang="${tag}" dir="rtl">`);
    const expected = hijri(at, tag, 240) as string;
    expect(expected).toMatch(/^[٠-٩]+ .+ [٠-٩]{4} هـ$/u);
    expect(both).toContain(`<span class="tax-hijri" dir="auto"> (${expected})</span>`);
    // The return lists the date by the same filter.
    expect((await farah.page(`/tax${PERIOD}&lang=en`)).html).toContain(`<td dir="auto">${dd}/${mm}/${d.getUTCFullYear()}</td>`);
  });
});
