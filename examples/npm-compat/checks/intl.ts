// Built-in Intl (needs full ICU in the isolate): Arabic number and date
// formatting for the UAE, including the Umm al-Qura calendar and Eastern
// Arabic digits (docs/21-uae-gcc-strategy.md: every starter ships EN/AR).
import { assert, assertEqual } from "./_lib/assert.ts";

const EASTERN_ARABIC_DIGITS = /[٠-٩]/;

export async function check(): Promise<void> {
  const n = 1234567.891;
  const en = new Intl.NumberFormat("en-AE").format(n);
  assertEqual(en, "1,234,567.891", "en-AE number");
  const ar = new Intl.NumberFormat("ar-AE").format(n);
  assert(ar.length > 0, "ar-AE number formats");
  const arab = new Intl.NumberFormat("ar-AE-u-nu-arab").format(n);
  assert(EASTERN_ARABIC_DIGITS.test(arab), `nu=arab gives Eastern Arabic digits, got ${arab}`);

  const date = new Date(Date.UTC(2026, 2, 20, 12));
  const hijri = new Intl.DateTimeFormat("ar-AE-u-ca-islamic-umalqura", {
    dateStyle: "long",
    timeZone: "Asia/Dubai",
  });
  assertEqual(hijri.resolvedOptions().calendar, "islamic-umalqura", "calendar resolved");
  const parts = hijri.formatToParts(date);
  assert(parts.some((p) => p.type === "month"), "hijri date has a month part");
  const aed = new Intl.NumberFormat("en-AE", { style: "currency", currency: "AED" }).format(99.5);
  assert(aed.includes("AED") && aed.includes("99.50"), `AED currency, got ${aed}`);
}
