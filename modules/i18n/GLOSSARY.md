# Arabic glossary (#336)

The terms the official modules and their catalogs use in Arabic, so that one product says one thing. The register is Modern Standard Arabic as UAE businesses write it: the polite form, no dialect, and short labels for buttons.

A catalog changes a term here first, then in every catalog that uses it. `renox check` (`i18n-missing-key`) makes sure every key exists in both languages; this file makes sure the words agree.

| English | Arabic | Notes |
| --- | --- | --- |
| Account | الحساب | |
| Admin (role) | مشرف | The role name stays `admin` in code |
| Appointment, booking | حجز، موعد | حجز for the record, موعد for the time |
| Audit trail | سجل التدقيق | |
| Bank transfer | تحويل بنكي | |
| Billing | الفوترة | |
| Cancel | إلغاء | |
| Cash on delivery | الدفع عند الاستلام | |
| Credit note | إشعار دائن ضريبي | The FTA's term on a tax credit note |
| Customer | العميل | |
| Deposit | عربون | |
| Email | البريد الإلكتروني | |
| Exempt (VAT) | معفى | |
| Files | الملفات | |
| Invoice | فاتورة | |
| Notifications | الإشعارات | |
| Organisation | المؤسسة | |
| Password | كلمة المرور | |
| Plan | الخطة | |
| Refund | استرداد | |
| Reports | التقارير | |
| Sign in, sign out | تسجيل الدخول، تسجيل الخروج | |
| Subscription | الاشتراك | |
| Tax invoice | فاتورة ضريبية | The FTA's title, word for word |
| TRN | الرقم الضريبي | Tax Registration Number |
| Two-step verification | التحقق بخطوتين | |
| VAT | ضريبة القيمة المضافة | |
| Zero-rated | بنسبة صفر | |

**Amounts.** Amounts are written as `AED 123.45` in English and `123.45 درهم` in Arabic, with the `money` filter. Fils are never shown alone. Dates use the `date` filter: `DD/MM/YYYY` in English (`date('short')`), and the CLDR Arabic short date `d‏/M‏/y` (no leading zeros, a right-to-left mark after the day and the month) in Arabic. Arabic-Indic digits (`nu = arab`) and the Hijri date next to the Gregorian one (`ca = islamic-umalqura`) are the app's choice (README, "Arabic digits", "Hijri dates"). Amounts are AED with fils as two decimals (`money`, or `number(2)` under an "AED" heading).
