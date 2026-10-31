// The booking pages in both directions (#336; docs/08-template-engine.md,
// RTL): services, slots, the customer's bookings and the staff calendar in
// `en` (ltr) and `ar` (rtl), snapshotted. Then the locale extensions on the
// same pages: Eastern Arabic digits (`nu-arab`) in the `money` and `date`
// filters, the Umm al-Qura Hijri date (`ca-islamic-umalqura`) next to the
// Gregorian one, AED with its fils (two decimals), DD/MM/YYYY, and the day
// arrows of the calendar that mirror in RTL.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { bothDirections, stableIds } from "../../i18n/tests/rtl.ts";
import { app, snapshot, type TestApp } from "../../../sdk/src/test.ts";
import { hijri } from "../lib/hijri.ts";

const MODULE = join(import.meta.dir, "..");
const worker = process.env.RENOX_TEST_SPEC ?? process.env.RENOX_WORKER_PATH;
const t = worker ? await app({ project: MODULE }) : (undefined as unknown as TestApp);
const PASSWORD = "correct horse battery";
/** Monday 7 January 2030, 09:00 in Dubai (UTC+4). */
const DAY = "2030-01-07";
const START = Date.UTC(2030, 0, 7, 5, 0);

async function user(name: string, role?: string): Promise<TestApp> {
  const u = t.as(name);
  expect((await u.action("/auth/register", "default", { email: `${name}@example.com`, password: PASSWORD, display_name: name })).status).toBe(200);
  expect((await u.action("/auth/login", "default", { email: `${name}@example.com`, password: PASSWORD })).status).toBe(303);
  if (role) expect((await u.request("POST", `/api/grant?role=${role}`)).status).toBe(200);
  return u;
}
const idOf = (name: string): string => t.db.query<{ id: string }>("select id from auth__users where email = ?", [`${name}@example.com`])[0]?.id as string;

/** The text of the first `<li>` of the list `id`. */
const firstItem = (html: string, id: string): string => new RegExp(`<ul id="${id}"[^>]*>\\s*<li[^>]*>([\\s\\S]*?)</li>`, "u").exec(html)?.[1] ?? "";

test("hijri(): only for a tag with a Hijri calendar, in the tag's digits, in the app's time zone", () => {
  expect(hijri(START, "ar", 240)).toBeNull();
  expect(hijri(START, "ar-u-nu-arab", 240)).toBeNull();
  expect(hijri(START, "ar-u-ca-gregory", 240)).toBeNull();
  // 7 January 2030 is 3 Ramadan 1451 in the Umm al-Qura calendar.
  expect(hijri(START, "ar-u-ca-islamic-umalqura", 240)).toBe("3 رمضان 1451 هـ");
  expect(hijri(START, "ar-u-ca-islamic-umalqura-nu-arab", 240)).toBe("٣ رمضان ١٤٥١ هـ");
  // 23:30 on 6 January UTC is already 7 January in Dubai.
  expect(hijri(Date.UTC(2030, 0, 6, 21, 30), "ar-u-ca-islamic-umalqura", 240)).toBe("3 رمضان 1451 هـ");
});

describe.skipIf(!worker)("booking in both directions", () => {
  let nour: TestApp;
  let sara: TestApp;

  test("every page in en (ltr) and ar (rtl), snapshotted, no English left", async () => {
    sara = await user("sara", "staff");
    const admin = await user("adel", "admin");
    expect((await admin.request("POST", `/api/seed?staff_user=${idOf("sara")}&hours=540-600`)).status).toBe(200);
    nour = await user("nour");
    // A hold through the service, not the page: confirming would schedule reminders, which are at most 30 days ahead,
    // and a fixed day years ahead keeps the snapshots stable. A held booking is listed the same way.
    await t.service("booking").hold("cut", "sara", START, idOf("nour"));
    await bothDirections(
      MODULE,
      [
        { name: "services", path: "/booking", as: nour, template: "pages/index.html", arabic: "<h1>احجز موعدًا</h1>" },
        { name: "slots", path: `/booking?service=cut&day=${DAY}`, as: nour, template: "pages/index.html", arabic: "اليوم" },
        { name: "mine", path: "/booking/mine", as: nour, template: "pages/mine.html", arabic: "محجوز مؤقتًا" },
        { name: "calendar", path: `/booking/calendar?day=${DAY}`, as: sara, template: "pages/calendar.html", arabic: "اليوم التالي" },
      ],
      stableIds,
    );
  });

  test("money: AED with its fils, the symbol after the amount in Arabic, Eastern Arabic digits with nu-arab", async () => {
    const deposit = (html: string) => /Colour<\/a>[^<]*<r-t[^>]*>|Colour<\/a>([\s\S]*?)<\/li>/u.exec(html)?.[1] ?? "";
    expect(deposit((await nour.page("/booking?lang=en")).html)).toContain("AED 25.05");
    expect(deposit((await nour.page("/booking?lang=ar")).html)).toContain("25.05 د.إ.");
    const arab = (await nour.page("/booking?lang=ar-u-nu-arab")).html;
    expect(arab).toContain('<html lang="ar-u-nu-arab" dir="rtl">');
    expect(deposit(arab)).toContain("٢٥٫٠٥ د.إ.");
    // The slot times through the date filter, in the same digits.
    expect((await nour.page(`/booking?service=cut&day=${DAY}`)).html).toContain(">٠٩:٣٠ · Sara<");
    snapshot(stableIds(arab), { role: "services ar-u-nu-arab" });
  });

  test("dates: DD/MM/YYYY in English, the CLDR Arabic short date, the digits of the tag, the Hijri date with ca-islamic-umalqura", async () => {
    expect(firstItem((await nour.page("/booking/mine?lang=en")).html, "booking-mine")).toContain(`<time dir="auto">07/01/2030 09:00</time> · held`);
    const ar = firstItem((await nour.page("/booking/mine?lang=ar")).html, "booking-mine");
    expect(ar).toContain(`<time dir="auto">7‏/1‏/2030 09:00</time> · محجوز مؤقتًا`);
    expect(ar).not.toContain("booking-hijri");
    const both = (await nour.page("/booking/mine?lang=ar-u-ca-islamic-umalqura-nu-arab")).html;
    expect(both).toContain('<html lang="ar-u-ca-islamic-umalqura-nu-arab" dir="rtl">');
    expect(firstItem(both, "booking-mine")).toContain('<time dir="auto">٧‏/١‏/٢٠٣٠ ٠٩:٠٠</time><span class="booking-hijri" dir="auto"> (٣ رمضان ١٤٥١ هـ)</span> · محجوز مؤقتًا');
    snapshot(stableIds(both), { role: "mine ar-u-ca-islamic-umalqura-nu-arab" });
    // Stored with the choice (i18n calendar = auto): the next page keeps both.
    expect((await nour.page("/booking/mine")).html).toContain("(٣ رمضان ١٤٥١ هـ)");
    // Hijri with Latin digits.
    expect((await nour.page("/booking/mine?lang=ar-u-ca-islamic-umalqura")).html).toContain("(3 رمضان 1451 هـ)");
    // The staff calendar: the day itself in both calendars.
    const cal = (await sara.page(`/booking/calendar?day=${DAY}&lang=ar-u-ca-islamic-umalqura`)).html;
    expect(cal).toContain('<time datetime="2030-01-07" dir="auto">7‏/1‏/2030</time><span class="booking-hijri" dir="auto"> (3 رمضان 1451 هـ)</span>');
    expect(firstItem(cal, "booking-calendar")).toContain("09:00 · Haircut · محجوز مؤقتًا");
  });

  test("mirrored icons: the calendar's day arrows carry the class that i18n's RTL baseline flips", async () => {
    const cal = (await sara.page(`/booking/calendar?day=${DAY}&lang=ar`)).html;
    expect(cal).toContain('<html lang="ar" dir="rtl">');
    expect(cal).toContain('<a href="?day=2030-01-06" rel="prev"><span class="i18n-mirror" aria-hidden="true">←</span> اليوم السابق</a>');
    expect(cal).toContain('<a href="?day=2030-01-08" rel="next">اليوم التالي <span class="i18n-mirror" aria-hidden="true">→</span></a>');
    expect(readFileSync(join(MODULE, "..", "i18n", "public", "i18n.css"), "utf8")).toContain('[dir="rtl"] .i18n-mirror { transform: scaleX(-1); }');
  });
});
